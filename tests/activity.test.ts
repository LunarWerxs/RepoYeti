import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { RepoYetiConfig } from "../src/config.ts";
import { getGitCommitStats, putGitCommitStats } from "../src/db.ts";
import { createApp } from "../src/http/app.ts";
import {
  ACTIVITY_AUTHOR_CAP,
  ACTIVITY_COMMIT_CAP,
  ACTIVITY_COMMIT_CAPS,
  ACTIVITY_QUERY_LIMIT,
  ACTIVITY_STAT_CACHE_VERSION,
  ACTIVITY_WINDOW_HOURS,
  type ActivityCommit,
  type ActivityStatCache,
  activityWindow,
  aggregateActivity,
  normalizeActivityScale,
  parseGitActivity,
  readFallbackActivity,
  readGitActivity,
  selectChangeStatCommits,
} from "../src/read/activity.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";

const HOUR_MS = 60 * 60 * 1000;
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

function entry(
  date: number,
  authorName: string,
  authorEmail: string,
  stat?: { filesChanged: number; addedLines: number; removedLines: number },
) {
  return {
    hash: `${date}-${authorEmail}`,
    shortHash: String(date).slice(-7),
    subject: "activity",
    authorName,
    authorEmail,
    date,
    refs: "",
    parents: [],
    isMerge: false,
    stat,
  };
}

test("aggregateActivity builds exact rolling totals, contributor groups, and 24 hourly buckets", () => {
  const until = Date.UTC(2026, 6, 24, 18, 30);
  const commits: ActivityCommit[] = [
    {
      authorName: "Alice",
      authorEmail: "ALICE@example.com",
      date: until - 30 * 60 * 1000,
      stat: { filesChanged: 2, addedLines: 3, removedLines: 1 },
    },
    {
      authorName: "Alice Cooper",
      authorEmail: "alice@example.com",
      date: until - 90 * 60 * 1000,
      stat: { filesChanged: 1, addedLines: 2, removedLines: 4 },
    },
    {
      authorName: "Bob",
      authorEmail: "",
      date: until - 5 * HOUR_MS,
    },
    {
      authorName: "Old",
      authorEmail: "old@example.com",
      date: until - 25 * HOUR_MS,
      stat: { filesChanged: 99, addedLines: 99, removedLines: 99 },
    },
  ];

  const result = aggregateActivity(commits, until);
  expect(result.ok).toBe(true);
  expect(result.windowHours).toBe(24);
  expect(result.until - result.since).toBe(24 * HOUR_MS);
  expect(result.commits).toBe(3);
  expect(result.commitsLastHour).toBe(1);
  expect(result.contributors).toBe(2);
  expect(result.filesChanged).toBe(3);
  expect(result.addedLines).toBe(5);
  expect(result.removedLines).toBe(5);
  expect(result.authors).toEqual([
    {
      name: "Alice",
      email: "ALICE@example.com",
      commits: 2,
      addedLines: 5,
      removedLines: 5,
    },
    { name: "Bob", email: "", commits: 1, addedLines: 0, removedLines: 0 },
  ]);
  expect(result.buckets).toHaveLength(ACTIVITY_WINDOW_HOURS);
  expect(result.buckets.map((bucket) => bucket.start)).toEqual(
    Array.from({ length: 24 }, (_, index) => result.since + index * HOUR_MS),
  );
  expect(result.buckets.reduce((sum, bucket) => sum + bucket.commits, 0)).toBe(3);
  expect(result.buckets[23]!.commits).toBe(1);
  expect(result.buckets[22]!.commits).toBe(1);
  expect(result.buckets[19]!.commits).toBe(1);
});

test("aggregateActivity builds 30 local-calendar day buckets including today", () => {
  const until = new Date(2026, 6, 24, 18, 30).getTime();
  const window = activityWindow("daily", until);
  const today = new Date(2026, 6, 24).getTime();
  const yesterday = new Date(2026, 6, 23).getTime();
  const result = aggregateActivity(
    [
      {
        authorName: "First",
        authorEmail: "first@example.com",
        date: window.since,
        stat: { filesChanged: 1, addedLines: 2, removedLines: 0 },
      },
      {
        authorName: "Yesterday",
        authorEmail: "yesterday@example.com",
        date: yesterday + HOUR_MS,
        stat: { filesChanged: 1, addedLines: 3, removedLines: 1 },
      },
      {
        authorName: "Today",
        authorEmail: "today@example.com",
        date: today + HOUR_MS,
        stat: { filesChanged: 1, addedLines: 4, removedLines: 2 },
      },
      {
        authorName: "Too old",
        authorEmail: "old@example.com",
        date: window.since - 1,
      },
    ],
    until,
    false,
    "daily",
  );

  expect(result.scale).toBe("daily");
  expect(result.bucketUnit).toBe("day");
  expect(result.windowCount).toBe(30);
  expect(result.buckets).toHaveLength(30);
  expect(result.buckets[0]!.start).toBe(window.since);
  expect(result.buckets[0]!.end).toBe(result.buckets[1]!.start);
  expect(result.buckets[28]!.start).toBe(yesterday);
  expect(result.buckets[29]!.start).toBe(today);
  expect(result.buckets[29]!.end).toBe(until);
  expect(result.buckets[0]!.commits).toBe(1);
  expect(result.buckets[28]!.commits).toBe(1);
  expect(result.buckets[29]!.commits).toBe(1);
  expect(result.commits).toBe(3);
  expect(result.addedLines).toBe(9);
  expect(result.windowHours).toBe((until - window.since) / HOUR_MS);
});

test("aggregateActivity builds 12 calendar-aware month buckets including this month", () => {
  const until = new Date(2026, 6, 24, 18, 30).getTime();
  const firstMonth = new Date(2025, 7, 1).getTime();
  const previousMonth = new Date(2026, 5, 1).getTime();
  const currentMonth = new Date(2026, 6, 1).getTime();
  const result = aggregateActivity(
    [
      {
        authorName: "First",
        authorEmail: "first@example.com",
        date: firstMonth,
      },
      {
        authorName: "Previous",
        authorEmail: "previous@example.com",
        date: new Date(2026, 5, 30, 23, 59).getTime(),
      },
      {
        authorName: "Current",
        authorEmail: "current@example.com",
        date: currentMonth,
      },
      {
        authorName: "Before range",
        authorEmail: "old@example.com",
        date: firstMonth - 1,
      },
    ],
    until,
    false,
    "monthly",
  );

  expect(result.scale).toBe("monthly");
  expect(result.bucketUnit).toBe("month");
  expect(result.windowCount).toBe(12);
  expect(result.buckets).toHaveLength(12);
  expect(result.since).toBe(firstMonth);
  expect(result.buckets[0]!.start).toBe(firstMonth);
  expect(result.buckets[0]!.end).toBe(result.buckets[1]!.start);
  expect(result.buckets[10]!.start).toBe(previousMonth);
  expect(result.buckets[11]!.start).toBe(currentMonth);
  expect(result.buckets[11]!.end).toBe(until);
  expect(result.buckets[0]!.commits).toBe(1);
  expect(result.buckets[10]!.commits).toBe(1);
  expect(result.buckets[11]!.commits).toBe(1);
  expect(result.commits).toBe(3);
});

test("activity scale parsing defaults invalid values to hourly", () => {
  expect(normalizeActivityScale(undefined)).toBe("hourly");
  expect(normalizeActivityScale("hourly")).toBe("hourly");
  expect(normalizeActivityScale("daily")).toBe("daily");
  expect(normalizeActivityScale("monthly")).toBe("monthly");
  expect(normalizeActivityScale("yearly")).toBe("hourly");
});

test("change-stat sampling covers every active Daily and Monthly bucket", () => {
  const until = new Date(2026, 6, 24, 18, 30).getTime();
  for (const scale of ["daily", "monthly"] as const) {
    const window = activityWindow(scale, until);
    const commits = window.starts
      .flatMap((start, bucket) =>
        Array.from({ length: bucket + 2 }, (_, index) => ({
          hash: `${scale}-${bucket}-${index}`,
          date: start + index + 1,
        })),
      )
      .sort((a, b) => b.date - a.date);
    const selected = selectChangeStatCommits(
      commits,
      window.starts,
      window.starts.length,
    );

    expect(selected).toHaveLength(window.starts.length);
    expect(
      new Set(selected.map((commit) => Number(commit.hash.split("-")[1]))),
    ).toEqual(new Set(window.starts.map((_, index) => index)));
  }

  const sparseStarts = [100, 200, 300];
  const sparse = [
    ...Array.from({ length: 20 }, (_, index) => ({ hash: `new-${index}`, date: 301 + index })),
    { hash: "middle-only", date: 201 },
    { hash: "old-only", date: 101 },
  ];
  const selected = selectChangeStatCommits(sparse, sparseStarts, 10);
  expect(selected).toHaveLength(10);
  expect(selected.some((commit) => commit.hash === "old-only")).toBe(true);
  expect(selected.some((commit) => commit.hash === "middle-only")).toBe(true);
});

test("aggregateActivity keeps the newest 5000 commits and exposes the cap sentinel", () => {
  const until = Date.UTC(2026, 6, 24, 18, 30);
  const commits: ActivityCommit[] = Array.from({ length: ACTIVITY_QUERY_LIMIT }, (_, index) => ({
    authorName: "Busy",
    authorEmail: "busy@example.com",
    date: until - index,
    stat: { filesChanged: 1, addedLines: 1, removedLines: 0 },
  }));

  const result = aggregateActivity(commits, until);
  expect(result.commits).toBe(ACTIVITY_COMMIT_CAP);
  expect(result.filesChanged).toBe(ACTIVITY_COMMIT_CAP);
  expect(result.addedLines).toBe(ACTIVITY_COMMIT_CAP);
  expect(result.truncated).toBe(true);
  expect(result.commitsTruncated).toBe(true);
  expect(result.changeStatsTruncated).toBe(false);
});

test("aggregateActivity keeps commit counts exact while marking bounded change statistics", () => {
  const until = new Date(2026, 6, 24, 18, 30).getTime();
  const result = aggregateActivity(
    [
      {
        authorName: "Known",
        authorEmail: "known@example.com",
        date: until - HOUR_MS,
        stat: { filesChanged: 2, addedLines: 9, removedLines: 3 },
        changeStatsKnown: true,
      },
      {
        authorName: "Metadata only",
        authorEmail: "metadata@example.com",
        date: until - 2 * HOUR_MS,
        changeStatsKnown: false,
      },
    ],
    until,
    false,
    "daily",
    true,
  );

  expect(result.commits).toBe(2);
  expect(result.contributors).toBe(2);
  expect(result.filesChanged).toBe(2);
  expect(result.addedLines).toBe(9);
  expect(result.removedLines).toBe(3);
  expect(result.commitsTruncated).toBe(false);
  expect(result.changeStatsTruncated).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.buckets.reduce((sum, bucket) => sum + bucket.commits, 0)).toBe(2);
  expect(result.buckets.reduce((sum, bucket) => sum + bucket.changeStatsCommits, 0)).toBe(1);
});

test("aggregateActivity keeps the contributor count exact while capping ranked author detail", () => {
  const until = Date.UTC(2026, 6, 24, 18, 30);
  const commits: ActivityCommit[] = Array.from({ length: ACTIVITY_AUTHOR_CAP + 5 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return {
      authorName: `User ${suffix}`,
      authorEmail: `user${suffix}@example.com`,
      date: until - index,
      stat: { filesChanged: 1, addedLines: 1, removedLines: 0 },
    };
  });

  const result = aggregateActivity(commits, until);
  expect(result.contributors).toBe(ACTIVITY_AUTHOR_CAP + 5);
  expect(result.authors).toHaveLength(ACTIVITY_AUTHOR_CAP);
  expect(result.authors[0]!.name).toBe("User 00");
  expect(result.authors.at(-1)!.name).toBe("User 24");
});

test("readFallbackActivity marks Lore entries without stats partial but preserves explicit zero stats", async () => {
  const until = Date.UTC(2026, 6, 24, 18, 30);
  let call: unknown[] = [];
  const result = await readFallbackActivity(
    async (...args) => {
      call = args;
      return {
        ok: true,
        code: "OK",
        commits: [
          entry(until - HOUR_MS, "Lore User", "", undefined),
          entry(until - 26 * HOUR_MS, "Old Lore User", "", undefined),
        ],
        hasMore: false,
      };
    },
    "all",
    until,
  );

  expect(call).toEqual([ACTIVITY_QUERY_LIMIT, 0, undefined, "all"]);
  expect(result.commits).toBe(1);
  expect(result.contributors).toBe(1);
  expect(result.filesChanged).toBe(0);
  expect(result.addedLines).toBe(0);
  expect(result.removedLines).toBe(0);
  expect(result.commitsTruncated).toBe(false);
  expect(result.changeStatsTruncated).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.buckets.reduce((sum, bucket) => sum + bucket.changeStatsCommits, 0)).toBe(0);

  const knownZero = await readFallbackActivity(
    async () => ({
      ok: true,
      code: "OK",
      commits: [
        entry(
          until - HOUR_MS,
          "Stats-capable User",
          "stats@example.com",
          { filesChanged: 0, addedLines: 0, removedLines: 0 },
        ),
      ],
      hasMore: false,
    }),
    "head",
    until,
  );
  expect(knownZero.changeStatsTruncated).toBe(false);
  expect(knownZero.truncated).toBe(false);
  expect(
    knownZero.buckets.reduce((sum, bucket) => sum + bucket.changeStatsCommits, 0),
  ).toBe(1);

  const capped = await readFallbackActivity(
    async () => ({
      ok: true,
      code: "OK",
      commits: [entry(until - HOUR_MS, "Lore User", "", undefined)],
      hasMore: true,
    }),
    "head",
    until,
  );
  expect(capped.truncated).toBe(true);

  let dailyLimit = 0;
  const daily = await readFallbackActivity(
    async (limit) => {
      dailyLimit = limit ?? 0;
      return { ok: true, code: "OK", commits: [], hasMore: false };
    },
    "head",
    until,
    "daily",
  );
  expect(dailyLimit).toBe(ACTIVITY_COMMIT_CAPS.daily + 1);
  expect(daily.scale).toBe("daily");
  expect(daily.buckets).toHaveLength(30);
});

function commitEnv(name: string, email: string, date: number): Record<string, string | undefined> {
  const iso = new Date(date).toISOString();
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  };
}

function splitDateCommitEnv(
  name: string,
  email: string,
  authorDate: number,
  committerDate: number,
): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: new Date(authorDate).toISOString(),
    GIT_COMMITTER_DATE: new Date(committerDate).toISOString(),
  };
}

async function commitFile(
  dir: string,
  path: string,
  content: string | Uint8Array,
  message: string,
  name: string,
  email: string,
  date: number,
): Promise<void> {
  writeFileSync(join(dir, path), content);
  await $`git -C ${dir} add -- ${path}`.quiet();
  await $`git -C ${dir} commit -q -m ${message}`.env(commitEnv(name, email, date)).quiet();
}

test("shortstat parser handles translated labels, one-sided changes, and no-stat commits", () => {
  const field = "\x1f";
  const raw = [
    `a${field}Add${field}add@example.com${field}100`,
    " 1 Datei geändert, 7 Zeilen hinzugefügt(+)",
    `b${field}Remove${field}remove@example.com${field}99`,
    " 2 fichiers modifiés, 3 suppressions(-)",
    `c${field}Both${field}both@example.com${field}98`,
    " 4 archivos modificados, 11 inserciones(+), 9 eliminaciones(-)",
    `d${field}Rename${field}rename@example.com${field}97`,
    " 1 bestand gewijzigd",
    `e${field}Binary${field}binary@example.com${field}96`,
    " 1 file changed, 0 insertions(+), 0 deletions(-)",
    `f${field}Empty${field}empty@example.com${field}95`,
  ].join("\n");

  expect(parseGitActivity(raw).map((commit) => commit.stat)).toEqual([
    { filesChanged: 1, addedLines: 7, removedLines: 0 },
    { filesChanged: 2, addedLines: 0, removedLines: 3 },
    { filesChanged: 4, addedLines: 11, removedLines: 9 },
    { filesChanged: 1, addedLines: 0, removedLines: 0 },
    { filesChanged: 1, addedLines: 0, removedLines: 0 },
    { filesChanged: 0, addedLines: 0, removedLines: 0 },
  ]);
});

test("metadata parser distinguishes omitted diff statistics from genuine zero-change commits", () => {
  const field = "\x1f";
  const raw = `abc${field}Author${field}author@example.com${field}100`;
  expect(parseGitActivity(raw, false)).toEqual([
    {
      hash: "abc",
      authorName: "Author",
      authorEmail: "author@example.com",
      date: 100_000,
      stat: undefined,
      changeStatsKnown: false,
    },
  ]);
});

test("persistent commit-stat cache is repo-scoped, versioned, and preserves known zero stats", () => {
  const repoId = mustUpsertRepo(
    mkScratchDir("ry-activity-cache-"),
    `activity-cache-${randomUUID()}`,
    "auto",
    false,
  );
  const otherRepoId = `activity-cache-${randomUUID()}`;
  const hash = "a".repeat(40);
  const date = Date.UTC(2026, 6, 1);
  const zero = { filesChanged: 0, addedLines: 0, removedLines: 0 };

  putGitCommitStats(
    repoId,
    [{ hash, date, stat: zero }],
    ACTIVITY_STAT_CACHE_VERSION,
  );

  expect(
    getGitCommitStats(
      repoId,
      date - 1,
      date + 1,
      ACTIVITY_STAT_CACHE_VERSION,
    ).get(hash),
  ).toEqual(zero);
  expect(
    getGitCommitStats(
      otherRepoId,
      date - 1,
      date + 1,
      ACTIVITY_STAT_CACHE_VERSION,
    ).size,
  ).toBe(0);
  expect(
    getGitCommitStats(
      repoId,
      date - 1,
      date + 1,
      ACTIVITY_STAT_CACHE_VERSION + 1,
    ).size,
  ).toBe(0);

  putGitCommitStats(
    otherRepoId,
    [{ hash, date, stat: zero }],
    ACTIVITY_STAT_CACHE_VERSION,
  );
  expect(
    getGitCommitStats(
      otherRepoId,
      date - 1,
      date + 1,
      ACTIVITY_STAT_CACHE_VERSION,
    ).size,
  ).toBe(0);
});

test("Git Daily sampling fills old, middle, and recent bars progressively from cache misses", async () => {
  const dir = mkScratchDir("ry-activity-stratified-");
  const until = new Date(2026, 6, 24, 18, 30).getTime();
  const window = activityWindow("daily", until);
  const activeBuckets = [1, 15, 29];
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();

  for (const bucket of activeBuckets) {
    for (let index = 0; index < 2; index++) {
      await commitFile(
        dir,
        `bucket-${bucket}-${index}.txt`,
        `bucket ${bucket}, commit ${index}\n`,
        `bucket ${bucket}, commit ${index}`,
        "Sampler",
        "sampler@example.com",
        window.starts[bucket]! + HOUR_MS + index * 60_000,
      );
    }
  }

  const stored = new Map<string, { filesChanged: number; addedLines: number; removedLines: number }>();
  const writeSizes: number[] = [];
  const statCache: ActivityStatCache = {
    read: () => new Map(stored),
    write: (entries) => {
      writeSizes.push(entries.length);
      for (const entry of entries) stored.set(entry.hash, entry.stat);
    },
  };

  const first = await readGitActivity(dir, "head", until, "daily", {
    changeStatCap: 3,
    statCache,
  });
  expect(first.ok).toBe(true);
  expect(first.commits).toBe(6);
  expect(first.buckets.reduce((sum, bucket) => sum + bucket.commits, 0)).toBe(6);
  expect(first.buckets.reduce((sum, bucket) => sum + bucket.changeStatsCommits, 0)).toBe(3);
  for (const bucket of activeBuckets) {
    expect(first.buckets[bucket]).toMatchObject({
      commits: 2,
      changeStatsCommits: 1,
      filesChanged: 1,
      addedLines: 1,
      removedLines: 0,
    });
  }
  expect(first.commitsTruncated).toBe(false);
  expect(first.changeStatsTruncated).toBe(true);
  expect(first.truncated).toBe(true);
  expect(writeSizes).toEqual([3]);

  const second = await readGitActivity(dir, "head", until, "daily", {
    changeStatCap: 3,
    statCache,
  });
  expect(second.buckets.reduce((sum, bucket) => sum + bucket.changeStatsCommits, 0)).toBe(6);
  for (const bucket of activeBuckets) {
    expect(second.buckets[bucket]).toMatchObject({
      commits: 2,
      changeStatsCommits: 2,
      filesChanged: 2,
      addedLines: 2,
      removedLines: 0,
    });
  }
  expect(second.changeStatsTruncated).toBe(false);
  expect(second.truncated).toBe(false);
  expect(writeSizes).toEqual([3, 3]);

  const third = await readGitActivity(dir, "head", until, "daily", {
    changeStatCap: 3,
    statCache,
  });
  expect(third).toEqual(second);
  expect(writeSizes).toEqual([3, 3]);
});

test("Git shortstat activity counts add-only, delete-only, pure rename, and binary commits", async () => {
  const dir = mkScratchDir("ry-activity-stats-");
  const until = Date.now();
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  // The activity policy pins rename detection, so a mutable repo preference cannot change an
  // already-cached commit's meaning.
  await $`git -C ${dir} config diff.renames false`.quiet();
  await commitFile(
    dir,
    "seed.txt",
    "seed\n",
    "old seed",
    "Seed",
    "seed@example.com",
    until - 26 * HOUR_MS,
  );
  await commitFile(
    dir,
    "lines.txt",
    "one\ntwo\nthree\n",
    "add lines",
    "Add Author",
    "add@example.com",
    until - 4 * HOUR_MS,
  );
  await commitFile(
    dir,
    "lines.txt",
    "one\n",
    "remove lines",
    "Delete Author",
    "delete@example.com",
    until - 3 * HOUR_MS,
  );
  await $`git -C ${dir} mv -- lines.txt renamed.txt`.quiet();
  await $`git -C ${dir} commit -q -m "rename only"`
    .env(commitEnv("Rename Author", "rename@example.com", until - 2 * HOUR_MS))
    .quiet();
  await commitFile(
    dir,
    "binary.bin",
    new Uint8Array([0, 1, 2, 0, 3]),
    "binary add",
    "Binary Author",
    "binary@example.com",
    until - HOUR_MS,
  );

  const result = await readGitActivity(dir, "head", until);
  expect(result.ok).toBe(true);
  expect(result.commits).toBe(4);
  expect(result.filesChanged).toBe(4);
  expect(result.addedLines).toBe(3);
  expect(result.removedLines).toBe(2);
  expect(result.authors.find((author) => author.email === "add@example.com")).toMatchObject({
    addedLines: 3,
    removedLines: 0,
  });
  expect(result.authors.find((author) => author.email === "delete@example.com")).toMatchObject({
    addedLines: 0,
    removedLines: 2,
  });
  expect(result.authors.find((author) => author.email === "rename@example.com")).toMatchObject({
    addedLines: 0,
    removedLines: 0,
  });
  expect(result.authors.find((author) => author.email === "binary@example.com")).toMatchObject({
    addedLines: 0,
    removedLines: 0,
  });
});

test("Git activity filters and buckets commits by the author date shown in History", async () => {
  const dir = mkScratchDir("ry-activity-author-date-");
  const until = Date.now();
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();

  writeFileSync(join(dir, "rebased.txt"), "old authored work\n");
  await $`git -C ${dir} add -- rebased.txt`.quiet();
  await $`git -C ${dir} commit -q -m "rebased old work"`
    .env(
      splitDateCommitEnv(
        "Earlier Author",
        "earlier@example.com",
        until - 48 * HOUR_MS,
        until - 2 * HOUR_MS,
      ),
    )
    .quiet();

  await commitFile(
    dir,
    "recent.txt",
    "recent\n",
    "recent work",
    "Recent Author",
    "recent@example.com",
    until - HOUR_MS,
  );

  const hourly = await readGitActivity(dir, "head", until);
  expect(hourly.ok).toBe(true);
  // The earlier commit's recent committer timestamp must not leak it into the author-date window.
  expect(hourly.commits).toBe(1);
  expect(hourly.authors).toEqual([
    {
      name: "Recent Author",
      email: "recent@example.com",
      commits: 1,
      addedLines: 1,
      removedLines: 0,
    },
  ]);

  const daily = await readGitActivity(dir, "head", until, "daily");
  expect(daily.ok).toBe(true);
  expect(daily.commits).toBe(2);
  const earlierBucket = daily.buckets.find(
    (bucket) => bucket.start <= until - 48 * HOUR_MS && until - 48 * HOUR_MS < bucket.end,
  );
  const committerBucket = daily.buckets.find(
    (bucket) => bucket.start <= until - 2 * HOUR_MS && until - 2 * HOUR_MS < bucket.end,
  );
  expect(earlierBucket?.commits).toBe(1);
  expect(committerBucket?.commits).toBe(1);
});

test("Git activity canonicalizes contributor aliases through mailmap", async () => {
  const dir = mkScratchDir("ry-activity-mailmap-");
  const until = Date.now();
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();

  writeFileSync(
    join(dir, ".mailmap"),
    [
      "Canonical Coder <canonical@example.com> Alias One <one@example.com>",
      "Canonical Coder <canonical@example.com> Alias Two <two@example.com>",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "one.txt"), "one\n");
  await $`git -C ${dir} add -- .mailmap one.txt`.quiet();
  await $`git -C ${dir} commit -q -m "first alias"`
    .env(commitEnv("Alias One", "one@example.com", until - 2 * HOUR_MS))
    .quiet();
  await commitFile(
    dir,
    "two.txt",
    "two\n",
    "second alias",
    "Alias Two",
    "two@example.com",
    until - HOUR_MS,
  );

  const result = await readGitActivity(dir, "head", until);
  expect(result.ok).toBe(true);
  expect(result.contributors).toBe(1);
  expect(result.authors).toEqual([
    {
      name: "Canonical Coder",
      email: "canonical@example.com",
      commits: 2,
      addedLines: 4,
      removedLines: 0,
    },
  ]);
});

test("Git activity respects the 24-hour window and ref scope, and counts a merge with zero stats", async () => {
  const dir = mkScratchDir("ry-activity-");
  const until = Date.now();
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await commitFile(
    dir,
    "seed.txt",
    "old\n",
    "old seed",
    "Old",
    "old@example.com",
    until - 26 * HOUR_MS,
  );

  await $`git -C ${dir} checkout -q -b feature`.quiet();
  await commitFile(
    dir,
    "feature.txt",
    "one\ntwo\n",
    "feature work",
    "Feature Author",
    "feature@example.com",
    until - 2 * HOUR_MS,
  );
  await $`git -C ${dir} checkout -q main`.quiet();
  await commitFile(
    dir,
    "main.txt",
    "main\n",
    "main work",
    "Main Author",
    "main@example.com",
    until - 90 * 60 * 1000,
  );

  const headBeforeMerge = await readGitActivity(dir, "head", until);
  const allBeforeMerge = await readGitActivity(dir, "all", until);
  expect(headBeforeMerge.commits).toBe(1);
  expect(headBeforeMerge.addedLines).toBe(1);
  expect(allBeforeMerge.commits).toBe(2);
  expect(allBeforeMerge.filesChanged).toBe(2);
  expect(allBeforeMerge.addedLines).toBe(3);
  expect(allBeforeMerge.contributors).toBe(2);

  await $`git -C ${dir} merge --no-ff -q -m "merge feature" feature`
    .env(commitEnv("Merge Bot", "merge@example.com", until - 20 * 60 * 1000))
    .quiet();
  const merged = await readGitActivity(dir, "head", until);
  expect(merged.ok).toBe(true);
  expect(merged.commits).toBe(3);
  expect(merged.commitsLastHour).toBe(1);
  expect(merged.contributors).toBe(3);
  // The merge is a commit, but plain `git log --shortstat` gives it no duplicate diff summary.
  expect(merged.filesChanged).toBe(2);
  expect(merged.addedLines).toBe(3);
  expect(merged.removedLines).toBe(0);
  expect(merged.truncated).toBe(false);
  expect(merged.buckets.reduce((sum, bucket) => sum + bucket.commits, 0)).toBe(3);

  const id = mustUpsertRepo(dir, "activity-route", "auto", false);
  const app = createApp(localCfg());
  const response = await app.request(`/api/repos/${id}/activity?refs=all&scale=daily`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.scale).toBe("daily");
  expect(body.bucketUnit).toBe("day");
  expect(body.windowCount).toBe(30);
  expect(body.commits).toBe(4);
  expect(body.buckets).toHaveLength(30);
  expect(body.commitsTruncated).toBe(false);
  expect(body.changeStatsTruncated).toBe(false);
  expect(body.buckets.every((bucket: { end?: number }) => Number.isFinite(bucket.end))).toBe(true);
  expect(body.until - body.since).toBeGreaterThan(29 * 24 * HOUR_MS);
  expect(
    getGitCommitStats(
      id,
      body.since,
      body.until,
      ACTIVITY_STAT_CACHE_VERSION,
    ).size,
  ).toBe(4);

  const defaultResponse = await app.request(`/api/repos/${id}/activity?scale=invalid`);
  expect((await defaultResponse.json()).scale).toBe("hourly");
  expect((await app.request("/api/repos/missing/activity")).status).toBe(404);
});
