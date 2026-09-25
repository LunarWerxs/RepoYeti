import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { readFixupBases } from "../src/read/fixup-base.ts";
import { withFixups, type CommitPlan } from "../src/ai/commit-plan.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

// The fixup finder's whole promise is "this file fixes exactly that unpushed commit, and nothing
// else". These tests pin both halves: a file whose touched lines all come from one unpushed
// commit resolves to it, and a file touching pushed lines or two commits never does.

const git = (dir: string) => (...a: string[]) =>
  $`git -C ${dir} -c user.name=T -c user.email=t@t.io ${a}`.quiet();

interface Fixture {
  work: string;
  /** Full hash of "add notes" (unpushed): n.txt and u.txt. */
  u1: string;
  /** Full hash of "tune notes and add tail" (unpushed): n.txt's 4th line and t.txt. */
  u2: string;
}

/**
 * A pushed base (a.txt), then two unpushed commits, then a dirty tree:
 *   a.txt  line 3 rewritten           -> pushed lines, unresolved
 *   n.txt  line 2 (U1) and 4 (U2)     -> two commits, unresolved
 *   t.txt  line 2 rewritten (U2)      -> U2, by deleted lines
 *   u.txt  a line appended at EOF     -> U1, by the bordering line (git clips the range end)
 *   new.txt staged, not in HEAD       -> new file, unresolved
 */
async function fixture(): Promise<Fixture> {
  const root = mkScratchDir("gm-fixup-");
  const bare = join(root, "remote.git");
  await $`git -c init.defaultBranch=main init -q --bare ${bare}`.quiet();
  const work = join(root, "work");
  await $`git -c init.defaultBranch=main clone -q ${bare} ${work}`.quiet();
  const W = git(work);
  const put = (name: string, text: string): void => writeFileSync(join(work, name), text);

  put("a.txt", "l1\nl2\nl3\nl4\nl5\n");
  await W("add", "-A");
  await W("commit", "-q", "-m", "base");
  await W("push", "-q", "-u", "origin", "main");

  put("n.txt", "n1\nn2\nn3\n");
  put("u.txt", "u1\nu2\n");
  await W("add", "-A");
  await W("commit", "-q", "-m", "add notes");
  const u1 = (await W("rev-parse", "HEAD").text()).trim();

  put("n.txt", "n1\nn2\nn3\nn4\n");
  put("t.txt", "t1\nt2\nt3\n");
  await W("add", "-A");
  await W("commit", "-q", "-m", "tune notes and add tail");
  const u2 = (await W("rev-parse", "HEAD").text()).trim();

  put("a.txt", "l1\nl2\nL3\nl4\nl5\n");
  put("n.txt", "n1\nN2\nn3\nN4\n");
  put("t.txt", "t1\nT2\nt3\n");
  put("u.txt", "u1\nu2\nu3\n");
  put("new.txt", "fresh\n");
  await W("add", "new.txt");
  return { work, u1, u2 };
}

test("each changed file resolves only to the one unpushed commit that wrote its lines", async () => {
  const { work, u1, u2 } = await fixture();
  const r = await readFixupBases(work);

  expect(r.ok).toBe(true);
  expect(r.unpushed).toBe(2);
  // Newest target first; each carries the autosquash message.
  expect(r.targets.map((t) => [t.hash, t.message])).toEqual([
    [u2, "fixup! tune notes and add tail"],
    [u1, "fixup! add notes"],
  ]);
  expect(r.targets[0]!.files).toEqual([{ path: "t.txt", evidence: "deleted" }]);
  expect(r.targets[1]!.files).toEqual([{ path: "u.txt", evidence: "context" }]);

  const reasons = Object.fromEntries(r.unresolved.map((u) => [u.path, u.reason]));
  expect(reasons).toEqual({ "a.txt": "pushed", "n.txt": "multiple", "new.txt": "new-file" });
  // Two targets plus unresolved files: there is no single atomic answer for the whole change.
  expect(r.single).toBeNull();
});

test("scoping to paths that fix one commit yields the single atomic answer", async () => {
  const { work, u2 } = await fixture();
  const r = await readFixupBases(work, ["t.txt"]);
  expect(r.single?.hash).toBe(u2);
  expect(r.single?.files.map((f) => f.path)).toEqual(["t.txt"]);
  expect(r.unresolved).toEqual([]);
});

// Regression: `diff HEAD` never lists untracked files, so `single` once named a target while an
// untracked file sat in the tree, and git_commit's `add -A` would have folded it into the fixup.
test("an untracked file is unresolved and withholds the single answer", async () => {
  const { work } = await fixture();
  const W = git(work);
  // Leave only t.txt (fixes U2) changed, plus new.txt untracked rather than staged.
  await W("checkout", "--", "a.txt", "n.txt", "u.txt");
  await W("rm", "-q", "--cached", "new.txt");
  const r = await readFixupBases(work);
  expect(r.targets.map((t) => t.files.map((f) => f.path))).toEqual([["t.txt"]]);
  expect(r.unresolved).toEqual([{ path: "new.txt", reason: "new-file" }]);
  expect(r.single).toBeNull();
});

test("withFixups keeps only offers for files the plan covers", () => {
  const plan: CommitPlan = {
    groups: [{ type: "fix", subject: "x", files: ["a.ts"] }],
    leftovers: ["b.ts"],
    degraded: false,
    truncated: false,
  };
  const base = { hash: "h", shortHash: "h", subject: "s", message: "fixup! s" };
  const out = withFixups(plan, [
    { ...base, files: ["a.ts", "gone.ts"] },
    { ...base, hash: "h2", files: ["gone.ts"] },
  ]);
  expect(out.fixups).toEqual([{ ...base, files: ["a.ts"] }]);
  // No surviving offer means no field at all, so a plan without fixups is byte-identical to before.
  expect(withFixups(plan, [{ ...base, files: ["gone.ts"] }])).toEqual(plan);
});
