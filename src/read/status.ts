/**
 * Read a repo's current state via the system git binary (simple-git).
 *
 * One `git status` call gives branch, ahead/behind, and the dirty file set; a
 * second cheap call resolves the remote URL. A 30s block timeout guards against
 * a hung child (e.g. an SSH key prompt). `behind` reflects the last fetch only —
 * we never fetch here, so a watch event never touches the network.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import type { SimpleGit } from "simple-git";
import { gitFor, currentGitOperation } from "../git.ts";
import { readGate } from "../gitgate.ts";
import { computeDiffStats, type DiffStat } from "./diffstat.ts";
import type { RepoStatus } from "../db.ts";

/**
 * Remote URLs change only when the user edits `.git/config` (`git remote add/set-url`),
 * which rewrites that file. So we cache the resolved origin URL per repo and reuse it
 * until `.git/config`'s mtime+size changes — the hot status path (every watch tick, every
 * post-action refresh) then skips a whole `git remote -v` subprocess. Worktrees/submodules
 * (`.git` is a file, no readable `config` here) simply don't cache and re-resolve each time.
 */
const remoteCache = new Map<string, { sig: string; remote: string | null }>();

/** A cheap, change-sensitive signature for `.git/config`, or null when it can't be read. */
function configSig(absPath: string): string | null {
  try {
    const s = statSync(join(absPath, ".git", "config"));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null; // `.git` is a file (worktree/submodule) or config missing — don't cache
  }
}

async function resolveRemote(git: SimpleGit, absPath: string): Promise<string | null> {
  const sig = configSig(absPath);
  if (sig !== null) {
    const hit = remoteCache.get(absPath);
    if (hit && hit.sig === sig) return hit.remote;
  }
  let remote: string | null = null;
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0];
    remote = origin?.refs?.fetch || origin?.refs?.push || null;
  } catch {
    /* no remotes configured */
  }
  if (sig !== null) remoteCache.set(absPath, { sig, remote });
  return remote;
}

/** One changed file for the tree view: porcelain status collapsed to a single letter. */
export interface ChangedFile {
  path: string;
  /** M(odified) · A(dded) · D(eleted) · R(enamed) · U(ntracked) · C(onflicted) */
  status: string;
  staged: boolean;
  /** Rename SOURCE path (present only for status "R"). The smart-commit executor stages a
   *  rename's old + new path together so the old-path deletion lands in the same commit. */
  from?: string;
  /** Per-file line/char delta — present only when the diff-stats setting is on. */
  stat?: DiffStat;
}

/** True when a porcelain index/working-dir letter pair marks an unmerged/conflicted path.
 *  Shared by readChanges (per-file "C" status) and readStatus (aggregate `conflicted` flag)
 *  so both agree on exactly one definition. */
function isConflictPair(x: string, y: string): boolean {
  return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

/**
 * The repo's changed-file list (names + status only — never file contents).
 * When `withStats` is on, each file also carries its line/char delta vs HEAD.
 */
export async function readChanges(absPath: string, withStats = false): Promise<ChangedFile[]> {
  // readGate bounds how many `git status` children run at once across all repos. When
  // stats are wanted, the diff runs inside this SAME slot (sequentially), so the pool
  // bound still holds and computeDiffStats never nests another gate.
  return readGate.run(async () => {
    const status = await gitFor(absPath).status();
    // simple-git surfaces renames in a separate `renamed: [{from,to}]` list; map by the
    // new path so we can attach the source path to the corresponding file entry.
    const renameFrom = new Map<string, string>();
    for (const r of status.renamed ?? []) {
      if (r?.to) renameFrom.set(r.to, r.from);
    }
    const files: ChangedFile[] = status.files.map((f) => {
      const x = f.index ?? " ";
      const y = f.working_dir ?? " ";
      const untracked = x === "?" || y === "?";
      const conflicted = isConflictPair(x, y);
      let letter: string;
      if (untracked) letter = "U";
      else if (conflicted) letter = "C";
      else if (renameFrom.has(f.path)) letter = "R";
      else letter = (y !== " " ? y : x) || "M";
      const from = renameFrom.get(f.path);
      return { path: f.path, status: letter, staged: !untracked && x !== " ", ...(from ? { from } : {}) };
    });
    if (withStats && files.length > 0) {
      const untracked = files.filter((f) => f.status === "U").map((f) => f.path);
      const { perFile } = await computeDiffStats(absPath, untracked);
      for (const f of files) {
        const s = perFile.get(f.path);
        if (s) f.stat = s;
      }
    }
    return files;
  });
}

/**
 * Read a repo's status. When `withDiff` is on, also compute the aggregate working-tree-
 * vs-HEAD line/char delta (so the card header can show it even while collapsed). The diff
 * runs inside the same readGate slot as the status read; preflights (pull/push/commit)
 * leave it off, so they never pay for a diff they don't use.
 */
export async function readStatus(absPath: string, withDiff = false): Promise<RepoStatus> {
  const updatedAt = Date.now();
  try {
    // One gate slot spans this repo's status (+ cached remote lookup + optional diff) so
    // boot hydration and SSE bursts can't fan out into hundreds of concurrent git children.
    return await readGate.run(async () => {
      const git = gitFor(absPath);
      const status = await git.status();
      const remote = await resolveRemote(git, absPath);
      const detached =
        Boolean(status.detached) || status.current === "HEAD" || status.current === null;
      let diff: DiffStat | null = null;
      if (withDiff && status.files.length > 0) {
        const untracked = status.files
          .filter((f) => f.index === "?" || f.working_dir === "?")
          .map((f) => f.path);
        diff = (await computeDiffStats(absPath, untracked)).total;
      }
      // Conflict Concierge inputs: cheap to compute alongside the status we already have (no
      // extra git subprocess for `conflicted` — `gitOperation` is one existsSync-only check,
      // shared with the auto-commit safety gate via src/git.ts currentGitOperation).
      const conflicted = status.files.some((f) => isConflictPair(f.index ?? " ", f.working_dir ?? " "));
      const gitOperation = await currentGitOperation(absPath);
      return {
        branch: status.current ?? null,
        detached,
        dirty: status.files.length,
        ahead: status.ahead ?? 0,
        behind: status.behind ?? 0,
        remote,
        error: null,
        fetchedAt: null,
        diff,
        conflicted,
        gitOperation,
        updatedAt,
      };
    });
  } catch (err) {
    return {
      branch: null,
      detached: false,
      dirty: 0,
      ahead: 0,
      behind: 0,
      remote: null,
      error: err instanceof Error ? err.message : String(err),
      fetchedAt: null,
      diff: null,
      updatedAt,
    };
  }
}
