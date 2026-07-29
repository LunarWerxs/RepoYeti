/**
 * Diff statistics — added/removed line + character counts, per file and aggregated.
 *
 * The header on every (even collapsed) repo card wants a *total* line delta, so the
 * aggregate has to ride RepoStatus (computed in status.ts, broadcast over SSE). Line
 * counts are cheap, but CHARACTER counts need the actual patch text — so the whole
 * feature is gated behind an owner setting (off by default; see `diffStatsEnabled`).
 * When off, neither status reads nor the changes endpoint pay any of this cost.
 *
 * A "modified" line shows in a unified diff as one `-` (old) plus one `+` (new), so a
 * single edit counts as 1 removed + 1 added line. Characters, though, are counted INTRA-line:
 * only the differing middle of a `-`/`+` pair, not both whole lines. Charging whole lines made
 * the figure track line length rather than edit size — flipping one character on an 800-char
 * JSON line read as "+800 −800 characters" — while saying nothing the line count didn't. The
 * net (added − removed) is identical either way, so it still reflects how much the file grew
 * or shrank, which is the intuition behind "lines/characters changed".
 */
import { join } from "node:path";
import { open as openFile, stat as fileStat } from "node:fs/promises";
import { safeGitEnv } from "../git.ts";
import { normalizeRelPath } from "../paths.ts";

export interface DiffStat {
  addedLines: number;
  removedLines: number;
  addedChars: number;
  removedChars: number;
}

export function emptyStat(): DiffStat {
  return { addedLines: 0, removedLines: 0, addedChars: 0, removedChars: 0 };
}

export function addStat(a: DiffStat, b: DiffStat): DiffStat {
  return {
    addedLines: a.addedLines + b.addedLines,
    removedLines: a.removedLines + b.removedLines,
    addedChars: a.addedChars + b.addedChars,
    removedChars: a.removedChars + b.removedChars,
  };
}

// ── runtime on/off flag (mirrors cfg.diffStats; set at boot + on the toggle route) ──
let _enabled = false;
export function diffStatsEnabled(): boolean {
  return _enabled;
}
export function setDiffStatsEnabled(value: boolean): void {
  _enabled = value;
}

// ── unified-diff parsing ────────────────────────────────────────────────────────

/** Decode git's C-style quoted path (`"a/sp ace\t.txt"`) back to a plain string. */
function unquotePath(s: string): string {
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  try {
    return JSON.parse(s) as string; // handles the common \" \\ \t escapes
  } catch {
    return s.slice(1, -1); // best-effort: drop the quotes
  }
}

/** Turn a `--- a/path` / `+++ b/path` header value into a clean repo-relative path. */
function headerPath(raw: string): string | null {
  let s = raw.trim();
  const tab = s.indexOf("\t"); // git may append a tab + timestamp
  if (tab >= 0) s = s.slice(0, tab);
  s = unquotePath(s);
  if (s === "/dev/null") return null;
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return normalizeRelPath(s);
}

/**
 * Characters actually touched between an old and a new version of one line: shared prefix
 * and shared suffix trimmed off, the remaining middles counted. Editing one character on an
 * 800-character line yields [1, 1], not [800, 800].
 *
 * Trimming removes the SAME amount from both sides, so the net (added − removed) is exactly
 * what whole-line counting produced — the file-grew-or-shrank reading is preserved while the
 * gross figures stop being dominated by however long the line happened to be.
 */
function changedChars(oldLine: string, newLine: string): [removed: number, added: number] {
  const max = Math.min(oldLine.length, newLine.length);
  let pre = 0;
  while (pre < max && oldLine.charCodeAt(pre) === newLine.charCodeAt(pre)) pre++;
  // Bounded by `max - pre` so the suffix can never reach back across the matched prefix.
  let suf = 0;
  while (
    suf < max - pre &&
    oldLine.charCodeAt(oldLine.length - 1 - suf) === newLine.charCodeAt(newLine.length - 1 - suf)
  )
    suf++;
  return [oldLine.length - pre - suf, newLine.length - pre - suf];
}

/**
 * How much removed text may be held while waiting to be paired — the parser's only buffer that
 * isn't O(1). Budgeted in characters rather than lines so it bounds actual memory: long lines
 * are both the expensive ones to hold AND the ones pairing helps most, and a run big enough to
 * exhaust this is a whole-file rewrite, where per-line pairing tells you nothing anyway.
 */
const PAIR_BUFFER_CHARS = 8_000_000;
/**
 * Maximum content retained for one unterminated patch line. Minified/generated files can contain
 * a line hundreds of megabytes long; `pending += chunk` used to retain that entire line until the
 * newline (or the 1 GB patch cap), multiplied by every concurrent status refresh. Past this bound
 * the parser keeps only the line's prefix + length and falls back to whole-line character counts.
 */
export const PATCH_LINE_BUFFER_CHARS = 1_000_000;

/**
 * Incremental unified-diff parser. Fed arbitrary chunks (not necessarily line-aligned),
 * it retains only the per-file result map, one partial trailing line, and the current run of
 * removed lines awaiting pairing — so peak memory is O(changed files), NOT O(patch size).
 * That's what lets the byte cap below sit at a runaway-only number: a 10 MB diff no longer
 * has to exist in memory to be counted.
 *
 * Counts content lines only: `+`/`-` lines that aren't the `+++`/`---` file headers,
 * ignoring hunk headers (`@@`) and the "\ No newline at end of file" marker. The path is
 * taken from the `+++ b/…` header (falling back to `--- a/…` for deletions, where the new
 * side is /dev/null).
 *
 * LINE counts are the plain unified-diff reading: a modified line is 1 removed + 1 added.
 * CHARACTER counts are intra-line. A unified diff never says which `-` pairs with which `+`,
 * so within one contiguous run of changes we pair them in order (the natural reading, and
 * what the UI's own inline highlighter shows) and count only each pair's differing middle.
 * Unpaired lines — a pure insertion, a pure deletion, a longer added run than removed —
 * count in full, which is correct: all of their characters really are new or gone.
 */
export function createPatchStatParser() {
  const out = new Map<string, DiffStat>();
  let minusPath: string | null = null;
  let cur: DiffStat | null = null;
  // The `---`/`+++` file headers only appear before a file's first `@@` hunk. Once we're
  // inside a hunk, every `+`/`-` is content — including a line whose text itself starts
  // with `--`/`++` (e.g. a `--` comment or a `---` rule), which would otherwise be misread
  // as a header. Tracking the hunk boundary removes that ambiguity.
  let inHunk = false;
  let pending = "";
  let oversizedLine = false;
  let oversizedPrefix = "";
  let oversizedLength = 0;
  // The removed lines of the run in progress, and how many have been paired with an added
  // line so far. Anything still unpaired when the run ends gets charged in full.
  let removedRun: string[] = [];
  let paired = 0;
  let buffered = 0;

  function endRun(): void {
    if (cur) for (let i = paired; i < removedRun.length; i++) cur.removedChars += removedRun[i]?.length ?? 0;
    if (removedRun.length > 0) removedRun = [];
    paired = 0;
    buffered = 0;
  }

  function feedLine(line: string): void {
    // Hunk content first: a `-`/`+` here is text, never a file header.
    if (inHunk && cur) {
      if (line.startsWith("-")) {
        cur.removedLines++;
        const text = line.slice(1);
        // Past the budget, stop buffering and charge in full — a pathological run loses the
        // intra-line refinement rather than the memory bound.
        if (buffered + text.length <= PAIR_BUFFER_CHARS) {
          removedRun.push(text);
          buffered += text.length;
        } else {
          cur.removedChars += text.length;
        }
        return;
      }
      if (line.startsWith("+")) {
        cur.addedLines++;
        const text = line.slice(1);
        const old = paired < removedRun.length ? removedRun[paired++] : undefined;
        if (old !== undefined) {
          const [rem, add] = changedChars(old, text);
          cur.removedChars += rem;
          cur.addedChars += add;
        } else {
          cur.addedChars += text.length;
        }
        return;
      }
      // "\ No newline at end of file" sits between the two sides of an edit — it must not
      // break the run, or the pairing either side of it is lost.
      if (line.startsWith("\\")) return;
    }
    endRun(); // a context line, hunk header, or file header ends the current run
    if (line.startsWith("diff --git ")) {
      minusPath = null;
      cur = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith("--- ")) {
      minusPath = headerPath(line.slice(4));
    } else if (!inHunk && line.startsWith("+++ ")) {
      const p = headerPath(line.slice(4)) ?? minusPath;
      if (p) {
        cur = out.get(p) ?? emptyStat();
        out.set(p, cur);
      }
    } else if (line.startsWith("@@")) {
      inHunk = true;
    }
  }

  /**
   * Count a line whose body exceeded PATCH_LINE_BUFFER_CHARS without reconstructing it. Line
   * counts stay exact. Character counts intentionally fall back to whole-line accounting because
   * intra-line prefix/suffix comparison would require retaining the giant old/new bodies.
   */
  function feedOversizedLine(prefix: string, length: number): void {
    if (inHunk && cur) {
      const contentLength = Math.max(0, length - 1);
      if (prefix === "-") {
        cur.removedLines++;
        cur.removedChars += contentLength;
        return;
      }
      if (prefix === "+") {
        cur.addedLines++;
        const old = paired < removedRun.length ? removedRun[paired++] : undefined;
        if (old !== undefined) cur.removedChars += old.length;
        cur.addedChars += contentLength;
        return;
      }
      if (prefix === "\\") return;
    }
    // Headers/context lines this large are pathological too. They cannot safely affect parser
    // state, but they must still terminate a pending +/- run just like a normal context line.
    endRun();
  }

  function finishPendingLine(): void {
    if (oversizedLine) feedOversizedLine(oversizedPrefix, oversizedLength);
    else feedLine(pending);
    pending = "";
    oversizedLine = false;
    oversizedPrefix = "";
    oversizedLength = 0;
  }

  return {
    push(text: string): void {
      // Process each decoded chunk in place. Crucially, once a line crosses the cap we retain
      // only its first character and total length until newline; later chunks never get appended
      // to a giant string.
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline < 0 ? text.length : newline;
        const partLength = end - start;
        if (oversizedLine) {
          oversizedLength += partLength;
        } else if (pending.length + partLength <= PATCH_LINE_BUFFER_CHARS) {
          pending += text.slice(start, end);
        } else {
          oversizedLine = true;
          oversizedPrefix = pending[0] ?? text[start] ?? "";
          oversizedLength = pending.length + partLength;
          pending = "";
        }
        if (newline < 0) break;
        finishPendingLine();
        start = newline + 1;
      }
    },
    /** Current retained text, exposed for the memory-bound regression test. */
    retainedChars(): number {
      return pending.length + buffered;
    },
    /** Flush the unterminated last line (a patch needn't end in a newline) and hand back the map. */
    finish(): Map<string, DiffStat> {
      if (pending !== "" || oversizedLine) finishPendingLine();
      endRun(); // the patch can end mid-run — charge whatever never found a pair
      return out;
    },
  };
}

/** Parse a complete unified diff patch held in memory into per-file stats. */
export function parsePatchStats(patch: string): Map<string, DiffStat> {
  const parser = createPatchStatParser();
  parser.push(patch);
  return parser.finish();
}

// ── streaming caps ────────────────────────────────────────────────────────────────
// These remain generous enough for the multi-megabyte working trees this parser was made to
// support, but are real resource budgets. Status hydration runs across multiple repositories; a
// 1 GB per-repo cap multiplied by the read gate was enough to exhaust a workstation even when the
// parser eventually released every chunk.
const DIFF_CAP_BYTES = 32_000_000;
const DIFF_TIMEOUT_MS = 30_000;
const UNTRACKED_TOTAL_CAP = 32_000_000; // total bytes read across all untracked files
const UNTRACKED_FILE_CAP = 16_000_000; // skip any single untracked file larger than this
const BINARY_SNIFF_BYTES = 8000;

/**
 * Fold a byte stream into "everything is an addition" counts without ever materializing it.
 * Mirrors the old whole-string version exactly: chars are decoded UTF-16 length, and lines
 * are newline count plus one for an unterminated final line.
 *
 * Returns null for a file that sniffs binary (a NUL byte in the head, git's own cheap test)
 * — bytes already pulled still count against the caller's budget, since we did read them.
 */
async function countFile(
  absPath: string,
  cap: number,
  onBytes: (n: number) => void,
  readBuffer: Buffer,
): Promise<DiffStat | null> {
  const file = await openFile(absPath, "r");
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const s = emptyStat();
  let read = 0;
  let sniffed = 0;
  let binary = false;
  let endsWithNewline = true;
  try {
    while (read < cap) {
      const requested = Math.min(readBuffer.length, cap - read);
      const { bytesRead } = await file.read(readBuffer, 0, requested, null);
      if (bytesRead === 0) break;
      read += bytesRead;
      onBytes(bytesRead);
      const value = readBuffer.subarray(0, bytesRead);
      for (let i = 0; i < bytesRead && sniffed < BINARY_SNIFF_BYTES; i++, sniffed++) {
        if (value[i] === 0) {
          binary = true;
          break;
        }
      }
      if (binary) return null;
      const text = decoder.decode(value, { stream: true });
      if (text === "") continue;
      for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) s.addedLines++;
      s.addedChars += text.length;
      endsWithNewline = text.endsWith("\n");
    }
    const tail = decoder.decode();
    if (tail !== "") {
      for (let i = tail.indexOf("\n"); i >= 0; i = tail.indexOf("\n", i + 1)) s.addedLines++;
      s.addedChars += tail.length;
      endsWithNewline = tail.endsWith("\n");
    }
  } finally {
    await file.close();
  }
  if (s.addedChars > 0 && !endsWithNewline) s.addedLines++;
  return s;
}

// ── streaming git diff runner ─────────────────────────────────────────────────────
// Same shape as git-actions.boundedGit (stop + kill at the cap so a pathological diff can't
// block the per-repo queue), except stdout is folded into the parser chunk by chunk instead
// of concatenated. Read-only; daemon-safe env.
async function streamGitPatchStats(
  absPath: string,
  args: string[],
  cap: number,
): Promise<{ perFile: Map<string, DiffStat>; truncated: boolean }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: absPath,
    env: safeGitEnv(),
    stdout: "pipe",
    stderr: "ignore",
  });
  const killTimer = setTimeout(() => proc.kill(), DIFF_TIMEOUT_MS);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const parser = createPatchStatParser();
  let read = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.length;
      parser.push(decoder.decode(value, { stream: true }));
      if (read >= cap) {
        truncated = true;
        break;
      }
    }
    parser.push(decoder.decode());
  } catch {
    /* child killed or stream errored — keep whatever we counted */
  } finally {
    clearTimeout(killTimer);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    proc.kill();
    try {
      await proc.exited;
    } catch {
      /* ignore */
    }
  }
  return { perFile: parser.finish(), truncated };
}

/**
 * Compute per-file + aggregate diff stats for a repo's working tree vs HEAD.
 *
 * MUST be called from inside an existing readGate slot (status.ts holds one): it spawns
 * its own `git diff` directly rather than taking another gate, so it never nests/deadlocks
 * the read pool. Tracked changes come from `git diff HEAD` (rename-aware, `-M`); untracked
 * files (passed in from the porcelain status) are read off disk and counted as additions.
 * On an unborn HEAD the diff is empty and only untracked files contribute — acceptable for
 * a brand-new repo. Binary/oversized untracked files are skipped, not counted.
 *
 * `truncated` reports that a runaway guard fired and some files therefore carry no stat at
 * all. It should never be true on a real repo; it exists so the blanks can be explained
 * rather than silently rendered as "this file has no changes".
 */
export async function computeDiffStats(
  absPath: string,
  untrackedPaths: string[],
): Promise<{ perFile: Map<string, DiffStat>; total: DiffStat; truncated: boolean }> {
  const { perFile, truncated } = await streamGitPatchStats(
    absPath,
    ["diff", "HEAD", "-M", "--no-color", "--no-ext-diff"],
    DIFF_CAP_BYTES,
  );

  let budget = UNTRACKED_TOTAL_CAP;
  let untrackedTruncated = false;
  // Reuse one small native buffer for the whole untracked pass. Bun.file().stream() retained a
  // native allocation per opened file in long-lived Bun processes; a generated tree with 12,000
  // untracked files therefore grew RSS by ~220 MB on every refresh even after JavaScript GC.
  const readBuffer = Buffer.allocUnsafe(64 * 1024);
  for (const rel of untrackedPaths) {
    if (budget <= 0) {
      untrackedTruncated = true;
      break;
    }
    try {
      const path = join(absPath, rel);
      const file = await fileStat(path);
      if (!file.isFile()) continue;
      if (file.size > UNTRACKED_FILE_CAP) {
        untrackedTruncated = true;
        continue;
      }
      if (file.size > budget) untrackedTruncated = true;
      const stat = await countFile(path, Math.min(UNTRACKED_FILE_CAP, budget), (n) => {
        budget -= n;
      }, readBuffer);
      if (stat) perFile.set(normalizeRelPath(rel), stat);
    } catch {
      /* unreadable (gone, permissions, a directory entry) — skip it */
    }
  }

  let total = emptyStat();
  for (const s of perFile.values()) total = addStat(total, s);
  return { perFile, total, truncated: truncated || untrackedTruncated };
}
