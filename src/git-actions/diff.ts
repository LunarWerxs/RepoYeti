/**
 * Read-only, bounded collection of git diffs/status/grep results — the inputs fed to the AI
 * commit-message/planner prompts and the file viewer's compact-diff mode, plus the changes-tree
 * "search content" toggle. Every reader here streams stdout and kills the child at a byte cap so
 * a pathological change-set can't balloon memory, time, or a provider payload. Never mutates the
 * index.
 */
import { safeGitEnv } from "../git.ts";
import { readChanges } from "../read/status.ts";
import { normalizeRelPath } from "../paths.ts";
import type { CommitPlanInput, PlanInputFile } from "../ai.ts";
import { PATCH_CAP } from "../contract.ts";

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

/**
 * Accumulate a bounded `git diff` (up to `cap` bytes) with the unborn-HEAD fallback baked in: try
 * `git diff HEAD <extraArgs> [-- <chunk>…]`, and if that comes back empty — a repo with no commits
 * yet errors/empties on `diff HEAD` — retry the same WITHOUT `HEAD` against the worktree. Pass
 * `paths=null` (or empty) for the whole tree (no pathspec); otherwise the pathspec is chunked so a
 * big group can't overflow the OS arg limit. `extraArgs` carries per-caller flags (e.g. -U0 -M).
 * Read-only. Extracted so the three diff collectors share ONE fallback path.
 */
async function boundedDiff(
  absPath: string,
  paths: string[] | null,
  extraArgs: string[],
  cap: number,
): Promise<string> {
  const chunks: (string[] | null)[] = paths?.length ? chunkByBytes(paths) : [null];
  const run = async (base: string[]): Promise<string> => {
    let out = "";
    for (const chunk of chunks) {
      if (out.length >= cap) break;
      out += await boundedGit(absPath, chunk ? [...base, "--", ...chunk] : base, cap);
    }
    return out.trim();
  };
  const withHead = await run(["diff", "HEAD", ...extraArgs]);
  return withHead || (await run(["diff", ...extraArgs]));
}

export async function collectCommitDiff(absPath: string): Promise<string> {
  const status = (await boundedGit(absPath, ["status", "--porcelain=v1"], STATUS_CAP)).trim();
  const diff = await boundedDiff(absPath, null, [], DIFF_CAP);
  let combined =
    `# git status --porcelain\n${status || "(clean)"}\n\n# git diff\n${diff || "(no textual diff — new/untracked files only)"}`;
  if (combined.length > DIFF_CAP) combined = `${combined.slice(0, DIFF_CAP)}\n…[truncated]`;
  return combined;
}

/**
 * Like collectCommitDiff but SCOPED to a subset of paths — the input for regenerating ONE
 * proposed commit's message from just its files (`git status`/`git diff HEAD -- <paths>`).
 * Bounded + read-only; chunks the pathspec so a big group can't overflow the OS arg limit.
 */
export async function collectPathsDiff(absPath: string, paths: string[]): Promise<string> {
  if (paths.length === 0) return "";
  const chunks = chunkByBytes(paths);
  let status = "";
  for (const chunk of chunks) {
    if (status.length >= STATUS_CAP) break;
    status += await boundedGit(absPath, ["status", "--porcelain=v1", "--", ...chunk], STATUS_CAP);
  }
  status = status.trim();
  const diff = await boundedDiff(absPath, paths, [], DIFF_CAP);
  let combined =
    `# git status --porcelain\n${status || "(clean)"}\n\n# git diff\n${diff || "(no textual diff — new/untracked files only)"}`;
  if (combined.length > DIFF_CAP) combined = `${combined.slice(0, DIFF_CAP)}\n…[truncated]`;
  return combined;
}

/** The smart-commit planner gets a larger diff budget than the message path — grouping needs
 *  more of the picture than a one-line summary does. Still bounded so a giant change-set can't
 *  balloon the provider payload; the per-file list (always complete) carries the rest. */
const PLAN_DIFF_CAP = 40_000;

/** Lockfile basenames whose DIFF BODY is high-noise / low-signal for commit GROUPING. */
const NOISE_BASENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "cargo.lock", "composer.lock", "gemfile.lock", "poetry.lock", "pipfile.lock", "go.sum", "flake.lock",
]);
/** Generated / minified / derived extensions (matched on the lowercased basename). */
const NOISE_EXT = /\.(min\.js|min\.css|map|snap|lock|lockb)$/i;

/**
 * True for a file whose diff body the planner doesn't need to READ — lockfiles, minified bundles,
 * source maps, snapshots. It only needs to KNOW the file changed (its name + stat ride in the
 * file list either way), so we fold the body out of the planner's diff to save a lot of tokens
 * (a single lockfile diff can be thousands of lines). Borrowed concept: claw-compactor's "diff
 * folding". Pure + unit-tested. NOTE: only the PLANNER's diff folds these; message generation
 * (collectPathsDiff / collectCommitDiff) keeps full content.
 */
export function isNoisyPath(path: string): boolean {
  const base = (normalizeRelPath(path).split("/").pop() ?? "").toLowerCase();
  return NOISE_BASENAMES.has(base) || NOISE_EXT.test(base);
}

/**
 * Build the read-only input for the AI commit planner: the complete changed-file list (with
 * per-file +/- stats and rename sources) plus a bounded, TOKEN-TRIMMED diff. Never mutates the
 * index. The file list is authoritative (it drives validation + grouping); the diff is best-
 * effort context, sent at ZERO context (`-U0`, just the changed lines) and with noisy files'
 * bodies folded out (see isNoisyPath) — so a big change-set stays small enough for a provider's
 * rate limit. May still be truncated on a pathological change-set.
 */
export async function collectCommitPlanInput(absPath: string): Promise<CommitPlanInput> {
  const changed = await readChanges(absPath, true); // withStats → per-file add/remove counts

  // Only diff the files worth reading; fold out lockfiles/generated/minified (their name + stat
  // in the file list is enough for grouping). `-U0` trims to just the changed lines.
  const diffPaths = changed.map((f) => f.path).filter((p) => !isNoisyPath(p));
  // +1 on the cap so the truncation check below can tell "exactly at cap" from "overflowed".
  let diff = diffPaths.length > 0
    ? await boundedDiff(absPath, diffPaths, ["-U0", "--no-color", "-M"], PLAN_DIFF_CAP + 1)
    : "";
  const truncated = diff.length > PLAN_DIFF_CAP;
  if (truncated) diff = `${diff.slice(0, PLAN_DIFF_CAP)}\n…[truncated]`;

  // Best-effort binary flag: git prints "Binary files <a> and b/<p> differ". Match the b-side
  // path so both modified ("a/x and b/x") and newly-added ("/dev/null and b/x") binaries flag.
  const binaryPaths = new Set<string>();
  for (const m of diff.matchAll(/^Binary files .+? and b\/(.+?) differ$/gm)) {
    if (m[1]) binaryPaths.add(m[1]);
  }

  const files: PlanInputFile[] = changed.map((f) => ({
    path: f.path,
    status: f.status,
    ...(f.from ? { from: f.from } : {}),
    additions: f.stat?.addedLines ?? 0,
    removals: f.stat?.removedLines ?? 0,
    binary: binaryPaths.has(f.path),
  }));
  return { files, diff, truncated };
}

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
export function chunkByBytes(paths: string[], maxBytes = 8_000): string[][] {
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
