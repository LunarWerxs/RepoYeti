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
import { gitFor, identityConfigArgs, safeGitEnv } from "./git.ts";
import { readStatus } from "./status.ts";
import { netGate } from "./gitgate.ts";
import type { Identity } from "./db.ts";
import type { ApiCode } from "./contract.ts";

/**
 * A git-action result code. This is the shared API code union (see contract.ts) so the
 * status mapping is centralized: classify() only ever produces the git subset, but
 * orchestration (service.ts runAction) can also return repo-level codes like NOT_FOUND /
 * SUBMODULE_NOT_ACTIONABLE through the same envelope.
 */
export type ActionCode = ApiCode;

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

/**
 * Stage everything and commit, attributed to the repo's identity. This is atomic and
 * can never produce a merge/conflicted state, so it's allowed from the phone (unlike a
 * partial stage). A pull/push still guard separately. Empty trees are refused.
 *
 * `amend` rewrites the previous commit (`commit --amend`) instead of adding a new one —
 * useful to fix the last message or fold in a forgotten change. It's allowed on a clean
 * tree (message-only edit) but still refused on a detached HEAD or before the first
 * commit (classify() maps "you have nothing to amend" to a plain ERROR). Amending an
 * already-pushed commit only diverges locally; the next non-force push reports
 * NON_FAST_FORWARD rather than rewriting the remote.
 */
export async function gitCommitAll(
  absPath: string,
  identity: Identity | null,
  message: string,
  amend = false,
): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) return fail("DETACHED_HEAD", "detached HEAD — resolve at your desk");
  if (!amend && pre.dirty === 0) return fail("NOTHING_TO_COMMIT", "nothing to commit");
  try {
    const git = gitFor(absPath);
    await git.raw([...identityConfigArgs(identity), "add", "-A"]);
    const commitArgs = [...identityConfigArgs(identity), "commit"];
    if (amend) commitArgs.push("--amend");
    commitArgs.push("-m", message);
    await git.raw(commitArgs);
    return ok(amend ? "amended" : "committed");
  } catch (err) {
    return classify(err);
  }
}

/**
 * Collect a compact, read-only snapshot of the working tree for an AI prompt:
 * the porcelain file list (so untracked names — which `add -A` will commit — show up)
 * plus the tracked diff vs HEAD. Capped so we never post a huge payload to a provider.
 * Never mutates the index. On an unborn HEAD (brand-new repo) the diff is empty and the
 * file list carries the context.
 */
const DIFF_CAP = 24_000;
const STATUS_CAP = 4_000;
const DIFF_TIMEOUT_MS = 30_000;

/**
 * Run `git <args>` in `absPath` and collect at most `cap` bytes of stdout, then KILL the
 * child. The previous version buffered the ENTIRE `git diff HEAD` into a string only to
 * slice it to 24 KB afterwards — so a generated file, a near-binary blob, or a 100k-line
 * change would still be fully read into memory (and block the per-repo queue) before the
 * cap applied. Streaming + early-kill bounds memory and time up front. Uses the same
 * daemon-safe git env as gitFor() (no pager, no prompts, GIT_OPTIONAL_LOCKS=0). Read-only.
 */
async function boundedGit(absPath: string, args: string[], cap: number): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: absPath,
    env: safeGitEnv(),
    stdout: "pipe",
    stderr: "ignore",
  });
  const killTimer = setTimeout(() => proc.kill(), DIFF_TIMEOUT_MS);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  try {
    while (out.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    if (out.length > cap) out = out.slice(0, cap);
  } catch {
    /* child killed or stream errored — keep whatever we read */
  } finally {
    clearTimeout(killTimer);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    proc.kill(); // no-op if it already exited; stops a still-streaming huge diff
    try {
      await proc.exited;
    } catch {
      /* ignore */
    }
  }
  return out;
}

export async function collectCommitDiff(absPath: string): Promise<string> {
  const status = (await boundedGit(absPath, ["status", "--porcelain=v1"], STATUS_CAP)).trim();
  // `git diff HEAD` is empty (non-zero exit) on an unborn HEAD → fall back to `git diff`.
  let diff = (await boundedGit(absPath, ["diff", "HEAD"], DIFF_CAP)).trim();
  if (!diff) diff = (await boundedGit(absPath, ["diff"], DIFF_CAP)).trim();
  let combined =
    `# git status --porcelain\n${status || "(clean)"}\n\n# git diff\n${diff || "(no textual diff — new/untracked files only)"}`;
  if (combined.length > DIFF_CAP) combined = combined.slice(0, DIFF_CAP) + "\n…[truncated]";
  return combined;
}

/** ~1 MB of unified diff is plenty for the viewer; bound the pathological "huge change in a
 *  huge file" case so we never buffer an unbounded patch. */
const PATCH_CAP = 1_000_000;

/**
 * A single tracked file's unified `git diff HEAD`, bounded via boundedGit so a pathological
 * change can't balloon memory. Powers the file viewer's compact-diff mode for LARGE modified
 * files: rather than shipping both whole copies and diffing in the browser, the daemon lets
 * git compute the patch and sends only that. `truncated` flags a patch that itself hit the
 * cap. The caller guarantees the path is a tracked, modified, non-binary file.
 */
export async function fileDiffPatch(
  absPath: string,
  relPath: string,
): Promise<{ patch: string; truncated: boolean }> {
  // `--` separates the pathspec so a filename that looks like a flag can't be misread.
  const raw = await boundedGit(absPath, ["diff", "HEAD", "--", relPath], PATCH_CAP + 1);
  const truncated = raw.length > PATCH_CAP;
  return { patch: truncated ? raw.slice(0, PATCH_CAP) : raw, truncated };
}

/** Cap the `-l` name list we read back from `git grep`. A few thousand paths fit easily;
 *  the changed-file set is the real bound — this just guards a pathological match storm. */
const GREP_CAP = 512_000;

/** Group `paths` so no single `git grep` invocation's pathspec list overflows the OS
 *  command-line limit (Windows ~32 KB). Greedy packing under a conservative byte budget. */
function chunkByBytes(paths: string[], maxBytes = 8_000): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let used = 0;
  for (const p of paths) {
    const cost = p.length + 1; // path + the separating space/arg slot
    if (used + cost > maxBytes && cur.length) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(p);
    used += cost;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * The subset of `paths` whose WORKING-TREE content contains `needle` (literal, case-
 * insensitive). Powers the changes-tree "search content" toggle: the tree only shows
 * changed files, so the caller scopes this to that set. Flags:
 *   -l names only · -I skip binaries · -i case-insensitive · -F literal (no regex)
 *   --untracked also search new/untracked files · core.quotePath=false → raw paths.
 * `git grep` exits 1 on "no match" — boundedGit ignores the exit code, so that's a no-op,
 * not an error. Read-only; same daemon-safe env + 30 s kill-timer as every bounded read.
 */
export async function grepChangedContent(
  absPath: string,
  needle: string,
  paths: string[],
): Promise<string[]> {
  if (!needle || paths.length === 0) return [];
  const matched = new Set<string>();
  for (const chunk of chunkByBytes(paths)) {
    const out = await boundedGit(
      absPath,
      ["-c", "core.quotePath=false", "grep", "--no-color", "-l", "-I", "-i", "-F", "--untracked", "-e", needle, "--", ...chunk],
      GREP_CAP,
    );
    for (const line of out.split("\n")) {
      const p = line.trim();
      if (p) matched.add(p);
    }
  }
  return [...matched];
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
