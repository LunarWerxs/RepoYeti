/**
 * Read-only repo inspection: branches, commit history (log), and stash entries.
 *
 * These are pure reads — no mutation, no unsafe-state risk — so they run behind the
 * `readGate` semaphore (like status reads) and deliberately NOT behind the per-repo op
 * queue: a branch list or log stays snappy even while a fetch/pull is in flight on the
 * same repo. Every result is bounded (branch/stash/commit caps) so a pathological repo
 * can't produce a multi-MB payload to a phone.
 *
 * Output is parsed from porcelain-ish `--format` strings using a unit-separator (\x1f)
 * between fields and newlines between records, so a commit subject or branch name with
 * spaces/tabs can never split a field.
 */
import { gitFor } from "../git.ts";
import { readGate } from "../gitgate.ts";

const US = "\x1f"; // field separator (unit separator) — can't appear in a ref name or subject

/** Caps: keep payloads small for a phone. A repo with thousands of branches/commits is
 *  unusable to scroll anyway — we send the most recent slice. */
export const MAX_BRANCHES = 200;
export const MAX_STASHES = 50;
export const LOG_PAGE_DEFAULT = 50;
// Match the browser's retained History window. A retained refresh can therefore come from one
// `git log` process/ref snapshot instead of stitching together pages while refs may be moving.
export const LOG_PAGE_MAX = 500;
// Keep hash argv comfortably below Windows' command-line limit during filtered stat enrichment.
const LOG_HASH_CHUNK = 200;

export interface BranchInfo {
  /** Short branch name, e.g. "main" or "feature/x". */
  name: string;
  /** True for the currently checked-out branch. */
  current: boolean;
  /** Upstream tracking ref (e.g. "origin/main"), or null if none. */
  upstream: string | null;
  /** Commits this local branch is ahead of its upstream (0 if no upstream/unknown). */
  ahead: number;
  /** Commits this local branch is behind its upstream (0 if no upstream/unknown). */
  behind: number;
  /** True when the upstream is gone (branch deleted on the remote). */
  gone: boolean;
}

export interface BranchList {
  ok: boolean;
  code: "OK" | "ERROR";
  message?: string;
  current: string | null;
  detached: boolean;
  branches: BranchInfo[];
  /** Total local branches before MAX_BRANCHES (present only when capped). */
  total?: number;
  truncated?: boolean;
}

/** Parse the "[ahead 1, behind 2]" / "[gone]" form of `%(upstream:track)`. */
function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const gone = /\bgone\b/.test(track);
  const ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(track.match(/behind (\d+)/)?.[1] ?? 0);
  return { ahead, behind, gone };
}

/**
 * Local branches, most-recently-committed first, each with its upstream + ahead/behind.
 * One `git for-each-ref` call — cheaper and more complete than parsing `git branch`.
 */
export async function readBranches(absPath: string): Promise<BranchList> {
  try {
    return await readGate.run(async () => {
      const raw = await gitFor(absPath).raw([
        "for-each-ref",
        "--sort=-committerdate",
        "refs/heads",
        `--format=%(refname:short)${US}%(upstream:short)${US}%(upstream:track)${US}%(HEAD)`,
      ]);
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      const all: BranchInfo[] = lines.map((line) => {
        const [name = "", upstream = "", track = "", head = ""] = line.split(US);
        const { ahead, behind, gone } = parseTrack(track);
        return {
          name,
          current: head.trim() === "*",
          upstream: upstream || null,
          ahead,
          behind,
          gone,
        };
      });
      const current = all.find((b) => b.current)?.name ?? null;
      const detached = current === null && all.length > 0; // HEAD not on any listed branch
      const branches = all.slice(0, MAX_BRANCHES);
      const truncated = all.length > MAX_BRANCHES;
      return {
        ok: true,
        code: "OK" as const,
        current,
        detached,
        branches,
        ...(truncated ? { total: all.length, truncated } : {}),
      };
    });
  } catch (e) {
    return {
      ok: false,
      code: "ERROR",
      message: e instanceof Error ? e.message : String(e),
      current: null,
      detached: false,
      branches: [],
    };
  }
}

/** Optional log filter: only merge commits, or exclude them entirely. */
export type MergeFilter = "only" | "exclude";

/**
 * Which refs the log walks. "head" (default) = just the current branch (HEAD), the historical
 * linear behavior. "local" adds every local branch + tag; "all" also adds remote-tracking
 * branches — the two that produce a real multi-lane DAG for the graph view's branch-scope toggle.
 */
export type RefScope = "head" | "local" | "all";

/** Exact author identity used by the History table filter. Email wins when both are present,
 *  matching the activity overview's contributor grouping; name is the fallback for VCSes that
 *  do not expose author email. */
export interface LogAuthorFilter {
  name?: string;
  email?: string;
}

const LOG_AUTHOR_PART_MAX = 320;

/** Keep direct callers and HTTP callers on the same bounded, case-insensitive identity rules. */
export function normalizeLogAuthorFilter(
  author?: LogAuthorFilter,
): { name: string; email: string } | undefined {
  const clean = (value: string | undefined): string =>
    Array.from(value ?? "", (character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
      .join("")
      .trim()
      .slice(0, LOG_AUTHOR_PART_MAX)
      .toLowerCase();
  const normalized = { name: clean(author?.name), email: clean(author?.email) };
  return normalized.email || normalized.name ? normalized : undefined;
}

/** VCS-neutral equivalent of git's exact --author match, also used by the Lore adapter. */
export function logAuthorMatches(
  filter: LogAuthorFilter | undefined,
  authorName: string,
  authorEmail: string,
): boolean {
  const normalized = normalizeLogAuthorFilter(filter);
  if (!normalized) return true;
  if (normalized.email) return authorEmail.trim().toLowerCase() === normalized.email;
  return authorName.trim().toLowerCase() === normalized.name;
}

/**
 * What one commit changed, totalled across its files (`git log --numstat`).
 * Line counts only — `--numstat` reports lines, never characters, so this is deliberately
 * narrower than the working-tree `DiffStat` in ./diffstat.ts (which parses patch text).
 * Binary files count toward `filesChanged` but contribute no lines (git reports "-").
 */
export interface CommitStat {
  filesChanged: number;
  addedLines: number;
  removedLines: number;
}

export interface LogEntry {
  /** Full 40-char commit hash. */
  hash: string;
  /** Abbreviated hash. */
  shortHash: string;
  /** Commit subject (first line of the message). */
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Author date as epoch milliseconds. */
  date: number;
  /** Ref decorations (e.g. "HEAD -> main, origin/main, tag: v1"), or "". */
  refs: string;
  /** Parent commit hashes (full). A root commit has none; a merge has 2+. */
  parents: string[];
  /** True when this commit has 2+ parents (a merge). Lets callers detect/flag merges
   *  without re-deriving from `parents`. */
  isMerge: boolean;
  /**
   * Files/lines this commit touched. Always present for git; all-zero on a merge, because
   * `git log --numstat` deliberately prints no diff for one (its change is the union of its
   * parents, not an edit of its own). Optional so non-git backends can omit it entirely.
   */
  stat?: CommitStat;
}

export interface LogResult {
  ok: boolean;
  code: "OK" | "ERROR";
  message?: string;
  commits: LogEntry[];
  /** True when a full page came back (there may be more — bump `skip` to page). */
  hasMore: boolean;
}

/**
 * The author-filtered page of `readLog`, as a two-pass fetch: `%aN`/`%aE` apply .mailmap, so
 * hashes are selected from that canonical metadata first — git's built-in --author predicate is
 * documented to match the raw author header, and would make a clicked canonical activity chip
 * silently omit that person's aliases. Returns "" (never non-numstat garbage) when the page is
 * empty, which the caller's parser already reads as zero commits.
 */
async function fetchAuthorFilteredLog(
  absPath: string,
  scopeArgs: string[],
  mergeFlag: string[],
  normalizedAuthor: NonNullable<ReturnType<typeof normalizeLogAuthorFilter>>,
  fmt: string,
  off: number,
  cap: number,
): Promise<{ raw: string; hasMore: boolean }> {
  const metadataFormat = ["%H", "%aN", "%aE"].join(US);
  const metadataRaw = await gitFor(absPath).raw([
    "log",
    "--no-color",
    ...scopeArgs,
    ...mergeFlag,
    "--use-mailmap",
    `--pretty=tformat:${metadataFormat}`,
  ]);
  const matchingHashes = metadataRaw
    .split("\n")
    .filter((line) => line.includes(US))
    .map((line) => {
      const [hash = "", authorName = "", authorEmail = ""] = line.split(US);
      return { hash, authorName, authorEmail };
    })
    .filter((commit) =>
      normalizedAuthor.email
        ? commit.authorEmail.trim().toLowerCase() === normalizedAuthor.email
        : commit.authorName.trim().toLowerCase() === normalizedAuthor.name
    )
    .map((commit) => commit.hash);
  const candidates = matchingHashes.slice(off, off + cap + 1);
  const pageHashes = candidates.slice(0, cap);
  const hasMore = candidates.length > cap;
  if (pageHashes.length === 0) return { raw: "", hasMore: false };

  // --no-walk=unsorted preserves the selected newest-first order and avoids traversing
  // each hash's ancestry again. Chunking keeps even a 500-row page safe on Windows.
  const chunks = Array.from(
    { length: Math.ceil(pageHashes.length / LOG_HASH_CHUNK) },
    (_, index) => pageHashes.slice(index * LOG_HASH_CHUNK, (index + 1) * LOG_HASH_CHUNK),
  );
  const details = await Promise.all(
    chunks.map((hashes) =>
      gitFor(absPath).raw([
        "log",
        "--no-color",
        "--no-walk=unsorted",
        "--use-mailmap",
        "--numstat",
        `--pretty=tformat:${fmt}`,
        ...hashes,
      ])
    ),
  );
  return { raw: details.join("\n"), hasMore };
}

/**
 * Parse `git log --numstat --pretty=...` output into commits. With --numstat the output is no
 * longer one line per commit: each commit record is followed by "<added>\t<removed>\t<path>"
 * lines (and blank separators). Commit records are the only lines carrying the unit separator, so
 * that's the discriminator — a numstat path could otherwise contain anything, but never US. Stat
 * lines fold into the commit above them.
 */
function parseNumstatLog(raw: string): LogEntry[] {
  const commits: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    if (line.includes(US)) {
      const [hash = "", shortHash = "", authorName = "", authorEmail = "", at = "0", parentsRaw = "", refs = "", subject = ""] =
        line.split(US);
      const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
      commits.push({
        hash,
        shortHash,
        subject,
        authorName,
        authorEmail,
        date: Number(at) * 1000,
        refs: refs.trim(),
        parents,
        isMerge: parents.length > 1,
        stat: { filesChanged: 0, addedLines: 0, removedLines: 0 },
      });
      continue;
    }
    const current = commits.at(-1);
    if (!current?.stat) continue;
    // "12\t3\tsrc/foo.ts" — or "-\t-\tlogo.png" for a binary file (counted, but no lines).
    const [addedRaw = "", removedRaw = "", ...pathParts] = line.split("\t");
    if (pathParts.length === 0) continue; // not a numstat row
    current.stat.filesChanged += 1;
    if (addedRaw !== "-") current.stat.addedLines += Number(addedRaw) || 0;
    if (removedRaw !== "-") current.stat.removedLines += Number(removedRaw) || 0;
  }
  return commits;
}

/**
 * Commit history of the current branch (HEAD), newest first, paginated by `skip`.
 * Read-only. On an unborn HEAD (brand-new repo with no commits) `git log` exits non-zero;
 * that surfaces as an empty list, not an error.
 */
export async function readLog(
  absPath: string,
  limit = LOG_PAGE_DEFAULT,
  skip = 0,
  merges?: MergeFilter,
  refScope: RefScope = "head",
  author?: LogAuthorFilter,
): Promise<LogResult> {
  const cap = Math.min(Math.max(1, Math.floor(limit)), LOG_PAGE_MAX);
  const off = Math.max(0, Math.floor(skip));
  try {
    return await readGate.run(async () => {
      // %P = space-separated parent hashes (→ merge detection). Subject (%s) stays LAST so any
      // odd character in it can't shift earlier fields when we split on the unit separator.
      const fmt = ["%H", "%h", "%aN", "%aE", "%at", "%P", "%D", "%s"].join(US);
      const mergeFlag = merges === "only" ? ["--merges"] : merges === "exclude" ? ["--no-merges"] : [];
      const normalizedAuthor = normalizeLogAuthorFilter(author);
      // Which refs to walk. HEAD-only stays the historical default (linear current-branch log).
      // local/all add the other branch tips (+ remotes) plus --date-order, so the graph's lanes
      // stay stable across pages. HEAD is passed explicitly so a detached checkout still appears.
      const scopeArgs =
        refScope === "all"
          ? ["HEAD", "--branches", "--tags", "--remotes", "--date-order"]
          : refScope === "local"
            ? ["HEAD", "--branches", "--tags", "--date-order"]
            : [];
      let raw = "";
      let hasMore = false;
      try {
        if (normalizedAuthor) {
          const fetched = await fetchAuthorFilteredLog(absPath, scopeArgs, mergeFlag, normalizedAuthor, fmt, off, cap);
          raw = fetched.raw;
          hasMore = fetched.hasMore;
        } else {
          raw = await gitFor(absPath).raw([
            "log",
            "--no-color",
            ...scopeArgs,
            ...mergeFlag,
            "--use-mailmap",
            `--max-count=${cap}`,
            `--skip=${off}`,
            // Per-commit file/line totals for the history table's "changes" column. This makes the
            // output MULTI-line per commit (a numstat line per changed file follows each record),
            // which the parser below handles by shape — see the US test.
            "--numstat",
            `--pretty=format:${fmt}`,
          ]);
        }
      } catch {
        return { ok: true, code: "OK" as const, commits: [], hasMore: false }; // unborn HEAD
      }
      const commits = parseNumstatLog(raw);
      return {
        ok: true,
        code: "OK" as const,
        commits,
        hasMore: normalizedAuthor ? hasMore : commits.length === cap,
      };
    });
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e), commits: [], hasMore: false };
  }
}

/** One changed file in a commit (`git show --name-status`), with its per-file line delta
 *  (`git show --numstat`). */
export interface CommitFile {
  /** A / M / D / R / C (first letter of the name-status code). */
  status: string;
  path: string;
  /** Rename/copy source path (only for R/C). */
  from?: string;
  /** Added / removed line counts for this file (both 0 for a binary file). */
  adds: number;
  dels: number;
}

/** Full detail for one commit: header + changed-file list (each with a per-file line delta). */
export interface CommitDetail {
  ok: boolean;
  code: "OK" | "ERROR";
  message?: string;
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  date: number;
  /** Parent commit hashes (full); 2+ ⇒ this is a merge. */
  parents: string[];
  /** True when this commit has 2+ parents (a merge). */
  isMerge: boolean;
  committerName: string;
  committerEmail: string;
  /** Committer date as epoch milliseconds (distinct from author date after a rebase/cherry-pick). */
  committerDate: number;
  /** Commit message body (everything after the subject line); "" when the commit has none. */
  body: string;
  files: CommitFile[];
  /** TOTAL changed-file count. When it exceeds `files.length`, the list was capped at
   *  COMMIT_FILES_CAP and the UI shows a "+N more" note instead of rendering every row. */
  filesTotal: number;
}

/** A pathological commit (vendored tree, generated churn) can touch tens of thousands of files;
 *  rendering them all as rows helps nobody. A few hundred is plenty to scan — the rest is a count. */
export const COMMIT_FILES_CAP = 500;

const emptyCommitDetail = (hash: string, code: "OK" | "ERROR", message?: string): CommitDetail => ({
  ok: code === "OK",
  code,
  message,
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
  filesTotal: 0,
});

/** Parse the unit-separated header line from `git show --format=<fmt>` into its named fields. */
function parseCommitHeaderLine(headerLine: string) {
  const [full = "", short = "", an = "", ae = "", at = "0", cn = "", ce = "", ct = "0", parentsRaw = "", ...subjRest] =
    headerLine.split(US);
  const subject = subjRest.join(US);
  const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
  return { full, short, an, ae, at, cn, ce, ct, subject, parents };
}

/** Parse `--name-status` lines (everything after the header) into the changed-file list. */
function parseNameStatusFiles(lines: string[]): CommitFile[] {
  const files: CommitFile[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    const parts = t.split("\t");
    const status = (parts[0] ?? "M")[0] ?? "M";
    if (status === "R" || status === "C") files.push({ status, path: parts[2] ?? "", from: parts[1], adds: 0, dels: 0 });
    else files.push({ status, path: parts[1] ?? "", adds: 0, dels: 0 });
  }
  return files;
}

// Per-file line counts via --numstat instead of shipping the raw patch. The inline History
// view only needs the file list + a "+adds −dels" stat; a single `git show -p` would
// materialize the WHOLE patch in memory (arbitrarily large for a commit that regenerates a
// lockfile or bundle) just to derive these numbers. --numstat emits the same rows in the
// same order as --name-status (same flags, same diff), so zip it onto `files` BY INDEX — its
// rename rows read `{old => new}`, which would not match the name-status target path. Binary
// files report "-" for both counts, which Number() makes NaN → left at 0. Mutates `files`.
function applyNumstat(files: CommitFile[], numstatOut: string): void {
  const numstat = numstatOut.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < files.length; i++) {
    const cols = numstat[i]?.split("\t");
    const a = Number(cols?.[0]);
    const d = Number(cols?.[1]);
    if (Number.isFinite(a)) files[i]!.adds = a;
    if (Number.isFinite(d)) files[i]!.dels = d;
  }
}

/**
 * Full detail for ONE commit (the History "tap a commit → see its changes" view): the header
 * fields plus its changed-file list (`--name-status`) with a per-file line delta (`--numstat`).
 * The raw patch is deliberately NOT shipped here — it's fetched per file, on demand, when the
 * owner opens one in the viewer, so a commit that rewrites a huge generated file can't make this
 * materialize the whole patch in memory. Read-only, behind the read-gate. The hash is shape-guarded
 * so no flag/path can sneak through `git show`.
 */
export async function readCommit(absPath: string, hash: string): Promise<CommitDetail> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return emptyCommitDetail(hash, "ERROR", "invalid commit hash");
  try {
    return await readGate.run(async () => {
      const git = gitFor(absPath);
      const fmt = ["%H", "%h", "%an", "%ae", "%at", "%cn", "%ce", "%ct", "%P", "%s"].join(US);
      // `-m --first-parent` pins BOTH diff calls below to the commit-vs-first-parent diff. Plain
      // `git show` on a MERGE uses condensed combined mode, where --name-status prints only the
      // few "interesting" files while --numstat prints the full first-parent list — different row
      // sets, so the index zip below would staple stats onto the wrong files. With these flags the
      // two calls emit the SAME rows in the SAME order for every commit shape (merge, root,
      // ordinary — verified empirically on all three), merges show the useful "what did this merge
      // bring in" list instead of a near-empty one, and the view agrees with readCommitFile, which
      // already diffs first-parent ↔ commit. Non-merge output is byte-identical to plain `show`.
      const showFlags = ["-m", "--first-parent", "--no-color"];
      // Header (first line) + name-status lines (the rest).
      const metaOut = await git.raw(["show", ...showFlags, "--name-status", `--format=${fmt}`, hash]);
      const lines = metaOut.split("\n");
      const header = parseCommitHeaderLine(lines[0] ?? "");
      const files = parseNameStatusFiles(lines.slice(1));

      const numstatOut = await git.raw(["show", ...showFlags, "--numstat", "--format=", hash]);
      applyNumstat(files, numstatOut);

      // Cap the shipped list AFTER the zip (both lists are aligned full-length): the UI renders a
      // row per file, and a vendored-tree commit touching tens of thousands would bloat the payload
      // and the DOM for no scanning value. filesTotal carries the real count for the "+N more" note.
      const filesTotal = files.length;
      if (files.length > COMMIT_FILES_CAP) files.length = COMMIT_FILES_CAP;
      // The message BODY (everything after the subject) — a separate `-s` call because %b is
      // multi-line and can't share the unit-separated single-line header parsed above.
      const body = (await git.raw(["show", "--no-color", "-s", "--format=%b", hash])).trim();
      return {
        ok: true,
        code: "OK" as const,
        hash: header.full || hash,
        shortHash: header.short || hash.slice(0, 12),
        subject: header.subject,
        body,
        authorName: header.an,
        authorEmail: header.ae,
        date: Number(header.at) * 1000,
        parents: header.parents,
        isMerge: header.parents.length > 1,
        committerName: header.cn,
        committerEmail: header.ce,
        committerDate: Number(header.ct) * 1000,
        files,
        filesTotal,
      };
    });
  } catch (e) {
    return emptyCommitDetail(hash, "ERROR", e instanceof Error ? e.message : String(e));
  }
}

export interface StashEntry {
  /** 0-based stash index (maps to `stash@{index}`). */
  index: number;
  /** The stash subject, e.g. "WIP on main: abc123 message". */
  message: string;
  /** Committer date as epoch milliseconds (when the stash was created). */
  date: number;
}

export interface StashList {
  ok: boolean;
  code: "OK" | "ERROR";
  message?: string;
  stashes: StashEntry[];
}

export interface TagEntry {
  /** Tag name (short), e.g. "v1.2.0". */
  name: string;
  /** Creation date (tagger date for annotated, commit date for lightweight) as epoch ms. */
  date: number;
  /** The tagged object's subject line, or "". */
  subject: string;
}

export interface TagList {
  ok: boolean;
  code: "OK" | "ERROR";
  message?: string;
  tags: TagEntry[];
}

/** Cap the tag list — a release-heavy repo can have thousands; the newest are what matter. */
export const MAX_TAGS = 100;

/** Tags, newest first. Read-only. Empty list when there are none (or an unborn HEAD). */
export async function readTags(absPath: string): Promise<TagList> {
  try {
    return await readGate.run(async () => {
      const raw = await gitFor(absPath).raw([
        "for-each-ref",
        "--sort=-creatordate",
        `--count=${MAX_TAGS}`,
        "refs/tags",
        `--format=%(refname:short)${US}%(creatordate:unix)${US}%(subject)`,
      ]);
      const tags: TagEntry[] = raw
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((line) => {
          const [name = "", at = "0", subject = ""] = line.split(US);
          return { name, date: Number(at) * 1000, subject };
        });
      return { ok: true, code: "OK" as const, tags };
    });
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e), tags: [] };
  }
}

/** The stash stack, newest (index 0) first. Read-only. Empty list when there are none. */
export async function readStashes(absPath: string): Promise<StashList> {
  try {
    return await readGate.run(async () => {
      const raw = await gitFor(absPath).raw([
        "stash",
        "list",
        "--no-color",
        `--pretty=format:%gd${US}%ct${US}%gs`,
      ]);
      const lines = raw.split("\n").filter((l) => l.trim() !== "").slice(0, MAX_STASHES);
      const stashes: StashEntry[] = lines.map((line) => {
        const [selector = "", ct = "0", message = ""] = line.split(US);
        const index = Number(selector.match(/stash@\{(\d+)\}/)?.[1] ?? 0);
        return { index, message, date: Number(ct) * 1000 };
      });
      return { ok: true, code: "OK" as const, stashes };
    });
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e), stashes: [] };
  }
}
