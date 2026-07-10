/**
 * ⭐ Agent Safety Rail — the approval queue (src/approvals.ts) + its MCP gate wiring
 * (src/mcp/core.ts's contextFor). Covers: approve path, deny path, timeout auto-deny, gate-off
 * passthrough, and that a read-only tool is never gated.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  requestApproval,
  approve,
  deny,
  listPending,
  summarizeArgs,
  approvalGateEnabled,
  setApprovalGateEnabled,
  getApprovalTimeoutSecs,
  setApprovalTimeoutSecs,
  clampApprovalTimeoutSecs,
  clearAllPending,
  APPROVAL_TIMEOUT_MIN_S,
  APPROVAL_TIMEOUT_MAX_S,
} from "../src/approvals.ts";
import { contextFor } from "../src/mcp/core.ts";
import { serviceBackend } from "../src/mcp/adapter-service.ts";
import { upsertRepo } from "../src/db.ts";
import { addListener, removeListener } from "../src/bus.ts";

/** A real git repo with one seed commit + local author (mirrors tests/smart-commit.test.ts's
 *  `repo()`), registered with the daemon. Real `git` calls fail FAST here (NOTHING_TO_COMMIT / no
 *  remote) instead of hanging, unlike a bare mkdtemp dir that was never `git init`'d. */
async function gitRepo(name: string): Promise<{ dir: string; id: string }> {
  const dir = mkdtempSync(join(tmpdir(), `gm-approvals-${name}-`));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  writeFileSync(join(dir, "a.txt"), "a0\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
  return { dir, id: upsertRepo(dir, name, "auto", false) };
}

// Restore the gate to its default (ON) + default timeout + clear any leftover pending entries
// around every test, so tests never leak state into one another.
beforeEach(() => {
  setApprovalGateEnabled(true);
  setApprovalTimeoutSecs(120);
  clearAllPending();
});
afterEach(() => {
  clearAllPending();
});

// ── the queue itself ──────────────────────────────────────────────────────────────
test("summarizeArgs renders a short one-line summary, skipping repo and clipping long values", () => {
  expect(summarizeArgs({ repo: "x", message: "fix: thing" })).toBe("message: fix: thing");
  expect(summarizeArgs({})).toBe("(no arguments)");
  const long = "a".repeat(200);
  const s = summarizeArgs({ message: long });
  expect(s.length).toBeLessThan(long.length);
  expect(s.endsWith("...")).toBe(true);
});

test("requestApproval registers a pending entry and broadcasts approval_pending", async () => {
  const events: Array<{ event: string; data: string }> = [];
  const listener = (event: string, data: string) => events.push({ event, data });
  addListener(listener);
  try {
    const { id, result } = requestApproval("git_commit", "my-repo", "message: fix: x", 5_000);
    expect(listPending().some((p) => p.id === id)).toBe(true);
    expect(events.some((e) => e.event === "approval_pending" && JSON.parse(e.data).id === id)).toBe(true);

    expect(approve(id)).toBe(true);
    expect(await result).toBe("approved");
    expect(listPending().some((p) => p.id === id)).toBe(false);
    expect(
      events.some(
        (e) => e.event === "approval_resolved" && JSON.parse(e.data).id === id && JSON.parse(e.data).outcome === "approved",
      ),
    ).toBe(true);
  } finally {
    removeListener(listener);
  }
});

test("deny path resolves the promise to 'denied' and removes the pending entry", async () => {
  const { id, result } = requestApproval("git_push", null, "(no arguments)", 5_000);
  expect(deny(id)).toBe(true);
  expect(await result).toBe("denied");
  expect(listPending().some((p) => p.id === id)).toBe(false);
});

test("approve/deny on an unknown or already-resolved id is a harmless no-op returning false", async () => {
  expect(approve("not-a-real-id")).toBe(false);
  const { id, result } = requestApproval("git_pull", null, "(no arguments)", 5_000);
  expect(deny(id)).toBe(true);
  await result;
  expect(deny(id)).toBe(false); // already resolved
  expect(approve(id)).toBe(false);
});

test("timeout auto-denies a pending approval when nobody responds in time", async () => {
  const { id, result } = requestApproval("git_fetch", null, "(no arguments)", 20);
  const outcome = await result;
  expect(outcome).toBe("timeout");
  expect(listPending().some((p) => p.id === id)).toBe(false);
});

test("clampApprovalTimeoutSecs clamps into [MIN, MAX] and falls back to the default on non-finite", () => {
  expect(clampApprovalTimeoutSecs(1)).toBe(APPROVAL_TIMEOUT_MIN_S);
  expect(clampApprovalTimeoutSecs(999_999)).toBe(APPROVAL_TIMEOUT_MAX_S);
  expect(clampApprovalTimeoutSecs(Number.NaN)).toBe(120);
  expect(setApprovalTimeoutSecs(45)).toBe(45);
  expect(getApprovalTimeoutSecs()).toBe(45);
});

// ── the MCP gate wiring (src/mcp/core.ts contextFor) ───────────────────────────────
test("a mutating tool call blocks until approved, then runs the real backend call", async () => {
  const { id } = await gitRepo("commit");
  const ctx = contextFor(serviceBackend());
  const tool = ctx.tools.find((t) => t.name === "git_commit")!;

  // Nothing staged (the seed commit already covers a.txt) → the backend call fails fast with
  // NOTHING_TO_COMMIT once approved, proving the gate let it through to commitRepo().
  const runPromise = tool.run({ repo: id, message: "test: commit" });

  // The call should still be pending shortly after firing (give the microtask queue a turn).
  await new Promise((r) => setTimeout(r, 10));
  const pending = listPending().find((p) => p.tool === "git_commit" && p.repo === id);
  expect(pending).toBeDefined();

  approve(pending!.id);
  await expect(runPromise).rejects.toThrow();
});

test("a denied mutating call throws a structured 'denied by owner' error, never reaching the backend", async () => {
  const { id } = await gitRepo("deny");
  const ctx = contextFor(serviceBackend());
  const tool = ctx.tools.find((t) => t.name === "git_push")!;

  const runPromise = tool.run({ repo: id });
  await new Promise((r) => setTimeout(r, 10));
  const pending = listPending().find((p) => p.tool === "git_push" && p.repo === id);
  expect(pending).toBeDefined();

  deny(pending!.id);
  await expect(runPromise).rejects.toThrow(/denied by owner/);
});

test(
  "an MCP gate call that times out (nobody approves/denies) throws a structured 'approval timed out' error",
  async () => {
    const { id } = await gitRepo("timeout");
    const ctx = contextFor(serviceBackend());
    const tool = ctx.tools.find((t) => t.name === "git_checkout")!;

    // core.ts's wrapper falls back to the runtime timeout (getApprovalTimeoutSecs) for every
    // call — shrink it to the clamp floor so this test waits out a real (but short) auto-deny
    // instead of asserting on the internals.
    setApprovalTimeoutSecs(APPROVAL_TIMEOUT_MIN_S);
    const runPromise = tool.run({ repo: id, branch: "main" });
    await expect(runPromise).rejects.toThrow(/approval timed out/);
    expect(listPending().length).toBe(0);
  },
  15_000,
);

test("gate-off passthrough: with mcpApprovalGate disabled, a mutating call runs immediately (no pending entry)", async () => {
  setApprovalGateEnabled(false);
  const { id } = await gitRepo("gateoff");
  const ctx = contextFor(serviceBackend());
  const tool = ctx.tools.find((t) => t.name === "git_fetch")!;

  await Promise.resolve(tool.run({ repo: id })).catch(() => {}); // may fail (no remote); only care it ran, not blocked
  expect(listPending().length).toBe(0);
});

test("approvalGateEnabled defaults to true and reflects setApprovalGateEnabled", () => {
  setApprovalGateEnabled(true);
  expect(approvalGateEnabled()).toBe(true);
  setApprovalGateEnabled(false);
  expect(approvalGateEnabled()).toBe(false);
});

test("a read-only tool (repo_status) is never gated, even while the gate is on", async () => {
  setApprovalGateEnabled(true);
  const { id } = await gitRepo("readonly");
  const ctx = contextFor(serviceBackend());
  const tool = ctx.tools.find((t) => t.name === "repo_status")!;

  const result = await tool.run({ repo: id });
  expect((result as { id: string }).id).toBe(id);
  expect(listPending().length).toBe(0);
});
