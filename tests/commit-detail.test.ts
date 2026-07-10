import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { registerRepo, getLog, getCommit, readCommitFile, stopWatching } from "../src/service/index.ts";

// Covers the commit-detail read path (the History "tap a commit → see its changed files + diff"
// feature): readCommit → VcsBackend → service.getCommit → GET /api/repos/:id/commit/:hash.
test("getCommit returns a commit's changed files + bounded diff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ry-commit-"));
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
    expect(detail.diff).toContain("b.txt");
    expect(detail.diff).toContain("+second");
    expect(detail.truncated).toBe(false);

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
