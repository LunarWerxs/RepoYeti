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
import { initDb, createShare, setRepoHidden, type Share } from "../src/db.ts";
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
    ["collaboration_snapshots_changed", { snapshots: [] }],
    ["identity_rules_changed", { rules: [{ glob: "/work/**", identityId: "i1" }] }],
    ["auto_update_applying", { from: "abc", to: "def" }],
    ["auto_update_restarting", { message: "restarting" }],
    ["repo_identity_changed", { id: inScope, identityId: "i1" }],
    ["repo_account_changed", { id: inScope, host: "github.com", login: "someone" }],
    // Note this list runs against the PER-REPO `share`. Hiding is owner-plane for that grant: it
    // names the repo outright, so decluttering your own dashboard can't silently revoke a link you
    // handed someone. On an all-repos share hiding IS a scope change and is translated instead —
    // see the repo_hidden_changed tests below. autoCommit is flattened by guestRepoView, so
    // forwarding it would put state on the guest's dashboard its controls can't act on. And
    // pinned/starred deliberately DO reach a guest now, per "the guest dashboard groups by
    // pinned/starred, so those patches must arrive live".
    ["repo_hidden_changed", { id: inScope, hidden: true }],
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

test("the guest dashboard groups by pinned/starred, so those patches must arrive live", () => {
  // guestRepoView keeps both flags (one dashboard, one layout), which makes them live view state:
  // without these events a guest's Pinned section drifts from the owner's until a reload.
  for (const [event, key] of [
    ["repo_pinned_changed", "pinned"],
    ["repo_starred_changed", "starred"],
  ] as const) {
    const out = guestEventData(share, event, { id: inScope, [key]: true });
    expect(out, `${event} must reach a guest`).not.toBeNull();
    expect(out!.event).toBe(event); // forwarded as itself, not translated
    // The payload is an id + a boolean and nothing else — no owner bookkeeping rides along.
    expect(JSON.parse(out!.data)).toEqual({ id: inScope, [key]: true });
    // ...and it is still scoped, like every other single-repo event.
    expect(guestEventData(share, event, { id: outOfScope, [key]: true })).toBeNull();
  }
});

test("a multi-repo event is filtered element-wise, not all-or-nothing", () => {
  // The subtle one: `{repos:[…]}` events would otherwise leak every OTHER repo's id + name just
  // because one repo in the batch happened to be in scope.
  const out = guestEventData(share, "repo_synced", {
    repos: [
      { id: inScope, name: "in-scope", pulled: 2 },
      { id: outOfScope, name: "out-of-scope", pulled: 9 },
    ],
  });
  expect(out).not.toBeNull();
  const parsed = JSON.parse(out!.data) as { repos: Array<{ id: string }> };
  expect(parsed.repos).toHaveLength(1);
  expect(parsed.repos[0]!.id).toBe(inScope);
  expect(out!.data).not.toContain("out-of-scope");
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

// ── hiding a repo scopes it out of an all-repos share ─────────────────────────────

test("allShare: hiding a repo translates repo_hidden_changed into repo_removed", () => {
  // From the guest's side, the owner hiding a repo IS the repo leaving their scope — so a scopeAll
  // share must never forward the owner's private repo_hidden_changed verbatim; it is renamed to
  // the scope-change event a guest actually understands.
  const out = guestEventData(allShare, "repo_hidden_changed", { id: inScope, hidden: true });
  expect(out).not.toBeNull();
  expect(out!.event).toBe("repo_removed");
  expect(JSON.parse(out!.data)).toEqual({ id: inScope });
});

test("allShare: un-hiding a repo translates repo_hidden_changed into repo_added, narrowed like any other guest repo", () => {
  // The un-hide direction is the same translation run in reverse: the repo arriving back on the
  // owner's own dashboard is, for a scopeAll guest, a repo arriving on theirs — and it must go
  // through the same guestRepoView narrowing every other repo_added repo gets, not a raw row that
  // still carries the owner's identity/account bookkeeping.
  const out = guestEventData(allShare, "repo_hidden_changed", { id: inScope, hidden: false });
  expect(out).not.toBeNull();
  expect(out!.event).toBe("repo_added");
  const parsed = JSON.parse(out!.data) as {
    repo: { identityId: string | null; autoCommit: boolean };
  };
  expect(parsed.repo.identityId).toBeNull();
  expect(parsed.repo.autoCommit).toBe(false);
});

test("a per-repo share drops repo_hidden_changed in both directions", () => {
  // That grant names the repo explicitly. Decluttering your own dashboard must not silently
  // revoke a link you deliberately handed someone, so neither hide nor un-hide may translate for
  // a share that isn't scopeAll.
  expect(guestEventData(share, "repo_hidden_changed", { id: inScope, hidden: true })).toBeNull();
  expect(guestEventData(share, "repo_hidden_changed", { id: inScope, hidden: false })).toBeNull();
});

test("allShare: a hidden repo is out of scope for both single-repo and batch events", () => {
  // getSharedRepos/shareCoversRepo (db.ts) already exclude a hidden repo from an all-repos share;
  // this pins that the live event stream honours the same rule instead of leaking the repo through
  // a different code path that forgot to check it.
  setRepoHidden(inScope, true);
  try {
    expect(guestEventData(allShare, "repo_state_changed", { id: inScope, status: null })).toBeNull();
    const out = guestEventData(allShare, "repo_synced", {
      repos: [{ id: inScope, name: "in-scope", pulled: 1 }],
    });
    expect(out).toBeNull(); // the batch's only member is now out of scope ⇒ nothing to send
  } finally {
    setRepoHidden(inScope, false); // other tests in this file still assume inScope is visible
  }
});

test("allShare: repo_added is dropped when the carried repo's own hidden flag is true", () => {
  // An event must not smuggle in what the list won't show: even though the event NAME is
  // repo_added, a payload whose repo is (or just became) hidden is exactly what a scopeAll guest's
  // repo list already excludes — so it gets dropped on the raw flag, before guestRepoView ever
  // flattens it away.
  const hiddenRepo = { id: "hidden-1", name: "hidden-repo", absPath: "/x/y", status: null, hidden: true };
  expect(guestEventData(allShare, "repo_added", { repo: hiddenRepo })).toBeNull();
});

test("allShare: a repo that no longer EXISTS is still covered, so repo_removed survives", () => {
  // The trap in excluding hidden repos from a scopeAll share: shareCoversRepo went from an
  // unconditional `true` to a row lookup, and `repo_removed` is broadcast AFTER the row is deleted
  // (service/repo-mgmt.ts: deleteRepos, then broadcast). A lookup that answered "not covered" for a
  // missing row would therefore swallow the one event that tells the guest's dashboard to drop the
  // card, stranding a dead repo on screen until they reloaded. "Not covered" means deliberately
  // withheld, never merely absent.
  const gone = "definitely-not-a-real-repo-id";
  const out = guestEventData(allShare, "repo_removed", { id: gone });
  expect(out).not.toBeNull();
  expect(out!.event).toBe("repo_removed");
  expect(JSON.parse(out!.data)).toEqual({ id: gone });
});

// ── credential redaction ─────────────────────────────────────────────────────────

test("a live event never carries a credential embedded in the remote URL", () => {
  // RepoStatus.remote is whatever `git remote -v` printed. If the owner's origin embeds a PAT,
  // it would ride this event straight to the guest.
  const out = guestEventData(share, "repo_state_changed", {
    id: inScope,
    status: { branch: "main", remote: "https://someone:ghp_SUPERSECRET@github.com/o/r.git", dirty: 1 },
  });
  expect(out).not.toBeNull();
  expect(out!.data).not.toContain("ghp_SUPERSECRET");
  expect(out!.data).toContain("https://github.com/o/r.git");
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
    displayName: null,
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
  // `hidden` is flattened for a different reason than the rest: the share's scope already decides
  // what a guest sees, and passing it through would blank a share that names a hidden repo.
  expect(view.hidden).toBe(false);
});

test("guestRepoView KEEPS pinned/starred — the guest gets the owner's layout, not a flat list", () => {
  // The regression this pins: flattening both flags didn't hide a secret, it silently downgraded
  // the guest to a different dashboard. RepoList groups on exactly these two, and only labels its
  // catch-all section (and lets you collapse it) when a section exists above it — so with both
  // false a share rendered as one unlabelled, uncollapsible list.
  const base = {
    id: "r1",
    name: "n",
    displayName: null,
    absPath: "/x",
    source: "pinned" as const,
    vcs: "git" as const,
    isSubmodule: false,
    identityId: null,
    syncAccountHost: null,
    syncAccountLogin: null,
    hidden: false,
    autoCommit: false,
    status: null,
    updatedAt: 0,
  };
  expect(guestRepoView({ ...base, pinned: true, starred: false }).pinned).toBe(true);
  expect(guestRepoView({ ...base, pinned: false, starred: true }).starred).toBe(true);
  // ...and an unflagged repo is still unflagged (no accidental promotion into a section).
  const plain = guestRepoView({ ...base, pinned: false, starred: false });
  expect(plain.pinned).toBe(false);
  expect(plain.starred).toBe(false);
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
