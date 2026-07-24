/**
 * Which GitHub account a repo syncs as, and how that credential reaches git.
 *
 * The bug this covers: `gh auth git-credential` serves ONLY gh's active account. A repo whose git
 * config names a different (but perfectly authenticated) account made git demand a credential gh
 * would not hand over, and the push died with "could not read Password" — naming an account that
 * `gh auth status` listed as logged in two lines up. So the resolution order below is the fix, and
 * the credential-injection shape is what lets a non-active account be used WITHOUT flipping the
 * machine's active account out from under every other tool.
 *
 * The security-critical assertion here is that the token never reaches argv: a `-c` flag is visible
 * to any process that can list processes, so the helper must reference the env var BY NAME.
 */
import { test, expect } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";
import { mkScratchDir } from "./helpers/scratch.ts";
import {
  resolveRepoAccount,
  githubRepository,
  remoteOwner,
  operativeRemoteUrl,
  authForRepo,
  authForCloneUrl,
} from "../src/gh-account.ts";
import { credentialConfigArgs, credentialEnv, gitHubAuth, GH_TOKEN_ENV } from "../src/git.ts";
import { isValidLogin, type GhAccount } from "../src/gh-cli.ts";
import { classify } from "../src/git-actions/sync.ts";
import type { RepoView } from "../src/db.ts";

const acct = (login: string, active = false): GhAccount => ({
  host: "github.com",
  login,
  active,
  gitProtocol: "https",
  scopes: ["repo"],
});

const ACCOUNTS = [acct("lunawerx", true), acct("L0garithmic"), acct("LunarWerxs")];

/** A real on-disk git repo, so resolveRepoAccount reads genuine git config rather than a stub. */
async function scratchRepo(cfg: Record<string, string> = {}): Promise<string> {
  const dir = join(mkScratchDir("gm-ghacct-"), "repo");
  await $`git init -q ${dir}`.quiet();
  for (const [k, v] of Object.entries(cfg)) await $`git -C ${dir} config ${k} ${v}`.quiet();
  return dir;
}

const repoAt = (absPath: string, over: Partial<RepoView> = {}): RepoView =>
  ({
    id: "r1",
    name: "repo",
    displayName: null,
    absPath,
    source: "pinned",
    vcs: "git",
    isSubmodule: false,
    identityId: null,
    syncAccountHost: null,
    syncAccountLogin: null,
    hidden: false,
    pinned: false,
    starred: false,
    autoCommit: false,
    status: null,
    updatedAt: 0,
    ...over,
  }) as unknown as RepoView;

// ── remoteOwner ─────────────────────────────────────────────────────────────────────

test("remoteOwner reads the owner from every remote form we might meet", () => {
  expect(remoteOwner("https://github.com/L0garithmic/pap3r.git")).toBe("L0garithmic");
  // The embedded-username form — exactly what the failing error message displayed.
  expect(remoteOwner("https://L0garithmic@github.com/L0garithmic/pap3r.git")).toBe("L0garithmic");
  expect(remoteOwner("git@github.com:Lunarwerx/askarr.git")).toBe("Lunarwerx");
  expect(remoteOwner("ssh://git@github.com/Lunarwerx/askarr.git")).toBe("Lunarwerx");
});

test("remoteOwner ignores hosts that aren't GitHub", () => {
  expect(remoteOwner("https://gitlab.com/someone/thing.git")).toBeNull();
  expect(remoteOwner("https://evil.com/github.com/spoof/x.git")).toBeNull();
  expect(remoteOwner("not a url")).toBeNull();
});

test("githubRepository extracts the owner and repository needed for a permission probe", () => {
  expect(githubRepository("https://github.com/Lunarwerx/connections.git")).toEqual({
    host: "github.com",
    owner: "Lunarwerx",
    repo: "connections",
  });
  expect(githubRepository("git@github.com:LunarWerxs/RepoYeti.git")).toEqual({
    host: "github.com",
    owner: "LunarWerxs",
    repo: "RepoYeti",
  });
});

// ── resolution order ────────────────────────────────────────────────────────────────

test("an explicit pin wins over everything the repo says about itself", async () => {
  const dir = await scratchRepo({
    "credential.https://github.com.username": "L0garithmic",
    "remote.origin.url": "https://github.com/L0garithmic/pap3r.git",
  });
  const r = await resolveRepoAccount(repoAt(dir, { syncAccountLogin: "LunarWerxs" }), ACCOUNTS);
  expect(r).toEqual({ host: "github.com", login: "LunarWerxs", source: "pinned" });
});

test("with no pin, the repo's OWN credential username is used — the case that used to fail", async () => {
  const dir = await scratchRepo({
    "credential.https://github.com.username": "L0garithmic",
    "remote.origin.url": "https://github.com/L0garithmic/pap3r.git",
  });
  const r = await resolveRepoAccount(repoAt(dir), ACCOUNTS);
  expect(r).toEqual({ host: "github.com", login: "L0garithmic", source: "gitconfig" });
});

test("with neither, a personal remote's owner is used when we hold that account", async () => {
  const dir = await scratchRepo({ "remote.origin.url": "https://github.com/LunarWerxs/thing.git" });
  const r = await resolveRepoAccount(repoAt(dir), ACCOUNTS);
  expect(r).toEqual({ host: "github.com", login: "LunarWerxs", source: "remote" });
});

test("a credential username we have no account for is ignored, not guessed at", async () => {
  // Installing a helper for an account gh can't authenticate as would turn a working ambient
  // credential into a hard failure — falling through is the safe direction.
  const dir = await scratchRepo({
    "credential.https://github.com.username": "somebody-else",
    "remote.origin.url": "https://github.com/somebody-else/thing.git",
  });
  expect(await resolveRepoAccount(repoAt(dir), ACCOUNTS)).toBeNull();
});

test("an org remote resolves to the unique signed-in account with push access", async () => {
  const dir = await scratchRepo({ "remote.origin.url": "https://github.com/Lunarwerx/askarr.git" });
  const checked: string[] = [];
  const r = await resolveRepoAccount(repoAt(dir), ACCOUNTS, async (account) => {
    checked.push(account.login);
    return account.login === "lunawerx";
  });
  expect(checked).toEqual(["lunawerx", "L0garithmic", "LunarWerxs"]);
  expect(r).toEqual({ host: "github.com", login: "lunawerx", source: "permission" });
});

test("when several accounts can push, the active writable account is the deterministic choice", async () => {
  const dir = await scratchRepo({ "remote.origin.url": "https://github.com/Lunarwerx/askarr.git" });
  const r = await resolveRepoAccount(
    repoAt(dir),
    ACCOUNTS,
    async (account) => account.login === "lunawerx" || account.login === "L0garithmic",
  );
  expect(r).toEqual({ host: "github.com", login: "lunawerx", source: "permission" });
});

test("several writable non-active accounts remain ambiguous rather than being guessed", async () => {
  const dir = await scratchRepo({ "remote.origin.url": "https://github.com/Lunarwerx/askarr.git" });
  const r = await resolveRepoAccount(
    repoAt(dir),
    ACCOUNTS,
    async (account) => account.login === "L0garithmic" || account.login === "LunarWerxs",
  );
  expect(r).toBeNull();
});

test("an org remote resolves to nothing when no signed-in account has push access", async () => {
  const dir = await scratchRepo({ "remote.origin.url": "https://github.com/Lunarwerx/askarr.git" });
  expect(await resolveRepoAccount(repoAt(dir), ACCOUNTS, async () => false)).toBeNull();
});

test("a repo with no remote and no pin resolves to nothing", async () => {
  expect(await resolveRepoAccount(repoAt(await scratchRepo()), ACCOUNTS)).toBeNull();
});

test("a non-git repo is never interrogated for git config", async () => {
  const dir = await scratchRepo({ "remote.origin.url": "https://github.com/LunarWerxs/x.git" });
  expect(await resolveRepoAccount(repoAt(dir, { vcs: "lore" } as Partial<RepoView>), ACCOUNTS)).toBeNull();
});

test("matching is case-insensitive but reports gh's own spelling", async () => {
  const dir = await scratchRepo({ "credential.https://github.com.username": "l0GARITHMIC" });
  const r = await resolveRepoAccount(repoAt(dir), ACCOUNTS);
  expect(r?.login).toBe("L0garithmic");
});

// ── credential injection ────────────────────────────────────────────────────────────

test("the token rides in the ENV, never in argv", () => {
  const auth = gitHubAuth("github.com", "L0garithmic", "gho_supersecrettokenvalue");
  const args = credentialConfigArgs(auth);
  const flat = args.join(" ");
  expect(flat).not.toContain("gho_supersecrettokenvalue");
  // …referenced by name instead, so only the child process can resolve it.
  expect(flat).toContain(`$${GH_TOKEN_ENV}`);
  expect(flat).toContain("username=L0garithmic");
  expect(credentialEnv(auth)).toEqual({ [GH_TOKEN_ENV]: "gho_supersecrettokenvalue" });
});

test("the inherited helper chain is RESET before ours is installed", () => {
  // Without the empty reset, git consults the machine's `gh auth git-credential` first — which
  // serves only the active account, i.e. the exact bug. Order matters.
  const args = credentialConfigArgs(gitHubAuth("github.com", "L0garithmic", "t"));
  expect(args[0]).toBe("-c");
  expect(args[1]).toBe("credential.helper=");
  expect(args[2]).toBe("-c");
  // Host-SCOPED, not a bare `credential.helper`. A bare helper answers every credential request the
  // invocation makes, whatever host it is for — so one git op touching a non-GitHub remote would be
  // handed a real GitHub token as its password. Scoping makes that structurally impossible.
  expect(args[3]).toStartWith("credential.https://github.com.helper=!");
});

test("the helper exits 0 for the store/erase verbs git calls after a successful auth", async () => {
  // `test "$1" = get && printf …` returns 1 for any other verb, which git reports as a failing
  // credential helper. An `if` block keeps the success path identical and exits clean otherwise.
  const snippet = credentialConfigArgs(gitHubAuth("github.com", "someone", "t"))[3]!.replace(
    "credential.https://github.com.helper=!",
    "",
  );
  for (const verb of ["store", "erase"]) {
    const r = await $`sh -c ${`${snippet} ${verb}`}`.env({ [GH_TOKEN_ENV]: "t" }).quiet().nothrow();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe(""); // and says nothing
  }
});

test("the helper answers a get with the account's credentials, token from the env", async () => {
  const snippet = credentialConfigArgs(gitHubAuth("github.com", "L0garithmic", "x"))[3]!.replace(
    "credential.https://github.com.helper=!",
    "",
  );
  const r = await $`sh -c ${`${snippet} get`}`.env({ [GH_TOKEN_ENV]: "tok-from-env" }).quiet().nothrow();
  expect(r.stdout.toString()).toContain("username=L0garithmic");
  expect(r.stdout.toString()).toContain("password=tok-from-env");
});

test("no auth means no flags and no env — the operation is left exactly as it was", () => {
  expect(credentialConfigArgs(null)).toEqual([]);
  expect(credentialEnv(null)).toEqual({});
});

test("a GitHubAuth cannot leak its token through stringification", () => {
  const auth = gitHubAuth("github.com", "L0garithmic", "gho_supersecrettokenvalue");
  expect(JSON.stringify({ auth })).not.toContain("gho_supersecrettokenvalue");
  expect(JSON.stringify(auth)).toBe('"[GitHubAuth L0garithmic@github.com]"');
});

test("logins that could break out of the helper snippet are refused", () => {
  expect(isValidLogin("L0garithmic")).toBe(true);
  expect(isValidLogin("Lunar-Werx")).toBe(true);
  for (const bad of ["a'; rm -rf /", "a$(whoami)", "a`id`", "a b", 'a"b', "a\nb", "", "-lead"]) {
    expect(isValidLogin(bad)).toBe(false);
  }
});

// ── the remote actually being contacted ─────────────────────────────────────────────

test("the operative remote follows the branch's upstream, not the name 'origin'", async () => {
  // The fork workflow: origin is the upstream you don't own, your branch tracks your own fork.
  // fetch/pull/push run with no remote argument, so git talks to `mine` — resolving against
  // `origin` would authenticate as the wrong account entirely.
  const dir = await scratchRepo({
    "remote.origin.url": "https://github.com/Lunarwerx/askarr.git",
    "remote.mine.url": "https://github.com/LunarWerxs/askarr.git",
  });
  await $`git -C ${dir} commit -q --allow-empty -m init`.env({
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e.invalid",
  }).quiet();
  const branch = (await $`git -C ${dir} rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
  await $`git -C ${dir} config branch.${branch}.remote mine`.quiet();

  expect(await operativeRemoteUrl(dir)).toBe("https://github.com/LunarWerxs/askarr.git");
  // …and the account resolved is the fork's owner, not the upstream org's.
  const r = await resolveRepoAccount(repoAt(dir), ACCOUNTS);
  expect(r).toEqual({ host: "github.com", login: "LunarWerxs", source: "remote" });
});

test("with no tracking config the operative remote falls back to origin", async () => {
  const dir = await scratchRepo({ "remote.origin.url": "https://github.com/LunarWerxs/thing.git" });
  expect(await operativeRemoteUrl(dir)).toBe("https://github.com/LunarWerxs/thing.git");
});

// ── never send a GitHub token to a host that isn't GitHub ───────────────────────────

test("a pin is refused when the repo's real remote is on a different host", async () => {
  // A pin is just a stored string: nothing stops the remote moving to a self-hosted server after
  // it was set. Minting a github.com token here would send a live credential to a third party.
  const dir = await scratchRepo({ "remote.origin.url": "https://git.example.internal/team/repo.git" });
  expect(await authForRepo(repoAt(dir, { syncAccountLogin: "L0garithmic" }))).toBeNull();
});

test("an ssh remote never gets a credential helper", async () => {
  const dir = await scratchRepo({ "remote.origin.url": "git@github.com:L0garithmic/pap3r.git" });
  expect(await authForRepo(repoAt(dir, { syncAccountLogin: "L0garithmic" }))).toBeNull();
});

test("a repo with no remote at all gets no credential", async () => {
  expect(await authForRepo(repoAt(await scratchRepo(), { syncAccountLogin: "L0garithmic" }))).toBeNull();
});

// ── clone, which has only the URL to go on ──────────────────────────────────────────

test("a clone URL on a host we hold no account for gets no credential", async () => {
  expect(await authForCloneUrl("https://gitlab.com/L0garithmic/thing.git")).toBeNull();
});

test("an ssh clone URL never gets a credential helper", async () => {
  expect(await authForCloneUrl("git@github.com:L0garithmic/pap3r.git")).toBeNull();
});

test("a malformed clone URL is refused rather than guessed at", async () => {
  for (const bad of ["", "not a url", "https://", "ftp://github.com/a/b.git"]) {
    expect(await authForCloneUrl(bad)).toBeNull();
  }
});

// ── the error the whole thing exists to stop producing ──────────────────────────────

test("a missing credential is classified, and names the account git asked for", () => {
  const r = classify(
    new Error("fatal: could not read Password for 'https://L0garithmic@github.com': terminal prompts disabled"),
  );
  expect(r.ok).toBe(false);
  expect(r.code).toBe("GH_ACCOUNT_NOT_AUTHORIZED");
  expect(r.message).toContain("L0garithmic");
});

test("the same failure without a parseable account still classifies", () => {
  const r = classify(new Error("fatal: terminal prompts disabled"));
  expect(r.code).toBe("GH_ACCOUNT_NOT_AUTHORIZED");
});

test("a genuine SSH failure is still SSH_AUTH_FAILED, not the new code", () => {
  expect(classify(new Error("git@github.com: Permission denied (publickey).")).code).toBe("SSH_AUTH_FAILED");
});
