/**
 * "Which unpushed commit does this change fix?" - read-only, answered with `git blame`.
 *
 * WHY: Smart Commit only ever makes NEW commits, so a change that corrects a commit still sitting
 * unpushed on the branch (review feedback, a typo in yesterday's work) lands as one more noise
 * commit. If every line the change touches was last written by the same unpushed commit, the
 * honest commit for it is `fixup! <that subject>`, which a later `git rebase --autosquash` on the
 * owner's desktop folds back in. RepoYeti never rebases (a phone is the wrong place to rewrite
 * history); it only names the right target and writes the conventional message.
 *
 * The approach follows lazygit's "find base commit for fixup" (jesseduffield/lazygit,
 * pkg/gui/controllers/helpers/fixup_helper.go, MIT): diff with zero context, blame the lines the
 * change DELETES or rewrites in HEAD's version, and only when a file has no deleted lines at all
 * fall back to blaming the lines around its pure insertions (weaker evidence, flagged `context`).
 * Written fresh for RepoYeti, and per FILE rather than per whole change, because Smart Commit
 * plans at file granularity. A file resolves only when every blamed line points at ONE commit
 * and that commit is unpushed; touching already-pushed lines, or lines from two unpushed commits,
 * leaves it unresolved so each fixup stays atomic.
 *
 * Git reads only; none of them modify the working tree, the index or any ref:
 *   · `rev-parse --verify HEAD`                 - an unborn branch has nothing to fix up
 *   · `log HEAD --not --remotes`                - the unpushed commits (not on any remote-tracking
 *                                                 ref; with no remote at all, local history is all
 *                                                 unpublished), capped at MAX_UNPUSHED_COMMITS
 *   · `diff --numstat -z --no-renames HEAD`     - which tracked files changed, and how much
 *   · `ls-files --others --exclude-standard`    - untracked files (always unresolved `new-file`)
 *   · `diff -U0 HEAD -- <file>`                 - that file's hunk headers
 *   · `blame --porcelain -L … HEAD -- <file>`   - who last wrote the touched lines
 */
import { gitFor } from "../git.ts";
import { readGate } from "../gitgate.ts";
import { parseNumstatZ, splitZ } from "./git-records.ts";

/** Most files examined per call (one diff + one blame spawn each). Past this, `truncated`. */
export const MAX_FIXUP_FILES = 100;
/** A file whose change is bigger than this (added + removed lines) is a rewrite, not a fixup. */
export const MAX_FIXUP_FILE_LINES = 5000;
/** How far back the unpushed range is read. A blame hit older than this counts as "pushed". */
export const MAX_UNPUSHED_COMMITS = 500;

const US = "\x1f";

/** How a file's target was proven: its deleted/rewritten lines (strong), or only the lines
 *  bordering its pure insertions (weak: new code next to X's code may still be a new feature). */
export type FixupEvidence = "deleted" | "context";

export type FixupUnresolvedReason =
  /** The touched lines come from two or more unpushed commits. */
  | "multiple"
  /** At least one touched line comes from a commit already pushed (or older than the cap). */
  | "pushed"
  /** Not in HEAD at all (staged or untracked): a brand-new file has no earlier commit to fix. */
  | "new-file"
  | "binary"
  | "too-large"
  /** No blameable lines (mode-only change, or a blame that could not run). */
  | "no-evidence";

export interface FixupFile {
  path: string;
  evidence: FixupEvidence;
}

/** One unpushed commit and the changed files that fix only it. */
export interface FixupTarget {
  hash: string;
  shortHash: string;
  subject: string;
  /** The commit message to use: `fixup! <subject>` (a subject already starting `fixup! ` is kept). */
  message: string;
  files: FixupFile[];
}

export interface FixupUnresolved {
  path: string;
  reason: FixupUnresolvedReason;
  /** Short hashes of the commits the blame hit, for `multiple` / `pushed`. */
  commits?: string[];
}

export interface FixupBaseResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  /** How many unpushed commits were considered. */
  unpushed: number;
  /** Every unpushed commit that at least one changed file resolves to, newest target first. */
  targets: FixupTarget[];
  /** The whole checked change resolves to exactly one commit (lazygit's atomic answer), else null. */
  single: FixupTarget | null;
  unresolved: FixupUnresolved[];
  /** True when more than MAX_FIXUP_FILES changed (or untracked) files matched and the rest were
   *  not examined. */
  truncated: boolean;
}

/** One `-U0` hunk header, `@@ -oldStart,oldCount +newStart,newCount @@` (counts default to 1). */
export interface ZeroContextHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

// Content lines in a unified diff always start with "+", "-", " " or "\", so a line starting
// "@@ -" can only be a hunk header.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Decode the hunk headers of one file's `git diff -U0` output. Pure. */
export function parseZeroContextHunks(diff: string): ZeroContextHunk[] {
  const out: ZeroContextHunk[] = [];
  for (const line of diff.split("\n")) {
    const m = HUNK_HEADER.exec(line);
    if (!m) continue;
    out.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return out;
}

/**
 * Which lines of HEAD's version to blame, as 1-based inclusive `[start, end]` ranges. Pure.
 *
 * Deleted or rewritten lines win outright: they were written by exactly the commit being fixed.
 * Only a file with no deleted line at all falls back to the lines around each insertion: for
 * `-a,0` the new text sits after old line `a`, so lines `a` and `a + 1` border it (just line 1
 * for an insertion at the top). `a + 1` can be past the end of the file; git clips a range END
 * itself, and blameCommits retries only when a START is past the end (an insertion into a file
 * that is empty in HEAD).
 */
export function blameRanges(
  hunks: readonly ZeroContextHunk[],
): { evidence: FixupEvidence; ranges: Array<[number, number]> } | null {
  const deleted = hunks
    .filter((h) => h.oldCount > 0)
    .map((h): [number, number] => [h.oldStart, h.oldStart + h.oldCount - 1]);
  if (deleted.length > 0) return { evidence: "deleted", ranges: deleted };
  const around = hunks.map((h): [number, number] => (h.oldStart < 1 ? [1, 1] : [h.oldStart, h.oldStart + 1]));
  return around.length > 0 ? { evidence: "context", ranges: around } : null;
}

/** Clip blame ranges to a file of `lines` lines, dropping any that start past the end. Pure. */
export function clipRanges(ranges: ReadonlyArray<[number, number]>, lines: number): Array<[number, number]> {
  return ranges
    .filter(([start]) => start <= lines)
    .map(([start, end]): [number, number] => [start, Math.min(end, lines)]);
}

// A porcelain group header: `<sha> <orig-line> <final-line>[ <count>]`. Metadata lines start with
// a lowercase key word and content lines with a TAB, so neither can match. 64 hex = SHA-256 repos.
const BLAME_HEADER = /^([0-9a-f]{64}|[0-9a-f]{40}) \d+ \d+/;

/** The distinct commits named in `git blame --porcelain` output, in first-seen order. Pure. */
export function parseBlameCommits(porcelain: string): string[] {
  const seen = new Set<string>();
  for (const line of porcelain.split("\n")) {
    const m = BLAME_HEADER.exec(line);
    if (m) seen.add(m[1]!);
  }
  return [...seen];
}

/** The conventional autosquash message for a target subject. */
export function fixupMessage(subject: string): string {
  return subject.startsWith("fixup! ") ? subject : `fixup! ${subject}`;
}

/** A changed file with the commits its touched lines blame to. */
export interface BlamedFile {
  path: string;
  evidence: FixupEvidence;
  commits: string[];
}

const short = (hash: string): string => hash.slice(0, 7);

/**
 * Turn per-file blame results into fixup targets. Pure: `unpushed` maps each unpushed commit's
 * full hash to its subject, in newest-first order. A file joins a target only when ALL of its
 * blamed commits are that one unpushed commit.
 */
export function resolveFixupTargets(
  files: readonly BlamedFile[],
  unpushed: ReadonlyMap<string, string>,
): { targets: FixupTarget[]; unresolved: FixupUnresolved[] } {
  const byHash = new Map<string, FixupFile[]>();
  const unresolved: FixupUnresolved[] = [];
  for (const f of files) {
    if (f.commits.length === 0) {
      unresolved.push({ path: f.path, reason: "no-evidence" });
      continue;
    }
    const outside = f.commits.filter((h) => !unpushed.has(h));
    if (outside.length > 0) {
      unresolved.push({ path: f.path, reason: "pushed", commits: f.commits.map(short) });
      continue;
    }
    if (f.commits.length > 1) {
      unresolved.push({ path: f.path, reason: "multiple", commits: f.commits.map(short) });
      continue;
    }
    const hash = f.commits[0]!;
    (byHash.get(hash) ?? byHash.set(hash, []).get(hash)!).push({ path: f.path, evidence: f.evidence });
  }
  // Newest target first, the order the unpushed log lists them in.
  const targets: FixupTarget[] = [];
  for (const [hash, subject] of unpushed) {
    const hit = byHash.get(hash);
    if (!hit) continue;
    targets.push({ hash, shortHash: short(hash), subject, message: fixupMessage(subject), files: hit });
  }
  return { targets, unresolved };
}

/** A result with no targets: the shape every early exit (and the service's non-git guard) returns. */
export function emptyFixupResult(code: FixupBaseResult["code"], message?: string): FixupBaseResult {
  return {
    ok: code === "OK",
    code,
    ...(message ? { message } : {}),
    unpushed: 0,
    targets: [],
    single: null,
    unresolved: [],
    truncated: false,
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Git = ReturnType<typeof gitFor>;

/** Unpushed commits, newest first: full hash to subject. */
async function readUnpushed(git: Git): Promise<Map<string, string>> {
  const out = await git.raw([
    "log",
    `--max-count=${MAX_UNPUSHED_COMMITS}`,
    `--format=%H${US}%s`,
    "HEAD",
    "--not",
    "--remotes",
  ]);
  const map = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [hash, subject = ""] = line.split(US);
    if (hash && /^[0-9a-f]{40,64}$/.test(hash)) map.set(hash, subject);
  }
  return map;
}

/** Blame the ranges in HEAD's copy of `path`. Returns "new-file" when HEAD has no such path. */
async function blameCommits(
  git: Git,
  path: string,
  ranges: ReadonlyArray<[number, number]>,
): Promise<string[] | "new-file"> {
  const run = async (rs: ReadonlyArray<[number, number]>): Promise<string[]> =>
    parseBlameCommits(
      await git.raw(["blame", "--porcelain", ...rs.flatMap(([a, b]) => ["-L", `${a},${b}`]), "HEAD", "--", path]),
    );
  try {
    return await run(ranges);
  } catch (e) {
    const msg = errorMessage(e);
    if (/no such path/i.test(msg)) return "new-file";
    // git clips a range END past end-of-file by itself, but rejects a START past it (an insertion
    // into a file that is empty in HEAD); it names the real length, so clip to it and blame once
    // more rather than reading the whole file to count its lines.
    const only = /has only (\d+) lines?/i.exec(msg);
    if (!only) throw e;
    const clipped = clipRanges(ranges, Number(only[1]));
    return clipped.length > 0 ? run(clipped) : [];
  }
}

/** Examine one changed file: its unresolved reason, or its blamed commits. */
async function examineFile(
  git: Git,
  path: string,
): Promise<{ blamed: BlamedFile } | { unresolved: FixupUnresolved }> {
  try {
    const diff = await git.raw(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "HEAD", "--", `:(literal)${path}`]);
    const plan = blameRanges(parseZeroContextHunks(diff));
    if (!plan) return { unresolved: { path, reason: "no-evidence" } };
    const commits = await blameCommits(git, path, plan.ranges);
    if (commits === "new-file") return { unresolved: { path, reason: "new-file" } };
    return { blamed: { path, evidence: plan.evidence, commits } };
  } catch {
    return { unresolved: { path, reason: "no-evidence" } };
  }
}

/**
 * Find, per changed tracked file, the one unpushed commit it fixes. `onlyPaths` scopes the check
 * to a subset (Smart Commit's checked selection); absent or empty means every changed file.
 * Read-only: never touches the index, the working tree or a ref.
 */
export async function readFixupBases(absPath: string, onlyPaths?: readonly string[]): Promise<FixupBaseResult> {
  try {
    return await readGate.run(async () => {
      const git = gitFor(absPath);
      // No `-q`: simple-git only rejects a failing command that wrote to stderr, so a quiet
      // failure would read as success. The empty-output check covers the same case twice over.
      let head = "";
      try {
        head = (await git.raw(["rev-parse", "--verify", "HEAD"])).trim();
      } catch {
        head = "";
      }
      if (!head) return emptyFixupResult("OK", "no commits yet");
      const unpushed = await readUnpushed(git);
      if (unpushed.size === 0) return emptyFixupResult("OK", "no unpushed commits");

      const pathspec = onlyPaths?.length ? ["--", ...onlyPaths.map((p) => `:(literal)${p}`)] : [];
      const changed = parseNumstatZ(
        splitZ(await git.raw(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "HEAD", ...pathspec])),
      );
      // Untracked files are invisible to `diff HEAD`, yet a whole-tree commit (`git add -A`) sweeps
      // them in: count each as an unresolved new file so `single` can never hide one.
      const untracked = splitZ(await git.raw(["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]));
      const truncated = changed.length > MAX_FIXUP_FILES || untracked.length > MAX_FIXUP_FILES;

      const blamed: BlamedFile[] = [];
      const skipped: FixupUnresolved[] = untracked
        .slice(0, MAX_FIXUP_FILES)
        .map((path): FixupUnresolved => ({ path, reason: "new-file" }));
      for (const rec of changed.slice(0, MAX_FIXUP_FILES)) {
        if (rec.binary) {
          skipped.push({ path: rec.path, reason: "binary" });
          continue;
        }
        if (rec.added + rec.removed > MAX_FIXUP_FILE_LINES) {
          skipped.push({ path: rec.path, reason: "too-large" });
          continue;
        }
        const r = await examineFile(git, rec.path);
        if ("blamed" in r) blamed.push(r.blamed);
        else skipped.push(r.unresolved);
      }

      const { targets, unresolved } = resolveFixupTargets(blamed, unpushed);
      const allUnresolved = [...skipped, ...unresolved];
      return {
        ok: true,
        code: "OK" as const,
        unpushed: unpushed.size,
        targets,
        single: targets.length === 1 && allUnresolved.length === 0 && !truncated ? targets[0]! : null,
        unresolved: allUnresolved,
        truncated,
      };
    });
  } catch (e) {
    return emptyFixupResult("ERROR", errorMessage(e));
  }
}
