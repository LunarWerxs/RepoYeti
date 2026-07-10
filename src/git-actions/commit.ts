/**
 * Local, non-network mutations to the index/working tree: whole-tree commit (+ amend), the
 * smart-commit multi-group planner's executor, and single-file discard. None of these ever
 * touch a remote, so none take `netGate` — but they share the same dirty/detached-HEAD guards
 * and identity attribution as the sync actions in ./sync.ts.
 */
import { existsSync, lstatSync, unlinkSync } from "node:fs";
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
