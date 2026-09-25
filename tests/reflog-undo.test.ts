// Reflog undo/redo (src/git-actions/undo.ts). Pins three contracts:
//  - the walk: an undo tags itself in the reflog, so a second undo steps further back instead of
//    undoing the first undo, and redo re-applies the most recently undone step;
//  - the safety swap for lazygit's `reset --hard`: an undone commit's changes stay staged and a
//    pre-existing uncommitted edit survives, so no undo can lose work;
//  - the refusals: a commit a remote already has (plain or merge), an entry outside the grammar
//    (a cherry-pick, a rebasing pull), and a step other than the one the owner confirmed, are
//    refused rather than reset past.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

test("pickStep: a rebasing pull is one barrier, not a chain of per-pick moves", () => {
  // Subjects as git 2.52 writes them for `git pull -q --rebase` over two local commits.
  const rebased: ReflogEntry[] = [
    { hash: "r2", subject: "pull -q --rebase (finish): returning to refs/heads/main" },
    { hash: "r2", subject: "pull -q --rebase (pick): mine2" },
    { hash: "r1", subject: "pull -q --rebase (pick): mine1" },
    { hash: "u1", subject: "pull -q --rebase (start): checkout u1" },
    { hash: "m2", subject: "commit: mine2" },
  ];
  expect(pickStep(rebased, "undo")).toMatchObject({ kind: "barrier", subject: rebased[0]!.subject });

  // A merging or fast-forward pull, and a named merge, stay undoable moves.
  const mine = { hash: "c1", subject: "commit: mine" };
  expect(pickStep([{ hash: "c2", subject: "pull: Fast-forward" }, mine], "undo")).toMatchObject({ kind: "move", from: "c1", to: "c2" });
  expect(pickStep([{ hash: "c2", subject: "pull -q origin main: Merge made by the 'ort' strategy." }, mine], "undo")?.kind).toBe("move");
  expect(pickStep([{ hash: "c2", subject: "merge feat: Fast-forward" }, mine], "undo")?.kind).toBe("move");
});

test("a run bound to the previewed step is refused once a newer step has landed", async () => {
  const dir = await repo();
  await commitFile(dir, "a.txt", "a\n", "add a");
  const previewed = (await planUndoRedo(dir, "undo")).step!;
  // An auto-commit lands between the preview and the tap.
  const newer = await commitFile(dir, "b.txt", "b\n", "auto-commit");

  const stale = await gitUndoRedo(dir, "undo", { to: previewed.to, subject: previewed.subject });
  expect(stale.code).toBe("UNDO_REFUSED");
  expect(await head(dir)).toBe(newer);

  const current = (await planUndoRedo(dir, "undo")).step!;
  expect((await gitUndoRedo(dir, "undo", { to: current.to, subject: current.subject })).ok).toBe(true);
  expect(await staged(dir)).toBe("b.txt");
});

/** `main` with a merge commit of `feat` on top; `before` is main just before the merge. */
async function mergedRepo(): Promise<{ dir: string; before: string; merged: string }> {
  const dir = await repo();
  await $`git -C ${dir} switch -q -c feat`.quiet();
  await commitFile(dir, "f.txt", "f\n", "on feat");
  await $`git -C ${dir} switch -q main`.quiet();
  const before = await commitFile(dir, "m.txt", "m\n", "on main");
  await $`git -C ${dir} ${ID} merge -q --no-edit feat`.quiet();
  return { dir, before, merged: await head(dir) };
}

test("a merge is undone with reset --keep, which refuses to overwrite an edited file", async () => {
  const { dir, before, merged } = await mergedRepo();
  expect((await planUndoRedo(dir, "undo")).step).toMatchObject({ kind: "move", from: before, to: merged });

  // The undo would remove f.txt, which now carries an uncommitted edit: nothing may move.
  writeFileSync(join(dir, "f.txt"), "local edit\n");
  expect((await gitUndoRedo(dir, "undo")).code).toBe("WOULD_OVERWRITE");
  expect(await head(dir)).toBe(merged);
  expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("local edit\n");

  await $`git -C ${dir} checkout -- f.txt`.quiet();
  expect((await gitUndoRedo(dir, "undo")).ok).toBe(true);
  expect(await head(dir)).toBe(before);
  expect(existsSync(join(dir, "f.txt"))).toBe(false);
});

test("a merge commit a remote already has is refused, like a pushed commit", async () => {
  const { dir, merged } = await mergedRepo();
  await $`git -C ${dir} update-ref refs/remotes/origin/main ${merged}`.quiet();
  expect((await planUndoRedo(dir, "undo")).code).toBe("UNDO_REFUSED");
  expect(await head(dir)).toBe(merged);
});

test("an entry outside the grammar refuses the undo against a real repo", async () => {
  const dir = await repo();
  await $`git -C ${dir} switch -q -c side`.quiet();
  const picked = await commitFile(dir, "s.txt", "s\n", "on side");
  await $`git -C ${dir} switch -q main`.quiet();
  await $`git -C ${dir} ${ID} cherry-pick ${picked}`.quiet();
  const top = await head(dir);

  const plan = await planUndoRedo(dir, "undo");
  expect(plan.code).toBe("UNDO_REFUSED");
  expect(plan.step?.kind).toBe("barrier");
  expect((await gitUndoRedo(dir, "undo")).code).toBe("UNDO_REFUSED");
  expect(await head(dir)).toBe(top);
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
