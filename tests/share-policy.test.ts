/**
 * The drift guard for the share-link capability policy.
 *
 * This is the most important test in the share feature, and it tests a PROCESS, not a behaviour.
 * The guest gate default-denies, so a route nobody classified is already safe — the danger isn't
 * that an unclassified route leaks, it's that nobody NOTICES it exists. Six months from now
 * someone adds `POST /api/repos/:id/nuke`, never thinks about share links, and the feature quietly
 * grows a hole (or, more likely, quietly fails to work and someone "fixes" it by loosening the
 * gate). So: every route on the live Hono table must appear in exactly one of policy.ts's two
 * lists. Adding a route without deciding is a failing test, with a message that says what to do.
 *
 * It walks `app.routes` — the live truth — and NOT openapi.ts's META, which looks like the registry
 * but isn't: buildOpenApiDoc() emits a fallback entry for anything missing, so META's own drift
 * guard passes while META silently lacks ~11 real routes.
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import { GUEST_ROUTES, OWNER_ONLY, policyFor, permSatisfies } from "../src/share/policy.ts";
import type { RepoYetiConfig } from "../src/config.ts";

// REPOYETI_HOME + the scratch root come from tests/setup.ts (bunfig preload).
const cfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200, mode: "remote" });

/** Every real operation on the live router: "METHOD /hono/path", middleware + catch-all removed. */
function liveRoutes(): string[] {
  const app = createApp(cfg());
  const seen = new Set<string>();
  for (const r of app.routes) {
    if (r.method === "ALL") continue; // middleware
    if (r.path === "/*" || r.path === "*") continue; // static PWA catch-all
    if (r.path.startsWith("/oauth/")) continue; // the sign-in dance; never guest-reachable
    if (r.path.startsWith("/s/")) continue; // share redemption itself — public by design
    seen.add(`${r.method} ${r.path}`);
  }
  return [...seen].sort();
}

test("every live route is consciously classified — guest-allowed or owner-only", () => {
  const guest = new Set(Object.keys(GUEST_ROUTES));
  const owner = new Set(OWNER_ONLY);
  const unclassified = liveRoutes().filter((r) => !guest.has(r) && !owner.has(r));

  expect(
    unclassified,
    `Unclassified route(s) found. A share-link guest cannot reach these (the gate default-denies),\n` +
      `but someone must decide that ON PURPOSE. Add each to exactly one list in src/share/policy.ts:\n` +
      `  • GUEST_ROUTES — a guest may call it (set scoped:true if the path has a :id repo param)\n` +
      `  • OWNER_ONLY   — a guest must never reach it\n\n` +
      `  ${unclassified.join("\n  ")}\n`,
  ).toEqual([]);
});

test("no route is in BOTH lists (a contradiction would silently resolve to allow)", () => {
  const owner = new Set(OWNER_ONLY);
  const both = Object.keys(GUEST_ROUTES).filter((r) => owner.has(r));
  expect(both).toEqual([]);
});

test("neither list names a route that no longer exists", () => {
  const live = new Set(liveRoutes());
  const stale = [...Object.keys(GUEST_ROUTES), ...OWNER_ONLY].filter((r) => !live.has(r));
  expect(stale, `policy.ts names route(s) the router no longer has — delete them:\n  ${stale.join("\n  ")}`).toEqual([]);
});

test("every guest route with a :id repo param is marked scoped", () => {
  // The teeth of the scope check: the gate only verifies the share covers a repo when the route
  // says it names one. A guest-allowed `/api/repos/:id/...` that forgot `scoped: true` would be
  // reachable for EVERY repo on the machine, share scope be damned.
  const unscoped = Object.entries(GUEST_ROUTES)
    .filter(([key, p]) => key.includes("/api/repos/:id") && !p.scoped)
    .map(([key]) => key);
  expect(
    unscoped,
    `Guest route(s) name a repo in the path but aren't marked scoped:true — they'd be callable on\n` +
      `EVERY repo, not just the share's:\n  ${unscoped.join("\n  ")}\n`,
  ).toEqual([]);
});

// ── the matcher itself ──────────────────────────────────────────────────────────

test("policyFor matches a real route and extracts the repo id", () => {
  const m = policyFor("POST", "/api/repos/abc-123/pull");
  expect(m).not.toBeNull();
  expect(m!.policy.need).toBe("control");
  expect(m!.policy.scoped).toBe(true);
  expect(m!.params.id).toBe("abc-123");
});

test("policyFor extracts multiple params", () => {
  const m = policyFor("GET", "/api/repos/r1/commit/deadbeef");
  expect(m!.params).toEqual({ id: "r1", hash: "deadbeef" });
});

test("policyFor returns null for an owner-only route (⇒ deny)", () => {
  expect(policyFor("POST", "/api/shutdown")).toBeNull();
  expect(policyFor("PUT", "/api/settings")).toBeNull();
  expect(policyFor("POST", "/api/shares")).toBeNull();
  expect(policyFor("POST", "/api/repos/abc/discard")).toBeNull();
});

test("policyFor is method-sensitive: GET /file is allowed, PUT /file is not", () => {
  expect(policyFor("GET", "/api/repos/abc/file")).not.toBeNull();
  expect(policyFor("PUT", "/api/repos/abc/file")).toBeNull();
});

test("a path param never swallows a slash (no cross-route matching)", () => {
  // "/api/repos/:id/file" must not match "/api/repos/x/y/file" by letting :id eat "x/y".
  expect(policyFor("GET", "/api/repos/x/y/file")).toBeNull();
});

test("literal dots are escaped, not wildcards", () => {
  // A regex-naive matcher would let "/api/openapi.json" match "/api/openapiXjson".
  expect(policyFor("GET", "/api/repos/abc/commit/h/file")).not.toBeNull();
  expect(policyFor("GET", "/api/reposXabc/changes")).toBeNull();
});

test("permSatisfies: control ⊃ view, view ⊅ control", () => {
  expect(permSatisfies("control", "view")).toBe(true);
  expect(permSatisfies("control", "control")).toBe(true);
  expect(permSatisfies("view", "view")).toBe(true);
  expect(permSatisfies("view", "control")).toBe(false);
});

test("the guest surface stays small and deliberate", () => {
  // Not a real invariant — a tripwire. If this number climbs, someone widened what a share link
  // can reach, and that should be a conscious diff-time conversation, not a silent drift.
  expect(Object.keys(GUEST_ROUTES).length).toBeLessThanOrEqual(24);
});
