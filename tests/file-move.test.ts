import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { moveFile } from "../src/service/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

// Drag-to-move: moveFile (src/service/files.ts) + POST /api/repos/:id/move. Same path-confinement
// + .git block as writeFileContent, never overwrites the destination, and stages a git rename for
// tracked files (plain fs rename for untracked ones).
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7191, maxDepth: 6, maxRepos: 200 });

const plainRepo = (): string => mkScratchDir("gm-move-");
async function gitRepo(): Promise<string> {
  const dir = mkScratchDir("gm-move-git-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("moveFile moves an untracked file into a subfolder, creating it", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "note.txt"), "hi");
  const id = mustUpsertRepo(dir, "move-untracked", "auto", false);

  const r = await moveFile(id, "note.txt", "docs");
  expect(r.ok).toBe(true);
  expect(r.to).toBe("docs/note.txt");
  expect(existsSync(join(dir, "note.txt"))).toBe(false);
  expect(existsSync(join(dir, "docs", "note.txt"))).toBe(true);
});

test("moveFile git-mv's a tracked file (staged rename)", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "a.txt"), "content\n");
  await $`git -C ${dir} add a.txt`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m add`.quiet();
  const id = mustUpsertRepo(dir, "move-tracked", "auto", false);

  const r = await moveFile(id, "a.txt", "sub");
  expect(r.ok).toBe(true);
  expect(existsSync(join(dir, "sub", "a.txt"))).toBe(true);
  expect(existsSync(join(dir, "a.txt"))).toBe(false);
  // `git mv` stages the move → it shows up in the index (not just the working tree).
  const staged = (await $`git -C ${dir} diff --cached --name-only`.text()).trim();
  expect(staged).toContain("sub/a.txt");
});

test("moveFile refuses a source path that escapes the repo", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "move-escape-src", "auto", false);
  const r = await moveFile(id, "../escape.txt", "docs");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("ERROR");
});

test("moveFile refuses a destination that escapes the repo", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "n.txt"), "x");
  const id = mustUpsertRepo(dir, "move-escape-dst", "auto", false);
  const r = await moveFile(id, "n.txt", "../..");
  expect(r.ok).toBe(false);
  expect(existsSync(join(dir, "n.txt"))).toBe(true); // source untouched
});

test("moveFile refuses moving into a .git directory (no hook RCE)", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "hook.sh"), "#!/bin/sh\n");
  const id = mustUpsertRepo(dir, "move-dotgit", "auto", false);
  const r = await moveFile(id, "hook.sh", ".git/hooks");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NOT_WRITABLE");
  expect(existsSync(join(dir, ".git", "hooks", "hook.sh"))).toBe(false);
});

test("moveFile never overwrites an existing destination file", async () => {
  const dir = plainRepo();
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "note.txt"), "src");
  writeFileSync(join(dir, "docs", "note.txt"), "existing");
  const id = mustUpsertRepo(dir, "move-clobber", "auto", false);

  const r = await moveFile(id, "note.txt", "docs");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("EXISTS");
  expect(readFileSync(join(dir, "docs", "note.txt"), "utf8")).toBe("existing"); // intact
  expect(existsSync(join(dir, "note.txt"))).toBe(true); // source untouched
});

test("moveFile errors when the file is already in that folder", async () => {
  const dir = plainRepo();
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "a.txt"), "x");
  const id = mustUpsertRepo(dir, "move-samedir", "auto", false);
  const r = await moveFile(id, "docs/a.txt", "docs");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("ERROR");
});

test("moveFile NOT_FOUND for a missing source file", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "move-missing", "auto", false);
  const r = await moveFile(id, "ghost.txt", "docs");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NOT_FOUND");
});

test("moveFile 404s an unknown repo", async () => {
  const r = await moveFile("does-not-exist", "a.txt", "docs");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NOT_FOUND");
});

test("POST /api/repos/:id/move moves and 400s a missing body", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "f.txt"), "hi");
  const id = mustUpsertRepo(dir, "move-route", "auto", false);
  const app = createApp(localCfg());

  const ok = await app.request(`/api/repos/${id}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "f.txt", toDir: "sub" }),
  });
  expect(ok.status).toBe(200);
  expect(existsSync(join(dir, "sub", "f.txt"))).toBe(true);

  const bad = await app.request(`/api/repos/${id}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "f.txt" }),
  });
  expect(bad.status).toBe(400);
});

test("POST /api/repos/:id/move is refused over remote when remoteEditing is off", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "f.txt"), "hi");
  const id = mustUpsertRepo(dir, "move-remote-off", "auto", false);
  const app = createApp({ ...localCfg(), remoteEditing: false });

  const remote = await app.request(`/api/repos/${id}/move`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ from: "f.txt", toDir: "sub" }),
  });
  expect(remote.status).toBe(403);
  expect(existsSync(join(dir, "sub", "f.txt"))).toBe(false); // not moved
});
