import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { readCommit, readLog } from "../src/read/inspect.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

const git = (dir: string, ...a: string[]) =>
  $`git -C ${dir} -c user.name=T -c user.email=t@t.io ${a}`.quiet();

async function initRepo(): Promise<string> {
  const dir = mkScratchDir("gm-inspectlog-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  return dir;
}

// F026: a commit subject may contain the unit separator (git only rejects NUL in messages). The
// list parser used to split on it and truncate %s at the first occurrence, so the History list
// disagreed with readCommit; %s is a trailing remainder and must be rejoined.
test("readLog keeps a subject that contains the unit separator (agrees with readCommit)", async () => {
  const dir = await initRepo();
  try {
    const subject = "before\u001fafter";
    writeFileSync(join(dir, "a.txt"), "a\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", subject);

    const log = await readLog(dir, 50, 0);
    expect(log.commits.length).toBe(1);
    expect(log.commits[0]!.subject).toBe(subject);

    const detail = await readCommit(dir, log.commits[0]!.hash);
    expect(detail.subject).toBe(subject);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// F024: only an unborn HEAD means "genuinely empty". Any other git failure (the repo directory is
// gone, HEAD points at a missing ref) must be reported as ERROR, not as an ok/empty log — otherwise
// a broken repo looks exactly like a fresh one.
test("readLog reports ERROR when the repo is gone but stays empty-ok for an unborn HEAD", async () => {
  const gone = join(mkScratchDir("gm-inspectlog-gone-"), "missing");
  const missing = await readLog(gone, 50, 0);
  expect(missing.ok).toBe(false);
  expect(missing.code).toBe("ERROR");
  expect(missing.commits).toEqual([]);

  const fresh = await initRepo();
  try {
    const head = await readLog(fresh, 50, 0);
    expect(head).toEqual({ ok: true, code: "OK", commits: [], hasMore: false });
    // local/all pass HEAD explicitly, which git rejects on an unborn branch — still not an error.
    const all = await readLog(fresh, 50, 0, undefined, "all");
    expect(all.ok).toBe(true);
    expect(all.commits).toEqual([]);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

/**
 * Build a linear history of `count` commits in ONE git process via fast-import, so a window-crossing
 * test doesn't spawn thousands of `git commit` children. Every `sparse`-th commit (1-based) is Ada.
 */
async function buildLongHistory(dir: string, count: number, sparse: number): Promise<void> {
  let stream = "";
  for (let i = 1; i <= count; i++) {
    const who =
      i % sparse === 1
        ? { name: "Ada", email: "ada@example.com" }
        : { name: "Other", email: "other@example.com" };
    const subject = `c${String(i).padStart(4, "0")}`;
    stream +=
      `commit refs/heads/main\n` +
      `author ${who.name} <${who.email}> ${1_600_000_000 + i} +0000\n` +
      `committer ${who.name} <${who.email}> ${1_600_000_000 + i} +0000\n` +
      `data ${subject.length}\n${subject}\n\n`;
  }
  const proc = Bun.spawn(["git", "-C", dir, "fast-import", "--quiet"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  proc.stdin.write(stream);
  await proc.stdin.end();
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
}

// F025: the author-filtered walk used to materialize the ENTIRE scope's metadata (and matching-hash
// list) for every page. It now walks in bounded windows; this history (1200 commits, every 100th
// Ada) must still surface every match, including ones past the first window, with correct paging.
test("author-filtered log walks past one window and pages correctly", async () => {
  const dir = await initRepo();
  try {
    await buildLongHistory(dir, 1200, 100);

    const first = await readLog(dir, 50, 0, undefined, "head", { email: "ada@example.com" });
    expect(first.ok).toBe(true);
    expect(first.commits.length).toBe(12);
    expect(first.hasMore).toBe(false);
    // Newest first: the Ada commit in each 100-block, so 1101, 1001, … 1 — crossing the
    // 1000-commit window boundary.
    expect(first.commits.map((c) => c.subject)).toEqual([
      "c1101", "c1001", "c0901", "c0801", "c0701", "c0601",
      "c0501", "c0401", "c0301", "c0201", "c0101", "c0001",
    ]);

    const page2 = await readLog(dir, 50, 10, undefined, "head", { email: "ada@example.com" });
    expect(page2.commits.map((c) => c.subject)).toEqual(["c0101", "c0001"]);
    expect(page2.hasMore).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
