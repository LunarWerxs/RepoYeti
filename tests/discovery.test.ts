import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../src/discovery.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "gm-disc-"));

test("finds a git repo, treats it as a leaf, and skips node_modules", () => {
  const root = tmp();
  mkdirSync(join(root, "repo-a", ".git"), { recursive: true });
  mkdirSync(join(root, "repo-a", "node_modules", "dep", ".git"), { recursive: true });
  mkdirSync(join(root, "plain", "nested"), { recursive: true }); // no .git anywhere

  const found = discover([root], 6, 200);
  const names = found.map((f) => f.name);
  expect(names).toContain("repo-a");
  expect(names).not.toContain("dep"); // node_modules skipped + repo is a discovery leaf
  expect(found.length).toBe(1);
});

test("flags a submodule (.git is a file) and not a real repo (.git is a dir)", () => {
  const root = tmp();
  mkdirSync(join(root, "mono", ".git"), { recursive: true });
  mkdirSync(join(root, "subm"), { recursive: true });
  writeFileSync(join(root, "subm", ".git"), "gitdir: ../.git/modules/subm");

  const found = discover([root], 6, 200);
  expect(found.find((f) => f.name === "mono")?.isSubmodule).toBe(false);
  expect(found.find((f) => f.name === "subm")?.isSubmodule).toBe(true);
});

test("respects the maxRepos cap", () => {
  const root = tmp();
  for (let i = 0; i < 5; i++) mkdirSync(join(root, `r${i}`, ".git"), { recursive: true });
  expect(discover([root], 6, 3).length).toBe(3);
});

test("respects the maxDepth limit", () => {
  const root = tmp();
  mkdirSync(join(root, "a", "b", "c", "deep", ".git"), { recursive: true });
  expect(discover([root], 2, 200).length).toBe(0); // repo is deeper than depth 2
  expect(discover([root], 6, 200).length).toBe(1);
});
