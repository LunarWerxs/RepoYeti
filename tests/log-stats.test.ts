import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { logAuthorMatches, readLog } from "../src/read/inspect.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

// `git log --numstat` makes the log output MULTI-line per commit (one stat row per changed file
// after each commit record), so readLog's parser has to tell commit records from stat rows by
// shape. These tests pin that: the counts must match what git itself reports, and a stat row must
// never be mistaken for a commit (the failure mode that would silently inflate the commit list).

/** A repo with known, hand-countable per-commit stats. */
async function repoWithKnownStats(): Promise<string> {
  const dir = mkScratchDir("gm-logstat-");
  const git = (...a: string[]) => $`git -C ${dir} -c user.name=T -c user.email=t@t.io ${a}`.quiet();
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();

  // c1: one new file, 3 added lines.
  writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "c1 add a");

  // c2: two files — a.txt grows by 2 lines, b.txt is new with 1 line.
  writeFileSync(join(dir, "a.txt"), "1\n2\n3\n4\n5\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "c2 grow a, add b");

  // c3: delete b.txt (1 removed line, 1 file).
  await git("rm", "-q", "b.txt");
  await git("commit", "-q", "-m", "c3 drop b");

  return dir;
}

function authorEnv(name: string, email: string): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

async function commitAs(
  dir: string,
  sequence: number,
  subject: string,
  name: string,
  email: string,
): Promise<void> {
  const path = `author-${sequence}.txt`;
  writeFileSync(join(dir, path), `${subject}\n`);
  await $`git -C ${dir} add -- ${path}`.quiet();
  await $`git -C ${dir} commit -q -m ${subject}`.env(authorEnv(name, email)).quiet();
}

async function repoWithAuthors(): Promise<string> {
  const dir = mkScratchDir("gm-logauthor-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  return dir;
}

test("readLog reports per-commit file/line totals matching git", async () => {
  const dir = await repoWithKnownStats();
  const r = await readLog(dir, 50, 0);
  expect(r.ok).toBe(true);
  // Three commits and exactly three — a numstat row leaking through as a commit would inflate this.
  expect(r.commits.length).toBe(3);

  const by = (subject: string) => r.commits.find((c) => c.subject === subject)!.stat!;

  expect(by("c1 add a")).toEqual({ filesChanged: 1, addedLines: 3, removedLines: 0 });
  expect(by("c2 grow a, add b")).toEqual({ filesChanged: 2, addedLines: 3, removedLines: 0 });
  expect(by("c3 drop b")).toEqual({ filesChanged: 1, addedLines: 0, removedLines: 1 });
});

test("readLog still parses commit fields correctly alongside the stat rows", async () => {
  const dir = await repoWithKnownStats();
  const r = await readLog(dir, 50, 0);
  // Newest first, and no field has been shifted by the interleaved numstat lines.
  expect(r.commits.map((c) => c.subject)).toEqual(["c3 drop b", "c2 grow a, add b", "c1 add a"]);
  for (const c of r.commits) {
    expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(c.authorName).toBe("T");
    expect(c.authorEmail).toBe("t@t.io");
    expect(c.date).toBeGreaterThan(0);
  }
  expect(r.commits.at(-1)!.parents.length).toBe(0); // root
});

test("readLog counts a binary file as changed but contributes no lines", async () => {
  const dir = mkScratchDir("gm-logbin-");
  const git = (...a: string[]) => $`git -C ${dir} -c user.name=T -c user.email=t@t.io ${a}`.quiet();
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  // A NUL byte makes git treat it as binary, so --numstat prints "-\t-\t<path>".
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
  await git("add", "-A");
  await git("commit", "-q", "-m", "c-bin");

  const r = await readLog(dir, 5, 0);
  const stat = r.commits[0]!.stat!;
  expect(stat.filesChanged).toBe(1);
  expect(stat.addedLines).toBe(0);
  expect(stat.removedLines).toBe(0);
});

test("readLog pagination is unaffected by the extra stat lines", async () => {
  const dir = await repoWithKnownStats();
  // cap=2 must page on COMMITS, not on output lines (each commit emits several).
  const page1 = await readLog(dir, 2, 0);
  expect(page1.commits.length).toBe(2);
  expect(page1.hasMore).toBe(true);
  expect(page1.commits.map((c) => c.subject)).toEqual(["c3 drop b", "c2 grow a, add b"]);

  const page2 = await readLog(dir, 2, 2);
  expect(page2.commits.length).toBe(1);
  expect(page2.hasMore).toBe(false);
  expect(page2.commits[0]!.subject).toBe("c1 add a");
});

test("author-filter pagination counts matching commits rather than intervening history", async () => {
  const dir = await repoWithAuthors();
  await commitAs(dir, 1, "ada oldest", "Ada", "ada@example.com");
  await commitAs(dir, 2, "other one", "Other", "other@example.com");
  await commitAs(dir, 3, "ada middle", "Ada Alternate", "ADA@example.com");
  await commitAs(dir, 4, "other two", "Other", "other@example.com");
  await commitAs(dir, 5, "ada newest", "Ada", "ada@example.com");

  const first = await readLog(dir, 2, 0, undefined, "head", {
    name: "ignored because email wins",
    email: "  ADA@EXAMPLE.COM  ",
  });
  expect(first.ok).toBe(true);
  expect(first.commits.map((commit) => commit.subject)).toEqual([
    "ada newest",
    "ada middle",
  ]);
  expect(first.hasMore).toBe(true);

  const second = await readLog(dir, 2, 2, undefined, "head", {
    email: "ada@example.com",
  });
  expect(second.commits.map((commit) => commit.subject)).toEqual(["ada oldest"]);
  expect(second.hasMore).toBe(false);
});

test("author filtering separates identical names by email and treats punctuation literally", async () => {
  const dir = await repoWithAuthors();
  await commitAs(dir, 1, "shared alpha", "Shared Name", "alpha@example.com");
  await commitAs(dir, 2, "shared beta", "Shared Name", "beta@example.com");
  await commitAs(
    dir,
    3,
    "literal punctuation",
    "Regex.*[Coder]",
    "literal+[]()@example.com",
  );
  await commitAs(dir, 4, "regex lookalike", "RegexZZCoder", "literall@example.com");

  const alpha = await readLog(dir, 50, 0, undefined, "head", {
    name: "Shared Name",
    email: "alpha@example.com",
  });
  expect(alpha.commits.map((commit) => commit.subject)).toEqual(["shared alpha"]);

  const punctuation = await readLog(dir, 50, 0, undefined, "head", {
    email: "literal+[]()@example.com",
  });
  expect(punctuation.commits.map((commit) => commit.subject)).toEqual([
    "literal punctuation",
  ]);

  const nameFallback = await readLog(dir, 50, 0, undefined, "head", {
    name: "  REGEX.*[CODER]  ",
  });
  expect(nameFallback.commits.map((commit) => commit.subject)).toEqual([
    "literal punctuation",
  ]);
});

test("name-only author filters use exact normalized names", () => {
  expect(logAuthorMatches({ name: "  NAME ONLY  " }, "Name Only", "")).toBe(true);
  expect(logAuthorMatches({ name: "Name Only" }, "Name Onlyish", "")).toBe(false);
  expect(logAuthorMatches({ name: "Regex.*[Coder]" }, "Regex.*[Coder]", "")).toBe(true);
  expect(logAuthorMatches({ name: "Regex.*[Coder]" }, "RegexZZCoder", "")).toBe(false);
});

test("author filtering returns every alias grouped by .mailmap under its canonical identity", async () => {
  const dir = await repoWithAuthors();
  writeFileSync(
    join(dir, ".mailmap"),
    [
      "Canonical Coder <canonical@example.com> Alias One <one@example.com>",
      "Canonical Coder <canonical@example.com> Alias Two <two@example.com>",
      "",
    ].join("\n"),
  );
  await $`git -C ${dir} add -- .mailmap`.quiet();
  await $`git -C ${dir} commit -q -m ${"first alias"}`
    .env(authorEnv("Alias One", "one@example.com"))
    .quiet();
  await commitAs(dir, 2, "unrelated", "Other", "other@example.com");
  await commitAs(dir, 3, "second alias", "Alias Two", "two@example.com");

  const filtered = await readLog(dir, 50, 0, undefined, "head", {
    name: "Canonical Coder",
    email: "canonical@example.com",
  });

  expect(filtered.commits.map((commit) => commit.subject)).toEqual([
    "second alias",
    "first alias",
  ]);
  expect(
    filtered.commits.map(({ authorName, authorEmail }) => ({ authorName, authorEmail })),
  ).toEqual([
    { authorName: "Canonical Coder", authorEmail: "canonical@example.com" },
    { authorName: "Canonical Coder", authorEmail: "canonical@example.com" },
  ]);
});

test("a merge commit reports zero stats rather than a missing/duplicated record", async () => {
  const dir = mkScratchDir("gm-logmerge-");
  const git = (...a: string[]) => $`git -C ${dir} -c user.name=T -c user.email=t@t.io ${a}`.quiet();
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "init");
  await git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "feat.txt"), "feat\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "c-feat");
  await git("checkout", "-q", "main");
  writeFileSync(join(dir, "main.txt"), "main\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "c-main");
  await git("merge", "--no-ff", "-m", "merge feature", "feature");

  const r = await readLog(dir, 50, 0);
  const merge = r.commits.find((c) => c.subject === "merge feature")!;
  // git prints no diff for a merge, so the totals are zero — but the record must still be there
  // with a stat object, and the surrounding commits must keep their own real counts.
  expect(merge.isMerge).toBe(true);
  expect(merge.stat).toEqual({ filesChanged: 0, addedLines: 0, removedLines: 0 });
  expect(r.commits.find((c) => c.subject === "c-feat")!.stat!.filesChanged).toBe(1);
  expect(r.commits.find((c) => c.subject === "c-main")!.stat!.filesChanged).toBe(1);
});
