/**
 * ⭐ Agent Safety Rail dashboard routes: GET/POST /api/approvals/* (src/http/routes/approvals.ts).
 * Local mode (no OIDC) → /api/* is ungated, so routes are exercised directly, same idiom as
 * server-routes.test.ts.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { requestApproval, clearAllPending, setApprovalGateEnabled } from "../src/approvals.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

beforeEach(() => {
  setApprovalGateEnabled(true);
  clearAllPending();
});
afterEach(() => {
  clearAllPending();
});

test("GET /api/approvals is empty by default", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/approvals");
  expect(res.status).toBe(200);
  expect((await res.json()).approvals).toEqual([]);
});

test("GET /api/approvals lists a pending request with tool/repo/argsSummary", async () => {
  const app = createApp(localCfg());
  const { id } = requestApproval("git_commit", "my-repo", "message: fix: x", 5_000);
  const res = await app.request("/api/approvals");
  const body = (await res.json()) as { approvals: Array<Record<string, unknown>> };
  const entry = body.approvals.find((a) => a.id === id);
  expect(entry).toBeDefined();
  expect(entry!.tool).toBe("git_commit");
  expect(entry!.repo).toBe("my-repo");
  expect(entry!.argsSummary).toBe("message: fix: x");
});

test("POST /api/approvals/:id/approve resolves the pending promise and removes it from the list", async () => {
  const app = createApp(localCfg());
  const { id, result } = requestApproval("git_push", null, "(no arguments)", 5_000);

  const res = await app.request(`/api/approvals/${id}/approve`, { method: "POST" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(await result).toBe("approved");

  const list = await app.request("/api/approvals");
  expect((await list.json()).approvals).toEqual([]);
});

test("POST /api/approvals/:id/deny resolves the pending promise as denied", async () => {
  const app = createApp(localCfg());
  const { id, result } = requestApproval("git_pull", null, "(no arguments)", 5_000);

  const res = await app.request(`/api/approvals/${id}/deny`, { method: "POST" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(await result).toBe("denied");
});

test("POST /api/approvals/:id/approve on an unknown id 404s", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/approvals/not-a-real-id/approve", { method: "POST" });
  expect(res.status).toBe(404);
  expect((await res.json()).code).toBe("NOT_FOUND");
});

test("POST /api/approvals/:id/deny on an unknown id 404s", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/approvals/not-a-real-id/deny", { method: "POST" });
  expect(res.status).toBe(404);
  expect((await res.json()).code).toBe("NOT_FOUND");
});

test("GET /api/status reports mcpApprovalGate (default true) and mcpApprovalTimeoutSecs", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/status");
  const body = await res.json();
  expect(body.mcpApprovalGate).toBe(true);
  expect(typeof body.mcpApprovalTimeoutSecs).toBe("number");
});

test("PUT /api/settings toggles mcpApprovalGate and clamps mcpApprovalTimeoutSecs", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mcpApprovalGate: false, mcpApprovalTimeoutSecs: 1 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.mcpApprovalGate).toBe(false);
  expect(body.mcpApprovalTimeoutSecs).toBe(10); // clamped to the 10s floor
});
