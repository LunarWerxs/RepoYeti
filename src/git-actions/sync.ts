/**
 * Remote sync actions — fetch / pull / push / clone — plus the shared error classifier.
 * These are the operations that talk to a remote and/or take the network gate (`netGate`).
 *
 * Auth + author identity are injected per operation (`-c core.sshCommand` + `-c user.*`)
 * via git.ts — global/repo config is never mutated.
 */
import {
  gitFor,
  identityConfigArgs,
  credentialConfigArgs,
  credentialEnv,
  type GitHubAuth,
} from "../git.ts";
import { readStatus } from "../read/status.ts";
import { netGate } from "../gitgate.ts";
import type { Identity } from "../db.ts";
import { ok, fail, type ActionResult } from "../contract.ts";

/** Map a thrown git error (simple-git surfaces stderr in the message) to a code. */
export function classify(err: unknown): ActionResult {
  const raw = err instanceof Error ? err.message : String(err);
  const low = raw.toLowerCase();

  if (low.includes("would be overwritten") || low.includes("commit your changes or stash")) {
    // A fast-forward that can't land without clobbering an uncommitted edit. git aborts
    // atomically (nothing is touched), so this is safe to surface and retry after the owner
    // commits or stashes — both of which RepoYeti can do from the phone.
    return fail(
      "WOULD_OVERWRITE",
      "your uncommitted changes would be overwritten; commit or stash them first",
    );
  }
  if (
    low.includes("non-fast-forward") ||
    low.includes("fetch first") ||
    low.includes("updates were rejected") ||
    low.includes("not possible to fast-forward") ||
    low.includes("cannot fast-forward") ||
    low.includes("need to specify how to reconcile")
  ) {
    return fail("NON_FAST_FORWARD", "remote has diverged — resolve at your desk");
  }
  if (low.includes("has no upstream branch") || low.includes("no upstream configured")) {
    return fail("NO_UPSTREAM", "branch has no upstream — set one at your desk");
  }
  // git asked a credential helper for a password and got nothing. On a headless daemon
  // (GIT_TERMINAL_PROMPT=0) there is no prompt to fall back to, so this is terminal — and the
  // stock message ("could not read Password for 'https://someone@github.com'") reads as if that
  // account is signed out, when the real cause is almost always that it is signed in but not
  // ACTIVE, and `gh auth git-credential` only ever serves the active account. Name the account git
  // actually asked for, so the message points at the right thing.
  if (low.includes("could not read password") || low.includes("terminal prompts disabled")) {
    const who = /could not read password for '([^']+)'/i.exec(raw)?.[1] ?? "";
    const login = /^https?:\/\/([^@]+)@/i.exec(who)?.[1] ?? "";
    return fail(
      "GH_ACCOUNT_NOT_AUTHORIZED",
      login
        ? `git needs credentials for the GitHub account "${login}" and none were available`
        : "git needs GitHub credentials and none were available",
    );
  }
  if (
    low.includes("permission denied") ||
    low.includes("could not read from remote repository") ||
    low.includes("authentication failed") ||
    low.includes("host key verification failed") ||
    low.includes("publickey")
  ) {
    return fail("SSH_AUTH_FAILED", "authentication failed — check this repo's identity / SSH key");
  }
  if (low.includes("timed out") || low.includes("timeout") || low.includes("block timeout")) {
    return fail(
      "SSH_PASSPHRASE_REQUIRED",
      "git timed out — the SSH key may need a passphrase; use ssh-agent or a passphrase-free key",
    );
  }
  if (
    low.includes("no configured push destination") ||
    low.includes("does not appear to be a git repository") ||
    low.includes("no such remote") ||
    low.includes("no remote")
  ) {
    return fail("NO_REMOTE", "no remote configured for this repo");
  }
  return fail("ERROR", raw.split("\n")[0]?.slice(0, 300) ?? "git error");
}

export async function gitFetch(
  absPath: string,
  identity: Identity | null,
  auth?: GitHubAuth | null,
): Promise<ActionResult> {
  try {
    const git = gitFor(absPath, undefined, credentialEnv(auth ?? null));
    await netGate.run(() =>
      git.raw([...identityConfigArgs(identity), ...credentialConfigArgs(auth ?? null), "fetch", "--prune"]),
    );
    return ok("fetched");
  } catch (err) {
    return classify(err);
  }
}

export async function gitPullFfOnly(
  absPath: string,
  identity: Identity | null,
  auth?: GitHubAuth | null,
): Promise<ActionResult> {
  // Preflight only for the one state a fast-forward genuinely can't handle: a detached HEAD has
  // no branch to advance. A dirty working tree is deliberately NOT preflighted. `git pull
  // --ff-only` is atomic and safe on a dirty tree: it fast-forwards when the incoming commits
  // don't touch your uncommitted files (preserving those edits) and aborts cleanly
  // (WOULD_OVERWRITE, classified above) only when they would be overwritten. So the pull runs
  // whenever git can do it safely, instead of being refused up front on any local change.
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) {
    return fail("DETACHED_HEAD", "detached HEAD — resolve at your desk");
  }
  try {
    const git = gitFor(absPath, undefined, credentialEnv(auth ?? null));
    await netGate.run(() =>
      git.raw([...identityConfigArgs(identity), ...credentialConfigArgs(auth ?? null), "pull", "--ff-only"]),
    );
    return ok("pulled (fast-forward)");
  } catch (err) {
    return classify(err);
  }
}

export async function gitPush(
  absPath: string,
  identity: Identity | null,
  auth?: GitHubAuth | null,
): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) {
    return fail("DETACHED_HEAD", "detached HEAD — cannot push");
  }
  try {
    const git = gitFor(absPath, undefined, credentialEnv(auth ?? null));
    // Plain push of the current branch to its upstream. No `--force`, ever.
    await netGate.run(() =>
      git.raw([...identityConfigArgs(identity), ...credentialConfigArgs(auth ?? null), "push"]),
    );
    return ok("pushed");
  } catch (err) {
    return classify(err);
  }
}

// ── clone ───────────────────────────────────────────────────────────────────────────

/** A clone can pull a large history — give it far more headroom than a normal op (which is
 *  capped at 30s). Still bounded so a hung transport can't wedge a net slot forever. */
const CLONE_TIMEOUT_MS = 300_000;

/**
 * Clone `url` into `<parentDir>/<name>` with per-operation identity injection (the SSH key is
 * selected via `-c core.sshCommand`, same seam as fetch/pull/push). The caller validates the
 * URL scheme, the name, and that `parentDir` sits under a scan root; `--` separates the args so
 * a URL/name can't be read as a flag. Runs behind `netGate` (it's a network op) with the long
 * clone timeout. git cleans up its own partial target directory on failure.
 */
export async function gitClone(
  parentDir: string,
  url: string,
  name: string,
  identity: Identity | null,
  auth?: GitHubAuth | null,
): Promise<ActionResult> {
  try {
    await netGate.run(() =>
      gitFor(parentDir, CLONE_TIMEOUT_MS, credentialEnv(auth ?? null)).raw([
        ...identityConfigArgs(identity),
        ...credentialConfigArgs(auth ?? null),
        "clone",
        "--",
        url,
        name,
      ]),
    );
    return ok("cloned");
  } catch (err) {
    return classify(err);
  }
}
