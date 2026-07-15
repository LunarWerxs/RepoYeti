/**
 * The share-link guest gate, tested adversarially.
 *
 * The question every test here asks is the one the owner is really asking when they paste a link
 * into a chat window: "what, exactly, can the person on the other end of this do to my machine?"
 * So these lean hard on the negative space — what a guest MUST NOT reach — because the positive
 * cases fail loudly during normal use while a gap in the negative space is silent until it isn't.
 *
 * The invariant that matters most is the last section: with no shares minted, every existing auth
 * behaviour is byte-for-byte what it was. A security feature that changes the security of the
 * thing it's bolted to has failed before it shipped.
 */
import { test, expect, beforeAll } from "bun:test";
import { $ } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import { sign } from "../src/auth.ts";
import { initDb, createShare, revokeShare, listShareEvents, type Share } from "../src/db.ts";
import { hashToken, mintToken, GUEST_COOKIE } from "../src/share/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import type { OAuthConfig, RepoYetiConfig } from "../src/config.ts";

const OWNER_OAUTH: OAuthConfig = {
  issuer: "https://accounts.connections.icu",
  clientId: "test-client",
  redirectUri: "https://example.com/cb",
  ownerSub: "owner-sub-123",
  ownerEmail: "owner@example.com",
};

const enforcedCfg = (extra?: Partial<RepoYetiConfig>): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  mode: "remote",
  oauth: { ...OWNER_OAUTH },
  ...extra,
});

/** A request arriving over the tunnel — carries a header true loopback never has. */
const REMOTE = { "cf-connecting-ip": "203.0.113.7" };

function ownerCookie(): string {
  return `gm_session=${sign(JSON.stringify({ sub: "owner-sub-123", email: "owner@example.com", exp: Date.now() + 60_000 }))}`;
}

/** The cookie a guest's browser holds after redeeming a link. */
function guestCookie(share: Share, exp = Date.now() + 3_600_000): string {
  return `${GUEST_COOKIE}=${sign(JSON.stringify({ sid: share.id, exp }))}`;
}

// ── fixtures: two real repos, one shared, one NOT ────────────────────────────────
let sharedRepoId = "";
let secretRepoId = "";

/**
 * A REAL git repo (mirrors tests/approvals.test.ts's gitRepo()), seeded and registered.
 *
 * The `git init` is not a formality — it is the whole point, and getting this wrong does real
 * damage. `mkScratchDir` roots fixtures at `.testtmp/`, which lives INSIDE this very repository
 * (deliberately: upsertRepo refuses paths under the OS temp dir, see helpers/scratch.ts). A fixture
 * dir that is not itself a git repo therefore isn't "not a repo" as far as git is concerned — git
 * walks UP the tree, finds RepoYeti's own .git, and happily runs against it. Tests here call
 * commit/push for real, so a fixture with a hand-made `mkdirSync(".git")` (which git does not
 * recognise as a repository) means `git commit`/`git push` execute against RepoYeti ITSELF.
 * Ask me how I know.
 */
async function gitRepo(name: string): Promise<string> {
  const dir = mkScratchDir(`share-gate-${name}-`);
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email seed@example.com`.quiet();
  writeFileSync(join(dir, "a.txt"), "a0\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
  return mustUpsertRepo(dir, name, "pinned", false);
}

beforeAll(async () => {
  initDb();
  sharedRepoId = await gitRepo("shared-repo");
  secretRepoId = await gitRepo("secret-repo");
});

function mkShare(perm: "view" | "control", opts?: Partial<Parameters<typeof createShare>[1]>): Share {
  return createShare(hashToken(mintToken()), {
    label: `${perm} link`,
    perm,
    scopeAll: false,
    repoIds: [sharedRepoId],
    expiresAt: null,
    ...opts,
  });
}

// ── what a VIEW link may do ──────────────────────────────────────────────────────

test("view guest can list repos — and sees ONLY the shared one", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request("/api/repos", { headers: { ...REMOTE, cookie: guestCookie(mkShare("view")) } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { repos: Array<{ id: string; name: string }> };
  expect(body.repos.map((r) => r.name)).toEqual(["shared-repo"]);
  // The un-shared repo must not appear in ANY form — not its id, path, or name.
  expect(JSON.stringify(body)).not.toContain(secretRepoId);
  expect(JSON.stringify(body)).not.toContain("secret-repo");
});

test("view guest can read the shared repo's changes (the whole point of the link)", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request(`/api/repos/${sharedRepoId}/changes`, {
    headers: { ...REMOTE, cookie: guestCookie(mkShare("view")) },
  });
  expect(res.status).not.toBe(401);
  expect(res.status).not.toBe(403);
  expect(res.status).not.toBe(404);
});

test("view guest CANNOT commit — that's the whole difference between the tiers", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request(`/api/repos/${sharedRepoId}/commit`, {
    method: "POST",
    headers: { ...REMOTE, cookie: guestCookie(mkShare("view")), "content-type": "application/json" },
    body: JSON.stringify({ message: "sneaky" }),
  });
  expect(res.status).toBe(403);
});

// ── scope ────────────────────────────────────────────────────────────────────────

test("a repo outside the share is 404 — indistinguishable from not existing", async () => {
  const app = createApp(enforcedCfg());
  const share = mkShare("control");
  for (const path of [
    `/api/repos/${secretRepoId}/changes`,
    `/api/repos/${secretRepoId}/log`,
    `/api/repos/${secretRepoId}/diff?path=x`,
    `/api/repos/${secretRepoId}/file?path=x`,
  ]) {
    const res = await app.request(path, { headers: { ...REMOTE, cookie: guestCookie(share) } });
    // 404, never 403: a 403 would confirm the repo is real, just off-limits.
    expect(res.status, `GET ${path}`).toBe(404);
  }
});

test("a CONTROL guest cannot push an out-of-scope repo", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request(`/api/repos/${secretRepoId}/push`, {
    method: "POST",
    headers: { ...REMOTE, cookie: guestCookie(mkShare("control")) },
  });
  expect(res.status).toBe(404);
});

test("scopeAll shares every repo — including ones the link never named", async () => {
  const app = createApp(enforcedCfg());
  const share = mkShare("view", { scopeAll: true, repoIds: [] });
  const res = await app.request("/api/repos", { headers: { ...REMOTE, cookie: guestCookie(share) } });
  const body = (await res.json()) as { repos: Array<{ name: string }> };
  const names = body.repos.map((r) => r.name);
  // `contains`, not `equals`: the whole suite shares one DB, so other test files' repos are in
  // here too. That's fine — the point is that scopeAll reaches a repo it never named (secret-repo),
  // which the per-repo shares in this file are proven NOT to.
  expect(names).toContain("shared-repo");
  expect(names).toContain("secret-repo");
});

// ── the owner-only surface, swept ────────────────────────────────────────────────

test("a CONTROL guest is refused EVERY owner-only route", async () => {
  const app = createApp(enforcedCfg({ apiToken: "owner-token" }));
  const cookie = guestCookie(mkShare("control"));
  // The routes that would actually hurt: daemon control, secrets, the owner's config, the agent
  // surface, and share administration itself (a guest minting a link = privilege escalation).
  const forbidden: Array<[string, string]> = [
    ["POST", "/api/shutdown"],
    ["PUT", "/api/settings"],
    ["PUT", "/api/mode"],
    ["PUT", "/api/tunnel"],
    ["POST", "/api/auth/token"],
    ["GET", "/api/auth/token"],
    ["DELETE", "/api/auth/token"],
    ["POST", "/api/auth/logout-all"],
    ["GET", "/api/shares"],
    ["POST", "/api/shares"],
    ["GET", "/api/identities"],
    ["GET", "/api/identities/detected"],
    ["GET", "/api/accounts"],
    ["GET", "/api/roots"],
    ["POST", "/api/roots"],
    ["POST", "/api/scan"],
    ["GET", "/api/editors"],
    ["GET", "/api/ai/settings"],
    ["GET", "/api/ai/catalog"],
    ["POST", "/api/mcp"],
    ["GET", "/api/approvals"],
    ["POST", "/api/updates/apply"],
    ["GET", "/api/settings/sync"],
    ["POST", "/api/repos/register"],
    ["POST", "/api/repos/clone"],
    ["POST", "/api/repos/fetch-all"],
    ["POST", "/api/portable-window"],
  ];
  for (const [method, path] of forbidden) {
    const res = await app.request(path, { method, headers: { ...REMOTE, cookie } });
    expect(res.status, `${method} ${path} must be refused`).toBe(403);
  }
});

test("a guest is refused destructive/config routes even on a repo they CAN see", async () => {
  const app = createApp(enforcedCfg());
  const cookie = guestCookie(mkShare("control"));
  const forbidden: Array<[string, string]> = [
    ["POST", `/api/repos/${sharedRepoId}/discard`], // destroys the owner's uncommitted work
    ["PUT", `/api/repos/${sharedRepoId}/file?path=x`], // edits the owner's working tree
    ["POST", `/api/repos/${sharedRepoId}/move`],
    ["POST", `/api/repos/${sharedRepoId}/gitignore`],
    ["POST", `/api/repos/${sharedRepoId}/checkout`], // switches the branch under the owner
    ["POST", `/api/repos/${sharedRepoId}/stash`],
    ["POST", `/api/repos/${sharedRepoId}/remote`], // re-points where pushes go
    ["DELETE", `/api/repos/${sharedRepoId}/remote`],
    ["POST", `/api/repos/${sharedRepoId}/identity`],
    ["POST", `/api/repos/${sharedRepoId}/account`],
    ["POST", `/api/repos/${sharedRepoId}/auto-commit`], // arms an unattended push timer
    ["POST", `/api/repos/${sharedRepoId}/open`], // launches a process on the owner's desktop
    ["POST", `/api/repos/${sharedRepoId}/hidden`],
  ];
  for (const [method, path] of forbidden) {
    const res = await app.request(path, { method, headers: { ...REMOTE, cookie } });
    expect(res.status, `${method} ${path} must be refused`).toBe(403);
  }
});

test("a CONTROL guest can commit, but CANNOT amend", async () => {
  // The one capability distinction the route-level policy can't draw: commit and amend are the
  // same route, split only by a body flag. Amend rewrites the previous commit — possibly the
  // owner's own, unrelated work — which is history editing, not the sync loop the tier grants.
  const app = createApp(enforcedCfg());
  const cookie = guestCookie(mkShare("control"));
  const res = await app.request(`/api/repos/${sharedRepoId}/commit`, {
    method: "POST",
    headers: { ...REMOTE, cookie, "content-type": "application/json" },
    body: JSON.stringify({ message: "rewriting your history", amend: true }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe("FORBIDDEN");

  // ...while a plain commit gets past the gate (it fails later on the fixture's empty tree, but
  // NOT with 401/403/404 — proving the gate admitted it).
  const plain = await app.request(`/api/repos/${sharedRepoId}/commit`, {
    method: "POST",
    headers: { ...REMOTE, cookie, "content-type": "application/json" },
    body: JSON.stringify({ message: "an honest commit" }),
  });
  expect([401, 403, 404]).not.toContain(plain.status);
});

test("the OWNER can still amend (the guard is about guests, not about amend)", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request(`/api/repos/${sharedRepoId}/commit`, {
    method: "POST",
    headers: { ...REMOTE, cookie: ownerCookie(), "content-type": "application/json" },
    body: JSON.stringify({ message: "fixing my own typo", amend: true }),
  });
  expect(res.status).not.toBe(403);
});

// ── liveness: revoke + expiry ────────────────────────────────────────────────────

test("revoking a link kills it on the guest's very next request", async () => {
  const app = createApp(enforcedCfg());
  const share = mkShare("view");
  const cookie = guestCookie(share);

  const before = await app.request("/api/repos", { headers: { ...REMOTE, cookie } });
  expect(before.status).toBe(200);

  revokeShare(share.id);

  // Same cookie, still perfectly signed and unexpired — and now worthless. This is why the share
  // is re-read from SQLite on every request instead of being baked into the cookie.
  const after = await app.request("/api/repos", { headers: { ...REMOTE, cookie } });
  expect(after.status).toBe(401);
});

test("an expired link is dead even with a fresh cookie", async () => {
  const app = createApp(enforcedCfg());
  const share = mkShare("view", { expiresAt: Date.now() - 1000 });
  const res = await app.request("/api/repos", { headers: { ...REMOTE, cookie: guestCookie(share) } });
  expect(res.status).toBe(401);
});

test("a cookie outliving its own exp is refused", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request("/api/repos", {
    headers: { ...REMOTE, cookie: guestCookie(mkShare("view"), Date.now() - 1000) },
  });
  expect(res.status).toBe(401);
});

// ── forgery ──────────────────────────────────────────────────────────────────────

test("an unsigned / forged guest cookie is refused", async () => {
  const app = createApp(enforcedCfg());
  const share = mkShare("control");
  for (const cookie of [
    `${GUEST_COOKIE}=${share.id}`, // raw id, no signature
    `${GUEST_COOKIE}=${Buffer.from(JSON.stringify({ sid: share.id, exp: Date.now() + 9e6 })).toString("base64url")}.deadbeef`,
    `${GUEST_COOKIE}=garbage`,
  ]) {
    const res = await app.request("/api/repos", { headers: { ...REMOTE, cookie } });
    expect(res.status, cookie.slice(0, 40)).toBe(401);
  }
});

test("a signed cookie naming a share that doesn't exist is refused", async () => {
  const app = createApp(enforcedCfg());
  const cookie = `${GUEST_COOKIE}=${sign(JSON.stringify({ sid: "no-such-share", exp: Date.now() + 9e6 }))}`;
  const res = await app.request("/api/repos", { headers: { ...REMOTE, cookie } });
  expect(res.status).toBe(401);
});

// ── redemption ───────────────────────────────────────────────────────────────────

test("GET /s/<token> redeems: sets a cookie and redirects", async () => {
  const app = createApp(enforcedCfg());
  const token = mintToken();
  createShare(hashToken(token), {
    label: "brother",
    perm: "view",
    scopeAll: false,
    repoIds: [sharedRepoId],
    expiresAt: null,
  });
  const res = await app.request(`/s/${token}`, { headers: REMOTE });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  expect(res.headers.get("set-cookie") ?? "").toContain(GUEST_COOKIE);
});

test("unknown, revoked, and expired links are INDISTINGUISHABLE to whoever holds them", async () => {
  // The real non-disclosure property, tested as such: a stranger who tries a link must not be able
  // to tell "never existed" from "existed and was revoked" — the latter confirms a real link, which
  // is a signal worth having if you're guessing at URLs or you found one in someone's chat history.
  // The page's copy is deliberately ambiguous ("may have expired or been turned off"); what makes
  // that true rather than decorative is that all three cases produce the exact same response.
  const app = createApp(enforcedCfg());
  const mk = (label: string, expiresAt: number | null) => {
    const token = mintToken();
    const share = createShare(hashToken(token), {
      label,
      perm: "view",
      scopeAll: false,
      repoIds: [sharedRepoId],
      expiresAt,
    });
    return { token, share };
  };
  const revoked = mk("revoked", null);
  revokeShare(revoked.share.id);
  const expired = mk("expired", Date.now() - 1000);

  const responses = await Promise.all(
    ["not-a-real-token-at-all", revoked.token, expired.token].map(async (t) => {
      const res = await app.request(`/s/${t}`, { headers: REMOTE });
      return { status: res.status, cookie: res.headers.get("set-cookie"), body: await res.text() };
    }),
  );
  for (const r of responses) {
    expect(r.status).toBe(404);
    expect(r.cookie).toBeNull(); // no credential is ever issued for a dead link
  }
  // Byte-identical: nothing in the response distinguishes the three.
  expect(responses[1]!.body).toBe(responses[0]!.body);
  expect(responses[2]!.body).toBe(responses[0]!.body);
});

// ── disclosure ───────────────────────────────────────────────────────────────────

test("GET /api/status tells a guest nothing about the owner's setup", async () => {
  const app = createApp(
    enforcedCfg({ defaultEditor: "code", autoCommit: true, tunnel: { hostname: "app.repoyeti.com" } }),
  );
  const res = await app.request("/api/status", { headers: { ...REMOTE, cookie: guestCookie(mkShare("view")) } });
  expect(res.status).toBe(200);
  const raw = await res.text();
  for (const leak of ["app.repoyeti.com", "defaultEditor", "mcpApprovalGate", "autoCommitAt", "hideTrayIcon", "aiKeyInvalid"]) {
    expect(raw, `/api/status leaked ${leak} to a guest`).not.toContain(leak);
  }
  const body = JSON.parse(raw) as { remoteEditing: boolean; share: { perm: string } };
  expect(body.remoteEditing).toBe(false); // a guest can't write files; the editor must be read-only
  expect(body.share.perm).toBe("view");
});

test("GET /api/auth/status gives a guest no owner identity", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request("/api/auth/status", {
    headers: { ...REMOTE, cookie: guestCookie(mkShare("control")) },
  });
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.authenticated).toBe(true); // they hold a live credential → dashboard, not sign-in gate
  expect(body.owner).toBeNull();
  expect(body.ownerPicture).toBeNull();
  expect(JSON.stringify(body)).not.toContain("owner@example.com");
  expect((body.share as { perm: string }).perm).toBe("control");
});

// ── audit ────────────────────────────────────────────────────────────────────────

test("a guest's refused mutation is recorded against their link", async () => {
  const app = createApp(enforcedCfg());
  const share = mkShare("view");
  await app.request(`/api/repos/${sharedRepoId}/push`, {
    method: "POST",
    headers: { ...REMOTE, cookie: guestCookie(share) },
  });
  const events = listShareEvents(share.id);
  expect(events.length).toBeGreaterThan(0);
  expect(events[0]!.outcome).toBe("denied");
  expect(events[0]!.action).toContain("/push");
});

// ── the load-bearing invariant: owner behaviour is untouched ─────────────────────

test("with NO shares, every auth behaviour is exactly as before", async () => {
  const app = createApp(enforcedCfg());
  // anonymous over the tunnel → 401, as always
  expect((await app.request("/api/repos", { headers: REMOTE })).status).toBe(401);
  // owner session → through
  expect((await app.request("/api/repos", { headers: { ...REMOTE, cookie: ownerCookie() } })).status).toBe(200);
});

test("the owner keeps full access while shares exist", async () => {
  const app = createApp(enforcedCfg());
  mkShare("view");
  const cookie = ownerCookie();
  // The owner still sees EVERY repo, not a share's subset...
  const repos = await app.request("/api/repos", { headers: { ...REMOTE, cookie } });
  const body = (await repos.json()) as { repos: Array<{ name: string }> };
  expect(body.repos.length).toBeGreaterThanOrEqual(2);
  // ...and still reaches owner-only routes.
  expect((await app.request("/api/shares", { headers: { ...REMOTE, cookie } })).status).toBe(200);
});

test("owner wins when a browser holds BOTH an owner session and a guest cookie", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request("/api/shares", {
    headers: { ...REMOTE, cookie: `${ownerCookie()}; ${guestCookie(mkShare("view"))}` },
  });
  // Owner-only route, reached with a view-tier guest cookie also present: the owner must win,
  // never the lesser principal.
  expect(res.status).toBe(200);
});

// ── "owner wins" must hold in the PROJECTIONS too, not just the gate ─────────────
// Regression: the gate checked the owner first, but the handlers that PROJECT (/api/repos,
// /api/status, /api/auth/status, the SSE filter) asked only "is there a share cookie?". So the
// moment the owner clicked their own link to check it — the first thing anyone does after minting
// one — their own dashboard silently degraded to that link's narrow view: their other repos
// vanished, their settings blanked. It restricted rather than granted, so it was never a security
// hole; it just looked exactly like data loss. See auth.ts effectiveGuest().

test("owner + guest cookie: /api/repos still shows the owner EVERY repo", async () => {
  const app = createApp(enforcedCfg());
  const cookie = `${ownerCookie()}; ${guestCookie(mkShare("view"))}`; // share scoped to sharedRepoId only
  const res = await app.request("/api/repos", { headers: { ...REMOTE, cookie } });
  const body = (await res.json()) as { repos: Array<{ name: string }> };
  const names = body.repos.map((r) => r.name);
  expect(names).toContain("shared-repo");
  expect(names).toContain("secret-repo"); // NOT in the share — but this caller is the owner
});

test("owner + guest cookie: /api/status is still the full owner dump, not the projection", async () => {
  const app = createApp(enforcedCfg({ defaultEditor: "code" }));
  const cookie = `${ownerCookie()}; ${guestCookie(mkShare("view"))}`;
  const res = await app.request("/api/status", { headers: { ...REMOTE, cookie } });
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.share).toBeUndefined(); // the owner is not a guest
  expect(body.defaultEditor).toBe("code"); // owner-only field still present
});

test("owner + guest cookie: /api/auth/status reports the owner, with no share", async () => {
  const app = createApp(enforcedCfg());
  const cookie = `${ownerCookie()}; ${guestCookie(mkShare("control"))}`;
  const res = await app.request("/api/auth/status", { headers: { ...REMOTE, cookie } });
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.share).toBeNull();
  expect(body.owner).toBe("owner@example.com");
});

test("local bypass + guest cookie: still the OWNER (the desk-side preview case)", async () => {
  // The likeliest shape of the bug in real life: the owner is on 127.0.0.1 in remote mode using
  // "Continue local for now", and clicks their own share link. No owner SESSION exists — only the
  // bypass — so a session-only check would have called them a guest on their own machine.
  const app = createApp(enforcedCfg());
  const localBypass = sign(JSON.stringify({ exp: Date.now() + 60_000 }));
  const cookie = `gm_local=${localBypass}; ${guestCookie(mkShare("view"))}`;
  const res = await app.request("/api/repos", { headers: { cookie } }); // no cf-connecting-ip → loopback
  const names = ((await res.json()) as { repos: Array<{ name: string }> }).repos.map((r) => r.name);
  expect(names).toContain("secret-repo"); // sees beyond the share ⇒ treated as the owner
});

test("a guest cookie grants nothing when the daemon has no OIDC configured (gate off)", async () => {
  // authEnforced=false means the daemon is loopback-only and fully open; the guest path must not
  // be what changes that, in either direction.
  const app = createApp({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200, mode: "local" });
  const res = await app.request("/api/repos", { headers: { cookie: guestCookie(mkShare("view")) } });
  expect(res.status).toBe(200);
});
