/**
 * Approval receipts (src/approvals.ts "Receipts"): an MCP approval is bound to the digest of the
 * exact {tool, args} the owner saw, consumed once at execution, and refused with a distinct reason
 * for each way it can be wrong. The SQLite store keeps the signed ledger across restarts.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  actionDigest,
  approve,
  canonicalJson,
  clearAllPending,
  consumeApproval,
  deny,
  listPending,
  listReceipts,
  requestApproval,
  resetReceiptStore,
  setApprovalGateEnabled,
  setAutoApproveEnabled,
  setAutoDenyEnabled,
  setReceiptStore,
  APPROVAL_RECEIPT_TTL_MS,
} from "../src/approvals.ts";
import { contextFor } from "../src/mcp/core.ts";
import type { McpBackend } from "../src/mcp/backend.ts";
// Through db.ts, which registers the boot sequence the store's getDb() needs.
import { sqliteReceiptStore } from "../src/db.ts";
import { getDb } from "../src/db/connection.ts";
import { rotateKey } from "../src/signing.ts";

beforeEach(() => {
  setApprovalGateEnabled(true);
  setAutoDenyEnabled(true);
  setAutoApproveEnabled(false);
  clearAllPending();
  resetReceiptStore();
});
afterEach(() => {
  clearAllPending();
  resetReceiptStore();
});

/** A backend that only records which repo a push was handed, so no git is involved. */
function recordingBackend(): { backend: McpBackend; pushed: string[] } {
  const pushed: string[] = [];
  const backend = {
    push: async (repo: string) => {
      pushed.push(repo);
      return { ok: true };
    },
  } as unknown as McpBackend;
  return { backend, pushed };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

test("the digest ignores key order and changes with any value", () => {
  expect(canonicalJson({ b: 1, a: { d: 2, c: [1, "x"] }, skip: undefined })).toBe('{"a":{"c":[1,"x"],"d":2},"b":1}');
  expect(actionDigest("git_commit", { repo: "r", message: "m" })).toBe(
    actionDigest("git_commit", { message: "m", repo: "r" }),
  );
  expect(actionDigest("git_commit", { repo: "r", message: "m" })).not.toBe(
    actionDigest("git_commit", { repo: "r", message: "m2" }),
  );
  expect(() => canonicalJson({ n: Number.NaN })).toThrow();
});

test("arguments changed between approve and execute are refused, and the backend never runs", async () => {
  const { backend, pushed } = recordingBackend();
  const tool = contextFor(backend).tools.find((t) => t.name === "git_push")!;
  const args: Record<string, unknown> = { repo: "reviewed-repo" };
  const run = tool.run(args);
  await tick();
  const pending = listPending().find((p) => p.tool === "git_push")!;
  expect(pending.digest).toBe(actionDigest("git_push", { repo: "reviewed-repo" }));

  args.repo = "some-other-repo"; // the swap the owner never saw
  approve(pending.id);
  await expect(run).rejects.toThrow(/approval refused: digest-mismatch/);
  expect(pushed).toEqual([]);
});

test("an approved call runs once; the same approval cannot be used again", async () => {
  const { backend, pushed } = recordingBackend();
  const tool = contextFor(backend).tools.find((t) => t.name === "git_push")!;
  const run = tool.run({ repo: "r1" });
  await tick();
  const { id } = listPending()[0]!;
  approve(id);
  await run;
  expect(pushed).toEqual(["r1"]);
  expect(consumeApproval(id, "git_push", { repo: "r1" })).toEqual({ ok: false, reason: "replayed" });
});

test("each way a receipt can be wrong has its own refusal reason", () => {
  const args = { repo: "r" };
  const decided = (verdict: "approve" | "deny"): string => {
    const { id } = requestApproval("git_fetch", "r", "(no arguments)", 5_000, args);
    if (verdict === "approve") approve(id);
    else deny(id);
    return id;
  };

  expect(consumeApproval("never-decided", "git_fetch", args)).toEqual({ ok: false, reason: "unknown" });
  expect(consumeApproval(decided("deny"), "git_fetch", args)).toEqual({ ok: false, reason: "not-approved" });

  const late = decided("approve");
  const [receipt] = listReceipts(1);
  expect(consumeApproval(late, "git_fetch", args, receipt!.decidedAt + APPROVAL_RECEIPT_TTL_MS + 1)).toEqual({
    ok: false,
    reason: "expired",
  });
  // A refusal burns the receipt: the correct call cannot ride it afterwards.
  expect(consumeApproval(late, "git_fetch", args)).toEqual({ ok: false, reason: "replayed" });

  const policyChanged = decided("approve");
  setAutoDenyEnabled(false); // the owner changed the gate between the decision and the execution
  expect(consumeApproval(policyChanged, "git_fetch", args)).toEqual({ ok: false, reason: "stale-policy" });
  setAutoDenyEnabled(true);

  const beforeRotation = decided("approve");
  rotateKey(); // "sign out everywhere"
  expect(consumeApproval(beforeRotation, "git_fetch", args)).toEqual({ ok: false, reason: "rotated-key" });
});

test("the SQLite ledger keeps signed receipts, detects an edited row, and records use", () => {
  setReceiptStore(sqliteReceiptStore);
  const args = { repo: "r", message: "fix: x" };

  const denied = requestApproval("git_commit", "r", "message: fix: x", 5_000, args).id;
  deny(denied);
  // Flip the stored verdict behind the daemon's back: the signature no longer matches.
  getDb().query(`UPDATE approval_receipts SET outcome = 'approved' WHERE id = ?`).run(denied);
  expect(consumeApproval(denied, "git_commit", args)).toEqual({ ok: false, reason: "bad-signature" });

  const approved = requestApproval("git_commit", "r", "message: fix: x", 5_000, args).id;
  approve(approved);
  expect(consumeApproval(approved, "git_commit", args).ok).toBe(true);

  const audit = listReceipts(10);
  const used = audit.find((r) => r.id === approved)!;
  expect(used).toMatchObject({
    digest: actionDigest("git_commit", args),
    outcome: "approved",
    decidedBy: "owner",
    refusal: null,
    verified: "ok",
  });
  expect(used.consumedAt).not.toBeNull();
  expect(audit.find((r) => r.id === denied)).toMatchObject({ refusal: "bad-signature", verified: "bad-signature" });
});
