// Reflog undo/redo (src/git-actions/undo.ts). Pins three contracts:
//  - the walk: an undo tags itself in the reflog, so a second undo steps further back instead of
//    undoing the first undo, and redo re-applies the most recently undone step;
//  - the safety swap for lazygit's `reset --hard`: an undone commit's changes stay staged and a
//    pre-existing uncommitted edit survives, so no undo can lose work;
//  - the refusals: a commit a remote already has, and an entry outside the grammar (a
//    cherry-pick), are refused rather than reset past.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { gitUndoRedo, pickStep, planUndoRedo, type ReflogEntry } from "../src/git-actions.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

const ID = ["-c", "user.name=Seed", "-c", "user.email=s@s.io"];

/** A git repo with one seed commit on `main`. */
async function repo(): Promise<string> {
  const dir = mkScratchDir("gm-undo-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await $`git -C ${dir} ${ID} add -A`.quiet();
  await $`git -C ${dir} ${ID} commit -q -m init`.quiet();
  return dir;
}

async function commitFile(dir: string, name: string, body: string, msg: string): Promise<string> {
  writeFileSync(join(dir, name), body);
  await $`git -C ${dir} ${ID} add -A`.quiet();
  await $`git -C ${dir} ${ID} commit -q -m ${msg}`.quiet();
  return (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
}

const head = async (dir: string): Promise<string> => (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
const branch = async (dir: string): Promise<string> => (await $`git -C ${dir} branch --show-current`.text()).trim();
const staged = async (dir: string): Promise<string> => (await $`git -C ${dir} diff --cached --name-only`.text()).trim();

test("pickStep: undo tags are counted, so undo walks back and redo takes the last undone step", () => {
  const log: ReflogEntry[] = [
    { hash: "c3", subject: "commit: third" },
    { hash: "c2", subject: "checkout: moving from main to feat" },
    { hash: "c2", subject: "commit: second" },
    { hash: "c1", subject: "commit (initial): first" },
  ];
  expect(pickStep(log, "undo")).toMatchObject({ kind: "commit", from: "c2", to: "c3" });
  expect(pickStep(log, "redo")).toBeNull();

  const afterOneUndo = [{ hash: "c2", subject: "[repoyeti undo]: updating HEAD" }, ...log];
  expect(pickStep(afterOneUndo, "undo")).toMatchObject({ kind: "checkout", from: "main", to: "feat" });
  expect(pickStep(afterOneUndo, "redo")).toMatchObject({ kind: "commit", to: "c3" });

  const afterUndoRedo = [{ hash: "c3", subject: "[repoyeti redo]: updating HEAD" }, ...afterOneUndo];
  expect(pickStep(afterUndoRedo, "undo")).toMatchObject({ kind: "commit", to: "c3" });
  expect(pickStep(afterUndoRedo, "redo")).toBeNull();

  // The first commit has nothing before it, and an unknown entry is a barrier, never skipped.
  expect(pickStep([{ hash: "c1", subject: "commit (initial): first" }], "undo")?.kind).toBe("barrier");
  expect(pickStep([{ hash: "c9", subject: "cherry-pick: x" }, ...log], "undo")?.kind).toBe("barrier");
});

test("undo of a commit keeps its changes staged and an unrelated edit intact; redo restores it", async () => {
  const dir = await repo();
  const before = await head(dir);
  const committed = await commitFile(dir, "a.txt", "a\n", "add a");
  writeFileSync(join(dir, "seed.txt"), "local edit\n");

  const undone = await gitUndoRedo(dir, "undo");
  expect(undone.ok).toBe(true);
  expect(await head(dir)).toBe(before);
  expect(await staged(dir)).toBe("a.txt");
  expect(readFileSync(join(dir, "seed.txt"), "utf8")).toBe("local edit\n");
  // The undo tagged itself, so the reflog now shows it as ours.
  expect((await $`git -C ${dir} log -g -n1 --format=%gs HEAD`.text()).trim()).toStartWith("[repoyeti undo]");

  const redone = await gitUndoRedo(dir, "redo");
  expect(redone.ok).toBe(true);
  expect(await head(dir)).toBe(committed);
  expect(await staged(dir)).toBe("");
  expect((await gitUndoRedo(dir, "redo")).code).toBe("NOTHING_TO_UNDO");
});

test("consecutive undos walk back through a commit and then a branch switch", async () => {
  const dir = await repo();
  await $`git -C ${dir} switch -q -c feat`.quiet();
  const base = await head(dir);
  await commitFile(dir, "f.txt", "f\n", "on feat");

  expect((await gitUndoRedo(dir, "undo")).ok).toBe(true);
  expect(await head(dir)).toBe(base);
  expect(await branch(dir)).toBe("feat");

  const second = await gitUndoRedo(dir, "undo");
  expect(second.ok).toBe(true);
  expect(await branch(dir)).toBe("main");

  expect((await gitUndoRedo(dir, "redo")).ok).toBe(true);
  expect(await branch(dir)).toBe("feat");
});

test("a commit a remote already has is refused, not taken back", async () => {
  const dir = await repo();
  const pushed = await commitFile(dir, "p.txt", "p\n", "pushed");
  await $`git -C ${dir} update-ref refs/remotes/origin/main ${pushed}`.quiet();

  const plan = await planUndoRedo(dir, "undo");
  expect(plan.ok).toBe(false);
  expect(plan.code).toBe("UNDO_REFUSED");
  expect((await gitUndoRedo(dir, "undo")).code).toBe("UNDO_REFUSED");
  expect(await head(dir)).toBe(pushed);
});
