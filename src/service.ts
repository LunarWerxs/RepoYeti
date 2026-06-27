/**
 * Orchestration layer between the HTTP routes / watcher and the git plumbing.
 *
 * Everything that touches a repo goes through the per-repo operation queue, so a
 * user-triggered fetch/pull/push can never race the watcher's status read (or each
 * other) on the same repo. After any action we re-read and broadcast status, so the
 * phone sees the result over SSE without polling.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { enqueue } from "./opqueue.ts";
import { readStatus } from "./status.ts";
import { broadcast } from "./bus.ts";
import { getRepo, setRepoStatus, upsertRepo } from "./db.ts";
import { resolveRepoIdentity } from "./identity.ts";
import { gitFor } from "./git.ts";
import { gitFetch, gitPullFfOnly, gitPush, gitCommitAll, type ActionResult } from "./git-actions.ts";
import { watchRepo, type WatchHandle } from "./watcher.ts";
import type { Identity, RepoView } from "./db.ts";

/** Per-repo last-status signature (sans timestamp) so a no-op read doesn't emit. */
const lastStatusSig = new Map<string, string>();

// ── watcher registry (lets repos registered/created at runtime get watched live) ──
const watchHandles = new Map<string, WatchHandle>();

export function watchOne(repoId: string, absPath: string): void {
  if (watchHandles.has(repoId)) return;
  watchHandles.set(
    repoId,
    watchRepo(absPath, () => void refreshRepo(repoId, absPath)),
  );
}
export function startWatching(repos: Array<{ id: string; absPath: string }>): void {
  for (const r of repos) watchOne(r.id, r.absPath);
}
export function stopWatching(): void {
  for (const h of watchHandles.values()) h.close();
  watchHandles.clear();
}

/** Read a repo's status behind its op-queue; persist + push over SSE only on change. */
export async function refreshRepo(id: string, absPath: string, markFetched = false): Promise<void> {
  const status = await enqueue(id, () => readStatus(absPath));
  if (markFetched) status.fetchedAt = Date.now();
  const { updatedAt: _omit, ...sig } = status;
  const signature = JSON.stringify(sig);
  if (lastStatusSig.get(id) === signature) return;
  lastStatusSig.set(id, signature);
  setRepoStatus(id, status);
  broadcast("repo_state_changed", { id, status });
}

export interface ActionOutcome extends ActionResult {
  repoId: string;
}

type GitAction = (absPath: string, identity: Identity | null) => Promise<ActionResult>;

async function runAction(repoId: string, action: GitAction, markFetched = false): Promise<ActionOutcome> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "ERROR", message: "repo not found", repoId };
  if (repo.isSubmodule) {
    return { ok: false, code: "ERROR", message: "submodule worktree is not actionable", repoId };
  }
  const identity = resolveRepoIdentity(repo);
  const result = await enqueue(repoId, () => action(repo.absPath, identity));
  // Reflect the new reality (ahead/behind/dirty) to all clients.
  await refreshRepo(repoId, repo.absPath, markFetched && result.ok);
  return { ...result, repoId };
}

export const fetchRepo = (id: string): Promise<ActionOutcome> => runAction(id, gitFetch, true);
export const pullRepo = (id: string): Promise<ActionOutcome> => runAction(id, gitPullFfOnly);
export const pushRepo = (id: string): Promise<ActionOutcome> => runAction(id, gitPush);
export const commitRepo = (id: string, message: string): Promise<ActionOutcome> =>
  runAction(id, (absPath, identity) => gitCommitAll(absPath, identity, message));

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
  const id = upsertRepo(p, basename(p) || p, "pinned", false);
  watchOne(id, p);
  await refreshRepo(id, p);
  return { ok: true, code: "OK", message: "registered", repo: getRepo(id) ?? undefined };
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
