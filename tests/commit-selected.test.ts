import { test, expect } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { stopWatching } from "../src/service/index.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

// Per-file (selected) staging for a single ordinary commit: stage + commit ONLY the chosen paths,
// leaving everything else pending. Reuses the same commitGroups primitive as Smart Commit, so this
// focuses on the route + service contract (subset commit, NO_MESSAGE, stale selection).

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const J = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** A git repo with one seed commit + a configured local author (so null-identity commits work). */
async function seededRepo(): Promise<string> {
  const dir = mkScratchDir("gm-sel-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  writeFileSync(join(dir, "a.txt"), "a0\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
  return dir;
}
async function logSubjects(dir: string): Promise<string[]> {
  return (await $`git -C ${dir} log --pretty=format:%s`.text()).split("\n").filter(Boolean);
}
async function porcelain(dir: string): Promise<string[]> {
  const out = (await $`git -C ${dir} status --porcelain`.text()).trim();
  return out ? out.split("\n") : [];
}
function rmrf(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows watcher-handle race — best-effort cleanup, the OS temp dir is reclaimed anyway */
  }
}

test("POST /api/repos/:id/commit-selected commits only the chosen files; the rest stay pending", async () => {
  const dir = await seededRepo();
  try {
    // Two pending changes: modify a.txt (tracked) and add c.txt (untracked).
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeFileSync(join(dir, "c.txt"), "c0\n");
    const id = mustUpsertRepo(dir, "sel", "auto", false);

    const res = await createApp(localCfg()).request(
      `/api/repos/${id}/commit-selected`,
      J({ message: "feat: just a", paths: ["a.txt"] }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // a.txt landed in a commit…
    expect(await logSubjects(dir)).toContain("feat: just a");
    // …and c.txt is still pending; a.txt no longer is.
    const status = await porcelain(dir);
    expect(status.some((l) => l.includes("c.txt"))).toBe(true);
    expect(status.some((l) => l.includes("a.txt"))).toBe(false);
  } finally {
    stopWatching();
    rmrf(dir);
  }
});

// ── the index outside the selection is not ours to touch (audit item 2) ──────────────
test("commit-selected preserves an unrelated file's staged-only intermediate content", async () => {
  // The 1.0 audit's reproduction, inverted into the guarantee. `unrelated.txt` is staged with one
  // content and then edited again in the working tree, so the staged version exists NOWHERE but
  // the index. Committing `wanted.txt` used to begin with a repository-wide mixed reset — "not
  // --hard, so harmless" — which replaced that index entry with HEAD's and lost the intermediate
  // for good; only the newer working-tree edit survived.
  const dir = await seededRepo();
  try {
    writeFileSync(join(dir, "unrelated.txt"), "base\n");
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -q -m base2`.quiet();
    writeFileSync(join(dir, "unrelated.txt"), "STAGED INTERMEDIATE\n");
    await $`git -C ${dir} add unrelated.txt`.quiet();
    writeFileSync(join(dir, "unrelated.txt"), "LATEST WORKTREE\n");
    writeFileSync(join(dir, "a.txt"), "wanted change\n");
    const id = mustUpsertRepo(dir, "sel-index", "auto", false);

    const res = await createApp(localCfg()).request(
      `/api/repos/${id}/commit-selected`,
      J({ message: "feat: only a", paths: ["a.txt"] }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // The commit holds exactly the selection…
    expect((await $`git -C ${dir} show --name-only --format= HEAD`.text()).trim()).toBe("a.txt");
    expect((await $`git -C ${dir} show HEAD:a.txt`.text()).trim()).toBe("wanted change");
    // …the unrelated file's INDEX entry is byte-for-byte what the owner staged…
    expect(await $`git -C ${dir} show :unrelated.txt`.text()).toBe("STAGED INTERMEDIATE\n");
    // …its working tree is untouched, and status reads the same as before the commit for it
    // (staged AND modified), while the committed file is clean.
    expect(readFileSync(join(dir, "unrelated.txt"), "utf8")).toBe("LATEST WORKTREE\n");
    const status = await porcelain(dir);
    expect(status).toContain("MM unrelated.txt");
    expect(status.some((l) => l.includes("a.txt"))).toBe(false);
  } finally {
    stopWatching();
    rmrf(dir);
  }
});

test("commit-selected refuses a partial commit while a merge is in progress (OPERATION_IN_PROGRESS, 409)", async () => {
  // git itself refuses `git commit -- <paths>` mid-merge: a commit built from anything but the
  // merged index would be recorded as THE merge commit with a tree that drops the other side. The
  // repository's unmerged entries used to make the commit fail by accident; with the commit built
  // in a scratch index the refusal has to be explicit.
  const dir = await seededRepo();
  try {
    await $`git -C ${dir} checkout -q -b feature`.quiet();
    writeFileSync(join(dir, "a.txt"), "theirs\n");
    await $`git -C ${dir} commit -q -am theirs`.quiet();
    await $`git -C ${dir} checkout -q main`.quiet();
    writeFileSync(join(dir, "a.txt"), "ours\n");
    await $`git -C ${dir} commit -q -am ours`.quiet();
    await $`git -C ${dir} merge feature`.quiet().nothrow(); // conflicts: that IS the fixture
    writeFileSync(join(dir, "other.txt"), "unrelated pending change\n"); // a valid selection
    const id = mustUpsertRepo(dir, "sel-merge", "auto", false);

    const res = await createApp(localCfg()).request(
      `/api/repos/${id}/commit-selected`,
      J({ message: "feat: other", paths: ["other.txt"] }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("OPERATION_IN_PROGRESS");
    // Nothing was committed and the merge is still in progress.
    expect(await logSubjects(dir)).not.toContain("feat: other");
    expect((await $`git -C ${dir} rev-parse -q --verify MERGE_HEAD`.quiet().nothrow()).exitCode).toBe(0);
  } finally {
    stopWatching();
    rmrf(dir);
  }
});

test("commit-selected requires a non-empty message (NO_MESSAGE, 400)", async () => {
  const dir = await seededRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const id = mustUpsertRepo(dir, "sel-nomsg", "auto", false);
    const res = await createApp(localCfg()).request(
      `/api/repos/${id}/commit-selected`,
      J({ message: "   ", paths: ["a.txt"] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_MESSAGE");
  } finally {
    stopWatching();
    rmrf(dir);
  }
});

test("commit-selected rejects a path that is no longer pending (PLAN_STALE, 409)", async () => {
  const dir = await seededRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const id = mustUpsertRepo(dir, "sel-stale", "auto", false);
    const res = await createApp(localCfg()).request(
      `/api/repos/${id}/commit-selected`,
      J({ message: "feat: x", paths: ["ghost.txt"] }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PLAN_STALE");
  } finally {
    stopWatching();
    rmrf(dir);
  }
});

// #7 — selecting a renamed file must stage BOTH sides (the rename's old path is auto-added), so the
// commit lands as a clean rename rather than a stray delete+add or a half-applied change.
test("commit-selected stages both sides of a rename when the new path is selected", async () => {
  const dir = await seededRepo();
  try {
    // `git mv` stages the rename; identical content → git detects it as a rename.
    await $`git -C ${dir} mv a.txt b.txt`.quiet();
    const id = mustUpsertRepo(dir, "sel-rename", "auto", false);
    const res = await createApp(localCfg()).request(
      `/api/repos/${id}/commit-selected`,
      J({ message: "refactor: rename a to b", paths: ["b.txt"] }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // The rename landed cleanly: nothing left pending, b.txt tracked, a.txt gone, recorded as R.
    expect(await logSubjects(dir)).toContain("refactor: rename a to b");
    expect(await porcelain(dir)).toEqual([]);
    const nameStatus = (await $`git -C ${dir} show --name-status --format= HEAD`.text()).trim();
    expect(nameStatus.startsWith("R")).toBe(true); // a rename, not a delete+add pair
  } finally {
    stopWatching();
    rmrf(dir);
  }
});

// #8 — the schema guards an empty selection (paths.min(1) → 400) before it can reach the service's
// NOTHING_TO_COMMIT branch; a duplicated path is silently deduped into one clean commit (no double git add).
test("commit-selected rejects an empty paths array at the schema (400)", async () => {
  const dir = await seededRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const id = mustUpsertRepo(dir, "sel-empty", "auto", false);
    const res = await createApp(localCfg()).request(
      `/api/repos/${id}/commit-selected`,
      J({ message: "x", paths: [] }),
    );
    expect(res.status).toBe(400);
  } finally {
    stopWatching();
    rmrf(dir);
  }
});

test("commit-selected dedupes a duplicated path into one clean commit", async () => {
  const dir = await seededRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const id = mustUpsertRepo(dir, "sel-dup", "auto", false);
    const res = await createApp(localCfg()).request(
      `/api/repos/${id}/commit-selected`,
      J({ message: "feat: dedup", paths: ["a.txt", "a.txt"] }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(await logSubjects(dir)).toContain("feat: dedup");
    expect(await porcelain(dir)).toEqual([]); // a.txt committed once, nothing left pending
  } finally {
    stopWatching();
    rmrf(dir);
  }
});
