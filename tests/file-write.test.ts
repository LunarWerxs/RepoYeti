import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { fileContentHash, readFileContent, readFileDiff, writeFileContent } from "../src/service/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

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

// ── compare-and-write (audit item 1) ─────────────────────────────────────────────
// Two viewers, or a phone and a desktop editor, used to overwrite each other silently: a save
// carried no notion of which version it was editing. Reads now hand out a content hash and a save
// that echoes it is refused when the file no longer matches — checked inside the op-queue slot.

test("a read returns a hash; a save that echoes it succeeds and returns the next one", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "note.txt"), "v1\n");
  const id = mustUpsertRepo(dir, "write-cas-happy", "auto", false);

  const read = await readFileContent(id, "note.txt");
  expect(read.ok).toBe(true);
  expect(read.hash).toBe(fileContentHash("v1\n"));

  const w = await writeFileContent(id, "note.txt", "v2\n", { expectedHash: read.hash });
  expect(w.ok).toBe(true);
  expect(w.hash).toBe(fileContentHash("v2\n"));
  expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("v2\n");
  // The new hash is the token for the next save; the old one no longer is.
  expect((await writeFileContent(id, "note.txt", "v3\n", { expectedHash: w.hash })).ok).toBe(true);
});

test("a save against a hash the file no longer matches is refused and writes nothing", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "note.txt"), "v1\n");
  const id = mustUpsertRepo(dir, "write-cas-stale", "auto", false);
  const read = await readFileContent(id, "note.txt");

  // Someone else — another viewer, a desktop editor — saves first.
  writeFileSync(join(dir, "note.txt"), "someone else's v2\n");

  const w = await writeFileContent(id, "note.txt", "my v2\n", { expectedHash: read.hash });
  expect(w.ok).toBe(false);
  expect(w.code).toBe("FILE_STALE");
  expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("someone else's v2\n");
  // No temp file left behind from the refused write.
  expect(existsSync(join(dir, "note.txt.repoyeti.tmp"))).toBe(false);
});

test("a hash is never handed out for a view an edit could not be made against", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "x.bin"), `a${String.fromCharCode(0)}b`);
  writeFileSync(join(dir, "big.log"), "x".repeat(2_000_001));
  const id = mustUpsertRepo(dir, "write-cas-nohash", "auto", false);
  expect((await readFileContent(id, "x.bin")).hash).toBeUndefined(); // binary
  expect((await readFileContent(id, "big.log")).hash).toBeUndefined(); // truncated
  // And a save that claims a hash against such a file is stale by definition.
  const w = await writeFileContent(id, "x.bin", "text now", { expectedHash: fileContentHash("") });
  expect(w.code).toBe("FILE_STALE");
});

test("the Diff tab's working side carries the same hash, so an edit made there is protected too", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "a.txt"), "a0\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m a0`.quiet();
  writeFileSync(join(dir, "a.txt"), "a1\n");
  const id = mustUpsertRepo(dir, "write-cas-diff", "auto", false);
  const diff = await readFileDiff(id, "a.txt");
  expect(diff.mode).toBe("models");
  expect(diff.hash).toBe(fileContentHash("a1\n"));
  expect((await readFileContent(id, "a.txt")).hash).toBe(diff.hash);
});

test("PUT /api/repos/:id/file: expectedHash round-trips, a stale one is 409 FILE_STALE, a malformed one is 400", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "readme.md"), "# v1\n");
  const id = mustUpsertRepo(dir, "write-cas-route", "auto", false);
  const app = createApp(localCfg());
  const put = (body: unknown) =>
    app.request(`/api/repos/${id}/file?path=readme.md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const got = (await (await app.request(`/api/repos/${id}/file?path=readme.md`)).json()) as { hash: string };
  expect(got.hash).toBe(fileContentHash("# v1\n"));

  const first = await put({ content: "# v2\n", expectedHash: got.hash });
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { hash: string };
  expect(firstBody.hash).toBe(fileContentHash("# v2\n"));

  // A second client still holding the ORIGINAL hash loses, and is told so.
  const stale = await put({ content: "# other v2\n", expectedHash: got.hash });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { code: string }).code).toBe("FILE_STALE");
  expect(readFileSync(join(dir, "readme.md"), "utf8")).toBe("# v2\n");

  const malformed = await put({ content: "# v3\n", expectedHash: "not-a-hash" });
  expect(malformed.status).toBe(400);

  // No hash at all is still an unconditional overwrite (a caller with no prior read).
  expect((await put({ content: "# v3\n" })).status).toBe(200);
  expect(readFileSync(join(dir, "readme.md"), "utf8")).toBe("# v3\n");
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
