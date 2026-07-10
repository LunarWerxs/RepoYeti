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
export const LOG_PAGE_MAX = 200;

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
): Promise<LogResult> {
  const cap = Math.min(Math.max(1, Math.floor(limit)), LOG_PAGE_MAX);
  const off = Math.max(0, Math.floor(skip));
  try {
    return await readGate.run(async () => {
      // %P = space-separated parent hashes (→ merge detection). Subject (%s) stays LAST so any
      // odd character in it can't shift earlier fields when we split on the unit separator.
      const fmt = ["%H", "%h", "%an", "%ae", "%at", "%P", "%D", "%s"].join(US);
      const mergeFlag = merges === "only" ? ["--merges"] : merges === "exclude" ? ["--no-merges"] : [];
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
      try {
        raw = await gitFor(absPath).raw([
          "log",
          "--no-color",
          ...scopeArgs,
          ...mergeFlag,
          `--max-count=${cap}`,
          `--skip=${off}`,
          `--pretty=format:${fmt}`,
        ]);
      } catch {
        return { ok: true, code: "OK" as const, commits: [], hasMore: false }; // unborn HEAD
      }
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      const commits: LogEntry[] = lines.map((line) => {
        const [hash = "", shortHash = "", authorName = "", authorEmail = "", at = "0", parentsRaw = "", refs = "", subject = ""] =
          line.split(US);
        const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
        return {
          hash,
          shortHash,
          subject,
          authorName,
          authorEmail,
          date: Number(at) * 1000,
          refs: refs.trim(),
          parents,
          isMerge: parents.length > 1,
        };
      });
      return { ok: true, code: "OK" as const, commits, hasMore: commits.length === cap };
    });
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e), commits: [], hasMore: false };
  }
}

/** One changed file in a commit (`git show --name-status`). */
export interface CommitFile {
  /** A / M / D / R / C (first letter of the name-status code). */
  status: string;
  path: string;
  /** Rename/copy source path (only for R/C). */
  from?: string;
}

/** Full detail for one commit: header + changed-file list + a bounded unified diff. */
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
  diff: string;
  truncated: boolean;
}

/** ~48 KB of a single commit's patch is plenty for a phone; bound a pathological huge commit. */
const COMMIT_DIFF_CAP = 48_000;

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
  diff: "",
  truncated: false,
});

/**
 * Full detail for ONE commit (the History "tap a commit → see its changes" view): the header
 * fields, its changed-file list (`--name-status`), and a bounded unified `git show -p`. Read-only,
 * behind the read-gate. The hash is shape-guarded so no flag/path can sneak through `git show`.
 */
export async function readCommit(absPath: string, hash: string): Promise<CommitDetail> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return emptyCommitDetail(hash, "ERROR", "invalid commit hash");
  try {
    return await readGate.run(async () => {
      const git = gitFor(absPath);
      const fmt = ["%H", "%h", "%an", "%ae", "%at", "%cn", "%ce", "%ct", "%P", "%s"].join(US);
      // Header (first line) + name-status lines (the rest).
      const metaOut = await git.raw(["show", "--no-color", "--name-status", `--format=${fmt}`, hash]);
      const lines = metaOut.split("\n");
      const [full = "", short = "", an = "", ae = "", at = "0", cn = "", ce = "", ct = "0", parentsRaw = "", ...subjRest] =
        (lines[0] ?? "").split(US);
      const subject = subjRest.join(US);
      const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
      const files: CommitFile[] = [];
      for (const l of lines.slice(1)) {
        const t = l.trim();
        if (!t) continue;
        const parts = t.split("\t");
        const status = (parts[0] ?? "M")[0] ?? "M";
        if (status === "R" || status === "C") files.push({ status, path: parts[2] ?? "", from: parts[1] });
        else files.push({ status, path: parts[1] ?? "" });
      }
      // The patch (empty --format suppresses the header so we get just the diff body).
      let diff = await git.raw(["show", "--no-color", "-p", "--format=", hash]);
      const truncated = diff.length > COMMIT_DIFF_CAP;
      if (truncated) diff = `${diff.slice(0, COMMIT_DIFF_CAP)}\n…[truncated]`;
      // The message BODY (everything after the subject) — a separate `-s` call because %b is
      // multi-line and can't share the unit-separated single-line header parsed above.
      const body = (await git.raw(["show", "--no-color", "-s", "--format=%b", hash])).trim();
      return {
        ok: true,
        code: "OK" as const,
        hash: full || hash,
        shortHash: short || hash.slice(0, 12),
        subject,
        body,
        authorName: an,
        authorEmail: ae,
        date: Number(at) * 1000,
        parents,
        isMerge: parents.length > 1,
        committerName: cn,
        committerEmail: ce,
        committerDate: Number(ct) * 1000,
        files,
        diff: diff.trim(),
        truncated,
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
