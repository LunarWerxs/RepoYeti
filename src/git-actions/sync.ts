/**
 * Remote sync actions — fetch / pull / push / clone — plus the shared error classifier.
 * These are the operations that talk to a remote and/or take the network gate (`netGate`).
 *
 * Auth + author identity are injected per operation (`-c core.sshCommand` + `-c user.*`)
 * via git.ts — global/repo config is never mutated.
 */
import { gitFor, identityConfigArgs } from "../git.ts";
import { readStatus } from "../read/status.ts";
import { netGate } from "../gitgate.ts";
import type { Identity } from "../db.ts";
import { ok, fail, type ActionResult } from "../contract.ts";

/** Map a thrown git error (simple-git surfaces stderr in the message) to a code. */
export function classify(err: unknown): ActionResult {
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
    await netGate.run(() => git.raw([...identityConfigArgs(identity), "fetch", "--prune"]));
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
    await netGate.run(() => git.raw([...identityConfigArgs(identity), "pull", "--ff-only"]));
    return ok("pulled (fast-forward)");
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
    await netGate.run(() => git.raw([...identityConfigArgs(identity), "push"]));
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
): Promise<ActionResult> {
  try {
    await netGate.run(() =>
      gitFor(parentDir, CLONE_TIMEOUT_MS).raw([...identityConfigArgs(identity), "clone", "--", url, name]),
    );
    return ok("cloned");
  } catch (err) {
    return classify(err);
  }
}
