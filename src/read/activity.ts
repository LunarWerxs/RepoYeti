/**
 * Bounded repository activity for the History overview.
 *
 * Git gets purpose-built bounded `git log` queries so the totals do not depend on which
 * paginated History rows the browser happens to have loaded. The longer views keep commit,
 * contributor, and bucket counts exact with a cheap metadata scan, then progressively enrich
 * cache misses from a bounded, time-stratified subset with expensive diff statistics. Other
 * backends reuse their normalized readLog result through `readFallbackActivity`.
 */
import { gitFor, gitRawWithInput } from "../git.ts";
import { readGate } from "../gitgate.ts";
import type { CommitStat, LogResult, RefScope } from "./inspect.ts";

export const ACTIVITY_WINDOW_HOURS = 24;
export const ACTIVITY_SCALES = ["hourly", "daily", "monthly"] as const;
export type ActivityScale = (typeof ACTIVITY_SCALES)[number];
export type ActivityBucketUnit = "hour" | "day" | "month";
/** Metadata caps keep even pathological histories bounded without penalizing normal repositories. */
export const ACTIVITY_COMMIT_CAPS: Readonly<Record<ActivityScale, number>> = {
  hourly: 5000,
  daily: 50_000,
  monthly: 100_000,
};
/**
 * Computing `--shortstat` means diffing every commit. Connections can scan 10k commit headers in
 * ~0.2s but needs ~18s to diff them, so long views enrich a deliberately smaller stratified
 * subset per request. Sampling across the whole window keeps every active chart period useful
 * instead of spending the entire budget on the newest days; persistent hits are removed before
 * sampling, so repeat views converge to exact totals. Commit/contributor counts remain exact and
 * the response explicitly marks change totals as partial while misses remain.
 */
export const ACTIVITY_CHANGE_STAT_CAPS: Readonly<Record<ActivityScale, number>> = {
  hourly: 5000,
  daily: 1500,
  monthly: 1000,
};
/** Four Daily chunks stay safely below Windows' command-line limit and bound Git concurrency. */
const ACTIVITY_CHANGE_STAT_CHUNK = 375;
/** Avoid a lone merge/rename making an otherwise active low-volume period look blank. */
const ACTIVITY_MIN_CHANGE_STATS_PER_BUCKET = 8;
/** Legacy hourly cap retained for callers that only need the default view. */
export const ACTIVITY_COMMIT_CAP = ACTIVITY_COMMIT_CAPS.hourly;
/** Enough detail for compact contributor chips without shipping thousands of identities. */
export const ACTIVITY_AUTHOR_CAP = 25;
/** One extra record tells the caller that the bounded result is incomplete. */
export const ACTIVITY_QUERY_LIMIT = ACTIVITY_COMMIT_CAP + 1;
/** Bump whenever the pinned diff policy, timestamp meaning, or shortstat parsing changes. */
export const ACTIVITY_STAT_CACHE_VERSION = 3;

const HOUR_MS = 60 * 60 * 1000;
const US = "\x1f";
/**
 * Pin every material Git diff option we rely on so an old cache row keeps the same meaning when
 * someone changes their global/repository diff configuration. Repository `.gitattributes` remain
 * part of the content being measured; external diff and text-conversion drivers do not.
 */
const ACTIVITY_DIFF_POLICY_ARGS = [
  "--find-renames=50%",
  "--diff-algorithm=histogram",
  "--no-indent-heuristic",
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=none",
  "-l1000",
] as const;

export interface ActivityAuthor {
  name: string;
  email: string;
  commits: number;
  addedLines: number;
  removedLines: number;
}

export interface ActivityBucket {
  /** Bucket start as epoch milliseconds. */
  start: number;
  /** Exclusive bucket end as epoch milliseconds (the current bucket ends at `until`). */
  end: number;
  commits: number;
  filesChanged: number;
  addedLines: number;
  removedLines: number;
  /** Number of commits whose expensive file/line statistics are represented in this bucket. */
  changeStatsCommits: number;
}

export interface ActivityResult {
  ok: boolean;
  code: "OK" | "ERROR";
  message?: string;
  scale: ActivityScale;
  bucketUnit: ActivityBucketUnit;
  windowCount: number;
  /** Actual span in hours; calendar ranges can vary with month length and daylight saving time. */
  windowHours: number;
  /** Inclusive aggregation start as epoch milliseconds. */
  since: number;
  /** Window end as epoch milliseconds (the server snapshot time). */
  until: number;
  commits: number;
  commitsLastHour: number;
  /** Exact number of unique normalized authors in the bounded window. */
  contributors: number;
  filesChanged: number;
  addedLines: number;
  removedLines: number;
  /** Top authors by commit count/change volume, capped at ACTIVITY_AUTHOR_CAP. */
  authors: ActivityAuthor[];
  buckets: ActivityBucket[];
  /** Compatibility summary: either commit metadata or change statistics are incomplete. */
  truncated: boolean;
  /** True when more than this scale's metadata cap may fall inside the window. */
  commitsTruncated: boolean;
  /** True when commit counts are exact but file/line totals only cover a bounded subset. */
  changeStatsTruncated: boolean;
}

export interface ActivityCommit {
  authorName: string;
  authorEmail: string;
  /** Author date shown by History, as epoch milliseconds. */
  date: number;
  stat?: CommitStat;
  /**
   * False when a backend deliberately omitted this commit's diff stats. An absent `stat` is also
   * unknown regardless of this flag; a present all-zero stat is how Git represents a known
   * zero-change commit (for example, a merge without its own shortstat).
   */
  changeStatsKnown?: boolean;
}

export interface ActivityStatCacheEntry {
  hash: string;
  date: number;
  stat: CommitStat;
}

/**
 * Persistent-cache seam kept separate from Git aggregation so cache failures can never make
 * History unavailable and focused tests can verify progressive coverage without touching disk.
 */
export interface ActivityStatCache {
  read(since: number, until: number): Map<string, CommitStat>;
  write(entries: readonly ActivityStatCacheEntry[]): void;
}

function nonNegativeInt(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

function authorKey(commit: ActivityCommit): string {
  const email = commit.authorEmail.trim().toLowerCase();
  if (email) return `email:${email}`;
  return `name:${commit.authorName.trim().toLowerCase()}`;
}

export function normalizeActivityScale(value: string | undefined): ActivityScale {
  return value === "daily" || value === "monthly" || value === "hourly" ? value : "hourly";
}

interface ActivityWindow {
  scale: ActivityScale;
  bucketUnit: ActivityBucketUnit;
  starts: number[];
  since: number;
  until: number;
}

function localDayStart(epoch: number, offsetDays: number): number {
  const date = new Date(epoch);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime();
}

function localMonthStart(epoch: number, offsetMonths: number): number {
  const date = new Date(epoch);
  return new Date(date.getFullYear(), date.getMonth() + offsetMonths, 1).getTime();
}

/**
 * Resolve one deterministic activity window. Day and month buckets follow the daemon's local
 * calendar so "today" and "this month" match the person running RepoYeti; the final bucket is
 * intentionally partial and ends at the snapshot time.
 */
export function activityWindow(scale: ActivityScale = "hourly", until = Date.now()): ActivityWindow {
  const safeUntil = Number.isFinite(until) ? Math.floor(until) : Date.now();
  if (scale === "daily") {
    const starts = Array.from({ length: 30 }, (_, index) =>
      localDayStart(safeUntil, index - 29),
    );
    return { scale, bucketUnit: "day", starts, since: starts[0]!, until: safeUntil };
  }
  if (scale === "monthly") {
    const starts = Array.from({ length: 12 }, (_, index) =>
      localMonthStart(safeUntil, index - 11),
    );
    return { scale, bucketUnit: "month", starts, since: starts[0]!, until: safeUntil };
  }
  const since = safeUntil - ACTIVITY_WINDOW_HOURS * HOUR_MS;
  const starts = Array.from(
    { length: ACTIVITY_WINDOW_HOURS },
    (_, index) => since + index * HOUR_MS,
  );
  return { scale, bucketUnit: "hour", starts, since, until: safeUntil };
}

function bucketIndexAt(starts: readonly number[], date: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= date) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, Math.min(starts.length - 1, low - 1));
}

/**
 * Choose a deterministic, approximately uniform subset for expensive diff-stat enrichment.
 *
 * A plain newest-first `--max-count` starves older chart buckets: their commit line is populated
 * from metadata while their change bars stay empty. Reserve one representative from every
 * non-empty bucket (when the budget permits), then fill the remaining budget systematically
 * across the complete window. The resulting lower-bound bars cover the whole selected range and
 * keep roughly the same sampling fraction in busy periods.
 */
export function selectChangeStatCommits<T extends { hash: string; date: number }>(
  commits: readonly T[],
  starts: readonly number[],
  limit: number,
): T[] {
  const cap = Math.min(commits.length, nonNegativeInt(limit));
  if (cap === 0) return [];
  if (commits.length <= cap) return [...commits];

  const selected = new Set<string>();
  const buckets = starts.map((): T[] => []);
  for (const commit of commits) {
    if (!Number.isFinite(commit.date) || buckets.length === 0) continue;
    buckets[bucketIndexAt(starts, commit.date)]!.push(commit);
  }
  const activeBuckets = buckets.filter((bucket) => bucket.length > 0);

  // Production budgets comfortably cover every bucket. If a future preset does not, select
  // active periods evenly instead of silently preferring the newest ones.
  if (activeBuckets.length > 0 && activeBuckets.length >= cap) {
    for (let index = 0; index < cap; index++) {
      const bucketIndex = Math.min(
        activeBuckets.length - 1,
        Math.floor(((index + 0.5) * activeBuckets.length) / cap),
      );
      const bucket = activeBuckets[bucketIndex]!;
      selected.add(bucket[Math.floor((bucket.length - 1) / 2)]!.hash);
    }
  } else if (activeBuckets.length > 0) {
    const perBucket = Math.min(
      ACTIVITY_MIN_CHANGE_STATS_PER_BUCKET,
      Math.max(1, Math.floor(cap / activeBuckets.length)),
    );
    for (const bucket of activeBuckets) {
      const bucketQuota = Math.min(bucket.length, perBucket);
      for (let index = 0; index < bucketQuota; index++) {
        const commitIndex = Math.min(
          bucket.length - 1,
          Math.floor(((index + 0.5) * bucket.length) / bucketQuota),
        );
        selected.add(bucket[commitIndex]!.hash);
      }
    }
  }

  // Midpoint systematic sampling avoids a permanent newest/oldest edge bias.
  for (let index = 0; index < cap && selected.size < cap; index++) {
    const commitIndex = Math.min(
      commits.length - 1,
      Math.floor(((index + 0.5) * commits.length) / cap),
    );
    selected.add(commits[commitIndex]!.hash);
  }
  // Bucket representatives can overlap systematic positions. Fill the small remainder without
  // exceeding the advertised cap; ordering is restored by the final filter.
  for (const commit of commits) {
    if (selected.size >= cap) break;
    selected.add(commit.hash);
  }
  return commits.filter((commit) => selected.has(commit.hash));
}

/**
 * Aggregate normalized commits into the stable response shape. Exported so fallback backends and
 * focused tests share the exact same window, cap, author grouping, and bucket rules.
 */
export function aggregateActivity(
  commits: readonly ActivityCommit[],
  until = Date.now(),
  sourceTruncated = false,
  scale: ActivityScale = "hourly",
  sourceChangeStatsTruncated = false,
): ActivityResult {
  const window = activityWindow(scale, until);
  const commitCap = ACTIVITY_COMMIT_CAPS[scale];
  const inWindow = commits
    .filter(
      (commit) =>
        Number.isFinite(commit.date) &&
        commit.date >= window.since &&
        commit.date <= window.until,
    )
    .sort((a, b) => b.date - a.date);
  const commitsTruncated = sourceTruncated || inWindow.length > commitCap;
  const bounded = inWindow.slice(0, commitCap);
  const buckets: ActivityBucket[] = window.starts.map((start, index) => ({
    start,
    end: window.starts[index + 1] ?? window.until,
    commits: 0,
    filesChanged: 0,
    addedLines: 0,
    removedLines: 0,
    changeStatsCommits: 0,
  }));
  const byAuthor = new Map<string, ActivityAuthor>();
  let commitsLastHour = 0;
  let filesChanged = 0;
  let addedLines = 0;
  let removedLines = 0;
  let changeStatsTruncated = sourceChangeStatsTruncated;

  for (const commit of bounded) {
    const changeStatsKnown =
      commit.stat !== undefined && commit.changeStatsKnown !== false;
    if (!changeStatsKnown) changeStatsTruncated = true;
    const files = nonNegativeInt(commit.stat?.filesChanged);
    const added = nonNegativeInt(commit.stat?.addedLines);
    const removed = nonNegativeInt(commit.stat?.removedLines);
    filesChanged += files;
    addedLines += added;
    removedLines += removed;
    if (commit.date >= window.until - HOUR_MS) commitsLastHour += 1;

    // A commit exactly at `until` belongs to the final bucket rather than falling one past it.
    const bucketIndex = bucketIndexAt(window.starts, commit.date);
    const bucket = buckets[bucketIndex]!;
    bucket.commits += 1;
    bucket.filesChanged += files;
    bucket.addedLines += added;
    bucket.removedLines += removed;
    if (changeStatsKnown) bucket.changeStatsCommits += 1;

    const key = authorKey(commit);
    const current = byAuthor.get(key);
    if (current) {
      current.commits += 1;
      current.addedLines += added;
      current.removedLines += removed;
      if (!current.name && commit.authorName) current.name = commit.authorName;
      if (!current.email && commit.authorEmail) current.email = commit.authorEmail;
    } else {
      byAuthor.set(key, {
        name: commit.authorName,
        email: commit.authorEmail,
        commits: 1,
        addedLines: added,
        removedLines: removed,
      });
    }
  }

  const rankedAuthors = [...byAuthor.values()].sort(
    (a, b) =>
      b.commits - a.commits ||
      b.addedLines + b.removedLines - (a.addedLines + a.removedLines) ||
      a.name.localeCompare(b.name) ||
      a.email.localeCompare(b.email),
  );
  const contributors = rankedAuthors.length;
  const authors = rankedAuthors.slice(0, ACTIVITY_AUTHOR_CAP);
  return {
    ok: true,
    code: "OK",
    scale,
    bucketUnit: window.bucketUnit,
    windowCount: buckets.length,
    windowHours: (window.until - window.since) / HOUR_MS,
    since: window.since,
    until: window.until,
    commits: bounded.length,
    commitsLastHour,
    contributors,
    filesChanged,
    addedLines,
    removedLines,
    authors,
    buckets,
    truncated: commitsTruncated || changeStatsTruncated,
    commitsTruncated,
    changeStatsTruncated,
  };
}

export function activityError(
  message: string,
  until = Date.now(),
  scale: ActivityScale = "hourly",
): ActivityResult {
  return { ...aggregateActivity([], until, false, scale), ok: false, code: "ERROR", message };
}

interface ParsedActivityCommit extends ActivityCommit {
  hash: string;
}

/**
 * Parse a bounded, path-free Git activity stream. `withChangeStats=false` is used by the fast
 * long-range metadata pass; those commits are deliberately distinguishable from genuine
 * zero-change/merge commits returned by `--shortstat`.
 */
export function parseGitActivity(
  raw: string,
  withChangeStats = true,
): ParsedActivityCommit[] {
  const commits: ParsedActivityCommit[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    if (line.includes(US)) {
      const [hash = "", authorName = "", authorEmail = "", authoredAt = "0"] = line.split(US);
      commits.push({
        hash,
        authorName,
        authorEmail,
        date: Number(authoredAt) * 1000,
        stat: withChangeStats
          ? { filesChanged: 0, addedLines: 0, removedLines: 0 }
          : undefined,
        changeStatsKnown: withChangeStats,
      });
      continue;
    }
    const current = commits.at(-1);
    if (!current?.stat) continue;
    // `--shortstat` emits at most one compact summary per commit instead of one `--numstat`
    // record per changed path. Match the stable (+)/(-) markers rather than English words so this
    // remains correct under a localized Git installation.
    const files = line.match(/^\s*(\d+)/);
    const added = line.match(/(\d+)\s+[^,\n]*\(\+\)/);
    const removed = line.match(/(\d+)\s+[^,\n]*\(-\)/);
    if (!files && !added && !removed) continue;
    current.stat.filesChanged = Number(files?.[1] ?? 0);
    current.stat.addedLines = Number(added?.[1] ?? 0);
    current.stat.removedLines = Number(removed?.[1] ?? 0);
  }
  return commits;
}

function scopeArgs(refScope: RefScope): string[] {
  return refScope === "all"
    ? ["HEAD", "--branches", "--tags", "--remotes", "--date-order"]
    : refScope === "local"
      ? ["HEAD", "--branches", "--tags", "--date-order"]
      : [];
}

function unbornHead(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not have any commits yet|bad default revision ['"]?HEAD|ambiguous argument ['"]?HEAD/i.test(message);
}

/**
 * Accurate bounded Git activity. `%at` matches the author date displayed by History rows, while
 * `%aN`/`%aE` honor `.mailmap` so contributor aliases stay grouped. Git's `--since`/`--until`
 * prefilter is based on committer time; the shared aggregator applies the authoritative
 * author-date window after parsing.
 *
 * The hourly view remains one exact `--shortstat` query. Daily/monthly first read cheap metadata
 * for exact commit/contributor/bucket counts, then enrich a bounded, time-stratified subset of
 * cache misses with diff statistics. The response never presents line totals as complete until
 * every live commit in the selected window has a measured stat.
 */
export interface ActivityReadOptions {
  /** Focused-test seam; production uses ACTIVITY_CHANGE_STAT_CAPS for the selected scale. */
  changeStatCap?: number;
  /**
   * Optional persistent store for immutable per-commit diff statistics. Git metadata remains the
   * source of truth for reachability and bucket membership; cache hits only avoid re-diffing.
   */
  statCache?: ActivityStatCache;
}

/** The `hourly` path: one exact `--shortstat` query, no caching, no sampling. */
async function readHourlyActivity(
  absPath: string,
  commonArgs: string[],
  commitCap: number,
  format: string,
  window: ActivityWindow,
  scale: ActivityScale,
): Promise<ActivityResult> {
  const raw = await gitFor(absPath).raw([
    ...commonArgs,
    `--max-count=${commitCap + 1}`,
    ...ACTIVITY_DIFF_POLICY_ARGS,
    "--shortstat",
    `--pretty=format:${format}`,
  ]);
  const commits = parseGitActivity(raw);
  return aggregateActivity(commits, window.until, commits.length > commitCap, scale);
}

/** Cache hits for commits still live in this window. Cache availability must never decide
 *  whether History itself is available: a corrupt/locked cache is only a performance miss. */
function loadCachedStats(
  statCache: ActivityStatCache | undefined,
  window: ActivityWindow,
  liveHashes: Set<string>,
): Map<string, CommitStat> {
  const statsByHash = new Map<string, CommitStat>();
  if (!statCache) return statsByHash;
  try {
    const cached = statCache.read(window.since, window.until);
    for (const [hash, stat] of cached) {
      if (liveHashes.has(hash)) statsByHash.set(hash, stat);
    }
  } catch {
    // Fall through to Git enrichment. A corrupt/locked cache is only a performance miss.
  }
  return statsByHash;
}

/** Diff-tree the sampled misses in bounded chunks, folding freshly measured stats into
 *  `statsByHash` (mutated in place) and returning them for the cache write. */
async function measureMissingStats(
  absPath: string,
  missingMetadata: ParsedActivityCommit[],
  window: ActivityWindow,
  changeStatCap: number,
  format: string,
  statsByHash: Map<string, CommitStat>,
): Promise<ActivityStatCacheEntry[]> {
  const sampledMetadata = selectChangeStatCommits(missingMetadata, window.starts, changeStatCap);
  const statChunks = Array.from(
    { length: Math.ceil(sampledMetadata.length / ACTIVITY_CHANGE_STAT_CHUNK) },
    (_, index) =>
      sampledMetadata.slice(index * ACTIVITY_CHANGE_STAT_CHUNK, (index + 1) * ACTIVITY_CHANGE_STAT_CHUNK),
  );
  const datesByHash = new Map(sampledMetadata.map((commit) => [commit.hash, commit.date] as const));
  const measured: ActivityStatCacheEntry[] = [];
  const statResults = await Promise.allSettled(
    statChunks.map((chunk) =>
      gitRawWithInput(
        absPath,
        [
          "diff-tree",
          "--stdin",
          "--root",
          "--always",
          "--no-color",
          ...ACTIVITY_DIFF_POLICY_ARGS,
          "--shortstat",
          `--pretty=format:${format}`,
        ],
        `${chunk.map((commit) => commit.hash).join("\n")}\n`,
      ),
    ),
  );
  for (const result of statResults) {
    if (result.status !== "fulfilled") continue;
    for (const commit of parseGitActivity(result.value)) {
      const stat = commit.stat ?? { filesChanged: 0, addedLines: 0, removedLines: 0 };
      const date = datesByHash.get(commit.hash);
      statsByHash.set(commit.hash, stat);
      if (date !== undefined) measured.push({ hash: commit.hash, date, stat });
    }
  }
  return measured;
}

/** Best-effort cache write: fresh measurements still belong in this response even if
 *  persistence is unavailable. */
function persistMeasuredStats(statCache: ActivityStatCache | undefined, measured: ActivityStatCacheEntry[]): void {
  if (!statCache || measured.length === 0) return;
  try {
    statCache.write(measured);
  } catch {
    // Fresh measurements still belong in this response even if persistence is unavailable.
  }
}

/** The `daily`/`monthly` path: cheap metadata for exact commit/contributor/bucket counts, then a
 *  bounded, time-stratified subset of cache misses is enriched with diff statistics. */
async function readBoundedActivity(
  absPath: string,
  commonArgs: string[],
  commitCap: number,
  format: string,
  window: ActivityWindow,
  scale: ActivityScale,
  changeStatCap: number,
  statCache: ActivityStatCache | undefined,
): Promise<ActivityResult> {
  const metadataRaw = await gitFor(absPath).raw([
    ...commonArgs,
    `--max-count=${commitCap + 1}`,
    `--pretty=format:${format}`,
  ]);
  const metadata = parseGitActivity(metadataRaw, false);
  const commitsTruncated = metadata.length > commitCap;
  const boundedMetadata = metadata.slice(0, commitCap);
  if (boundedMetadata.length === 0) {
    return aggregateActivity([], window.until, commitsTruncated, scale);
  }

  const liveHashes = new Set(boundedMetadata.map((commit) => commit.hash));
  const statsByHash = loadCachedStats(statCache, window, liveHashes);

  // Spend this request's bounded work only on misses. Repeated views therefore grow
  // coverage monotonically until every commit in the selected window is exact.
  const missingMetadata = boundedMetadata.filter((commit) => !statsByHash.has(commit.hash));
  const measured = await measureMissingStats(absPath, missingMetadata, window, changeStatCap, format, statsByHash);
  persistMeasuredStats(statCache, measured);

  const commits = boundedMetadata.map((commit): ParsedActivityCommit => {
    const stat = statsByHash.get(commit.hash);
    return {
      ...commit,
      stat,
      changeStatsKnown: stat !== undefined,
    };
  });
  const changeStatsTruncated =
    commitsTruncated || commits.some((commit) => commit.changeStatsKnown === false);
  return aggregateActivity(commits, window.until, commitsTruncated, scale, changeStatsTruncated);
}

export async function readGitActivity(
  absPath: string,
  refScope: RefScope = "head",
  until = Date.now(),
  scale: ActivityScale = "hourly",
  options: ActivityReadOptions = {},
): Promise<ActivityResult> {
  const window = activityWindow(scale, until);
  const commitCap = ACTIVITY_COMMIT_CAPS[scale];
  const changeStatCap = Math.min(
    commitCap,
    options.changeStatCap == null
      ? ACTIVITY_CHANGE_STAT_CAPS[scale]
      : nonNegativeInt(options.changeStatCap),
  );
  try {
    return await readGate.run(async () => {
      const format = ["%H", "%aN", "%aE", "%at"].join(US);
      const commonArgs = [
        "log",
        "--no-color",
        ...scopeArgs(refScope),
        `--since=${new Date(window.since).toISOString()}`,
        `--until=${new Date(window.until).toISOString()}`,
      ];
      try {
        if (scale === "hourly") {
          return await readHourlyActivity(absPath, commonArgs, commitCap, format, window, scale);
        }
        return await readBoundedActivity(
          absPath,
          commonArgs,
          commitCap,
          format,
          window,
          scale,
          changeStatCap,
          options.statCache,
        );
      } catch (error) {
        if (unbornHead(error)) return aggregateActivity([], window.until, false, scale);
        return activityError(
          error instanceof Error ? error.message : String(error),
          window.until,
          scale,
        );
      }
    });
  } catch (error) {
    return activityError(error instanceof Error ? error.message : String(error), window.until, scale);
  }
}

type LogReader = (
  limit?: number,
  skip?: number,
  merges?: "only" | "exclude",
  refScope?: RefScope,
) => Promise<LogResult>;

/**
 * Graceful non-Git fallback. Backends already normalize identity/date/stat into LogEntry, so ask
 * for one cap+sentinel page and feed it through the shared aggregator. If a backend applies a
 * smaller internal cap and says there is more while every returned commit is still in-window,
 * `truncated` stays honest.
 */
export async function readFallbackActivity(
  readLog: LogReader,
  refScope: RefScope = "head",
  until = Date.now(),
  scale: ActivityScale = "hourly",
): Promise<ActivityResult> {
  const window = activityWindow(scale, until);
  const commitCap = ACTIVITY_COMMIT_CAPS[scale];
  try {
    const result = await readLog(commitCap + 1, 0, undefined, refScope);
    if (!result.ok)
      return activityError(result.message ?? "activity unavailable", window.until, scale);
    const possiblyIncompleteWindow =
      result.hasMore &&
      (result.commits.length === 0 ||
        result.commits.every(
          (commit) => Number.isFinite(commit.date) && commit.date >= window.since,
        ));
    return aggregateActivity(result.commits, window.until, possiblyIncompleteWindow, scale);
  } catch (error) {
    return activityError(error instanceof Error ? error.message : String(error), window.until, scale);
  }
}
