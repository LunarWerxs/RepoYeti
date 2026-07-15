/**
 * The SSE filter for share-link guests.
 *
 * This covers what was the widest hole in the whole feature. `bus.broadcast()` hands one identical
 * payload to every listener with no idea who's listening, and the daemon puts far more than repo
 * state on that bus: `settings_changed` carries the owner's tunnel + MCP config, `daemon_status`
 * carries the tunnel URL, `scan_*` narrates a sweep of their disks, `approval_pending` narrates
 * their agent traffic, and `repo_added` carries the absolute path of a repo the guest may have no
 * business knowing exists. A guest subscribed to the raw bus would have received all of it, live.
 *
 * These test guestEventData() directly rather than through a live SSE stream: it's the pure
 * function where every filtering decision actually lives, so it can be pinned exhaustively without
 * the flake of racing a stream. The wiring itself (that the /api/events listener calls it at all)
 * is one assertion at the bottom.
 */
import { test, expect, beforeAll } from "bun:test";
import { $ } from "bun";
import { initDb, createShare, type Share } from "../src/db.ts";
import { hashToken, mintToken } from "../src/share/index.ts";
import { guestEventData } from "../src/share/events.ts";
import { redactRemoteUrl, guestRepoView } from "../src/share/redact.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";

let inScope = "";
let outOfScope = "";
let share: Share;
let allShare: Share;

/** A real git repo. See tests/share-gate.test.ts's gitRepo() for why the `git init` is load-bearing
 *  and not decoration: `.testtmp/` sits inside THIS repository, so a fixture that isn't itself a git
 *  repo makes git walk up and operate on RepoYeti itself. Nothing here runs a mutating git op, but
 *  the fixtures are built correctly anyway — the next person to add one shouldn't inherit a trap. */
async function gitRepo(name: string): Promise<string> {
  const dir = mkScratchDir(`share-events-${name}-`);
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email seed@example.com`.quiet();
  return mustUpsertRepo(dir, name, "pinned", false);
}

beforeAll(async () => {
  initDb();
  inScope = await gitRepo("in-scope");
  outOfScope = await gitRepo("out-of-scope");
  share = createShare(hashToken(mintToken()), {
    label: "scoped",
    perm: "view",
    scopeAll: false,
    repoIds: [inScope],
    expiresAt: null,
  });
  allShare = createShare(hashToken(mintToken()), {
    label: "everything",
    perm: "view",
    scopeAll: true,
    repoIds: [],
    expiresAt: null,
  });
});

// ── the owner-plane events a guest must never see ────────────────────────────────

test("owner-plane events are dropped entirely", () => {
  // Each of these was verified to be a real broadcast in the daemon (grep for `broadcast(`), and
  // each would tell a guest something about the owner's machine or configuration.
  const forbidden: Array<[string, unknown]> = [
    ["settings_changed", { tunnel: { hostname: "app.repoyeti.com" }, mcpApprovalGate: false }],
    ["settings_changed", { defaultEditor: "code" }],
    ["daemon_status", { tunnelUrl: "https://secret.trycloudflare.com", tunnelActive: true }],
    ["scan_started", { scope: "machine", roots: 4 }],
    ["scan_progress", { found: 120, added: 3 }],
    ["scan_done", { found: 120, added: 3, cancelled: false }],
    ["ai_key_invalid", { provider: "groq", label: "Groq" }],
    ["approval_pending", { id: "x", tool: "commit", repo: "some-repo" }],
    ["approval_resolved", { id: "x", tool: "commit", outcome: "approved" }],
    ["identity_rules_changed", { rules: [{ glob: "/work/**", identityId: "i1" }] }],
    ["auto_update_applying", { from: "abc", to: "def" }],
    ["auto_update_restarting", { message: "restarting" }],
    ["repo_identity_changed", { id: inScope, identityId: "i1" }],
    ["repo_account_changed", { id: inScope, host: "github.com", login: "someone" }],
    ["repo_hidden_changed", { id: inScope, hidden: true }],
    ["repo_pinned_changed", { id: inScope, pinned: true }],
    ["repo_starred_changed", { id: inScope, starred: true }],
    ["repo_auto_commit_changed", { id: inScope, autoCommit: true }],
  ];
  for (const [event, payload] of forbidden) {
    expect(guestEventData(share, event, payload), `${event} must not reach a guest`).toBeNull();
  }
});

test("an unknown event is dropped (the allowlist default)", () => {
  // The point of the whole design: an event added next year is invisible to guests until someone
  // decides otherwise.
  expect(guestEventData(share, "some_future_event", { id: inScope, secret: "x" })).toBeNull();
});

// ── scope ────────────────────────────────────────────────────────────────────────

test("repo_state_changed passes for an in-scope repo, drops for an out-of-scope one", () => {
  expect(guestEventData(share, "repo_state_changed", { id: inScope, status: null })).not.toBeNull();
  expect(guestEventData(share, "repo_state_changed", { id: outOfScope, status: null })).toBeNull();
});

test("repo_removed is scoped too", () => {
  expect(guestEventData(share, "repo_removed", { id: inScope })).not.toBeNull();
  expect(guestEventData(share, "repo_removed", { id: outOfScope })).toBeNull();
});

test("a multi-repo event is filtered element-wise, not all-or-nothing", () => {
  // The subtle one: `{repos:[…]}` events would otherwise leak every OTHER repo's id + name just
  // because one repo in the batch happened to be in scope.
  const data = guestEventData(share, "repo_synced", {
    repos: [
      { id: inScope, name: "in-scope", pulled: 2 },
      { id: outOfScope, name: "out-of-scope", pulled: 9 },
    ],
  });
  expect(data).not.toBeNull();
  const parsed = JSON.parse(data!) as { repos: Array<{ id: string }> };
  expect(parsed.repos).toHaveLength(1);
  expect(parsed.repos[0]!.id).toBe(inScope);
  expect(data).not.toContain("out-of-scope");
});

test("a multi-repo event with nothing in scope is dropped, not sent empty", () => {
  // An empty `{repos:[]}` would still tell the guest "a sync just happened on repos you can't see".
  expect(
    guestEventData(share, "repo_behind", { repos: [{ id: outOfScope, name: "out-of-scope" }] }),
  ).toBeNull();
});

test("every multi-repo event type is filtered", () => {
  for (const event of ["repo_synced", "repo_behind", "repo_auto_committed", "repo_auto_commit_blocked"]) {
    const out = guestEventData(share, event, { repos: [{ id: outOfScope, name: "out-of-scope" }] });
    expect(out, `${event} leaked an out-of-scope repo`).toBeNull();
  }
});

test("repo_added reaches an all-repos share, but never a per-repo one", () => {
  const repo = { id: "new-1", name: "brand-new", absPath: "/x/y", status: null };
  // A per-repo link was granted a fixed list; a new clone must not silently widen it.
  expect(guestEventData(share, "repo_added", { repo })).toBeNull();
  expect(guestEventData(allShare, "repo_added", { repo })).not.toBeNull();
});

// ── credential redaction ─────────────────────────────────────────────────────────

test("a live event never carries a credential embedded in the remote URL", () => {
  // RepoStatus.remote is whatever `git remote -v` printed. If the owner's origin embeds a PAT,
  // it would ride this event straight to the guest.
  const data = guestEventData(share, "repo_state_changed", {
    id: inScope,
    status: { branch: "main", remote: "https://someone:ghp_SUPERSECRET@github.com/o/r.git", dirty: 1 },
  });
  expect(data).not.toBeNull();
  expect(data).not.toContain("ghp_SUPERSECRET");
  expect(data).toContain("https://github.com/o/r.git");
});

test("redactRemoteUrl strips credentials without mangling ordinary remotes", () => {
  // http(s): the userinfo IS the credential, in both its forms.
  expect(redactRemoteUrl("https://u:ghp_x@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  expect(redactRemoteUrl("https://ghp_token@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  expect(redactRemoteUrl("http://u:p@internal.example/o/r.git")).toBe("http://internal.example/o/r.git");
  // Nothing to strip — must round-trip untouched.
  expect(redactRemoteUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  expect(redactRemoteUrl(null)).toBeNull();
  // ssh: "git" is the ACCOUNT NAME, not a secret. Stripping it would corrupt the remote into one
  // that doesn't work — the guest is shown a URL, and it should be the real one.
  expect(redactRemoteUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git"); // scp-like
  expect(redactRemoteUrl("ssh://git@github.com/o/r.git")).toBe("ssh://git@github.com/o/r.git");
  // ...but an ssh URL carrying a password still loses the password.
  expect(redactRemoteUrl("ssh://user:hunter2@host/o/r.git")).toBe("ssh://user@host/o/r.git");
});

test("guestRepoView drops the owner's credential bookkeeping + private flags", () => {
  const view = guestRepoView({
    id: "r1",
    name: "n",
    absPath: "/x",
    source: "pinned",
    vcs: "git",
    isSubmodule: false,
    identityId: "identity-secret",
    syncAccountHost: "github.com",
    syncAccountLogin: "owner-login",
    hidden: true,
    pinned: true,
    starred: true,
    autoCommit: true,
    status: { branch: "main", detached: false, dirty: 0, ahead: 0, behind: 0, remote: "https://u:p@h/r.git", error: null, fetchedAt: null, updatedAt: 0 },
    updatedAt: 0,
  });
  expect(view.identityId).toBeNull();
  expect(view.syncAccountHost).toBeNull();
  expect(view.syncAccountLogin).toBeNull();
  expect(view.autoCommit).toBe(false);
  expect(view.status!.remote).toBe("https://h/r.git");
  expect(JSON.stringify(view)).not.toContain("owner-login");
});

// ── wiring ───────────────────────────────────────────────────────────────────────

test("bus.broadcast hands listeners the pre-serialized payload AND the raw object", async () => {
  // The SSE filter needs the object (to rewrite a repos array); every other listener wants the
  // string. Both are delivered, so no listener pays to parse what broadcast already serialized.
  const { addListener, removeListener, broadcast } = await import("../src/bus.ts");
  const seen: Array<{ event: string; data: string; payload: unknown }> = [];
  const l = (event: string, data: string, payload: unknown) => seen.push({ event, data, payload });
  addListener(l);
  broadcast("repo_state_changed", { id: "r1", status: null });
  removeListener(l);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.data).toBe(JSON.stringify({ id: "r1", status: null }));
  expect(seen[0]!.payload).toEqual({ id: "r1", status: null });
});
