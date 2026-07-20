/**
 * Which GitHub account should a given repo sync as?
 *
 * The owner can pin one explicitly (the repo card's "GitHub account to sync this repo as"), but
 * most repos already answer the question themselves and should not need to be told twice:
 *
 *   1. The explicit pin, when set. Always wins — it is the owner saying so out loud.
 *   2. The repo's OWN git config: `credential.https://<host>.username`. A repo cloned by, or
 *      configured for, a particular account carries this already. It is also precisely the setting
 *      that USED to make a push fail outright: git demands a credential for that login, gh serves
 *      only its active account, and the push dies with "could not read Password" while the account
 *      it wanted sits authenticated two lines up in `gh auth status`. Reading it here turns that
 *      failure into the answer.
 *   3. The remote's owner, when it exactly matches one of the authenticated logins — i.e.
 *      github.com/<login>/<repo>. A personal repo is nearly always pushed as its owner. Org and
 *      fork remotes match nothing and fall through, which is the safe direction.
 *
 * Nothing here mutates git config or gh state; every step is a read. When no step answers, the
 * result is null and the operation runs unauthenticated-by-us — i.e. exactly as it did before,
 * under whatever credential helper the machine already has.
 */
import { gitFor } from "./git.ts";
import { accountsSnapshot, ghTokenFor, isValidLogin, type GhAccount } from "./gh-cli.ts";
import { gitHubAuth, type GitHubAuth } from "./git.ts";
import type { RepoView } from "./db.ts";

/** Where a repo's effective account came from — surfaced so the UI can explain itself. */
export type AccountSource = "pinned" | "gitconfig" | "remote";

export interface ResolvedAccount {
  host: string;
  login: string;
  source: AccountSource;
}

const DEFAULT_HOST = "github.com";

/** Read one repo-local config value. Best-effort: an unset key or a non-repo yields null. */
async function localConfig(absPath: string, key: string): Promise<string | null> {
  try {
    const out = await gitFor(absPath).raw(["config", "--local", "--get", key]);
    return out.trim() || null;
  } catch {
    return null; // key unset (git exits 1) or the path isn't a working copy
  }
}

/**
 * The URL of the remote this repo's network ops will ACTUALLY contact.
 *
 * Not simply `origin`: fetch/pull/push run with no remote argument (see git-actions/sync.ts), and
 * git resolves those against the current branch's `branch.<name>.remote`, falling back to `origin`
 * only when that is unset. In an ordinary fork workflow — `origin` pointing at the upstream, the
 * branch tracking your own fork — those are different remotes owned by different accounts, so
 * reading `origin` would resolve (and authenticate as) the wrong one.
 */
export async function operativeRemoteUrl(absPath: string): Promise<string | null> {
  const branch = (await gitFor(absPath)
    .raw(["rev-parse", "--abbrev-ref", "HEAD"])
    .then((s) => s.trim())
    .catch(() => "")) as string;
  // A detached HEAD has no tracking config; "origin" is the honest fallback there, as it is for a
  // branch that has simply never been given an upstream.
  const named =
    branch && branch !== "HEAD" ? await localConfig(absPath, `branch.${branch}.remote`) : null;
  return localConfig(absPath, `remote.${named || "origin"}.url`);
}

/** The `owner` in a github.com remote URL, for both https and ssh forms. */
export function remoteOwner(url: string): string | null {
  const trimmed = url.trim();
  // https://github.com/owner/repo(.git) — with or without an embedded user@
  const https = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\//i.exec(trimmed);
  if (https?.[1]) return https[1];
  // git@github.com:owner/repo(.git)
  const ssh = /^(?:ssh:\/\/)?[^@]+@github\.com[:/]([^/]+)\//i.exec(trimmed);
  return ssh?.[1] ?? null;
}

/**
 * Resolve the account this repo should sync as, given the machine's authenticated accounts.
 * `accounts` is passed in rather than fetched so a fan-out ("Fetch all") reads gh once, not once
 * per repo.
 */
export async function resolveRepoAccount(
  repo: RepoView,
  accounts: GhAccount[],
): Promise<ResolvedAccount | null> {
  // 1. Explicit pin. Trusted as-is: the owner chose it, and honouring it even when gh has since
  //    been logged out is better than silently syncing as somebody else.
  if (repo.syncAccountLogin && isValidLogin(repo.syncAccountLogin)) {
    return { host: repo.syncAccountHost || DEFAULT_HOST, login: repo.syncAccountLogin, source: "pinned" };
  }
  // Only git working copies have git config / git remotes to interrogate.
  if (repo.vcs !== "git") return null;

  const known = (host: string, login: string): GhAccount | undefined =>
    accounts.find((a) => a.host === host && a.login.toLowerCase() === login.toLowerCase());

  // 2. The repo's own credential username pin.
  const pinned = await localConfig(repo.absPath, `credential.https://${DEFAULT_HOST}.username`);
  if (pinned && isValidLogin(pinned)) {
    const match = known(DEFAULT_HOST, pinned);
    // Only claim it when gh can actually authenticate as that login — otherwise we would install a
    // helper with no token and turn a working fallback into a hard failure.
    if (match) return { host: match.host, login: match.login, source: "gitconfig" };
  }

  // 3. The remote's owner, when it names an account we hold.
  const url = await operativeRemoteUrl(repo.absPath);
  const owner = url ? remoteOwner(url) : null;
  if (owner && isValidLogin(owner)) {
    const match = known(DEFAULT_HOST, owner);
    if (match) return { host: match.host, login: match.login, source: "remote" };
  }
  return null;
}

/**
 * The credential for a CLONE, resolved from the URL alone.
 *
 * A clone has no repo row to consult yet, so the URL is the only evidence available — but it is
 * enough for the case that actually fails: cloning a private repo belonging to an account that is
 * signed in but not ACTIVE. Without this, `gh auth git-credential` declines exactly as it does for
 * fetch/pull/push, and the clone dies with the same misleading "could not read Password".
 *
 * Only an https URL whose owner is one of the authenticated logins qualifies. An org or
 * third-party URL matches nothing and clones exactly as before, under the ambient helper.
 */
export async function authForCloneUrl(url: string): Promise<GitHubAuth | null> {
  let host: string;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") return null; // ssh clones use the identity's key, not a helper
    host = parsed.host.toLowerCase();
  } catch {
    return null;
  }
  const owner = remoteOwner(url);
  if (!owner || !isValidLogin(owner)) return null;
  let accounts: GhAccount[];
  try {
    accounts = (await accountsSnapshot()).accounts;
  } catch {
    return null;
  }
  const match = accounts.find(
    (a) => a.host.toLowerCase() === host && a.login.toLowerCase() === owner.toLowerCase(),
  );
  if (!match) return null;
  const token = await ghTokenFor(match.host, match.login);
  return token ? gitHubAuth(match.host, match.login, token) : null;
}

/**
 * The per-operation credential for a repo, or null to leave the operation exactly as it was.
 *
 * Deliberately best-effort at every step: no gh, no matching account, or no retrievable token all
 * mean "run it the old way" rather than "fail". A repo that used to sync fine under the machine's
 * ambient credential helper must keep syncing fine.
 */
export async function authForRepo(repo: RepoView): Promise<GitHubAuth | null> {
  // Establish the target FIRST, from local git config alone. Everything below can disqualify the
  // repo without spawning `gh`, which matters: this runs before every fetch/pull/push, and a repo
  // that can never take an injected credential should not pay for a subprocess to find that out.
  //
  // The credential may only be minted for the remote this operation will really contact, and only
  // when that remote is on the SAME host as the account. An explicit pin in particular is just a
  // stored string — nothing forces it to still match a remote that has since moved — and handing a
  // github.com token to, say, a self-hosted git server would send a live credential to a third
  // party. Refusing here is what makes that impossible; credentialConfigArgs then scopes the helper
  // to this host as a second, independent guard.
  const url = repo.vcs === "git" ? await operativeRemoteUrl(repo.absPath) : null;
  if (!url) return null;
  let host: string;
  try {
    const parsed = new URL(url.trim());
    // https only: an ssh remote authenticates with the identity's key (identityConfigArgs) and
    // never consults a credential helper, so injecting one would be meaningless at best.
    if (parsed.protocol !== "https:") return null;
    host = parsed.host.toLowerCase();
  } catch {
    return null; // scp-style (git@host:owner/repo) or unparseable → not an https credential path
  }
  // A pin names its own host, so a mismatch is decidable here — no account list required.
  if (repo.syncAccountLogin && (repo.syncAccountHost || DEFAULT_HOST).toLowerCase() !== host) {
    return null;
  }

  let accounts: GhAccount[];
  try {
    accounts = (await accountsSnapshot()).accounts;
  } catch {
    return null;
  }
  if (accounts.length === 0) return null;
  const resolved = await resolveRepoAccount(repo, accounts);
  if (!resolved || resolved.host.toLowerCase() !== host) return null;

  const token = await ghTokenFor(resolved.host, resolved.login);
  return token ? gitHubAuth(resolved.host, resolved.login, token) : null;
}
