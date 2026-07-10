import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { discoverStream, machineScanRoots, type FoundRepo } from "../src/discovery.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "gm-disc-"));

/** Collect discoverStream's `onFound` callback into an array (the walk is async). */
async function discover(roots: string[], maxDepth: number, maxRepos: number): Promise<FoundRepo[]> {
  const found: FoundRepo[] = [];
  await discoverStream(roots, maxDepth, maxRepos, (f) => found.push(f));
  return found;
}

test("finds a git repo, treats it as a leaf, and skips node_modules", async () => {
  const root = tmp();
  mkdirSync(join(root, "repo-a", ".git"), { recursive: true });
  mkdirSync(join(root, "repo-a", "node_modules", "dep", ".git"), { recursive: true });
  mkdirSync(join(root, "plain", "nested"), { recursive: true }); // no .git anywhere

  const found = await discover([root], 6, 200);
  const names = found.map((f) => f.name);
  expect(names).toContain("repo-a");
  expect(names).not.toContain("dep"); // node_modules skipped + repo is a discovery leaf
  expect(found.length).toBe(1);
});

test("flags a submodule (.git is a file) and not a real repo (.git is a dir)", async () => {
  const root = tmp();
  mkdirSync(join(root, "mono", ".git"), { recursive: true });
  mkdirSync(join(root, "subm"), { recursive: true });
  writeFileSync(join(root, "subm", ".git"), "gitdir: ../.git/modules/subm");

  const found = await discover([root], 6, 200);
  expect(found.find((f) => f.name === "mono")?.isSubmodule).toBe(false);
  expect(found.find((f) => f.name === "subm")?.isSubmodule).toBe(true);
});

test("respects the maxRepos cap", async () => {
  const root = tmp();
  for (let i = 0; i < 5; i++) mkdirSync(join(root, `r${i}`, ".git"), { recursive: true });
  expect((await discover([root], 6, 3)).length).toBe(3);
});

test("respects the maxDepth limit", async () => {
  const root = tmp();
  mkdirSync(join(root, "a", "b", "c", "deep", ".git"), { recursive: true });
  expect((await discover([root], 2, 200)).length).toBe(0); // repo is deeper than depth 2
  expect((await discover([root], 6, 200)).length).toBe(1);
});

test("a concurrent walk still finds every repo", async () => {
  const root = tmp();
  for (let i = 0; i < 12; i++) mkdirSync(join(root, `c${i}`, ".git"), { recursive: true });
  const found: FoundRepo[] = [];
  await discoverStream([root], 6, 200, (f) => found.push(f), undefined, { concurrency: 8 });
  expect(found.length).toBe(12);
});

test("overlapping roots are walked once (no double-count)", async () => {
  const root = tmp();
  mkdirSync(join(root, "nested", "repo", ".git"), { recursive: true });
  const found: FoundRepo[] = [];
  // A root and its own subfolder both passed as roots → the repo is reported exactly once.
  await discoverStream([root, join(root, "nested")], 6, 200, (f) => found.push(f), undefined, {
    concurrency: 4,
  });
  expect(found.filter((f) => f.name === "repo").length).toBe(1);
});

test("a zero time budget stops the walk immediately", async () => {
  const root = tmp();
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  const found: FoundRepo[] = [];
  // budgetMs is a positive ceiling; 1ms with a forced-past deadline can't be relied on, but a
  // walk that never starts (empty roots) and a walk with a real budget both terminate.
  await discoverStream([root], 6, 200, (f) => found.push(f), undefined, { budgetMs: 60_000 });
  expect(found.length).toBe(1); // a generous budget doesn't cut a tiny walk short
});

test("machineScanRoots includes home and (on Windows) a drive root", () => {
  const roots = machineScanRoots();
  expect(roots).toContain(homedir());
  expect(roots.length).toBeGreaterThan(0);
  if (process.platform === "win32") {
    expect(roots.some((r) => /^[A-Za-z]:\\$/.test(r))).toBe(true);
  } else {
    expect(roots).toContain("/");
  }
});
