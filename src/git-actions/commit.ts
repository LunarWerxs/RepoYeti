/**
 * Local, non-network mutations to the index/working tree: whole-tree commit (+ amend), the
 * smart-commit multi-group planner's executor, and single-file discard. None of these ever
 * touch a remote, so none take `netGate` — but they share the same dirty/detached-HEAD guards
 * and identity attribution as the sync actions in ./sync.ts.
 */
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gitFor, identityConfigArgs } from "../git.ts";
import { readStatus } from "../read/status.ts";
import type { Identity } from "../db.ts";
import {
  ok,
  fail,
  type ActionResult,
  type CommitGroupSpec,
  type CommitGroupResult,
  type CommitGroupsResult,
} from "../contract.ts";
import { classify } from "./sync.ts";
import { chunkByBytes } from "./diff.ts";

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

// ── smart commit: split the working tree into several scoped commits ─────────────────
// CommitGroupSpec / CommitGroupResult / CommitGroupsResult now live in contract.ts (the backend
// contract); they're imported + re-exported above so existing `from "./git-actions.ts"` callers
// keep working.

const subjectOf = (message: string): string => (message.split("\n")[0] ?? "").slice(0, 120);

/**
 * Execute a multi-commit plan: stage each group's files in isolation and commit it,
 * attributed to the repo's identity. FILE-LEVEL only — `git add -A -- <paths>` stages the
 * whole-file change (modify / add / delete / rename) for exactly those paths, then a commit
 * captures just the staged set. Between groups the index returns to clean, so the next add
 * stages only the next group (the caller guarantees the groups are disjoint + complete).
 *
 * Safety: starts with a MIXED `git reset` (index → HEAD, working tree UNTOUCHED — never
 * `--hard`) so each commit contains exactly its group regardless of any pre-staged state.
 * If a commit fails mid-sequence we STOP and report a partial result: the changes for the
 * remaining groups simply stay in the working tree (a normal, safe, recoverable state — never
 * a half-merge). The whole sequence must run inside ONE op-queue slot (the service wrapper
 * enqueues once and refreshes after).
 */
export async function gitCommitGroups(
  absPath: string,
  identity: Identity | null,
  groups: CommitGroupSpec[],
): Promise<CommitGroupsResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return { ok: false, code: "ERROR", message: pre.error, committed: [], remaining: groups.length };
  if (pre.detached || !pre.branch)
    return { ok: false, code: "DETACHED_HEAD", message: "detached HEAD — resolve at your desk", committed: [], remaining: groups.length };
  if (pre.dirty === 0)
    return { ok: false, code: "NOTHING_TO_COMMIT", message: "nothing to commit", committed: [], remaining: groups.length };

  const git = gitFor(absPath);
  const committed: CommitGroupResult[] = [];
  try {
    // Normalise the index to HEAD so each group's commit contains exactly its own files.
    // Mixed reset (the default) never touches the working tree — categorically not `--hard`.
    await git.raw(["reset", "-q"]);
  } catch {
    // `git reset` fails on an UNBORN HEAD (a fresh repo with no commit yet) — there's nothing
    // to reset to. That's fine: the index is the only state and the per-group add/commit below
    // creates the first commit(s). Swallow and proceed (any real corruption surfaces per group).
  }

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const subject = subjectOf(g.message);
    try {
      // Stage in path-list chunks so a huge group can't overflow the OS command-line limit.
      for (const chunk of chunkByBytes(g.paths)) {
        await git.raw(["add", "-A", "--", ...chunk]);
      }
      // Skip a group that staged nothing (defensive — disjoint/complete validation should
      // prevent it) rather than aborting the whole plan on a "nothing to commit". Use
      // `--name-only` (non-empty = something staged) instead of `--quiet`: under
      // GIT_OPTIONAL_LOCKS=0 the `--quiet`/`--exit-code` fast path can wrongly report "no
      // diff" for a staged deletion (it skips the index refresh), which `--name-only` doesn't.
      const stagedNames = (await git.raw(["diff", "--cached", "--name-only"])).trim();
      if (!stagedNames) {
        committed.push({ ok: true, code: "OK", subject, message: "skipped (no changes)" });
        continue;
      }
      await git.raw([...identityConfigArgs(identity), "commit", "-m", g.message]);
      committed.push({ ok: true, code: "OK", subject });
    } catch (err) {
      const r = classify(err);
      committed.push({ ok: false, code: r.code, subject, message: r.message });
      // Stop on the first failure; the remaining groups' changes stay safely in the tree.
      return { ok: false, code: r.code, message: r.message, committed, remaining: groups.length - i - 1 };
    }
  }
  const made = committed.filter((c) => c.message !== "skipped (no changes)").length;
  return { ok: true, code: "OK", message: `committed ${made} change set${made === 1 ? "" : "s"}`, committed, remaining: 0 };
}

/**
 * VcsBackend.discardFile for git — restore ONE file to its committed/absent state. Backs the
 * changes-tree "Discard" action (DESTRUCTIVE; the UI confirms first). Two cases:
 *  - tracked in HEAD (modified/deleted) → `git checkout HEAD -- <path>` restores index+worktree.
 *  - added/untracked (not in HEAD)      → delete the working file + unstage any add.
 * HEAD is never touched and no merge state is possible. The caller (service.discardFile)
 * guarantees the path is repo-relative, resolved, and not inside the `.git` marker dir.
 */
export async function gitDiscardFile(absPath: string, relPath: string): Promise<ActionResult> {
  try {
    const git = gitFor(absPath);
    let inHead = false;
    try {
      await git.raw(["cat-file", "-e", `HEAD:${relPath}`]);
      inHead = true;
    } catch {
      /* not in HEAD → newly added or untracked */
    }
    if (inHead) {
      // Restores both the index and the working tree to the committed content.
      await git.raw(["checkout", "HEAD", "--", relPath]);
    } else {
      const abs = join(absPath, relPath);
      if (existsSync(abs) && lstatSync(abs).isFile()) unlinkSync(abs);
      // Drop any staged "add" for this path. No-op (harmless throw) on an unborn HEAD.
      try {
        await git.raw(["reset", "-q", "--", relPath]);
      } catch {
        /* unborn HEAD or nothing staged */
      }
    }
    return ok("discarded");
  } catch (e) {
    return fail("DISCARD_FAILED", e instanceof Error ? e.message : String(e));
  }
}

/** Count of plain files (not dirs) anywhere under `dir`, walked ourselves rather than shelling
 *  out — cheaper than parsing `git rm`'s per-line output (which only covers the TRACKED subset
 *  anyway) and it's the one number that's true regardless of tracked/untracked/ignored. */
function countFilesRecursive(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    n += entry.isDirectory() ? countFilesRecursive(p) : 1;
  }
  return n;
}

/**
 * VcsBackend.deleteFile's directory branch — delete a whole FOLDER outright (recursive:true on a
 * directory path; see gitDeleteFile). Two-step, because `git rm -r` only ever touches what's
 * TRACKED:
 *  1. `git rm -r -f -- <dir>` removes every tracked file under it from disk AND stages the
 *     removals in one step (-f past local modifications, same reasoning as the single-file case).
 *     A folder with nothing tracked inside makes `git rm` fail outright rather than partially
 *     succeed. That is the expected pure-untracked case, not a real error — so `git ls-files`
 *     ASKS whether anything is tracked first, instead of running the command and pattern-matching
 *     its English error prose. Matching /did not match any files/ was the first cut and it is a
 *     latent bug: a localized or reworded git would send a genuine failure down the benign path
 *     and delete the tree anyway, having silently skipped staging the removals.
 *  2. Whatever step 1 didn't touch (untracked/ignored leftovers) would otherwise survive as a
 *     non-empty husk, which isn't what "delete this folder" means — so the directory tree is
 *     removed from disk directly afterward, unconditionally.
 * The caller (service.deleteFile) has already confirmed `relPath` isn't the repo root, isn't
 * inside the VCS marker dir, and isn't/doesn't directly contain a nested repo checkout.
 */
async function gitDeleteDirectory(absPath: string, relPath: string): Promise<ActionResult & { deleted?: number }> {
  const abs = join(absPath, relPath);
  let deleted = 0;
  try {
    deleted = countFilesRecursive(abs);
  } catch (e) {
    return fail("DELETE_FAILED", e instanceof Error ? e.message : String(e));
  }
  const git = gitFor(absPath);
  try {
    // -z so a filename with a newline can't fake an empty result; any output at all means git
    // has something under this path to remove.
    const tracked = await git.raw(["ls-files", "-z", "--", relPath]);
    if (tracked.length > 0) await git.raw(["rm", "-r", "-f", "--", relPath]);
  } catch (e) {
    return fail("DELETE_FAILED", e instanceof Error ? e.message : String(e));
  }
  try {
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
  } catch (e) {
    return fail("DELETE_FAILED", e instanceof Error ? e.message : String(e));
  }
  return { ok: true, code: "OK", message: `deleted ${deleted} file${deleted === 1 ? "" : "s"}`, deleted };
}

/**
 * VcsBackend.deleteFile for git — delete ONE file from disk outright (the changes-tree "Delete"
 * action). Distinct from gitDiscardFile: discard RESTORES a file to its committed/absent state;
 * this one has no restore direction — the file is just gone. Same `inHead` split as discard, but
 * the tracked branch uses a different primitive:
 *  - tracked in HEAD (modified/deleted) → `git rm -f -- <path>` deletes the working file AND
 *    stages the removal in one step. -f is required because git rm otherwise refuses a file with
 *    local modifications ("you have local modifications; use --cached to keep it, or -f to force");
 *    this action is explicitly destructive, so that safety check doesn't apply here.
 *  - added/untracked (not in HEAD)      → nothing committed to preserve, so there's no `git rm`
 *    target — remove the working file and drop any staged add, same as discard's untracked case.
 * The caller (service.deleteFile) guarantees the path is repo-relative, resolved, and not inside
 * the `.git` marker dir.
 *
 * `recursive:true` on a DIRECTORY path delegates to gitDeleteDirectory; on a FILE path it's a
 * no-op (falls straight through to the ordinary single-file logic below) — recursive only ever
 * WIDENS what's allowed, never changes single-file behavior.
 */
export async function gitDeleteFile(
  absPath: string,
  relPath: string,
  recursive = false,
): Promise<ActionResult & { deleted?: number }> {
  if (recursive) {
    let isDir = false;
    try {
      isDir = lstatSync(join(absPath, relPath)).isDirectory();
    } catch {
      /* nothing at the leaf — fall through; the single-file path below reports its own
         not-found-shaped failure (an `inHead` miss + a no-op unlink is a harmless success today,
         matching the pre-existing untracked-file behavior for a path that's already gone) */
    }
    if (isDir) return gitDeleteDirectory(absPath, relPath);
  }
  try {
    const git = gitFor(absPath);
    let inHead = false;
    try {
      await git.raw(["cat-file", "-e", `HEAD:${relPath}`]);
      inHead = true;
    } catch {
      /* not in HEAD → newly added or untracked */
    }
    if (inHead) {
      await git.raw(["rm", "-f", "--", relPath]);
    } else {
      const abs = join(absPath, relPath);
      if (existsSync(abs) && lstatSync(abs).isFile()) unlinkSync(abs);
      // Drop any staged "add" for this path. No-op (harmless throw) on an unborn HEAD.
      try {
        await git.raw(["reset", "-q", "--", relPath]);
      } catch {
        /* unborn HEAD or nothing staged */
      }
    }
    return ok("deleted");
  } catch (e) {
    return fail("DELETE_FAILED", e instanceof Error ? e.message : String(e));
  }
}

/**
 * VcsBackend.stageFile for git — stage ONE file's working-tree change into the index (the
 * changes-tree per-file "Stage" action, GitHub-Desktop-style). `git add -A -- <path>` stages the
 * whole-file change (modify / add / delete / rename) for exactly that path — same primitive
 * gitCommitGroups uses per-group, just for a single file and with no follow-on commit. Never
 * touches HEAD; purely additive to the index, so it's safe to call repeatedly / redundantly.
 */
export async function gitStageFile(absPath: string, relPath: string): Promise<ActionResult> {
  try {
    const git = gitFor(absPath);
    await git.raw(["add", "-A", "--", relPath]);
    return ok("staged");
  } catch (e) {
    return fail("STAGE_FAILED", e instanceof Error ? e.message : String(e));
  }
}
