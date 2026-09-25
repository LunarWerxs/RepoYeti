import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { auditHurlSuite, loadHurlSuite } from "../scripts/hurl-conformance.ts";

// The black-box Hurl suite (tests/hurl) is only useful while every request in it still names a
// real route: a renamed route would otherwise leave the suite failing on a live host for reasons
// nobody reads as "the API moved". This pins the committed suite to the LIVE routing table, which
// is stricter than the META-based `check:hurl` (a META entry can outlive its route).

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

/** The live OpenAPI doc's operations as `"<METHOD> <hono-path>"` keys. */
async function liveRoutes(): Promise<string[]> {
  const res = await createApp(localCfg()).request("/api/openapi.json");
  const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(doc.paths).flatMap(([path, ops]) =>
    Object.keys(ops).map((verb) => `${verb.toUpperCase()} ${path.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1")}`),
  );
}

test("every request in tests/hurl resolves to a route the running app documents", async () => {
  const audit = auditHurlSuite(loadHurlSuite(), await liveRoutes());
  expect(audit.requests.length).toBeGreaterThan(0);
  expect(audit.drift.map((d) => `${d.request.file}:${d.request.line} ${d.problem}`)).toEqual([]);
});

test("the drift check rejects an undocumented route, a hard-coded host, and a template posing as a literal", () => {
  const documented = ["GET /api/identities/detected", "DELETE /api/identities/:id", "GET /api/repos/:id/log"];
  const text = [
    "GET {{base}}/api/identities/{{identity_id}}", // templated segment cannot stand in for "detected"
    "DELETE {{base}}/api/identities/{{identity_id}}",
    "GET {{base}}/api/repos/hurl-{{uid}}-absent/log?limit=5",
    "GET {{base}}/api/renamed-away",
    "GET http://127.0.0.1:7171/api/identities/detected",
  ].join("\n");
  const audit = auditHurlSuite([{ file: "synthetic.hurl", text }], documented);
  expect(audit.drift.map((d) => d.request.line)).toEqual([1, 4, 5]);
  expect([...audit.covered].sort()).toEqual(["DELETE /api/identities/:id", "GET /api/repos/:id/log"]);
});
