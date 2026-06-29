import { test, expect } from "bun:test";
import { createApp } from "../src/daemon.ts";
import { statusForCode } from "../src/contract.ts";
import type { GitmobConfig } from "../src/config.ts";

// Local mode (no OIDC) → /api/* is not gated, so routes are exercised directly.
const localCfg = (): GitmobConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

test("statusForCode maps every code family to the right HTTP status", () => {
  expect(statusForCode("OK")).toBe(200);
  expect(statusForCode("BAD_REQUEST")).toBe(400);
  expect(statusForCode("NO_AI_PROVIDER")).toBe(400);
  expect(statusForCode("AI_AUTH_FAILED")).toBe(401);
  expect(statusForCode("NOT_FOUND")).toBe(404);
  expect(statusForCode("BAD_PROVIDER")).toBe(404);
  expect(statusForCode("DIRTY_WORKING_TREE")).toBe(409);
  expect(statusForCode("NON_FAST_FORWARD")).toBe(409);
  expect(statusForCode("SUBMODULE_NOT_ACTIONABLE")).toBe(409);
  expect(statusForCode("SSH_AUTH_FAILED")).toBe(502);
  expect(statusForCode("SSH_PASSPHRASE_REQUIRED")).toBe(504);
  expect(statusForCode("ERROR")).toBe(500);
});

// Regression for the drift the contract centralization fixed: a git action on a missing
// repo used to fall through to code "ERROR" → 500, while every other route returned 404.
test("a git action on an unknown repo is 404 NOT_FOUND, not 500", async () => {
  const res = await createApp(localCfg()).request("/api/repos/does-not-exist/pull", { method: "POST" });
  expect(res.status).toBe(404);
  const j = await res.json();
  expect(j.ok).toBe(false);
  expect(j.code).toBe("NOT_FOUND");
});

test("every error route now emits the { ok, code, message } envelope", async () => {
  // A bad reorder body — formerly a bare { error } body, now the standard envelope.
  const res = await createApp(localCfg()).request("/api/repos/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: "not-an-array" }),
  });
  expect(res.status).toBe(400);
  const j = await res.json();
  expect(j.ok).toBe(false);
  expect(j.code).toBe("BAD_REQUEST");
  expect(typeof j.message).toBe("string");
});
