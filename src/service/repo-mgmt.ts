/**
 * Repo lifecycle management: discover a scan root, forget repos under a removed root, and
 * the manual-targeting paths (register an existing repo, clone git/Lore, create new). Each
 * indexes → watches → refreshes the repo and broadcasts the SSE event so the dashboard
 * fills in live.
 */
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { pathWithin } from "../paths.ts";
import { broadcast } from "../bus.ts";
import { getRepo, getRepos, getIdentity, upsertRepo, deleteRepos } from "../db.ts";
import { discoverStream } from "../discovery.ts";
import { gitFor } from "../git.ts";
import { detectVcs } from "../vcs/index.ts";
import { loreClone } from "../vcs/lore.ts";
import { gitClone } from "../git-actions.ts";
import type { RepoView } from "../db.ts";
import { refreshRepo } from "./core.ts";
import { watchOne, unwatchOne } from "./watch.ts";

// ── scan-root discovery / removal ─────────────────────────────────────────────────
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
    // null → refused (path is under the OS temp dir); SKIP_DIRS already prunes these during the
    // walk, so this should essentially never fire, but never watch/broadcast a null id.
    if (!id) return;
    watchOne(id, f.absPath);
    // Fire-and-forget: a bad repo can't halt discovery of the rest; its status row stays stale.
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
  const victims = getRepos().filter((r) => r.source === "auto" && pathWithin(root, r.absPath));
  for (const r of victims) unwatchOne(r.id);
  deleteRepos(victims.map((r) => r.id));
  for (const r of victims) broadcast("repo_removed", { id: r.id });
  return victims.length;
}

/**
 * "Clean up missing directories": drop every repo entry (regardless of source: auto, pinned,
 * or created) whose absolute path no longer exists on disk. Unlike `forgetReposUnder`, this is
 * NOT scoped to a removed scan root or to auto-discovered repos: a manually pinned/cloned repo
 * whose folder was since deleted or moved is exactly as stale as an auto-discovered one, and
 * nothing else in the app ever re-validates a repo row's path once it's indexed. Unwatches +
 * deletes + broadcasts `repo_removed` per victim (mirrors forgetReposUnder). Returns how many
 * entries were removed.
 */
export function cleanupMissingRepos(): number {
  const victims = getRepos().filter((r) => !existsSync(r.absPath));
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
  // Detect the VCS instead of hardcoding a `.git` check — a valid Lore repo (`.lore`, when
  // Lore is enabled) would otherwise be silently rejected. detectVcs returns null for neither.
  const vcs = detectVcs(p);
  if (!vcs) {
    return { ok: false, code: "NOT_A_REPO", message: "that folder is not a git or Lore repository" };
  }
  // Only a git worktree has the `.git`-as-file submodule marker; Lore has no submodule concept.
  const isSubmodule = vcs === "git" && lstatSync(join(p, ".git")).isFile();
  const id = upsertRepo(p, basename(p) || p, "pinned", isSubmodule, vcs);
  if (!id) {
    return {
      ok: false,
      code: "TEMP_PATH_REFUSED",
      message: "that folder is inside a temporary directory and will not be added",
    };
  }
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
  if (!id) {
    return {
      ok: false,
      code: "TEMP_PATH_REFUSED",
      message: "that folder is inside a temporary directory and will not be added",
    };
  }
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
  if (!id) {
    return {
      ok: false,
      code: "TEMP_PATH_REFUSED",
      message: "that folder is inside a temporary directory and will not be added",
    };
  }
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
  if (!id) {
    return {
      ok: false,
      code: "TEMP_PATH_REFUSED",
      message: "that folder is inside a temporary directory and will not be added",
    };
  }
  watchOne(id, p);
  await refreshRepo(id, p);
  return { ok: true, code: "OK", message: "created", repo: getRepo(id) ?? undefined };
}
