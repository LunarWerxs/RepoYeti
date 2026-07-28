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
  NET_BLOCK_MS,
  PROGRESS_ARG,
  type GitHubAuth,
} from "../git.ts";
import { readStatus } from "../read/status.ts";
import { netGate } from "../gitgate.ts";
import type { Identity } from "../db.ts";
import { ok, fail, type ActionResult } from "../contract.ts";

/** Was this failure our own idle-timeout kill (or a transport timeout) rather than a git verdict? */
function isTimeout(err: unknown): boolean {
  const low = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return low.includes("timed out") || low.includes("timeout") || low.includes("block timeout");
}

/**
 * The first line of git's output that is an actual diagnosis rather than transfer progress.
 *
 * Network ops run with `--progress` (see NET_BLOCK_MS in git.ts), so stderr now OPENS with a wall
 * of "Writing objects:  43% (…)". Taking line 1 blindly would report a progress bar as the error.
 * Prefer git's own diagnostic prefixes, then the first line that isn't progress.
 */
function diagnosisLine(raw: string): string {
  const lines = raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const isProgress = (l: string): boolean =>
    /\d+% \(\d+\/\d+\)/.test(l) ||
    /^(remote: )?(Enumerating|Counting|Compressing|Writing|Receiving|Resolving|Unpacking|Total|Cloning into) /i.test(l);
  return (
    lines.find((l) => /^(remote: )?(fatal|error):/i.test(l)) ??
    lines.find((l) => !isProgress(l)) ??
    lines[0] ??
    "git error"
  );
}

/** What the caller knows that makes a timeout diagnosable. */
export interface ClassifyContext {
  /**
   * True ONLY when git could genuinely have blocked on an interactive SSH passphrase prompt: an
   * SSH transport reached WITHOUT our own `-o BatchMode=yes`. Whenever an identity supplies a key
   * we set BatchMode (see sshCommandFor), and ssh then fails fast instead of prompting — so a hang
   * on that path is never a passphrase, and saying so sends the owner after a phantom.
   */
  couldPromptForPassphrase?: boolean;
}

/** Map a thrown git error (simple-git surfaces stderr in the message) to a code. */
export function classify(err: unknown, ctx?: ClassifyContext): ActionResult {
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
  if (
    low.includes("has no upstream branch") ||
    low.includes("no upstream configured") ||
    // What `git pull` says for the same state — a different sentence for "this branch tracks
    // nothing", which without this line fell through to ERROR and put git's four-line lecture
    // about `--set-upstream` in front of the owner instead of the one thing to do about it.
    low.includes("no tracking information")
  ) {
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
  // We killed git for going silent (or the transport itself timed out). This used to be reported
  // as SSH_PASSPHRASE_REQUIRED unconditionally — which named a cause that, on an https remote or a
  // passphrase-free key, cannot exist. Only claim the passphrase when the caller confirms git could
  // actually have been sitting at a prompt; otherwise say plainly that it stopped responding.
  if (isTimeout(err)) {
    if (ctx?.couldPromptForPassphrase) {
      return fail(
        "SSH_PASSPHRASE_REQUIRED",
        "git stopped responding, and this remote's SSH key can prompt for a passphrase — load it into ssh-agent, or use a passphrase-free key",
      );
    }
    return fail(
      "NETWORK_TIMEOUT",
      `git sent no output for ${Math.round(NET_BLOCK_MS / 1000)}s and was stopped — the remote or the network is not responding`,
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
  return fail("ERROR", diagnosisLine(raw).slice(0, 300));
}

/** Is this remote URL reached over SSH (`ssh://…` or the scp-like `git@host:owner/repo`)? */
export function isSshUrl(url: string): boolean {
  const u = url.trim();
  if (/^ssh:\/\//i.test(u)) return true;
  if (/^(https?|git|file):\/\//i.test(u)) return false;
  return /^[^\s/@]+@[^\s/:]+:/.test(u);
}

/**
 * Whether ANY remote of this repo is reached over SSH. Best-effort, message-only (never control
 * flow), local (no network), and run solely on the timeout path — so it costs nothing in the
 * ordinary case. `--get-regexp` exits 1 with no matches, which lands in the catch as "can't tell".
 */
async function hasSshRemote(absPath: string): Promise<boolean> {
  try {
    const out = await gitFor(absPath, 5_000).raw(["config", "--get-regexp", "^remote\\..*\\.url$"]);
    return out
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1] ?? "")
      .filter(Boolean)
      .some(isSshUrl);
  } catch {
    return false;
  }
}

/**
 * classify() for a remote op: on a timeout, establish whether an SSH passphrase prompt was even
 * possible before letting the classifier blame one. Everything else goes straight through.
 */
export async function classifyRemote(
  absPath: string,
  identity: Identity | null,
  err: unknown,
): Promise<ActionResult> {
  if (!isTimeout(err)) return classify(err);
  const couldPromptForPassphrase = !identity?.sshKeyPath && (await hasSshRemote(absPath));
  return classify(err, { couldPromptForPassphrase });
}

export async function gitFetch(
  absPath: string,
  identity: Identity | null,
  auth?: GitHubAuth | null,
): Promise<ActionResult> {
  try {
    const git = gitFor(absPath, NET_BLOCK_MS, credentialEnv(auth ?? null));
    await netGate.run(() =>
      git.raw([
        ...identityConfigArgs(identity),
        ...credentialConfigArgs(auth ?? null),
        "fetch",
        "--prune",
        PROGRESS_ARG,
      ]),
    );
    return ok("fetched");
  } catch (err) {
    return classifyRemote(absPath, identity, err);
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
    const git = gitFor(absPath, NET_BLOCK_MS, credentialEnv(auth ?? null));
    await netGate.run(() =>
      git.raw([
        ...identityConfigArgs(identity),
        ...credentialConfigArgs(auth ?? null),
        "pull",
        "--ff-only",
        PROGRESS_ARG,
      ]),
    );
    return ok("pulled (fast-forward)");
  } catch (err) {
    return classifyRemote(absPath, identity, err);
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
    const git = gitFor(absPath, NET_BLOCK_MS, credentialEnv(auth ?? null));
    // Plain push of the current branch to its upstream. No `--force`, ever.
    await netGate.run(() =>
      git.raw([...identityConfigArgs(identity), ...credentialConfigArgs(auth ?? null), "push", PROGRESS_ARG]),
    );
    return ok("pushed");
  } catch (err) {
    return classifyRemote(absPath, identity, err);
  }
}

// ── clone ───────────────────────────────────────────────────────────────────────────

/** A clone can pull a large history — give it more headroom than an ordinary network op
 *  (NET_BLOCK_MS). Like all of them this is an IDLE budget, not a total one, so `--progress` below
 *  is what keeps it honest; it stays bounded so a hung transport can't wedge a net slot forever. */
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
        PROGRESS_ARG,
        "--",
        url,
        name,
      ]),
    );
    return ok("cloned");
  } catch (err) {
    // No repo exists yet to read remotes from, but the URL we were handed IS the transport — so
    // unlike classifyRemote there's nothing to look up, and the context costs nothing to pass
    // always (classify only consults it on a timeout).
    return classify(err, { couldPromptForPassphrase: !identity?.sshKeyPath && isSshUrl(url) });
  }
}
