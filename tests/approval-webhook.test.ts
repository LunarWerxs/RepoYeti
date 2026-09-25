/**
 * Approval gate webhook mode (src/approvals.ts requestWebhookVerdict, wired in src/mcp/core.ts's
 * contextFor). Pins the three-answer contract end to end through the real MCP gate: a deny never
 * reaches the backend, a rewrite is what runs, and a policy service that fails to answer properly
 * denies (fail closed) instead of letting the agent's call through.
 */
import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  setApprovalGateEnabled,
  setApprovalWebhookUrl,
  normalizeApprovalWebhookUrl,
  listPending,
  clearAllPending,
  APPROVAL_WEBHOOK_REQID_HEADER,
} from "../src/approvals.ts";
import { contextFor } from "../src/mcp/core.ts";
import type { McpBackend } from "../src/mcp/backend.ts";

// The policy service under test: each test sets what it answers and reads what it was sent.
let reply: () => Response = () => Response.json({ decision: "approve" });
let received: Array<{ reqIdHeader: string | null; body: Record<string, unknown> }> = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      received.push({
        reqIdHeader: req.headers.get(APPROVAL_WEBHOOK_REQID_HEADER),
        body: (await req.json()) as Record<string, unknown>,
      });
      return reply();
    },
  });
});
afterAll(() => {
  server.stop(true);
});

// A backend stub that only records what git_commit would have run with.
let commits: Array<{ repo: string; message: string; amend: boolean }> = [];
const backend = {
  commit: async (repo: string, message: string, amend: boolean) => {
    commits.push({ repo, message, amend });
    return { ok: true };
  },
} as unknown as McpBackend;

function commitTool() {
  return contextFor(backend).tools.find((t) => t.name === "git_commit")!;
}

beforeEach(() => {
  reply = () => Response.json({ decision: "approve" });
  received = [];
  commits = [];
  setApprovalGateEnabled(true);
  setApprovalWebhookUrl(`http://127.0.0.1:${server.port}/policy`);
  clearAllPending();
});
afterEach(() => {
  setApprovalWebhookUrl(null);
  clearAllPending();
});

test("a deny answer stops the call before the backend and names the reason and request id", async () => {
  reply = () => Response.json({ decision: "deny", reason: "no agent commits on release branches" });
  const err = await Promise.resolve(commitTool().run({ repo: "r1", message: "fix: thing" })).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/denied by the approval webhook: no agent commits on release branches/);
  expect(commits).toEqual([]);
  // The id in the header, the body and the agent's error is the same one, so the three logs join up.
  expect(received.length).toBe(1);
  const reqId = received[0]!.body.reqId as string;
  expect(received[0]!.reqIdHeader).toBe(reqId);
  expect((err as Error).message).toContain(reqId);
  expect(received[0]!.body.op).toBe("mcp_tool_call");
  expect((received[0]!.body.content as { tool: string; repo: string }).tool).toBe("git_commit");
  // Webhook mode never parks the call in the dashboard queue.
  expect(listPending().length).toBe(0);
});

test("an approve answer runs the call with the agent's own arguments", async () => {
  await commitTool().run({ repo: "r1", message: "fix: thing" });
  expect(commits).toEqual([{ repo: "r1", message: "fix: thing", amend: false }]);
});

test("a rewrite answer runs the rewritten arguments, not the agent's", async () => {
  reply = () => Response.json({ decision: "rewrite", args: { message: "agent: fix: thing" } });
  await commitTool().run({ repo: "r1", message: "fix: thing" });
  expect(commits).toEqual([{ repo: "r1", message: "agent: fix: thing", amend: false }]);
});

test("a rewrite that retargets the repo, or names a field the tool lacks, is denied", async () => {
  reply = () => Response.json({ decision: "rewrite", args: { repo: "someone-else" } });
  await expect(Promise.resolve(commitTool().run({ repo: "r1", message: "m" }))).rejects.toThrow(/may not rewrite "repo"/);
  reply = () => Response.json({ decision: "rewrite", args: { force: true } });
  await expect(Promise.resolve(commitTool().run({ repo: "r1", message: "m" }))).rejects.toThrow(/may not rewrite "force"/);
  expect(commits).toEqual([]);
});

test("the gate fails closed on a non-200, a non-JSON reply, an unknown decision, or no service at all", async () => {
  reply = () => new Response("oops", { status: 500 });
  await expect(Promise.resolve(commitTool().run({ repo: "r1", message: "m" }))).rejects.toThrow(/HTTP 500/);
  reply = () => new Response("yes please", { status: 200 });
  await expect(Promise.resolve(commitTool().run({ repo: "r1", message: "m" }))).rejects.toThrow(/not JSON/);
  reply = () => Response.json({ unchange: true });
  await expect(Promise.resolve(commitTool().run({ repo: "r1", message: "m" }))).rejects.toThrow(/no valid decision/);
  // A port nothing listens on: the service being down must not wave the call through.
  const down = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const deadUrl = `http://127.0.0.1:${down.port}/policy`;
  down.stop(true);
  setApprovalWebhookUrl(deadUrl);
  await expect(Promise.resolve(commitTool().run({ repo: "r1", message: "m" }))).rejects.toThrow(/unreachable/);
  expect(commits).toEqual([]);
});

test("normalizeApprovalWebhookUrl accepts http(s), clears on empty, and refuses the rest", () => {
  expect(normalizeApprovalWebhookUrl("https://policy.example/hook")).toBe("https://policy.example/hook");
  expect(normalizeApprovalWebhookUrl("  ")).toBeNull();
  expect(normalizeApprovalWebhookUrl("file:///etc/passwd")).toBeUndefined();
  expect(normalizeApprovalWebhookUrl("not a url")).toBeUndefined();
  expect(normalizeApprovalWebhookUrl("https://user:pw@policy.example/")).toBeUndefined();
  expect(normalizeApprovalWebhookUrl(42)).toBeUndefined();
});
