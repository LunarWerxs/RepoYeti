/**
 * parseBody must not conflate a garbled/truncated body with an empty one.
 *
 * The helper used to be `c.req.json().catch(() => ({}))`, so a JSON-parse failure (a short read
 * from a dropped tunnel connection, a truncated upload) collapsed to `{}`. Because every field of
 * SettingsUpdateSchema is optional, `safeParse({})` then SUCCEEDS and the route answers `{ok:true}`
 * while changing nothing — the dashboard's optimistic update sticks even though the daemon ignored
 * the request. Only a genuinely empty body may be treated as `{}`.
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

test("parseBody: malformed JSON is rejected as BAD_REQUEST, not silently treated as {}", async () => {
  const app = createApp(localCfg());

  // Baseline: turn remote editing off with a well-formed body.
  await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remoteEditing: false }),
  });

  // A body that stops mid-object — exactly what a truncated POST looks like to the daemon. If the
  // old catch-to-{} behavior were still here this would flip remoteEditing back to true.
  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: '{"remoteEditing": tru',
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.code).toBe("BAD_REQUEST");

  // And nothing from the truncated body reached config.
  const status = await (await app.request("/api/status")).json();
  expect(status.remoteEditing).toBe(false);
});

test("parseBody: a genuinely empty body still parses as {} (all-optional route succeeds)", async () => {
  const app = createApp(localCfg());

  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "",
  });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
});
