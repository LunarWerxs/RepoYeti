/**
 * Orchestration layer between the HTTP routes / watcher and the git plumbing.
 *
 * Everything that touches a repo goes through the per-repo operation queue, so a
 * user-triggered fetch/pull/push can never race the watcher's status read (or each
 * other) on the same repo. After any action we re-read and broadcast status, so the
 * phone sees the result over SSE without polling.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join, basename, dirname, relative, isAbsolute } from "node:path";
import { enqueue } from "./opqueue.ts";
import { readStatus, readChanges, type ChangedFile } from "./status.ts";
import { diffStatsEnabled } from "./diffstat.ts";
import { broadcast } from "./bus.ts";
import { getRepo, getRepos, getWatchableRepos, getIdentity, setRepoStatus, upsertRepo, setRepoOrder, deleteRepos } from "./db.ts";
import { discoverStream } from "./discovery.ts";
import { resolveRepoIdentity } from "./identity.ts";
import { gitFor } from "./git.ts";
import { backendFor } from "./vcs/index.ts";
import { loreFilePatch, loreDiscardFile, loreClone } from "./vcs/lore.ts";
import type { VcsBackend } from "./vcs/types.ts";
import {
  gitPullFfOnly,
  gitPush,
  gitClone,
  gitRemoteSet,
  gitRemoteRemove,
  gitTagCreate,
  collectCommitDiff,
  collectPathsDiff,
  collectCommitPlanInput,
  gitCommitGroups,
  fileDiffPatch,
  grepChangedContent,
  type ActionResult,
  type ActionCode,
  type CommitGroupSpec,
  type CommitGroupResult,
} from "./git-actions.ts";
import type { CommitPlanInput } from "./ai.ts";
import { readTags, type BranchList, type LogResult, type StashList, type TagList } from "./inspect.ts";
import { watchRepo, type WatchHandle } from "./watcher.ts";
import type { Identity, RepoView } from "./db.ts";

/** Per-repo last-status signature (sans timestamp) so a no-op read doesn't emit. */
const lastStatusSig = new Map<string, string>();

// ── watcher registry (lets repos registered/created at runtime get watched live) ──
const watchHandles = new Map<string, WatchHandle>();
// Repos whose fs.watch couldn't be installed run a low-frequency polling fallback so
// they don't silently go stale; the timer ids live here keyed by repo id.
const pollHandles = new Map<string, ReturnType<typeof setTimeout>>();
// Repo ids whose live watch is unhealthy (watch failed → polling). For diagnostics.
const unhealthyWatch = new Set<string>();

// Watcher/poll refreshes are fire-and-forget and bursty; collapse them per repo to at most
// one in-flight + one trailing pass, so a flurry of fs events (or refreshes piling up behind
// a slow 30s git read) can't stack into a deep queue of soon-obsolete status reads. The
// user-facing paths (runAction, forceRefresh) still await refreshRepo directly, so their
// returned result stays exact.
const refreshBusy = new Set<string>();
const refreshAgain = new Set<string>();

function coalescedRefresh(repoId: string, absPath: string): void {
  if (refreshBusy.has(repoId)) {
    refreshAgain.add(repoId); // a read is already running for this repo — fold into a trailing pass
    return;
  }
  refreshBusy.add(repoId);
  void refreshRepo(repoId, absPath).finally(() => {
    refreshBusy.delete(repoId);
    if (refreshAgain.delete(repoId)) coalescedRefresh(repoId, absPath);
  });
}

/** Base/jitter for the watch-failure poll fallback — slow and spread out, since this is
 *  a degraded path, not the primary signal. Jitter avoids a synchronized poll stampede. */
const POLL_BASE_MS = 30_000;
const POLL_JITTER_MS = 10_000;
const nextPollDelay = (): number => POLL_BASE_MS + Math.floor(Math.random() * POLL_JITTER_MS);

function startPollFallback(repoId: string, absPath: string): void {
  if (pollHandles.has(repoId)) return;
  unhealthyWatch.add(repoId);
  console.warn(
    `gitmob: filesystem watch unavailable for ${absPath} — using ~${Math.round(POLL_BASE_MS / 1000)}s polling. ` +
      `Live updates may lag; check OS watch limits (e.g. fs.inotify.max_user_watches on Linux).`,
  );
  const tick = (): void => {
    coalescedRefresh(repoId, absPath);
    pollHandles.set(repoId, setTimeout(tick, nextPollDelay())); // self-reschedule with fresh jitter
  };
  pollHandles.set(repoId, setTimeout(tick, nextPollDelay()));
}

export function watchOne(repoId: string, absPath: string): void {
  if (watchHandles.has(repoId)) return;
  // Watch the VCS's marker dir (.git / .lore) so a Lore repo's metadata changes still tick.
  const marker = backendFor(getRepo(repoId)?.vcs ?? "git").marker;
  const handle = watchRepo(absPath, () => coalescedRefresh(repoId, absPath), marker);
  watchHandles.set(repoId, handle);
  if (!handle.watching) startPollFallback(repoId, absPath);
}
/** Tear down a single repo's watcher/poll/registries (used when a scan root is removed). */
export function unwatchOne(repoId: string): void {
  const h = watchHandles.get(repoId);
  if (h) {
    h.close();
    watchHandles.delete(repoId);
  }
  const t = pollHandles.get(repoId);
  if (t) {
    clearTimeout(t);
    pollHandles.delete(repoId);
  }
  unhealthyWatch.delete(repoId);
  refreshBusy.delete(repoId);
  refreshAgain.delete(repoId);
  lastStatusSig.delete(repoId);
}
export function startWatching(repos: Array<{ id: string; absPath: string }>): void {
  for (const r of repos) watchOne(r.id, r.absPath);
}
export function stopWatching(): void {
  for (const h of watchHandles.values()) h.close();
  watchHandles.clear();
  for (const t of pollHandles.values()) clearTimeout(t);
  pollHandles.clear();
  unhealthyWatch.clear();
  refreshBusy.clear();
  refreshAgain.clear();
}

/** Watcher health snapshot for diagnostics/tests: how many repos are watched live vs
 *  degraded to polling, and which ids are degraded. */
export function watcherHealth(): { watched: number; polling: number; unhealthy: string[] } {
  return { watched: watchHandles.size, polling: pollHandles.size, unhealthy: [...unhealthyWatch] };
}

/** Read a repo's status behind its op-queue; persist + push over SSE only on change. */
export async function refreshRepo(id: string, absPath: string, markFetched = false): Promise<void> {
  const previous = getRepo(id)?.status;
  const backend = backendFor(getRepo(id)?.vcs ?? "git");
  const status = await enqueue(id, () => backend.readStatus(absPath, diffStatsEnabled()));
  if (markFetched) status.fetchedAt = Date.now();
  else status.fetchedAt = previous?.fetchedAt ?? null;
  const { updatedAt: _omit, ...sig } = status;
  const signature = JSON.stringify(sig);
  if (lastStatusSig.get(id) === signature) return;
  lastStatusSig.set(id, signature);
  setRepoStatus(id, status);
  broadcast("repo_state_changed", { id, status });
}

/**
 * Re-read every watched repo (coalesced, fire-and-forget). Used when the diff-stats
 * setting flips, so each card's aggregate stat appears/clears right away instead of
 * waiting for the next filesystem event.
 */
export function refreshAllRepos(): void {
  for (const r of getWatchableRepos()) coalescedRefresh(r.id, r.absPath);
}

export interface ActionOutcome extends ActionResult {
  repoId: string;
}

type VcsAction = (backend: VcsBackend, absPath: string, identity: Identity | null) => Promise<ActionResult>;

async function runAction(repoId: string, action: VcsAction, markFetched = false): Promise<ActionOutcome> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found", repoId };
  if (repo.isSubmodule) {
    return { ok: false, code: "SUBMODULE_NOT_ACTIONABLE", message: "submodule worktree is not actionable", repoId };
  }
  const identity = resolveRepoIdentity(repo);
  const backend = backendFor(repo.vcs);
  const result = await enqueue(repoId, () => action(backend, repo.absPath, identity));
  // Reflect the new reality (ahead/behind/dirty) to all clients.
  await refreshRepo(repoId, repo.absPath, markFetched && result.ok);
  return { ...result, repoId };
}

export const fetchRepo = (id: string): Promise<ActionOutcome> => runAction(id, (b, p, idn) => b.fetch(p, idn), true);
export const pullRepo = (id: string): Promise<ActionOutcome> => runAction(id, (b, p, idn) => b.pull(p, idn), true);
export const pushRepo = (id: string): Promise<ActionOutcome> => runAction(id, (b, p, idn) => b.push(p, idn));
export const commitRepo = (
  id: string,
  message: string,
  amend = false,
): Promise<ActionOutcome> =>
  runAction(id, (b, p, idn) => b.commitAll(p, idn, message, amend));

// ── branch actions (switch / create / delete) ─────────────────────────────────────
export const checkoutRepo = (id: string, branch: string): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.checkout(p, branch));
export const createBranchRepo = (id: string, name: string, switchTo = true): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.createBranch(p, name, switchTo));
export const deleteBranchRepo = (id: string, name: string): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.deleteBranch(p, name));

// ── stash actions (save / pop / drop) ─────────────────────────────────────────────
export const stashSaveRepo = (id: string, message?: string): Promise<ActionOutcome> =>
  runAction(id, (b, p, idn) => b.stashSave(p, idn, message));
export const stashPopRepo = (id: string, index = 0): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.stashPop(p, index));
export const stashDropRepo = (id: string, index = 0): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.stashDrop(p, index));

// ── remote actions (set-url / remove origin) ──────────────────────────────────────
// Local `.git/config` edits (no network). runAction refreshes status after, so the card's
// remote URL + the cloud icon update over SSE immediately.
export const setRemoteRepo = (id: string, name: string, url: string): Promise<ActionOutcome> =>
  runAction(id, (_b, p) => gitRemoteSet(p, name, url));
export const removeRemoteRepo = (id: string, name: string): Promise<ActionOutcome> =>
  runAction(id, (_b, p) => gitRemoteRemove(p, name));

// ── tag creation (git-only; the route guards on repo.vcs) ──────────────────────────
export const createTagRepo = (
  id: string,
  name: string,
  message?: string,
  push = false,
): Promise<ActionOutcome> =>
  runAction(id, (_b, p, idn) => gitTagCreate(p, idn, name, message, push));

// ── read-only inspection (branches / log / stashes) ───────────────────────────────
// Deliberately NOT behind the per-repo op-queue (reads stay snappy during a fetch/pull).
const NOT_FOUND_BRANCHES: BranchList = { ok: false, code: "ERROR", message: "repo not found", current: null, detached: false, branches: [] };

export function getBranches(repoId: string): Promise<BranchList> {
  const repo = getRepo(repoId);
  if (!repo) return Promise.resolve(NOT_FOUND_BRANCHES);
  return backendFor(repo.vcs).listBranches(repo.absPath);
}

export function getLog(repoId: string, limit?: number, skip?: number): Promise<LogResult> {
  const repo = getRepo(repoId);
  if (!repo) return Promise.resolve({ ok: false, code: "ERROR", message: "repo not found", commits: [], hasMore: false });
  return backendFor(repo.vcs).readLog(repo.absPath, limit, skip);
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

// ── bulk fetch-all ────────────────────────────────────────────────────────────────
export interface FetchAllResult {
  /** Repos that had a remote and were attempted. */
  total: number;
  /** How many fetched cleanly. */
  ok: number;
  /** Per-repo failures (so the UI can name them). */
  failed: Array<{ id: string; name: string; code: string }>;
}

/**
 * Fetch every repo that has a remote. Each goes through `fetchRepo` → the per-repo op-queue
 * and the network gate (`netGate`, default 4 concurrent), so firing them all at once stays
 * bounded — no new concurrency logic needed. Repos with no remote are skipped (not failures).
 */
export async function fetchAllRepos(): Promise<FetchAllResult> {
  const repos = getWatchableRepos().filter((r) => r.status?.remote);
  const results = await Promise.allSettled(repos.map((r) => fetchRepo(r.id)));
  const failed: FetchAllResult["failed"] = [];
  let ok = 0;
  results.forEach((res, i) => {
    if (res.status === "fulfilled" && res.value.ok) ok++;
    else {
      const code = res.status === "fulfilled" ? res.value.code : "ERROR";
      failed.push({ id: repos[i]!.id, name: repos[i]!.name, code });
    }
  });
  return { total: repos.length, ok, failed };
}

// ── scan-root discovery / removal ─────────────────────────────────────────────────
/** True when `p` is the root itself or sits inside it. */
function isPathUnder(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Discover one newly-added scan root in the background, mirroring boot discovery:
 * index → watch → status-read each repo as it's found and broadcast `repo_added` so the
 * dashboard fills in live over SSE. Fire-and-forget from the route (a big root can take a
 * while); errors are swallowed so a bad path can't crash the daemon.
 */
export async function discoverRoot(absPath: string, maxDepth: number, maxRepos: number): Promise<number> {
  let count = 0;
  await discoverStream([absPath], maxDepth, maxRepos, (f) => {
    const id = upsertRepo(f.absPath, f.name, "auto", f.isSubmodule, f.vcs);
    watchOne(id, f.absPath);
    void refreshRepo(id, f.absPath).catch(() => {});
    const repo = getRepo(id);
    if (repo) {
      count++;
      broadcast("repo_added", { repo });
    }
  });
  return count;
}

/**
 * Forget every AUTO-discovered repo under a removed scan root: unwatch it, drop its DB row,
 * and broadcast `repo_removed` so the dashboard drops the card live. Repos the owner pinned
 * explicitly (`source` 'pinned'/'created') are LEFT alone — removing a scan root shouldn't
 * delete a repo they deliberately added by path. Returns how many were forgotten.
 */
export function forgetReposUnder(rootAbs: string): number {
  const root = resolve(rootAbs);
  const victims = getRepos().filter((r) => r.source === "auto" && isPathUnder(root, r.absPath));
  for (const r of victims) unwatchOne(r.id);
  deleteRepos(victims.map((r) => r.id));
  for (const r of victims) broadcast("repo_removed", { id: r.id });
  return victims.length;
}

// ── manual targeting: register an existing repo, or create a new one ──────────────
export interface RepoMutation {
  ok: boolean;
  code: string;
  message: string;
  repo?: RepoView;
}

/** "Point to Folder" — index an existing git repo by absolute path. */
export async function registerRepo(inputPath: string): Promise<RepoMutation> {
  const p = resolve(inputPath);
  if (!existsSync(p)) return { ok: false, code: "NOT_FOUND", message: "that path does not exist" };
  if (!existsSync(join(p, ".git"))) {
    return { ok: false, code: "NOT_A_REPO", message: "that folder is not a git repository" };
  }
  const gitEntry = join(p, ".git");
  const id = upsertRepo(p, basename(p) || p, "pinned", lstatSync(gitEntry).isFile());
  watchOne(id, p);
  await refreshRepo(id, p);
  return { ok: true, code: "OK", message: "registered", repo: getRepo(id) ?? undefined };
}

/**
 * "Clone" — clone `url` into `<parentAbs>/<name>` with the chosen identity's SSH key, then
 * index/watch/refresh it and announce it over SSE. The caller (route) has already validated the
 * URL scheme, the name, that `parentAbs` is under a scan root, and that the target doesn't
 * exist. The cloned repo is recorded as source 'created' (the owner deliberately added it).
 */
export async function cloneRepo(
  parentAbs: string,
  name: string,
  url: string,
  identityId: string | null,
): Promise<RepoMutation> {
  const identity = identityId ? getIdentity(identityId) : null;
  const res = await gitClone(parentAbs, url, name, identity);
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  const dest = join(parentAbs, name);
  const id = upsertRepo(dest, name, "created", false);
  watchOne(id, dest);
  await refreshRepo(id, dest);
  const repo = getRepo(id);
  if (repo) broadcast("repo_added", { repo });
  return { ok: true, code: "OK", message: "cloned", repo: repo ?? undefined };
}

/**
 * Clone a Lore repo from a server URL into `<parentAbs>/<name>`, then index/watch/refresh it as
 * a Lore repo (vcs="lore"). Mirrors cloneRepo (git); server auth is Lore's own session
 * (`lore login`), so no SSH key/identity is injected. The route validates the URL + parent.
 */
export async function cloneLoreRepo(parentAbs: string, name: string, url: string): Promise<RepoMutation> {
  const dest = join(parentAbs, name);
  const res = await loreClone(parentAbs, url, dest);
  if (!res.ok) return { ok: false, code: "ERROR", message: res.message ?? "lore clone failed" };
  const id = upsertRepo(dest, name, "created", false, "lore");
  watchOne(id, dest);
  await refreshRepo(id, dest);
  const repo = getRepo(id);
  if (repo) broadcast("repo_added", { repo });
  return { ok: true, code: "OK", message: "cloned", repo: repo ?? undefined };
}

/** "Create New" — make a directory and `git init` it. */
export async function createRepo(inputPath: string): Promise<RepoMutation> {
  const p = resolve(inputPath);
  if (existsSync(join(p, ".git"))) {
    return { ok: false, code: "EXISTS", message: "that folder is already a git repository" };
  }
  try {
    mkdirSync(p, { recursive: true });
    await gitFor(p).init(["-b", "main"]);
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
  const id = upsertRepo(p, basename(p) || p, "created", false);
  watchOne(id, p);
  await refreshRepo(id, p);
  return { ok: true, code: "OK", message: "created", repo: getRepo(id) ?? undefined };
}

/**
 * Force a fresh status read (the phone's "pull to refresh"). Catches working-tree
 * edits the `.git`-only watcher intentionally doesn't see. Returns the latest view.
 */
export async function forceRefresh(repoId: string): Promise<RepoView | null> {
  const repo = getRepo(repoId);
  if (!repo) return null;
  await refreshRepo(repo.id, repo.absPath);
  return getRepo(repo.id);
}

/** Persist the user's drag-to-reorder of the repo list (order = repo ids top→bottom). */
export function reorderRepos(orderedIds: string[]): void {
  setRepoOrder(orderedIds);
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
  // Content search uses `git grep`; not wired for non-git backends (Lore) yet → no matches.
  if (repo.vcs !== "git") return { ok: true, code: "OK", paths: [] };
  try {
    const changed = await readChanges(repo.absPath, false);
    if (changed.length === 0) return { ok: true, code: "OK", paths: [] };
    const paths = await grepChangedContent(repo.absPath, needle, changed.map((f) => f.path));
    return { ok: true, code: "OK", paths };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** A single file's contents for the read-only source-control viewer. */
export interface FileContentResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  /** Repo-relative path (normalised to forward slashes). */
  path?: string;
  /** UTF-8 text, or "" when binary. Truncated to MAX_FILE_BYTES if oversized. */
  content?: string;
  /** True when the bytes look binary — `content` is empty and the UI shows a notice. */
  binary?: boolean;
  /** True when the file exceeded the size cap and `content` is only its head. */
  truncated?: boolean;
  /** Byte size of the source (working-tree file, or the HEAD blob). */
  size?: number;
  /** Which revision the bytes came from — "head" means the working file was gone (deleted). */
  ref?: "work" | "head";
}

/** Cap how much we ship to the browser editor — big enough for real source, small
 *  enough that Monaco stays snappy and we never stream a multi-MB blob to a phone. */
const MAX_FILE_BYTES = 2_000_000;

/** A NUL byte in the head of the file is the cheap, git-style "this is binary" signal. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** True when `target` is the repo root itself or sits inside it (blocks `../` escapes). */
function isInsideRepo(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Last-committed contents of a path (used for files deleted from the working tree). */
async function readFromHead(absPath: string, clean: string): Promise<FileContentResult> {
  try {
    // `git show HEAD:<path>` decodes to a string; good enough for the deleted-file case.
    const content = await gitFor(absPath).raw(["show", `HEAD:${clean}`]);
    const binary = content.includes("\u0000");
    const size = Buffer.byteLength(content, "utf8");
    const truncated = size > MAX_FILE_BYTES;
    return {
      ok: true,
      code: "OK",
      path: clean,
      ref: "head",
      size,
      binary,
      truncated,
      content: binary ? "" : truncated ? content.slice(0, MAX_FILE_BYTES) : content,
    };
  } catch {
    return { ok: false, code: "NOT_FOUND", message: "file not found" };
  }
}

interface TextRead {
  content: string;
  binary: boolean;
  truncated: boolean;
  size: number;
}

/** Working-tree text for an absolute path (read straight off disk), or null if it's gone. */
async function readWorkText(abs: string): Promise<TextRead | null> {
  const file = Bun.file(abs);
  if (!(await file.exists())) return null;
  const size = file.size;
  const slice = size > MAX_FILE_BYTES ? file.slice(0, MAX_FILE_BYTES) : file;
  const bytes = new Uint8Array(await slice.arrayBuffer());
  if (looksBinary(bytes)) return { content: "", binary: true, truncated: false, size };
  return {
    content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    binary: false,
    truncated: size > MAX_FILE_BYTES,
    size,
  };
}

/** Normalise + confine an untrusted request path to the repo (blocks `../` escapes). */
function resolveRepoPath(
  absPath: string,
  relPath: string,
): { clean: string; abs: string } | { error: string } {
  const clean = String(relPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!clean) return { error: "path is required" };
  const abs = resolve(absPath, clean);
  if (!isInsideRepo(absPath, abs)) return { error: "path escapes the repository" };
  return { clean, abs };
}

/**
 * Read one changed file's contents for the viewer drawer. Read-only and untrusted-path
 * safe: the request's path is normalised and confined to the repo (no traversal). The
 * working-tree version is read straight off disk (fast, no git); a path that's gone from
 * the working tree (a deletion) falls back to its last-committed blob so it's still
 * viewable. Binary files and oversized files come back flagged rather than dumped.
 */
export async function readFileContent(
  repoId: string,
  relPath: string,
  ref: "work" | "head" = "work",
): Promise<FileContentResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };

  try {
    if (ref === "work") {
      const work = await readWorkText(r.abs);
      if (work) return { ok: true, code: "OK", path: r.clean, ref: "work", ...work };
      // deleted from the working tree → fall through to the committed version
    }
    const head = await readFromHead(repo.absPath, r.clean);
    return head.ok ? head : { ok: false, code: "NOT_FOUND", message: "file not found" };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Result of writing an edited file back to the working tree (the viewer's Edit mode). */
export interface WriteFileResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "TOO_LARGE" | "IS_BINARY" | "NOT_WRITABLE";
  message?: string;
  /** Repo-relative path that was written (normalised to forward slashes). */
  path?: string;
  /** Byte size written. */
  size?: number;
}

/**
 * Overwrite a working-tree file with edited text from the viewer's Edit mode. Untrusted-path
 * safe: the request path is normalised and confined to the repo exactly like readFileContent
 * (no `../` escapes). Refuses NUL-bearing (binary) content, content over the size cap, and
 * non-regular targets — a symlink (which could redirect the write outside the repo) or a
 * directory. The watcher and the route's forceRefresh then surface the change to the UI.
 */
export async function writeFileContent(
  repoId: string,
  relPath: string,
  content: string,
): Promise<WriteFileResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };

  // Never let an edit reach a .git directory — writing .git/hooks/* would be arbitrary code
  // execution on the next git command. The UI only opens tracked changes, but the endpoint is
  // directly reachable, so guard it here. (Covers submodule .git dirs too.)
  if (r.clean.split("/").includes(".git")) {
    return { ok: false, code: "NOT_WRITABLE", message: "refusing to write inside a .git directory" };
  }

  // A NUL byte means the text isn't really text — refuse so we don't write a corrupt blob.
  if (content.includes(String.fromCharCode(0))) {
    return { ok: false, code: "IS_BINARY", message: "refusing to write binary content" };
  }
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_BYTES) {
    return { ok: false, code: "TOO_LARGE", message: `file exceeds the ${MAX_FILE_BYTES}-byte edit limit` };
  }

  // If what's already on disk is bigger than we ever ship to the editor, the incoming text is
  // necessarily a truncated view — refuse so we don't lop off the file's tail. (Mirrors the
  // client's canEdit gate at the server, in case a crafted request bypasses the UI.)
  const onDisk = Bun.file(r.abs);
  if ((await onDisk.exists()) && onDisk.size > MAX_FILE_BYTES) {
    return { ok: false, code: "TOO_LARGE", message: "the file on disk is larger than the edit limit" };
  }

  // Resolve symlinks for real: the *real* parent dir must sit inside the *real* repo root,
  // so a symlinked parent can't redirect the write outside the repo.
  try {
    if (!isInsideRepo(realpathSync(repo.absPath), realpathSync(dirname(r.abs)))) {
      return { ok: false, code: "NOT_WRITABLE", message: "path escapes the repository" };
    }
  } catch {
    return { ok: false, code: "NOT_FOUND", message: "parent directory does not exist" };
  }
  // Refuse a symlink or directory at the leaf itself; otherwise a fresh write is fine.
  try {
    const st = lstatSync(r.abs);
    if (st.isSymbolicLink()) return { ok: false, code: "NOT_WRITABLE", message: "refusing to write through a symlink" };
    if (st.isDirectory()) return { ok: false, code: "NOT_WRITABLE", message: "path is a directory" };
  } catch {
    /* nothing at the leaf yet — a fresh write is fine */
  }

  // Atomic replace: write a sibling temp file, then rename over the target. rename() never
  // follows a symlink at the destination (closing the lstat→write TOCTOU window), and a crash
  // mid-write can't leave a half-written source file.
  const tmp = `${r.abs}.gitmob-${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(tmp, content);
    renameSync(tmp, r.abs);
    return { ok: true, code: "OK", path: r.clean, size };
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup of the temp file */
    }
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Both sides of a changed file's diff for the viewer's Diff tab (mirrors web/src/types.ts). */
export interface FileDiffResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  path?: string;
  /** How the diff is shipped: "models" (default) = the original+modified pair for a rich
   *  side-by-side editor · "patch" = a single unified `git diff`, used for large modified
   *  files so we send only the hunks instead of both whole copies. */
  mode?: "models" | "patch";
  /** Last-committed (HEAD) text — "" for a newly-added/untracked file. ("models" mode.) */
  original?: string;
  /** Working-tree text — "" for a file deleted from the working tree. ("models" mode.) */
  modified?: string;
  /** Unified `git diff HEAD` text — present only in "patch" mode. */
  patch?: string;
  /** True when either side is binary — no textual diff is shown. */
  binary?: boolean;
  /** True when either side hit the size cap ("models"), or the patch did ("patch"). */
  truncated?: boolean;
}

/**
 * File-viewer Diff-tab threshold (bytes): a changed file bigger than this on either side
 * ships as a compact server-computed `git diff` (patch mode) instead of both whole files for
 * a rich side-by-side view. Owner setting (`cfg.diffPatchBytes`, surfaced in Settings),
 * mirrored here at runtime — set at boot + on the settings route, read by readFileDiff.
 * Clamped to [MIN, MAX]; values are powers of two so the Settings presets read as real KB/MB.
 */
export const DIFF_PATCH_BYTES_DEFAULT = 512 * 1024; // 512 KB
const DIFF_PATCH_BYTES_MIN = 64 * 1024; // 64 KB
const DIFF_PATCH_BYTES_MAX = 2 * 1024 * 1024; // 2 MB
let _diffPatchBytes = DIFF_PATCH_BYTES_DEFAULT;

export function getDiffPatchBytes(): number {
  return _diffPatchBytes;
}
/** Set the threshold, clamped to the safe range. Returns the value actually stored so the
 *  caller can persist the clamped number (not the raw, possibly out-of-range, input). */
export function setDiffPatchBytes(bytes: number): number {
  _diffPatchBytes = Math.min(DIFF_PATCH_BYTES_MAX, Math.max(DIFF_PATCH_BYTES_MIN, Math.round(bytes)));
  return _diffPatchBytes;
}

/**
 * Owner setting: when false the viewer NEVER switches large files to the compact patch —
 * every changed file loads as a full side-by-side diff (so a file past the read cap may be
 * truncated). Default true (patch mode on). Mirrored at runtime like the threshold above.
 */
let _diffPatchEnabled = true;
export function getDiffPatchEnabled(): boolean {
  return _diffPatchEnabled;
}
export function setDiffPatchEnabled(enabled: boolean): void {
  _diffPatchEnabled = enabled;
}

/** Cheap binary probe of a working-tree file — peek the head for a NUL byte (git's signal),
 *  without reading the whole (possibly large) file. */
async function workLooksBinary(abs: string): Promise<boolean> {
  const head = new Uint8Array(await Bun.file(abs).slice(0, 8000).arrayBuffer());
  return looksBinary(head);
}

/**
 * Both versions of a changed file for the Diff view: the HEAD blob (original) and the
 * working-tree file (modified). Added/untracked files have an empty original; deleted
 * files have an empty modified — so the diff reads naturally for every git status.
 */
export async function readFileDiff(repoId: string, relPath: string): Promise<FileDiffResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };

  // Non-git (Lore): `lore diff <path>` yields a unified working-vs-current-revision patch —
  // the viewer's "patch" mode. Reconstructing both whole sides isn't needed for a read-only view.
  if (repo.vcs !== "git") {
    const lr = await loreFilePatch(repo.absPath, r.clean);
    return lr.ok
      ? { ok: true, code: "OK", path: r.clean, mode: "patch", patch: lr.patch, truncated: lr.truncated }
      : { ok: false, code: "ERROR", message: lr.message ?? "lore diff failed" };
  }

  try {
    // Probe both sides' sizes cheaply (a working-tree stat + the HEAD blob size) BEFORE
    // reading megabytes off disk. A path that isn't in HEAD throws → it's newly added.
    const workFile = Bun.file(r.abs);
    const inWork = await workFile.exists();
    const workSize = inWork ? workFile.size : 0;
    let headSize = 0;
    let inHead = false;
    try {
      headSize = parseInt((await gitFor(repo.absPath).raw(["cat-file", "-s", `HEAD:${r.clean}`])).trim(), 10) || 0;
      inHead = true;
    } catch {
      /* not in HEAD → newly added / untracked */
    }

    // Large AND modified (present on BOTH sides) → compact diff: let git compute the patch
    // and ship only that. Added/deleted files stay on the model path — one side is empty
    // there, so the "diff" already IS the single file and there's nothing smaller to send.
    // Skipped entirely when the owner has turned patch mode off (always side-by-side).
    if (
      getDiffPatchEnabled() &&
      inWork &&
      inHead &&
      Math.max(workSize, headSize) > getDiffPatchBytes() &&
      !(await workLooksBinary(r.abs))
    ) {
      const { patch, truncated } = await fileDiffPatch(repo.absPath, r.clean);
      if (patch.trim()) return { ok: true, code: "OK", path: r.clean, mode: "patch", patch, truncated };
      // empty patch (e.g. a mode-only change) → fall through to the model view
    }

    const [head, work] = await Promise.all([
      readFromHead(repo.absPath, r.clean),
      readWorkText(r.abs),
    ]);
    if (!head.ok && !work) return { ok: false, code: "NOT_FOUND", message: "file not found" };
    return {
      ok: true,
      code: "OK",
      path: r.clean,
      mode: "models",
      original: head.ok ? (head.content ?? "") : "",
      modified: work?.content ?? "",
      binary: (head.binary ?? false) || (work?.binary ?? false),
      truncated: (head.truncated ?? false) || (work?.truncated ?? false),
    };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Result of discarding one file's working-tree changes (the changes-tree "Discard" action). */
export interface DiscardResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "DISCARD_FAILED" | "SUBMODULE_NOT_ACTIONABLE";
  message?: string;
  /** Repo-relative path that was discarded (normalised to forward slashes). */
  path?: string;
}

/**
 * Discard one changed file's working-tree changes — the inverse of the file editor.
 * Untrusted-path safe (confined to the repo exactly like readFileContent), behind the
 * per-repo op-queue, and DESTRUCTIVE — the UI gates it behind an explicit confirm.
 *
 * Three cases, all "restore this file to its committed/absent state":
 *  - tracked in HEAD (modified or deleted) → `git checkout HEAD -- <path>` restores it.
 *  - added/untracked (not in HEAD)         → remove the working file + unstage any add.
 * HEAD is never touched and no merge state is possible, so the safety invariant holds.
 */
export async function discardFile(repoId: string, relPath: string): Promise<DiscardResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  if (repo.isSubmodule) return { ok: false, code: "SUBMODULE_NOT_ACTIONABLE", message: "submodule worktree is not actionable" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  // Non-git (Lore): `lore reset --purge <path>` reverts the tracked file + deletes it if untracked.
  if (repo.vcs !== "git") {
    if (r.clean.split("/").includes(".lore")) {
      return { ok: false, code: "ERROR", message: "refusing to touch a .lore directory" };
    }
    const out = await enqueue(repoId, async (): Promise<DiscardResult> => {
      const lr = await loreDiscardFile(repo.absPath, r.clean);
      return lr.ok
        ? { ok: true, code: "OK" as const, path: r.clean }
        : { ok: false, code: "DISCARD_FAILED" as const, message: lr.message ?? "lore reset failed" };
    });
    if (out.ok) await refreshRepo(repo.id, repo.absPath);
    return out;
  }
  // Never reach into a .git dir (restoring .git/* would be nonsense / unsafe).
  if (r.clean.split("/").includes(".git")) {
    return { ok: false, code: "ERROR", message: "refusing to touch a .git directory" };
  }

  const result = await enqueue(repoId, async (): Promise<DiscardResult> => {
    try {
      const git = gitFor(repo.absPath);
      let inHead = false;
      try {
        await git.raw(["cat-file", "-e", `HEAD:${r.clean}`]);
        inHead = true;
      } catch {
        /* not in HEAD → newly added or untracked */
      }
      if (inHead) {
        // Restores both the index and the working tree to the committed content.
        await git.raw(["checkout", "HEAD", "--", r.clean]);
      } else {
        if (existsSync(r.abs) && lstatSync(r.abs).isFile()) unlinkSync(r.abs);
        // Drop any staged "add" for this path. No-op (and harmless throw) on an unborn HEAD.
        try {
          await git.raw(["reset", "-q", "--", r.clean]);
        } catch {
          /* unborn HEAD or nothing staged */
        }
      }
      return { ok: true, code: "OK" as const, path: r.clean };
    } catch (e) {
      return { ok: false, code: "DISCARD_FAILED" as const, message: e instanceof Error ? e.message : String(e) };
    }
  });
  // Refresh AFTER the queue slot releases (refreshRepo enqueues again → would deadlock if nested).
  if (result.ok) await refreshRepo(repo.id, repo.absPath);
  return result;
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
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  if (repo.isSubmodule) return { ok: false, code: "ERROR", message: "submodule worktree is not actionable" };
  return enqueue(repoId, async () => {
    const st = await readStatus(repo.absPath);
    if (st.error) return { ok: false, code: "ERROR" as const, message: st.error };
    if (st.dirty === 0) return { ok: false, code: "NOTHING_TO_COMMIT" as const, message: "nothing to commit" };
    const diff = await collectCommitDiff(repo.absPath);
    return { ok: true, code: "OK" as const, diff };
  });
}

/**
 * Collect a repo's diff SCOPED to a subset of paths, for regenerating one proposed commit's
 * message from just its files. Behind the per-repo op-queue, read-only. Refuses a submodule
 * or an empty path set; an empty scoped diff still returns OK (the model gets the file list).
 */
export async function collectRepoPathsDiff(repoId: string, paths: string[]): Promise<DiffResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  if (repo.isSubmodule) return { ok: false, code: "ERROR", message: "submodule worktree is not actionable" };
  if (paths.length === 0) return { ok: false, code: "NOTHING_TO_COMMIT", message: "no files selected" };
  return enqueue(repoId, async () => {
    const diff = await collectPathsDiff(repo.absPath, paths);
    return { ok: true, code: "OK" as const, diff };
  });
}

// ── smart commit (AI multi-commit splitter) ─────────────────────────────────────────

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
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  if (repo.isSubmodule) return { ok: false, code: "ERROR", message: "submodule worktree is not actionable" };
  return enqueue(repoId, async () => {
    const st = await readStatus(repo.absPath);
    if (st.error) return { ok: false, code: "ERROR" as const, message: st.error };
    if (st.dirty === 0) return { ok: false, code: "NOTHING_TO_COMMIT" as const, message: "nothing to commit" };
    const input = await collectCommitPlanInput(repo.absPath);
    return { ok: true, code: "OK" as const, input };
  });
}

export interface SmartCommitOutcome {
  ok: boolean;
  code: ActionCode;
  message: string;
  repoId: string;
  /** Per-group outcome, in order (present once execution started). */
  committed?: CommitGroupResult[];
  /** Groups not attempted because an earlier one failed. */
  remaining?: number;
  /** True when a requested post-commit push succeeded. */
  synced?: boolean;
  /** The sync (pull/push) code/message when sync was requested and didn't fully succeed. */
  syncCode?: ActionCode;
  syncMessage?: string;
}

/**
 * Execute an owner-edited commit plan: validate the submitted groups against the LIVE working
 * tree, then run the whole stage+commit sequence inside ONE op-queue slot (so nothing can
 * interleave), optionally syncing afterward, and refresh once the slot releases.
 *
 * Validation (against fresh `readChanges`):
 *  - every submitted path must currently be changed (a vanished/stale path → PLAN_STALE);
 *  - no path may appear in two groups (→ PLAN_PATHS_INVALID).
 * A rename's old path is auto-added to its group so the deletion lands with the addition.
 * Leaving some changed files unassigned is allowed — they simply stay in the working tree.
 */
export async function smartCommitRepo(
  repoId: string,
  commits: Array<{ message: string; paths: string[] }>,
  sync = false,
): Promise<SmartCommitOutcome> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found", repoId };
  if (repo.isSubmodule)
    return { ok: false, code: "SUBMODULE_NOT_ACTIONABLE", message: "submodule worktree is not actionable", repoId };
  if (commits.length === 0) return { ok: false, code: "EMPTY_PLAN", message: "no commits in the plan", repoId };
  const identity = resolveRepoIdentity(repo);

  const outcome = await enqueue(repoId, async (): Promise<Omit<SmartCommitOutcome, "repoId">> => {
    // Validate against the CURRENT tree (the plan may have been built minutes ago).
    const fresh = await readChanges(repo.absPath, false);
    const changedSet = new Set(fresh.map((f) => f.path));
    const renameFrom = new Map<string, string>();
    for (const f of fresh) if (f.from) renameFrom.set(f.path, f.from);

    const seen = new Set<string>();
    const specs: CommitGroupSpec[] = [];
    for (const c of commits) {
      const expanded: string[] = [];
      for (const raw of c.paths) {
        const p = raw.replace(/\\/g, "/").trim();
        if (!changedSet.has(p)) {
          return { ok: false, code: "PLAN_STALE", message: `"${p}" is no longer a pending change — re-plan` };
        }
        if (seen.has(p)) {
          return { ok: false, code: "PLAN_PATHS_INVALID", message: `"${p}" is assigned to more than one commit` };
        }
        seen.add(p);
        expanded.push(p);
        const from = renameFrom.get(p);
        if (from) expanded.push(from); // stage the rename's old path with the new one
      }
      specs.push({ message: c.message, paths: expanded });
    }

    const res = await gitCommitGroups(repo.absPath, identity, specs);
    const base: Omit<SmartCommitOutcome, "repoId"> = {
      ok: res.ok,
      code: res.code,
      message: res.message,
      committed: res.committed,
      remaining: res.remaining,
    };
    if (!res.ok || !sync) return base;

    // Post-commit sync (mirrors the UI's "commit & sync"): pull --ff-only, then push.
    const pull = await gitPullFfOnly(repo.absPath, identity);
    const push = await gitPush(repo.absPath, identity);
    if (push.ok) return { ...base, synced: true };
    return { ...base, synced: false, syncCode: push.code, syncMessage: push.message || pull.message };
  });

  // Refresh AFTER the slot releases (refreshRepo enqueues again → nesting would deadlock).
  await refreshRepo(repo.id, repo.absPath, outcome.ok && outcome.synced === true);
  return { ...outcome, repoId };
}
