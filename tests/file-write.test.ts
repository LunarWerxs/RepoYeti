import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { writeFileContent } from "../src/service/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

// Edit-mode save path: writeFileContent (src/service.ts) + PUT /api/repos/:id/file
// (src/daemon.ts). Guards the confinement + binary/size limits that keep an untrusted edit
// from escaping the repo or writing a corrupt blob.
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

const plainRepo = (): string => mkScratchDir("gm-write-");
async function gitRepo(): Promise<string> {
  const dir = mkScratchDir("gm-write-git-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("writeFileContent overwrites a working-tree file", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "note.txt"), "old");
  const id = mustUpsertRepo(dir, "write-happy", "auto", false);

  const r = await writeFileContent(id, "note.txt", "new content\n");
  expect(r.ok).toBe(true);
  expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("new content\n");
});

test("writeFileContent creates a nested file under the repo", async () => {
  const dir = plainRepo();
  mkdirSync(join(dir, "src"));
  const id = mustUpsertRepo(dir, "write-nested", "auto", false);

  const r = await writeFileContent(id, "src/a.ts", "export const a = 1;\n");
  expect(r.ok).toBe(true);
  expect(existsSync(join(dir, "src", "a.ts"))).toBe(true);
});

test("writeFileContent refuses a path that escapes the repo", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "write-escape", "auto", false);

  const r = await writeFileContent(id, "../escape.txt", "nope");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("ERROR"); // "path escapes the repository"
  expect(existsSync(join(dir, "..", "escape.txt"))).toBe(false);
});

test("writeFileContent refuses binary (NUL-bearing) content", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "write-binary", "auto", false);

  const r = await writeFileContent(id, "x.bin", `a${String.fromCharCode(0)}b`);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("IS_BINARY");
});

test("writeFileContent refuses content over the size cap", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "write-big", "auto", false);

  const r = await writeFileContent(id, "big.txt", "x".repeat(2_000_001));
  expect(r.ok).toBe(false);
  expect(r.code).toBe("TOO_LARGE");
});

test("writeFileContent 404s an unknown repo", async () => {
  const r = await writeFileContent("does-not-exist", "a.txt", "hi");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NOT_FOUND");
});

test("PUT /api/repos/:id/file saves and 400s a missing body", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "readme.md"), "# old\n");
  const id = mustUpsertRepo(dir, "write-route", "auto", false);
  const app = createApp(localCfg());

  const ok = await app.request(`/api/repos/${id}/file?path=readme.md`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "# new\n" }),
  });
  expect(ok.status).toBe(200);
  expect(readFileSync(join(dir, "readme.md"), "utf8")).toBe("# new\n");

  const bad = await app.request(`/api/repos/${id}/file?path=readme.md`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(bad.status).toBe(400);
});

test("PUT /api/repos/:id/file 404s an unknown repo", async () => {
  const res = await createApp(localCfg()).request("/api/repos/nope/file?path=a.txt", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "hi" }),
  });
  expect(res.status).toBe(404);
});

test("writeFileContent refuses to write inside .git (no hook RCE)", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "write-dotgit", "auto", false);
  const r = await writeFileContent(id, ".git/hooks/pre-commit", "#!/bin/sh\necho pwned\n");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NOT_WRITABLE");
});

test("writeFileContent refuses to clobber a file larger than the edit cap", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "big.log"), "x".repeat(2_000_001)); // > MAX_FILE_BYTES on disk
  const id = mustUpsertRepo(dir, "write-ondisk-big", "auto", false);

  const r = await writeFileContent(id, "big.log", "tiny");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("TOO_LARGE");
  expect(readFileSync(join(dir, "big.log"), "utf8").length).toBe(2_000_001); // intact
});

test("writeFileContent returns NOT_FOUND when the parent directory is missing", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "write-noparent", "auto", false);

  const r = await writeFileContent(id, "a/b/c/new.ts", "hi");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NOT_FOUND");
});

test("PUT /api/repos/:id/file is refused over remote when remoteEditing is off", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "f.txt"), "old\n");
  const id = mustUpsertRepo(dir, "write-remote-off", "auto", false);
  const app = createApp({ ...localCfg(), remoteEditing: false });

  // A remote request (forwarded header present) is refused; local edits still work.
  const remote = await app.request(`/api/repos/${id}/file?path=f.txt`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ content: "new\n" }),
  });
  expect(remote.status).toBe(403);
  expect((await remote.json()).code).toBe("EDIT_REMOTE_DISABLED");
  expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("old\n"); // unchanged

  const local = await app.request(`/api/repos/${id}/file?path=f.txt`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "new\n" }),
  });
  expect(local.status).toBe(200);
  expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("new\n");
});
