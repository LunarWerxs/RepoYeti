/**
 * Safe remote git actions — fetch / pull / push — with the non-negotiable guards:
 *  - The daemon NEVER leaves a repo half-merged. Pull is fast-forward-only and is
 *    refused outright on a dirty tree or detached HEAD ("resolve at your desk").
 *  - Push is never `--force`. A non-fast-forward push is reported, not forced.
 *  - Every failure maps to a stable, first-class error code the UI can render.
 *
 * Auth + author identity are injected per operation (`-c core.sshCommand` + `-c user.*`)
 * via git.ts — global/repo config is never mutated.
 */
import { gitFor, identityConfigArgs } from "./git.ts";
import { readStatus } from "./status.ts";
import type { Identity } from "./db.ts";

export type ActionCode =
  | "OK"
  | "DIRTY_WORKING_TREE"
  | "NON_FAST_FORWARD"
  | "DETACHED_HEAD"
  | "NO_UPSTREAM"
  | "NO_REMOTE"
  | "NOTHING_TO_COMMIT"
  | "SSH_AUTH_FAILED"
  | "SSH_PASSPHRASE_REQUIRED"
  | "ERROR";

export interface ActionResult {
  ok: boolean;
  code: ActionCode;
  message: string;
}

const ok = (message: string): ActionResult => ({ ok: true, code: "OK", message });
const fail = (code: ActionCode, message: string): ActionResult => ({ ok: false, code, message });

/** Map a thrown git error (simple-git surfaces stderr in the message) to a code. */
function classify(err: unknown): ActionResult {
  const raw = err instanceof Error ? err.message : String(err);
  const low = raw.toLowerCase();

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

export async function gitFetch(absPath: string, identity: Identity | null): Promise<ActionResult> {
  try {
    const git = gitFor(absPath);
    await git.raw([...identityConfigArgs(identity), "fetch", "--prune"]);
    return ok("fetched");
  } catch (err) {
    return classify(err);
  }
}

export async function gitPullFfOnly(
  absPath: string,
  identity: Identity | null,
): Promise<ActionResult> {
  // Preflight: never pull into an unsafe state.
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) {
    return fail("DETACHED_HEAD", "detached HEAD — resolve at your desk");
  }
  if (pre.dirty > 0) {
    return fail("DIRTY_WORKING_TREE", "working tree has uncommitted changes — resolve at your desk");
  }
  try {
    const git = gitFor(absPath);
    await git.raw([...identityConfigArgs(identity), "pull", "--ff-only"]);
    return ok("pulled (fast-forward)");
  } catch (err) {
    return classify(err);
  }
}

/**
 * Stage everything and commit, attributed to the repo's identity. This is atomic and
 * can never produce a merge/conflicted state, so it's allowed from the phone (unlike a
 * partial stage). A pull/push still guard separately. Empty trees are refused.
 */
export async function gitCommitAll(
  absPath: string,
  identity: Identity | null,
  message: string,
): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) return fail("DETACHED_HEAD", "detached HEAD — resolve at your desk");
  if (pre.dirty === 0) return fail("NOTHING_TO_COMMIT", "nothing to commit");
  try {
    const git = gitFor(absPath);
    await git.raw([...identityConfigArgs(identity), "add", "-A"]);
    await git.raw([...identityConfigArgs(identity), "commit", "-m", message]);
    return ok("committed");
  } catch (err) {
    return classify(err);
  }
}

export async function gitPush(absPath: string, identity: Identity | null): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) {
    return fail("DETACHED_HEAD", "detached HEAD — cannot push");
  }
  try {
    const git = gitFor(absPath);
    // Plain push of the current branch to its upstream. No `--force`, ever.
    await git.raw([...identityConfigArgs(identity), "push"]);
    return ok("pushed");
  } catch (err) {
    return classify(err);
  }
}
