import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { registerRepo, getLog, getCommit, readCommitFile, stopWatching } from "../src/service/index.ts";
import { COMMIT_FILES_CAP } from "../src/read/inspect.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

// Covers the commit-detail read path (the History "tap a commit → see its changed files + per-file
// line counts" feature): readCommit → VcsBackend → service.getCommit → GET /api/repos/:id/commit/:hash.
// The raw patch is NOT part of this payload — it's fetched per file via readCommitFile (asserted below).
test("getCommit returns a commit's changed files with per-file line counts", async () => {
  const dir = mkScratchDir("ry-commit-");
  try {
    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} config user.name T`.quiet();
    await $`git -C ${dir} config user.email t@t.io`.quiet();
    writeFileSync(join(dir, "a.txt"), "first\n");
    await $`git -C ${dir} add a.txt`.quiet();
    await $`git -C ${dir} commit -q -m "feat: add a"`.quiet();
    writeFileSync(join(dir, "a.txt"), "first\nsecond\n");
    writeFileSync(join(dir, "b.txt"), "new file\n");
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -q -m "feat: edit a, add b" -m "Adds b.txt and a second line."`.quiet();

    const reg = await registerRepo(dir);
    expect(reg.ok).toBe(true);
    const id = reg.repo!.id;

    const log = await getLog(id, 10);
    const head = log.commits[0]!; // newest first
    expect(head.subject).toBe("feat: edit a, add b");

    const detail = await getCommit(id, head.hash);
    expect(detail.ok).toBe(true);
    expect(detail.hash).toBe(head.hash);
    expect(detail.subject).toBe("feat: edit a, add b");
    expect(detail.body).toBe("Adds b.txt and a second line.");
    expect(detail.authorName).toBe("T");
    expect(detail.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(["A b.txt", "M a.txt"]);
    // Per-file line counts come from `git show --numstat`, zipped onto the file list by index.
    const byPath = Object.fromEntries(detail.files.map((f) => [f.path, f]));
    expect(byPath["a.txt"]).toMatchObject({ status: "M", adds: 1, dels: 0 }); // "second" added
    expect(byPath["b.txt"]).toMatchObject({ status: "A", adds: 1, dels: 0 }); // "new file" line

    // readCommitFile: the file's two sides AT the commit (first-parent ↔ commit) for the Monaco
    // viewer opened from the history graph.
    const aDiff = await readCommitFile(id, head.hash, "a.txt");
    expect(aDiff.ok).toBe(true);
    expect(aDiff.mode).toBe("models");
    expect(aDiff.original).toBe("first\n"); // the parent's version
    expect(aDiff.modified).toBe("first\nsecond\n"); // this commit's version
    const bDiff = await readCommitFile(id, head.hash, "b.txt");
    expect(bDiff.ok).toBe(true);
    expect(bDiff.original).toBe(""); // added in this commit — no parent blob
    expect(bDiff.modified).toBe("new file\n");
    // Path confinement still applies on the commit-file route.
    const escaped = await readCommitFile(id, head.hash, "../etc/passwd");
    expect(escaped.ok).toBe(false);

    // A well-formed but nonexistent hash → graceful error, not a throw.
    const bad = await getCommit(id, "deadbeef");
    expect(bad.ok).toBe(false);
    // A shape-invalid hash is rejected up front.
    const garbage = await getCommit(id, "../etc/passwd");
    expect(garbage.ok).toBe(false);
    expect(garbage.message).toContain("invalid");
  } finally {
    stopWatching();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the fs.watch handle for a beat after stopWatching — temp-dir
      // cleanup is best-effort (the OS reclaims tmp anyway); a locked dir must not fail the test.
    }
  }
});

// The per-file counts come from a SECOND `git show --numstat` pass zipped onto the --name-status
// file list BY INDEX. Two cases would silently break a naive by-path zip: a RENAME (numstat renders
// its path as `{old => new}`, which never matches the name-status target path) and a BINARY file
// (numstat prints "-\t-" instead of numbers). This locks in that both map to the right file, and
// that index alignment survives a file sitting between them.
test("getCommit maps --numstat counts correctly across a rename + a binary file", async () => {
  const dir = mkScratchDir("ry-commit-numstat-");
  try {
    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} config user.name T`.quiet();
    await $`git -C ${dir} config user.email t@t.io`.quiet();
    // Base commit: a text file to rename, and a plain file to edit.
    writeFileSync(join(dir, "old.txt"), `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
    writeFileSync(join(dir, "keep.txt"), "k1\nk2\n");
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -q -m base`.quiet();

    // HEAD: rename old.txt → renamed.txt with a small edit (high similarity ⇒ git detects R),
    // add a binary blob, and edit keep.txt — three distinct numstat shapes in one commit.
    rmSync(join(dir, "old.txt"));
    writeFileSync(join(dir, "renamed.txt"), `${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
    writeFileSync(join(dir, "data.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 10, 0, 9]));
    writeFileSync(join(dir, "keep.txt"), "k1\nk2\nk3\n");
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -q -m rename-binary-edit`.quiet();

    const reg = await registerRepo(dir);
    const id = reg.repo!.id;
    const log = await getLog(id, 10);
    const detail = await getCommit(id, log.commits[0]!.hash);
    expect(detail.ok).toBe(true);

    const byPath = Object.fromEntries(detail.files.map((f) => [f.path, f]));
    // Rename: status R, source recorded in `from`, and the +2 lines land on the RIGHT file even
    // though numstat labels this row `{old.txt => renamed.txt}`.
    expect(byPath["renamed.txt"]).toMatchObject({ status: "R", from: "old.txt", adds: 2, dels: 0 });
    // Binary: numstat "-\t-" ⇒ counts left at 0, not NaN, not misread from an adjacent row.
    expect(byPath["data.bin"]).toMatchObject({ status: "A", adds: 0, dels: 0 });
    // The plain edit still gets ITS own count — proof the index zip didn't drift past the binary.
    expect(byPath["keep.txt"]).toMatchObject({ status: "M", adds: 1, dels: 0 });
  } finally {
    stopWatching();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup (see above) */
    }
  }
});

// A commit touching more files than COMMIT_FILES_CAP ships a capped list + the real total, so a
// vendored-tree or generated-churn commit can't bloat the payload/DOM. The cap slices AFTER the
// numstat zip, so the files that DO ship keep their correct counts.
test("getCommit caps the file list at COMMIT_FILES_CAP and reports filesTotal", async () => {
  const dir = mkScratchDir("ry-commit-cap-");
  try {
    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} config user.name T`.quiet();
    await $`git -C ${dir} config user.email t@t.io`.quiet();
    const total = COMMIT_FILES_CAP + 15;
    mkdirSync(join(dir, "gen"));
    for (let i = 0; i < total; i++) writeFileSync(join(dir, "gen", `f${String(i).padStart(4, "0")}.txt`), `content ${i}\n`);
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -q -m "generated churn"`.quiet();

    const reg = await registerRepo(dir);
    const id = reg.repo!.id;
    const log = await getLog(id, 5);
    const detail = await getCommit(id, log.commits[0]!.hash);
    expect(detail.ok).toBe(true);
    expect(detail.filesTotal).toBe(total);
    expect(detail.files.length).toBe(COMMIT_FILES_CAP);
    // Shipped rows kept their zipped stats (every generated file is a 1-line add).
    expect(detail.files[0]).toMatchObject({ status: "A", adds: 1, dels: 0 });
    expect(detail.files[COMMIT_FILES_CAP - 1]).toMatchObject({ status: "A", adds: 1, dels: 0 });
  } finally {
    stopWatching();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup (see above) */
    }
  }
});
