/**
 * Read a repo's current state via the system git binary (simple-git).
 *
 * One `git status` call gives branch, ahead/behind, and the dirty file set; a
 * `rev-parse` records HEAD's exact object id and the remote URL is resolved (usually
 * from the config-keyed cache). A 30s block timeout guards against a hung child
 * (e.g. an SSH key prompt). `behind` reflects the last fetch only — we never fetch
 * here, so a watch event never touches the network.
 */
import { stat, readFile } from "node:fs/promises";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
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
const REMOTE_CACHE_MAX = 10_000;
const remoteCache = new Map<string, { sig: string; remote: string | null }>();

function cachedRemote(absPath: string, sig: string): string | null | undefined {
  const hit = remoteCache.get(absPath);
  if (!hit || hit.sig !== sig) return undefined;
  remoteCache.delete(absPath);
  remoteCache.set(absPath, hit);
  return hit.remote;
}

function rememberRemote(absPath: string, entry: { sig: string; remote: string | null }): void {
  remoteCache.delete(absPath);
  if (remoteCache.size >= REMOTE_CACHE_MAX) {
    const oldest = remoteCache.keys().next().value as string | undefined;
    if (oldest !== undefined) remoteCache.delete(oldest);
  }
  remoteCache.set(absPath, entry);
}

/** A cheap, change-sensitive signature for `.git/config`, or null when it can't be read. */
async function configSig(absPath: string): Promise<string | null> {
  try {
    const s = await stat(join(absPath, ".git", "config"));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null; // `.git` is a file (worktree/submodule) or config missing — don't cache
  }
}

async function resolveRemote(git: SimpleGit, absPath: string): Promise<string | null> {
  const sig = await configSig(absPath);
  if (sig !== null) {
    const hit = cachedRemote(absPath, sig);
    if (hit !== undefined) return hit;
  }
  let remote: string | null = null;
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0];
    remote = origin?.refs?.fetch || origin?.refs?.push || null;
  } catch {
    /* no remotes configured */
  }
  if (sig !== null) rememberRemote(absPath, { sig, remote });
  return remote;
}

/** Full ref identity for invalidation. An unborn/missing ref has no object yet. */
async function resolveOid(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    const oid = (await git.revparse(["--verify", ref])).trim();
    // Git repositories may use SHA-1 (40 hex) or SHA-256 (64 hex). Refuse any diagnostic
    // text rather than letting an unexpected command response become an unstable signal.
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid) ? oid.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Stable identity for every ref that can add/remove/decorate a row in History.
 *
 * `for-each-ref` reads only Git's ref store (it does not walk commits), and one sorted command
 * covers loose, packed, and reftable refs across linked worktrees. Recomputing is intentional:
 * this value is itself the cache-invalidation key, so caching it behind filesystem metadata
 * would reintroduce the stale-ref edge case it exists to prevent.
 */
export async function resolveHistoryRefsHash(git: SimpleGit): Promise<string> {
  const refs = await git.raw([
    "for-each-ref",
    "--sort=refname",
    // `symref` matters for decorations such as origin/HEAD -> origin/main: its object id can
    // stay identical when the symbolic target changes.
    "--format=%(refname)%00%(objectname)%00%(symref)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  return createHash("sha256").update(refs, "utf8").digest("hex");
}

interface WorktreeStatusPath {
  path: string;
  from?: string;
  index: string;
  working_dir: string;
}

/**
 * Stable, content-free identity for the path/state inputs that control checkout safety.
 *
 * A plain dirty-file count misses important transitions (`a.ts` → `b.ts`, staged → unstaged)
 * that can flip a pull between ready and WOULD_OVERWRITE. The staged-index identity includes
 * exact blob OIDs, so replacing the staged contents of the same `M` path also invalidates a
 * preview. Sorting keeps simple-git's output order out of the path/status portion; filenames and
 * object IDs never leave this SHA-256 digest.
 *
 * This also covers Conflict Concierge's resolve transition for free: `readChanges`'s `resolved`
 * flag is derived from a path leaving the unmerged index/working-dir pair (e.g. `UU` → `M `
 * after `git add`), and that pair is already part of `state` below — verified empirically
 * (scratch repo, 2026-07-27) that resolving a conflict changes this hash without any extra input.
 */
function worktreeStateHash(
  files: readonly WorktreeStatusPath[],
  stagedIndexIdentity: string,
): string {
  const state = files
    .map((file) => [
      file.path,
      file.from ?? "",
      file.index ?? " ",
      file.working_dir ?? " ",
    ])
    .sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        const compared = (a[i] ?? "").localeCompare(b[i] ?? "");
        if (compared !== 0) return compared;
      }
      return 0;
    });
  return createHash("sha256")
    .update(JSON.stringify(state), "utf8")
    .update("\0", "utf8")
    .update(stagedIndexIdentity, "utf8")
    .digest("hex");
}

/** Which unmerged porcelain pair a conflicted path is in. X = index = "us"/ours,
 *  Y = worktree = "them"/theirs. */
export type ConflictKind =
  | "both-modified" // UU
  | "both-added" // AA
  | "both-deleted" // DD
  | "added-by-us" // AU
  | "added-by-them" // UA
  | "deleted-by-us" // DU
  | "deleted-by-them"; // UD

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
  /** Set only while the path is STILL unmerged. Pairs with status === "C". */
  conflict?: ConflictKind;
  /** Set when this path was conflicted in the in-progress merge/rebase/cherry-pick and has
   *  since been resolved (staged). Mutually exclusive with `conflict`. */
  resolved?: boolean;
}

/** True when a porcelain index/working-dir letter pair marks an unmerged/conflicted path.
 *  Shared by readChanges (per-file "C" status) and readStatus (aggregate `conflicted` flag)
 *  so both agree on exactly one definition. */
function isConflictPair(x: string, y: string): boolean {
  return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

/** Which conflict an unmerged porcelain pair represents, per git-status(1)'s own "Unmerged"
 *  table (DD/AU/UD/UA/DU/AA/UU) — the same 7 pairs isConflictPair() treats as conflicted, just
 *  named instead of collapsed to a bare boolean. Kept as a separate function (rather than
 *  changing isConflictPair's return type) because readStatus's aggregate `conflicted` flag and
 *  readWorktreeStateHash only ever needed the boolean and must keep working unchanged. */
function conflictKind(x: string, y: string): ConflictKind | undefined {
  if (x === "D" && y === "D") return "both-deleted";
  if (x === "A" && y === "A") return "both-added";
  if (x === "U" && y === "U") return "both-modified";
  if (x === "A" && y === "U") return "added-by-us";
  if (x === "U" && y === "A") return "added-by-them";
  if (x === "D" && y === "U") return "deleted-by-us";
  if (x === "U" && y === "D") return "deleted-by-them";
  return undefined;
}

/**
 * Git-dir path for reading operation-scoped marker files (MERGE_MSG) straight off disk.
 * Mirrors the `.git`-file (linked worktree/submodule) resolution in src/git.ts's private
 * gitDirFor — that helper isn't exported, and this call site only ever runs while
 * currentGitOperation() has already reported a merge/rebase/cherry-pick in progress (a rare,
 * non-hot event), so it intentionally skips gitDirFor's LRU cache rather than duplicating it.
 */
async function gitMetaDir(absPath: string): Promise<string | null> {
  const marker = join(absPath, ".git");
  try {
    const s = await stat(marker);
    if (s.isDirectory()) return marker;
    if (!s.isFile() || s.size > 16_384) return null;
    const content = await readFile(marker, "utf8");
    const target = /^gitdir:\s*(.+?)\s*$/im.exec(content)?.[1]?.trim();
    if (!target) return null;
    return isAbsolute(target) ? target : resolve(dirname(marker), target);
  } catch {
    return null; // no `.git` marker at all — can't locate MERGE_MSG
  }
}

/**
 * Paths listed in `.git/MERGE_MSG`'s "Conflicts:" block for the CURRENT in-progress
 * merge/rebase/cherry-pick step — the one on-disk record of "what was conflicted a moment
 * ago" once a path has been `git add`-ed and no longer shows as unmerged in porcelain status.
 *
 * Verified empirically in a scratch repo (2026-07-27) for all three operations: `git merge`,
 * `git rebase` (each interactive pick), and `git cherry-pick` all write an identical
 * `# Conflicts:\n#\t<path>\n...` block to MERGE_MSG — always LF-terminated, always a bare
 * `#\t<path>` line with no "deleted by us:"-style prefix even for add/add or delete/modify
 * conflicts — and it survives `git add` (resolution) until the step is committed/continued,
 * at which point the NEXT step (or a clean MERGE_MSG-less repo) simply won't match this shape.
 * A rebase's later picks overwrite MERGE_MSG with that pick's own conflicts only, which is
 * exactly the "still relevant right now" set we want, not stale history from earlier picks.
 */
async function conflictedPathsFromMergeMsg(absPath: string): Promise<Set<string> | null> {
  const gitDir = await gitMetaDir(absPath);
  if (!gitDir) return null;
  let content: string;
  try {
    content = await readFile(join(gitDir, "MERGE_MSG"), "utf8");
  } catch {
    return null; // no merge message — e.g. a rebase step with no conflicts to report
  }
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === "# Conflicts:");
  if (start === -1) return null;
  const paths = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^#\t(.+)$/.exec(lines[i] ?? "");
    if (!match?.[1]) break;
    paths.add(match[1]);
  }
  return paths;
}

/**
 * Hash the exact staged index delta together with the canonical porcelain path/status tuples.
 *
 * `git diff --cached --raw --no-abbrev` is deliberately proportional to staged changes rather
 * than every tracked file, which keeps the hot status path practical in large repositories. Its
 * raw records contain each stage-0 blob OID and mode, work with an unborn HEAD, and are stable
 * across locale/diff-driver settings. An unmerged raw diff uses zero OIDs, so only in that rare
 * state do we append `ls-files --unmerged` to include the exact stage 1/2/3 entries.
 */
export async function readWorktreeStateHash(
  git: SimpleGit,
  files: readonly WorktreeStatusPath[],
): Promise<string> {
  const hasUnmerged = files.some((file) =>
    isConflictPair(file.index ?? " ", file.working_dir ?? " "),
  );
  const hasStaged = files.some((file) => {
    const index = file.index ?? " ";
    return index !== " " && index !== "?";
  });
  // A clean, untracked-only, or unstaged-only index is already identified by HEAD plus the
  // porcelain tuples. Avoid an extra Git child on those overwhelmingly common status ticks.
  const staged = hasStaged
    ? await git.raw([
        "diff",
        "--cached",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "--no-ext-diff",
        "--ignore-submodules=none",
        "-z",
      ])
    : "";
  const unmerged = hasUnmerged
    ? await git.raw(["ls-files", "--unmerged", "--stage", "-z"])
    : "";
  return worktreeStateHash(files, `${staged}\0${unmerged}`);
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
    // The "resolved" marker needs "what was conflicted a moment ago", which only exists while a
    // merge/rebase/cherry-pick is actually in progress. currentGitOperation is one filesystem
    // stat/readdir and spawns no git subprocess (readStatus makes its own separate call — this
    // is not shared with it), so a clean repo pays exactly that and never opens MERGE_MSG.
    const gitOperation = await currentGitOperation(absPath);
    const priorConflicts = gitOperation ? await conflictedPathsFromMergeMsg(absPath) : null;
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
      // A path is "resolved" only once it's left the unmerged pair AND MERGE_MSG shows it was
      // part of THIS operation's conflict set — otherwise an ordinary staged M/A on an unrelated
      // path during a merge would be mislabeled as a just-resolved conflict.
      const resolved = !conflicted && priorConflicts?.has(f.path) ? true : undefined;
      return {
        path: f.path,
        status: letter,
        staged: !untracked && x !== " ",
        ...(from ? { from } : {}),
        ...(conflicted ? { conflict: conflictKind(x, y) } : {}),
        ...(resolved ? { resolved } : {}),
      };
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
      const [remote, headOid, upstreamOid, historyRefsHash] = await Promise.all([
        resolveRemote(git, absPath),
        resolveOid(git, "HEAD"),
        resolveOid(git, "@{u}"),
        resolveHistoryRefsHash(git),
      ]);
      const statusStateHash = await readWorktreeStateHash(git, status.files);
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
      // extra git subprocess for `conflicted` — `gitOperation` is a filesystem-only marker check
      // on normal checkouts/worktrees, shared with the auto-commit gate via currentGitOperation).
      const conflicted = status.files.some((f) => isConflictPair(f.index ?? " ", f.working_dir ?? " "));
      const gitOperation = await currentGitOperation(absPath);
      return {
        branch: status.current ?? null,
        detached,
        headOid,
        upstreamOid,
        historyRefsHash,
        worktreeStateHash: statusStateHash,
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
      headOid: null,
      upstreamOid: null,
      historyRefsHash: null,
      worktreeStateHash: null,
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
