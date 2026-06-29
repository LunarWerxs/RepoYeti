import { test, expect } from "bun:test";
import { createApp } from "../src/daemon.ts";
import type { RepoYetiConfig } from "../src/config.ts";

// Local mode (no OIDC) → /api/* is ungated, so routes are exercised directly.
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("zod rejects a malformed identity body as BAD_REQUEST, naming the bad field", async () => {
  const res = await post(createApp(localCfg()), "/api/identities", {
    displayName: "", // fails the non-empty schema
    gitUsername: "octocat",
    gitEmail: "me@example.com",
  });
  expect(res.status).toBe(400);
  const j = await res.json();
  expect(j.code).toBe("BAD_REQUEST");
  expect(j.message).toContain("displayName");
});

test("zod rejects a wrong-typed reorder body as BAD_REQUEST", async () => {
  const res = await post(createApp(localCfg()), "/api/repos/reorder", { order: [1, 2, 3] });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("BAD_REQUEST");
});

test("a valid identity body passes validation and creates the identity (trimmed)", async () => {
  const res = await post(createApp(localCfg()), "/api/identities", {
    displayName: "  Personal GitHub  ",
    gitUsername: "octocat",
    gitEmail: "me@example.com",
  });
  expect(res.status).toBe(201);
  const j = await res.json();
  expect(j.identity.displayName).toBe("Personal GitHub"); // schema .trim() applied
});
