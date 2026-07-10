/**
 * Read-only inspection of a repo for the UI: branches / log / commit / stashes / tags, the
 * changed-file tree, content search, and the AI-diff / commit-plan collectors. The simple
 * listings are deliberately NOT behind the per-repo op-queue (reads stay snappy during a
 * fetch/pull); the AI collectors ARE enqueued so they can't race a mutating action.
 */
import { enqueue } from "../opqueue.ts";
import type { ChangedFile } from "../read/status.ts";
import { diffStatsEnabled } from "../read/diffstat.ts";
import { getRepo } from "../db.ts";
import { backendFor } from "../vcs/index.ts";
import type { VcsBackend } from "../vcs/types.ts";
import { collectCommitPlanInput } from "../git-actions.ts";
import type { CommitPlanInput, PlanInputFile } from "../ai.ts";
import { readTags, type BranchList, type LogResult, type StashList, type TagList, type CommitDetail, type MergeFilter, type RefScope } from "../read/inspect.ts";
import { guardRepo } from "./guards.ts";

// ── read-only inspection (branches / log / stashes) ───────────────────────────────
// Deliberately NOT behind the per-repo op-queue (reads stay snappy during a fetch/pull).
const NOT_FOUND_BRANCHES: BranchList = { ok: false, code: "ERROR", message: "repo not found", current: null, detached: false, branches: [] };

export function getBranches(repoId: string): Promise<BranchList> {
  const repo = getRepo(repoId);
  if (!repo) return Promise.resolve(NOT_FOUND_BRANCHES);
  return backendFor(repo.vcs).listBranches(repo.absPath);
}

export function getLog(repoId: string, limit?: number, skip?: number, merges?: MergeFilter, refScope?: RefScope): Promise<LogResult> {
  const repo = getRepo(repoId);
  if (!repo) return Promise.resolve({ ok: false, code: "ERROR", message: "repo not found", commits: [], hasMore: false });
  return backendFor(repo.vcs).readLog(repo.absPath, limit, skip, merges, refScope);
}

export function getCommit(repoId: string, hash: string): Promise<CommitDetail> {
  const repo = getRepo(repoId);
  if (!repo)
    return Promise.resolve({
      ok: false,
      code: "ERROR",
      message: "repo not found",
      hash,
      shortHash: hash.slice(0, 12),
      subject: "",
      body: "",
      authorName: "",
      authorEmail: "",
      date: 0,
      parents: [],
      isMerge: false,
      committerName: "",
      committerEmail: "",
      committerDate: 0,
      files: [],
      diff: "",
      truncated: false,
    });
  return backendFor(repo.vcs).readCommit(repo.absPath, hash);
}

export function getStashes(repoId: string): Promise<StashList> {
  const repo = getRepo(repoId);
  if (!repo) return Promise.resolve({ ok: false, code: "ERROR", message: "repo not found", stashes: [] });
  return backendFor(repo.vcs).readStashes(repo.absPath);
}

export function getTags(repoId: string): Promise<TagList> {
  const repo = getRepo(repoId);
  if (!repo) return Promise.resolve({ ok: false, code: "ERROR", message: "repo not found", tags: [] });
  // Tags are a git concept; non-git backends (Lore) have none → empty list, not a git error.
  if (repo.vcs !== "git") return Promise.resolve({ ok: true, code: "OK", tags: [] });
  return readTags(repo.absPath);
}

/** Changed-file list for the tree view (names + status only). Null if repo unknown. */
export interface ChangesResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  files?: ChangedFile[];
  /** Total changed files before the cap (present only when `truncated`). */
  total?: number;
  /** True when `files` was capped at MAX_CHANGED_FILES. */
  truncated?: boolean;
}

/** Cap the changed-file list shipped to the browser. A repo with tens of thousands of
 *  dirty files (a fresh clone gone wrong, a generated-output dir) would otherwise produce
 *  a multi-MB JSON payload and a huge recursive DOM in the tree view. Past this we send a
 *  truncated head plus a marker so the client can show "N of M" instead of freezing. */
export const MAX_CHANGED_FILES = 2000;

export async function getChanges(repoId: string): Promise<ChangesResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  try {
    const all = await enqueue(repoId, () => backendFor(repo.vcs).readChanges(repo.absPath, diffStatsEnabled()));
    if (all.length > MAX_CHANGED_FILES) {
      return { ok: true, code: "OK", files: all.slice(0, MAX_CHANGED_FILES), total: all.length, truncated: true };
    }
    return { ok: true, code: "OK", files: all };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Paths (a subset of the changed files) whose content matched a "search content" query. */
export interface SearchResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  paths?: string[];
}

/** Don't grep until the needle is at least this long — keeps content search cheap and
 *  intentful. Mirrored by the UI, which won't fire the request below this length. */
export const MIN_CONTENT_SEARCH = 3;

/**
 * Changed files whose working-tree content contains `query` (literal, case-insensitive).
 * The changes tree only ever shows changed files, so we read that set and scope the grep
 * to it — bounded work, a small payload. Sub-threshold queries return [] without touching
 * git. Read-only and deliberately NOT behind the per-repo action queue, so a search stays
 * snappy even while a fetch/pull is in flight on the same repo. The trade-off: a search
 * fired mid-commit (between `git add` and `git commit`) is a display-only snapshot that can
 * momentarily list a path the tree no longer shows — never a data hazard, and it self-heals
 * on the next keystroke.
 */
export async function searchChangedContent(repoId: string, query: string): Promise<SearchResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const needle = query.trim();
  if (needle.length < MIN_CONTENT_SEARCH) return { ok: true, code: "OK", paths: [] };
  const backend = backendFor(repo.vcs);
  try {
    const changed = await backend.readChanges(repo.absPath, false);
    if (changed.length === 0) return { ok: true, code: "OK", paths: [] };
    const paths = await backend.searchContent(repo.absPath, needle, changed.map((f) => f.path));
    return { ok: true, code: "OK", paths };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

export interface DiffResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "NOTHING_TO_COMMIT" | "ERROR";
  message?: string;
  diff?: string;
}

/**
 * Collect a repo's working-tree diff for an AI prompt, behind the per-repo op-queue
 * (so it can't race a fetch/pull/push/commit). Refuses a clean tree — there is nothing
 * to write a message about. Read-only; never mutates the index.
 */
export async function collectRepoDiff(repoId: string): Promise<DiffResult> {
  const g = guardRepo<"ERROR">(repoId, "ERROR");
  if (g.fail) return g.fail;
  const repo = g.repo;
  const backend = backendFor(repo.vcs);
  return enqueue(repoId, async () => {
    // C5: the backend's readStatus takes the read-gate (git) but is NOT itself enqueued, so calling
    // it inside this op-queue slot cannot deadlock. It holds the op slot while awaiting a read slot —
    // intentional, so the status check + diff are one consistent snapshot.
    const st = await backend.readStatus(repo.absPath);
    if (st.error) return { ok: false, code: "ERROR" as const, message: st.error };
    if (st.dirty === 0) return { ok: false, code: "NOTHING_TO_COMMIT" as const, message: "nothing to commit" };
    const diff = await backend.collectAiDiff(repo.absPath);
    return { ok: true, code: "OK" as const, diff };
  });
}

/**
 * Collect a repo's diff SCOPED to a subset of paths, for regenerating one proposed commit's
 * message from just its files. Behind the per-repo op-queue, read-only. Refuses a submodule
 * or an empty path set; an empty scoped diff still returns OK (the model gets the file list).
 */
export async function collectRepoPathsDiff(repoId: string, paths: string[]): Promise<DiffResult> {
  const g = guardRepo<"ERROR">(repoId, "ERROR");
  if (g.fail) return g.fail;
  const repo = g.repo;
  if (paths.length === 0) return { ok: false, code: "NOTHING_TO_COMMIT", message: "no files selected" };
  const backend = backendFor(repo.vcs);
  return enqueue(repoId, async () => {
    const diff = await backend.collectAiDiff(repo.absPath, paths);
    return { ok: true, code: "OK" as const, diff };
  });
}

// ── smart commit (AI multi-commit splitter): plan input ──────────────────────────────

export interface PlanInputResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "NOTHING_TO_COMMIT" | "ERROR";
  message?: string;
  input?: CommitPlanInput;
}

/**
 * Collect the read-only input for the AI commit planner, behind the per-repo op-queue (so
 * it can't race a fetch/pull/push/commit). Refuses a clean tree and submodules. Read-only;
 * never mutates the index. The route turns this into a plan via ai.generateCommitPlan.
 */
export async function planCommitInput(repoId: string): Promise<PlanInputResult> {
  const g = guardRepo<"ERROR">(repoId, "ERROR");
  if (g.fail) return g.fail;
  const repo = g.repo;
  const backend = backendFor(repo.vcs);
  return enqueue(repoId, async () => {
    // C5: the backend's readStatus takes the read-gate (git) but is NOT itself enqueued, so calling
    // it inside this op-queue slot can't deadlock — intentional, so status + plan input are one snapshot.
    const st = await backend.readStatus(repo.absPath);
    if (st.error) return { ok: false, code: "ERROR" as const, message: st.error };
    if (st.dirty === 0) return { ok: false, code: "NOTHING_TO_COMMIT" as const, message: "nothing to commit" };
    const input = await planInputFor(backend, repo.absPath);
    return { ok: true, code: "OK" as const, input };
  });
}

/** AI smart-commit plan input. Git uses the rich collector (folds noisy files, `-U0`, binary
 *  detection); other backends (Lore) build it from the changed-file list + the backend's AI diff —
 *  the file list drives grouping, the diff carries the textual context. */
async function planInputFor(backend: VcsBackend, absPath: string): Promise<CommitPlanInput> {
  if (backend.kind === "git") return collectCommitPlanInput(absPath);
  const changed = await backend.readChanges(absPath, true);
  const diff = await backend.collectAiDiff(absPath);
  const files: PlanInputFile[] = changed.map((f) => ({
    path: f.path,
    status: f.status,
    ...(f.from ? { from: f.from } : {}),
    additions: f.stat?.addedLines ?? 0,
    removals: f.stat?.removedLines ?? 0,
    binary: false,
  }));
  return { files, diff, truncated: false };
}
