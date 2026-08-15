// The "All files" browse mode's directory listing (src/service/tree.ts) + its route.
//
// The security-shaped cases matter most here: this is the one read surface whose whole purpose is
// to walk paths the user did NOT already have a handle on, so traversal, the VCS metadata
// boundary, and symlink descent each get an explicit test rather than being implied by the
// file-reader's coverage.
import { test, expect } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { RepoYetiConfig } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import {
  listRepoTree,
  searchRepoTree,
  MAX_TREE_ENTRIES,
  MAX_TREE_SEARCH_RESULTS,
  type RepoTreeEntry,
} from "../src/service/index.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

async function gitRepo(): Promise<string> {
  const dir = mkScratchDir("gm-tree-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("lists the repo root when no path is given", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "readme.md"), "hi\n");
  mkdirSync(join(dir, "src"));
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await listRepoTree(id);

  expect(res.ok).toBe(true);
  expect(res.path).toBe("");
  const names = (res.entries ?? []).map((e) => e.name);
  expect(names).toContain("readme.md");
  expect(names).toContain("src");
});

test("directories sort before files, each case-insensitively alphabetical", async () => {
  const dir = await gitRepo();
  for (const d of ["zeta", "Alpha"]) mkdirSync(join(dir, d));
  for (const f of ["b.txt", "A.txt"]) writeFileSync(join(dir, f), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await listRepoTree(id);

  expect((res.entries ?? []).map((e) => e.name)).toEqual(["Alpha", "zeta", "A.txt", "b.txt"]);
});

test("lists a nested directory and reports repo-relative paths", async () => {
  const dir = await gitRepo();
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  writeFileSync(join(dir, "src", "deep", "leaf.ts"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await listRepoTree(id, "src/deep");

  expect(res.ok).toBe(true);
  expect(res.path).toBe("src/deep");
  expect(res.entries).toEqual([{ name: "leaf.ts", path: "src/deep/leaf.ts", type: "file" }]);
});

// The mode's whole selling point: `dist/` and `node_modules/` are exactly what you open it for.
test("includes gitignored paths — that is the point of the mode", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, ".gitignore"), "dist/\n");
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "bundle.js"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const root = await listRepoTree(id);
  expect((root.entries ?? []).map((e) => e.name)).toContain("dist");

  const inner = await listRepoTree(id, "dist");
  expect((inner.entries ?? []).map((e) => e.name)).toEqual(["bundle.js"]);
});

// VS Code dims ignored entries in its explorer; the panel does the same, and the daemon is what
// knows. Asking git (rather than matching patterns here) is what makes negations and nested
// .gitignore files come out right.
test("marks which listed entries git is ignoring", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, ".gitignore"), "dist/\n*.log\n");
  mkdirSync(join(dir, "dist"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "app.log"), "x");
  writeFileSync(join(dir, "app.ts"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const byName = new Map((await listRepoTree(id)).entries?.map((e) => [e.name, e]) ?? []);

  expect(byName.get("dist")?.ignored).toBe(true);
  expect(byName.get("app.log")?.ignored).toBe(true);
  // Absent rather than false, so an un-ignored row ships nothing extra.
  expect(byName.get("src")?.ignored).toBeUndefined();
  expect(byName.get("app.ts")?.ignored).toBeUndefined();
  expect(byName.get(".gitignore")?.ignored).toBeUndefined();
});

test("ignore marks honour negations, not a naive pattern match", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, ".gitignore"), "logs/*\n!logs/keep.log\n");
  mkdirSync(join(dir, "logs"));
  writeFileSync(join(dir, "logs", "drop.log"), "x");
  writeFileSync(join(dir, "logs", "keep.log"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const byName = new Map((await listRepoTree(id, "logs")).entries?.map((e) => [e.name, e]) ?? []);

  expect(byName.get("drop.log")?.ignored).toBe(true);
  expect(byName.get("keep.log")?.ignored).toBeUndefined();
});

test("a repo with nothing ignored marks nothing", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "a.ts"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  // `git check-ignore` exits 1 when no path matches; that must read as "none", not as an error.
  const res = await listRepoTree(id);

  expect(res.ok).toBe(true);
  expect(res.entries?.every((e) => e.ignored === undefined)).toBe(true);
});

test("marks entries whose names contain spaces and quotes", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, ".gitignore"), "*.tmp\n");
  writeFileSync(join(dir, "a file with spaces.tmp"), "x");
  writeFileSync(join(dir, "plain.ts"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  // NUL-separated stdin is what keeps this honest — as arguments the name would be re-split.
  const byName = new Map((await listRepoTree(id)).entries?.map((e) => [e.name, e]) ?? []);

  expect(byName.get("a file with spaces.tmp")?.ignored).toBe(true);
  expect(byName.get("plain.ts")?.ignored).toBeUndefined();
});

test("never lists the VCS metadata directory, at the root or nested", async () => {
  const dir = await gitRepo();
  mkdirSync(join(dir, "sub"), { recursive: true });
  mkdirSync(join(dir, "sub", ".git"), { recursive: true });
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  expect((await listRepoTree(id)).entries?.map((e) => e.name)).not.toContain(".git");
  // A nested .git (a submodule/embedded checkout) is filtered per-entry, so it can't be reached
  // by opening the root and clicking down.
  expect((await listRepoTree(id, "sub")).entries?.map((e) => e.name)).not.toContain(".git");
});

test("refuses to list inside the VCS metadata directory", async () => {
  const dir = await gitRepo();
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  for (const p of [".git", ".git/refs", "sub/.git", ".GIT"]) {
    const res = await listRepoTree(id, p);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("refusing to list");
  }
});

test("refuses a path that escapes the repository", async () => {
  const dir = await gitRepo();
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await listRepoTree(id, "../..");

  expect(res.ok).toBe(false);
  expect(res.message).toContain("escapes the repository");
});

test("a symlinked directory is reported as a file and never descended", async () => {
  const dir = await gitRepo();
  mkdirSync(join(dir, "real"));
  writeFileSync(join(dir, "real", "a.txt"), "x");
  try {
    // A link pointing at its own ancestor is the shape that would make a recursive walk infinite.
    symlinkSync(dir, join(dir, "loop"), "dir");
  } catch {
    return; // unprivileged Windows can't create symlinks — nothing to assert
  }
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await listRepoTree(id);
  const loop = (res.entries ?? []).find((e) => e.name === "loop");

  expect(loop?.type).toBe("file");
});

test("reports NOT_FOUND for a missing directory and ERROR for a file", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "a.txt"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  expect((await listRepoTree(id, "nope")).code).toBe("NOT_FOUND");
  const onFile = await listRepoTree(id, "a.txt");
  expect(onFile.ok).toBe(false);
  expect(onFile.message).toBe("not a directory");
});

test("an unknown repo id is NOT_FOUND, not a crash", async () => {
  expect((await listRepoTree("does-not-exist")).code).toBe("NOT_FOUND");
});

test("caps a huge directory and reports the true total", async () => {
  const dir = await gitRepo();
  const big = join(dir, "many");
  mkdirSync(big);
  const count = MAX_TREE_ENTRIES + 5;
  for (let i = 0; i < count; i++) writeFileSync(join(big, `f${i}.txt`), "");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await listRepoTree(id, "many");

  expect(res.ok).toBe(true);
  expect(res.truncated).toBe(true);
  expect(res.total).toBe(count);
  expect(res.entries).toHaveLength(MAX_TREE_ENTRIES);
}, 60_000);

test("GET /api/repos/:id/tree serves the root and a subdirectory", async () => {
  const dir = await gitRepo();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.ts"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);
  const app = createApp(localCfg());

  const root = await app.request(`/api/repos/${id}/tree`);
  expect(root.status).toBe(200);
  const rootBody = (await root.json()) as { path: string; entries: Array<{ name: string }> };
  expect(rootBody.path).toBe("");
  expect(rootBody.entries.map((e) => e.name)).toContain("src");

  const sub = await app.request(`/api/repos/${id}/tree?path=src`);
  expect(sub.status).toBe(200);
  const subBody = (await sub.json()) as { entries: RepoTreeEntry[] };
  expect(subBody.entries).toEqual([{ name: "index.ts", path: "src/index.ts", type: "file" }]);
});

// ── search ───────────────────────────────────────────────────────────────────

test("finds a path anywhere in the tree, not just in loaded folders", async () => {
  const dir = await gitRepo();
  mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
  writeFileSync(join(dir, "a", "b", "c", "needle.ts"), "x");
  writeFileSync(join(dir, "other.ts"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await searchRepoTree(id, "needle", { includeIgnored: true });

  expect(res.ok).toBe(true);
  expect(res.entries?.map((e) => e.path)).toEqual(["a/b/c/needle.ts"]);
});

test("matches the whole path, case-insensitively, and returns folders too", async () => {
  const dir = await gitRepo();
  mkdirSync(join(dir, "src", "Api"), { recursive: true });
  writeFileSync(join(dir, "src", "Api", "routes.ts"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const byPath = await searchRepoTree(id, "src/api");
  expect(byPath.entries?.map((e) => e.path)).toContain("src/Api");
  expect(byPath.entries?.find((e) => e.path === "src/Api")?.type).toBe("dir");

  const byName = await searchRepoTree(id, "ROUTES");
  expect(byName.entries?.map((e) => e.path)).toContain("src/Api/routes.ts");
});

// The default deliberately DIFFERS from the listing's: a folder in the tree costs nothing until
// you open it, but a search has no such protection — one query would otherwise flatten every
// vendored copy of a common filename into the results.
test("skips gitignored paths by default, and finds them when asked", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, ".gitignore"), "dist/\n");
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "bundle.js"), "x");
  writeFileSync(join(dir, "bundle.ts"), "x"); // NOT ignored
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const def = await searchRepoTree(id, "bundle");
  expect(def.entries?.map((e) => e.path)).toEqual(["bundle.ts"]);
  expect(def.ignoredIncluded).toBe(false);

  const all = await searchRepoTree(id, "bundle", { includeIgnored: true });
  expect(all.entries?.map((e) => e.path).sort()).toEqual(["bundle.ts", "dist/bundle.js"]);
  expect(all.ignoredIncluded).toBe(true);
});

test("the default honours real gitignore semantics, negations included", async () => {
  const dir = await gitRepo();
  // `logs/*`, NOT `logs/` — git cannot re-include a file whose parent DIRECTORY is excluded, so
  // the negation only bites when the contents are excluded rather than the folder. That rule is
  // precisely the kind a hand-rolled matcher gets wrong, which is why git is asked instead.
  writeFileSync(join(dir, ".gitignore"), "logs/*\n!logs/keep.log\n");
  mkdirSync(join(dir, "logs"));
  writeFileSync(join(dir, "logs", "drop.log"), "x");
  writeFileSync(join(dir, "logs", "keep.log"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const paths = (await searchRepoTree(id, ".log")).entries?.map((e) => e.path) ?? [];

  expect(paths).toContain("logs/keep.log");
  expect(paths).not.toContain("logs/drop.log");
});

test("the default still returns matching FOLDERS, derived from the file set", async () => {
  const dir = await gitRepo();
  mkdirSync(join(dir, "src", "components"), { recursive: true });
  writeFileSync(join(dir, "src", "components", "Button.vue"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await searchRepoTree(id, "components");

  // `git ls-files` reports files only; without deriving ancestors, searching a folder name would
  // find everything inside it and never the folder itself.
  const folder = res.entries?.find((e) => e.path === "src/components");
  expect(folder?.type).toBe("dir");
});

test("the default never leaks the VCS metadata directory either", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "a.txt"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  for (const q of ["config", "HEAD", "git"]) {
    const res = await searchRepoTree(id, q);
    expect(res.entries?.some((e) => e.path.toLowerCase().split("/").includes(".git"))).toBe(false);
  }
});

test("never returns anything inside the VCS metadata directory", async () => {
  const dir = await gitRepo();
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  // "config" and "HEAD" both exist under .git in every real repo.
  for (const q of ["config", "HEAD", "git"]) {
    const res = await searchRepoTree(id, q);
    expect(res.entries?.some((e) => e.path.toLowerCase().split("/").includes(".git"))).toBe(false);
  }
});

test("returns nothing below the minimum query length, without walking", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "a.txt"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  expect((await searchRepoTree(id, "a")).entries).toEqual([]);
  expect((await searchRepoTree(id, "   ")).entries).toEqual([]);
});

test("caps the result set and says the answer is a head", async () => {
  const dir = await gitRepo();
  const many = join(dir, "many");
  mkdirSync(many);
  for (let i = 0; i < MAX_TREE_SEARCH_RESULTS + 10; i++) {
    writeFileSync(join(many, `needle${i}.txt`), "");
  }
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await searchRepoTree(id, "needle");

  expect(res.entries).toHaveLength(MAX_TREE_SEARCH_RESULTS);
  expect(res.truncated).toBe(true);
}, 60_000);

test("finds shallow matches before deep ones, so a capped answer is still the useful one", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "target.ts"), "x");
  mkdirSync(join(dir, "deep", "deeper", "deepest"), { recursive: true });
  writeFileSync(join(dir, "deep", "deeper", "deepest", "target.ts"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const paths = (await searchRepoTree(id, "target")).entries?.map((e) => e.path) ?? [];

  expect(paths[0]).toBe("target.ts"); // breadth-first: the root hit comes first
});

test("an unknown repo id is NOT_FOUND for search too", async () => {
  expect((await searchRepoTree("nope", "anything")).code).toBe("NOT_FOUND");
});

test("GET /api/repos/:id/tree-search serves matches", async () => {
  const dir = await gitRepo();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "widget.ts"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);
  const app = createApp(localCfg());

  const res = await app.request(`/api/repos/${id}/tree-search?q=widget`);

  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: RepoTreeEntry[] };
  expect(body.entries.map((e) => e.path)).toEqual(["src/widget.ts"]);
});

test("GET /api/repos/:id/tree rejects traversal with a 4xx, not a listing", async () => {
  const dir = await gitRepo();
  const id = mustUpsertRepo(dir, "repo", "auto", false);
  const app = createApp(localCfg());

  const res = await app.request(`/api/repos/${id}/tree?path=${encodeURIComponent("../..")}`);

  expect(res.ok).toBe(false);
  expect(res.status).toBeGreaterThanOrEqual(400);
});
