/**
 * ⭐ Identity Firewall dashboard routes: GET/PUT /api/identity-rules (src/http/routes/identity-rules.ts).
 * Local mode (no OIDC) → /api/* is ungated, same idiom as approval-routes.test.ts.
 */
import { test, expect, afterEach } from "bun:test";
import { createApp } from "../src/http/app.ts";
import { createIdentity } from "../src/db.ts";
import { setIdentityRulesConfig } from "../src/identity.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const J = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

afterEach(() => setIdentityRulesConfig({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 }));

test("GET /api/identity-rules is empty by default", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/identity-rules");
  expect(res.status).toBe(200);
  expect((await res.json()).rules).toEqual([]);
});

test("PUT /api/identity-rules replaces the rule list and GET reflects it", async () => {
  const cfg = localCfg();
  const app = createApp(cfg);
  const idn = createIdentity({ displayName: "Work", gitUsername: "w", gitEmail: "w@x.io" });

  const rules = [{ pathPattern: "D:/Work/**", requiredIdentityId: idn }];
  const putRes = await app.request("/api/identity-rules", J({ rules }));
  expect(putRes.status).toBe(200);
  expect((await putRes.json()).rules).toEqual(rules);

  const getRes = await app.request("/api/identity-rules");
  expect((await getRes.json()).rules).toEqual(rules);
});

test("PUT /api/identity-rules rejects a rule naming an identity that doesn't exist", async () => {
  const app = createApp(localCfg());
  const res = await app.request(
    "/api/identity-rules",
    J({ rules: [{ pathPattern: "D:/Work/**", requiredIdentityId: "no-such-identity" }] }),
  );
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.code).toBe("NOT_FOUND");
});

test("PUT /api/identity-rules with an empty list clears any existing rules", async () => {
  const cfg = localCfg();
  const app = createApp(cfg);
  const idn = createIdentity({ displayName: "Work", gitUsername: "w", gitEmail: "w@x.io" });
  await app.request("/api/identity-rules", J({ rules: [{ pathPattern: "D:/Work/**", requiredIdentityId: idn }] }));

  const res = await app.request("/api/identity-rules", J({ rules: [] }));
  expect(res.status).toBe(200);
  expect((await res.json()).rules).toEqual([]);
  const getRes = await app.request("/api/identity-rules");
  expect((await getRes.json()).rules).toEqual([]);
});
