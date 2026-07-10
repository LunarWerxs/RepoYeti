import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { registerRepo, getLog, stopWatching } from "../src/service/index.ts";

// Covers the "Git Graph" data path: the log's ref-scope (?refs=head|local|all → readLog's
// scopeArgs) plus the parent-hash / ref-decoration fields the DAG renderer needs. A repo with an
// UNMERGED side branch proves head-only ≠ all, and a merge proves parents/isMerge come through.
test("getLog ref-scope: head is current-branch only, all spans branches, merges carry 2 parents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ry-graph-"));
  try {
    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} config user.name T`.quiet();
    await $`git -C ${dir} config user.email t@t.io`.quiet();

    writeFileSync(join(dir, "a.txt"), "a\n");
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -q -m "A"`.quiet();

    // A side branch with an unmerged commit B.
    await $`git -C ${dir} checkout -q -b feature`.quiet();
    writeFileSync(join(dir, "b.txt"), "b\n");
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -q -m "B"`.quiet();

    // Back on main, a commit C that does NOT contain B.
    await $`git -C ${dir} checkout -q main`.quiet();
    writeFileSync(join(dir, "c.txt"), "c\n");
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -q -m "C"`.quiet();

    const reg = await registerRepo(dir);
    expect(reg.ok).toBe(true);
    const id = reg.repo!.id;

    // head-only (default): main's line only — A and C, never the unmerged B.
    const head = await getLog(id, 50, 0, undefined, "head");
    const headSubjects = head.commits.map((c) => c.subject);
    expect(headSubjects).toContain("C");
    expect(headSubjects).toContain("A");
    expect(headSubjects).not.toContain("B");

    // The tip C is decorated with HEAD → main, and its single parent is A (linear).
    const c = head.commits.find((x) => x.subject === "C")!;
    expect(c.refs).toContain("HEAD");
    expect(c.refs).toContain("main");
    expect(c.parents.length).toBe(1);
    expect(c.isMerge).toBe(false);

    // all: spans every branch — B is now present, tagged with the `feature` ref.
    const all = await getLog(id, 50, 0, undefined, "all");
    const allSubjects = all.commits.map((x) => x.subject);
    expect(allSubjects).toContain("B");
    const b = all.commits.find((x) => x.subject === "B")!;
    expect(b.refs).toContain("feature");

    // Merge feature into main → a merge commit with two parents (C and B).
    await $`git -C ${dir} merge --no-ff -q -m "merge feature" feature`.quiet();
    const merged = await getLog(id, 50, 0, undefined, "all");
    const m = merged.commits.find((x) => x.subject === "merge feature")!;
    expect(m).toBeTruthy();
    expect(m.isMerge).toBe(true);
    expect(m.parents.length).toBe(2);
    expect(m.parents).toContain(c.hash); // first parent = the pre-merge main tip
    expect(m.parents).toContain(b.hash); // second parent = the feature tip
  } finally {
    stopWatching();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold the fs.watch handle briefly after stopWatching — cleanup is best-effort.
    }
  }
});
