/**
 * Guest-facing projections — what a share link is allowed to SEE, as opposed to what it may DO
 * (policy.ts) or who it is (index.ts).
 *
 * The gate decides which routes a guest may call; it can't decide what a handler puts in the body.
 * Several handlers were written when the only possible reader was the owner, and they say more
 * than a guest should hear. These are the narrowings.
 */
import type { RepoStatus, RepoView } from "../db.ts";

/**
 * Strip credentials out of a git remote URL.
 *
 * `RepoStatus.remote` is whatever `git remote -v` printed, verbatim (read/status.ts resolveRemote).
 * For an HTTPS remote that embeds a PAT — `https://user:ghp_xxx@github.com/o/r.git`, which is what
 * `git clone` writes when you paste a token, and what several CI setups produce — that string is a
 * live credential. It has always round-tripped to the dashboard, which was fine when the dashboard
 * was only ever the owner's. It is NOT fine for a guest, so it is stripped here.
 *
 * Scheme-aware, because "userinfo" means two different things:
 *   • http/https — the userinfo IS the credential (`user:token@`, or a bare `token@`). Drop all of it.
 *   • anything else (ssh://, git://) — the user is an ACCOUNT NAME, not a secret: `ssh://git@host/o/r`
 *     is the normal form of every SSH remote on GitHub. Dropping it would corrupt the URL shown to
 *     the guest into one that doesn't work. Only a password (`user:pass@`) is removed.
 * The scp-like form (`git@github.com:o/r.git`) has no scheme and no password field, so it's left
 * alone entirely.
 *
 * Regex, not `new URL()`, so it also does the right thing on inputs URL can't parse.
 */
export function redactRemoteUrl(remote: string | null): string | null {
  if (!remote) return remote;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(remote);
  if (!scheme) return remote; // scp-like or a bare path — no userinfo to strip
  if (/^https?$/i.test(scheme[1]!)) {
    // Drop the whole userinfo: for http(s) it is the credential, whether or not it has a password.
    return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  }
  // Other schemes: keep the account name, drop only a password.
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/:@]*):[^/@]*@/i, "$1$2@");
}

/** A repo's status as a guest may see it: identical, minus any credential in the remote URL. */
export function guestStatus(status: RepoStatus | null): RepoStatus | null {
  if (!status) return null;
  return { ...status, remote: redactRemoteUrl(status.remote) };
}

/**
 * A repo as a guest may see it.
 *
 * `absPath` is kept on purpose: the owner's stated case is a second person working the other shift
 * on the same codebase, the UI shows the path, and hiding it would break the product for no real
 * gain (they already know where the code lives). What's dropped is the owner's private bookkeeping:
 * which commit identity and which GitHub account this repo authenticates as (`identityId`,
 * `syncAccountHost`, `syncAccountLogin`) name the owner's credentials, and the dashboard flags
 * (`hidden`/`pinned`/`starred`/`autoCommit`) are the owner's own organisation, not the guest's.
 */
export function guestRepoView(repo: RepoView): RepoView {
  return {
    ...repo,
    identityId: null,
    syncAccountHost: null,
    syncAccountLogin: null,
    hidden: false,
    pinned: false,
    starred: false,
    autoCommit: false,
    status: guestStatus(repo.status),
  };
}
