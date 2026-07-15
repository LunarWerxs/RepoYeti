import { test, expect } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  parseCommitPlan,
  heuristicPlan,
  generateCommitPlan,
  planSystemPrompt,
  planUserPrompt,
  AiError,
  clearRateGate,
  rateGateRemainingMs,
  type CommitPlanInput,
  type FetchFn,
} from "../src/ai.ts";
import {
  gitCommitGroups,
  collectCommitPlanInput,
  collectPathsDiff,
  isNoisyPath,
  foldLargeFileDiffs,
  DIFF_DETAIL_CAPS,
} from "../src/git-actions.ts";
import { planMaxTokens } from "../src/ai/adapters.ts";
import { smartCommitRepo, planCommitInput, collectRepoPathsDiff } from "../src/service/index.ts";
import { createApp } from "../src/http/app.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import type { Identity } from "../src/db.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

const ID: Identity = { id: "x", displayName: "T", gitUsername: "Tester", gitEmail: "t@test.io", sshKeyPath: null };
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const J = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A git repo with one seed commit, local author configured (so null-identity commits work). */
async function repo(): Promise<string> {
  const dir = mkScratchDir("gm-smart-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  writeFileSync(join(dir, "a.txt"), "a0\n");
  writeFileSync(join(dir, "b.txt"), "b0\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
  return dir;
}

async function logSubjects(dir: string): Promise<string[]> {
  const out = await $`git -C ${dir} log --pretty=format:%s`.text();
  return out.split("\n").filter(Boolean);
}
async function dirtyCount(dir: string): Promise<number> {
  const out = (await $`git -C ${dir} status --porcelain`.text()).trim();
  return out ? out.split("\n").length : 0;
}

// ── parseCommitPlan (pure) ──────────────────────────────────────────────────────

test("parseCommitPlan parses a clean plan and assigns every path once", () => {
  const text = JSON.stringify({
    groups: [
      { type: "feat", scope: "x", subject: "add x", files: ["src/x.ts", "tests/x.test.ts"] },
      { type: "docs", subject: "update readme", files: ["README.md"] },
    ],
    leftovers: [],
  });
  const plan = parseCommitPlan(text, ["src/x.ts", "tests/x.test.ts", "README.md"]);
  expect(plan).not.toBeNull();
  expect(plan!.groups.length).toBe(2);
  expect(plan!.groups[0]!.files).toEqual(["src/x.ts", "tests/x.test.ts"]);
  expect(plan!.leftovers).toEqual([]);
  expect(plan!.degraded).toBe(false);
});

test("parseCommitPlan tolerates code fences and surrounding prose", () => {
  const text = `Here is your plan:\n\`\`\`json\n${JSON.stringify({ groups: [{ type: "fix", subject: "y", files: ["y.ts"] }] })}\n\`\`\``;
  const plan = parseCommitPlan(text, ["y.ts"]);
  expect(plan!.groups[0]!.subject).toBe("y");
});

test("parseCommitPlan sweeps a forgotten path into leftovers and drops hallucinated paths", () => {
  const text = JSON.stringify({ groups: [{ type: "feat", subject: "a", files: ["a.ts", "ghost.ts"] }] });
  const plan = parseCommitPlan(text, ["a.ts", "b.ts"]);
  expect(plan!.groups[0]!.files).toEqual(["a.ts"]); // ghost dropped
  expect(plan!.leftovers).toEqual(["b.ts"]); // forgotten path surfaced
});

test("parseCommitPlan dedupes a path claimed by two groups (first wins)", () => {
  const text = JSON.stringify({
    groups: [
      { type: "feat", subject: "one", files: ["a.ts"] },
      { type: "fix", subject: "two", files: ["a.ts", "b.ts"] },
    ],
  });
  const plan = parseCommitPlan(text, ["a.ts", "b.ts"]);
  expect(plan!.groups[0]!.files).toEqual(["a.ts"]);
  expect(plan!.groups[1]!.files).toEqual(["b.ts"]);
});

test("parseCommitPlan coerces an unknown type to chore and drops empty groups", () => {
  const text = JSON.stringify({
    groups: [
      { type: "wizardry", subject: "weird", files: ["a.ts"] },
      { type: "feat", subject: "empty", files: ["ghost.ts"] }, // becomes empty → dropped
    ],
  });
  const plan = parseCommitPlan(text, ["a.ts"]);
  expect(plan!.groups.length).toBe(1);
  expect(plan!.groups[0]!.type).toBe("chore");
});

test("parseCommitPlan returns null on non-JSON garbage", () => {
  expect(parseCommitPlan("the model refused to answer", ["a.ts"])).toBeNull();
});

// ── heuristicPlan (pure) ────────────────────────────────────────────────────────

test("heuristicPlan buckets by top-level directory and marks itself degraded", () => {
  const input: CommitPlanInput = {
    files: [
      { path: "src/a.ts", status: "M", additions: 1, removals: 0, binary: false },
      { path: "src/b.ts", status: "M", additions: 1, removals: 0, binary: false },
      { path: "tests/a.test.ts", status: "A", additions: 9, removals: 0, binary: false },
      { path: "README.md", status: "M", additions: 1, removals: 1, binary: false },
    ],
    diff: "",
    truncated: false,
  };
  const plan = heuristicPlan(input);
  expect(plan.degraded).toBe(true);
  const scopes = plan.groups.map((g) => g.scope ?? "root").sort();
  expect(scopes).toEqual(["root", "src", "tests"]);
  const tests = plan.groups.find((g) => g.scope === "tests")!;
  expect(tests.type).toBe("test");
});

// ── generateCommitPlan (mock fetch) ──────────────────────────────────────────────

test("generateCommitPlan validates a provider response into a normalized plan", async () => {
  const planJson = JSON.stringify({
    groups: [{ type: "feat", scope: "auth", subject: "add login", files: ["src/auth.ts"] }],
    leftovers: [],
  });
  // groq is OpenAI-compatible → choices[0].message.content carries the JSON.
  const fakeFetch: FetchFn = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: planJson } }] }), { status: 200 });
  const input: CommitPlanInput = {
    files: [{ path: "src/auth.ts", status: "M", additions: 3, removals: 1, binary: false }],
    diff: "diff --git a/src/auth.ts b/src/auth.ts\n",
    truncated: false,
  };
  const plan = await generateCommitPlan("groq", "gsk_test", "llama", input, "conventional", fakeFetch);
  expect(plan.groups.length).toBe(1);
  expect(plan.groups[0]!.scope).toBe("auth");
  expect(plan.degraded).toBe(false);
});

test("generateCommitPlan retries once when the first response is unparseable", async () => {
  let calls = 0;
  const fakeFetch: FetchFn = async () => {
    calls++;
    const content =
      calls === 1
        ? "Sorry, I can't help with that." // unparseable → triggers the retry
        : JSON.stringify({ groups: [{ type: "feat", subject: "x", files: ["a.ts"] }], leftovers: [] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  const input: CommitPlanInput = {
    files: [{ path: "a.ts", status: "M", additions: 1, removals: 0, binary: false }],
    diff: "",
    truncated: false,
  };
  const plan = await generateCommitPlan("groq", "gsk_x", "llama", input, "conventional", fakeFetch);
  expect(calls).toBe(2); // first ask failed to parse → one retry
  expect(plan.groups.length).toBe(1);
});

test("plan prompts mention the file-level rule and list every path", () => {
  const input: CommitPlanInput = {
    files: [{ path: "src/x.ts", status: "M", additions: 1, removals: 0, binary: false }],
    diff: "",
    truncated: false,
  };
  expect(planSystemPrompt("conventional")).toContain("FILE level");
  expect(planUserPrompt(input)).toContain("src/x.ts");
});

// ── payload budget: size folding + right-sized reservation ──────────────────────
//
// Both exist because of a measurement: one generated `data/car-embeddings.json` was 97% of a real
// 40k planner diff (106 other files shared 3%), and every plan reserved 4096 output tokens to
// produce ~900 — on a 100k/day budget that is ~7 commits/day.

test("foldLargeFileDiffs condenses a big file and leaves small ones untouched", () => {
  const small = "diff --git a/small.ts b/small.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const huge = `diff --git a/data/blob.json b/data/blob.json\n@@ -1 +1 @@\n${"+x".repeat(5000)}\n`;
  const { diff, folded } = foldLargeFileDiffs(small + huge, 2000);

  expect(folded).toBe(1);
  expect(diff).toContain("small.ts"); // the small file survives verbatim
  expect(diff).toContain("-a\n+b"); //   ...body intact
  expect(diff).toContain("data/blob.json"); // the big file is still PRESENT (name/header kept)
  expect(diff).toContain("# condensed:"); // ...but its body became a map
  // Structureless data degrades to an honest line-range row rather than a wall of "+x".
  expect(diff).not.toContain("+x+x+x");
  // The map must be DRASTICALLY smaller than even the truncated head it replaced.
  expect(diff.length).toBeLessThan(small.length + 400);
});

// The whole point over truncation: a big file reports EVERY symbol it touched, not an
// arbitrary first-2%. git puts the enclosing declaration in each hunk header for free.
test("condensed output names every changed symbol with its own counts", () => {
  const mk = (sym: string, n: number) =>
    `@@ -1,${n} +1,${n} @@ ${sym}\n${Array.from({ length: n }, (_, i) => `+  line ${i}`).join("\n")}\n`;
  const chunk =
    "diff --git a/src/a.ts b/src/a.ts\n" +
    mk("export function alpha() {", 60) +
    mk("export function omega() {", 60); // ...far past any head-cut, so truncation would hide it
  const { diff, folded } = foldLargeFileDiffs(chunk, 900);

  expect(folded).toBe(1);
  expect(diff).toContain("export function alpha()");
  expect(diff).toContain("export function omega()"); // <- truncation would have dropped this entirely
  expect(diff).toContain("+60/-0"); // per-symbol tallies, not a single lump
  expect(diff.length).toBeLessThan(chunk.length);
});

test("foldLargeFileDiffs never cuts a diff line in half when it falls back to a head cut", () => {
  // No hunk headers at all → nothing to condense → the head-cut path still applies.
  const chunk = `diff --git a/a.ts b/a.ts\n${Array.from({ length: 400 }, (_, i) => `+line ${i}`).join("\n")}\n`;
  const { diff } = foldLargeFileDiffs(chunk, 500);
  const body = diff.split("\n").filter((l) => l.startsWith("+line "));
  // every retained body line is whole (no truncated tail like "+line 12" -> "+lin")
  for (const l of body) expect(l).toMatch(/^\+line \d+$/);
});

test("foldLargeFileDiffs is a no-op below the cap", () => {
  const d = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
  expect(foldLargeFileDiffs(d, 2000)).toEqual({ diff: d, folded: 0 });
  expect(foldLargeFileDiffs("", 2000).folded).toBe(0);
});

test("the diff-detail dial is monotonic on BOTH bounds: lean < balanced < thorough", () => {
  // A dial nobody can trust is worse than a constant — each step must actually send more.
  // Both bounds matter: with only perFile moving, the flat total cap binds first and every
  // setting produces an identical payload on a many-file repo (measured — that was the bug).
  for (const k of ["perFile", "msgTotal", "planTotal"] as const) {
    expect(DIFF_DETAIL_CAPS.lean[k]).toBeLessThan(DIFF_DETAIL_CAPS.balanced[k]);
    expect(DIFF_DETAIL_CAPS.balanced[k]).toBeLessThan(DIFF_DETAIL_CAPS.thorough[k]);
  }
  // `balanced` must stay exactly the historical caps, so the default changes nothing.
  expect(DIFF_DETAIL_CAPS.balanced.msgTotal).toBe(24_000);
  expect(DIFF_DETAIL_CAPS.balanced.planTotal).toBe(40_000);

  const huge = `diff --git a/big.ts b/big.ts\n${Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n")}\n`;
  const sizes = (["lean", "balanced", "thorough"] as const).map(
    (d) => foldLargeFileDiffs(huge, DIFF_DETAIL_CAPS[d].perFile).diff.length,
  );
  expect(sizes[0]!).toBeLessThan(sizes[1]!);
  expect(sizes[1]!).toBeLessThan(sizes[2]!);
  // even the richest setting still folds a runaway file — the dial tunes the cap, it can't remove it
  expect(sizes[2]!).toBeLessThan(huge.length);
});

test("planMaxTokens sizes the reservation to the change-set, with a floor and a cap", () => {
  expect(planMaxTokens(1)).toBe(512); // floor: never so small the JSON gets cut off
  expect(planMaxTokens(11)).toBe(916); // a normal commit: ~4x smaller than the old flat 4096
  expect(planMaxTokens(107)).toBe(4096); // cap: a huge plan still gets the ceiling
  expect(planMaxTokens(10_000)).toBe(4096); // never above the ceiling
});

// A 429 means the request was REJECTED — the model never ran, so "the AI couldn't structure this"
// is the wrong story. It must surface as its own code, carrying the provider's text (which says
// which limit tripped and when it resets) so the owner can act on it.
test("a rate-limited provider surfaces AI_RATE_LIMITED with the provider's own message", async () => {
  const body = JSON.stringify({
    error: { message: "Rate limit reached ... on tokens per day (TPD): Limit 100000. Try again in 4h55m.", code: "rate_limit_exceeded" },
  });
  const fakeFetch: FetchFn = async () => new Response(body, { status: 429 });
  const input: CommitPlanInput = {
    files: [{ path: "a.ts", status: "M", additions: 1, removals: 0, binary: false }],
    diff: "",
    truncated: false,
  };
  const err = await generateCommitPlan("groq", "gsk_x", "llama", input, "conventional", fakeFetch).catch((e) => e);
  expect(err).toBeInstanceOf(AiError);
  expect((err as AiError).code).toBe("AI_RATE_LIMITED");
  expect((err as AiError).status).toBe(429);
  expect((err as AiError).message).toContain("tokens per day");
});

// Anti-hammer: a provider that just said 429 will say it again. Re-asking burns request quota and
// makes the owner wait to hear the same thing, so the second ask is answered from memory.
test("a 429 gates further generation calls instead of re-hammering the provider", async () => {
  clearRateGate("groq");
  let calls = 0;
  const fakeFetch: FetchFn = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "Rate limit reached. Try again in 3h." } }), {
      status: 429,
      headers: { "retry-after": "13010" }, // Groq really does hand back ~3.6h
    });
  };
  const input: CommitPlanInput = {
    files: [{ path: "a.ts", status: "M", additions: 1, removals: 0, binary: false }],
    diff: "",
    truncated: false,
  };
  const run = () => generateCommitPlan("groq", "gsk_x", "llama", input, "conventional", fakeFetch).catch((e) => e);

  const first = await run();
  expect((first as AiError).code).toBe("AI_RATE_LIMITED");
  expect(calls).toBe(1);

  const second = await run(); // must NOT reach the network
  expect((second as AiError).code).toBe("AI_RATE_LIMITED");
  expect((second as AiError).message).toContain("Rate limit reached"); // provider's words, replayed
  expect(calls).toBe(1); // <- the whole point: still 1

  // The local pause is capped (a minute), NOT the provider's 3.6h — an owner who upgrades their
  // tier or swaps keys must recover quickly rather than stay blocked by our own cache.
  expect(rateGateRemainingMs("groq")).toBeGreaterThan(0);
  expect(rateGateRemainingMs("groq")).toBeLessThanOrEqual(60_000);

  clearRateGate("groq");
  expect(rateGateRemainingMs("groq")).toBe(0); // connecting a new key clears it
});

test("heuristicPlan carries the degraded reason so the UI can state the real cause", () => {
  const input: CommitPlanInput = {
    files: [{ path: "src/a.ts", status: "M", additions: 1, removals: 0, binary: false }],
    diff: "",
    truncated: false,
  };
  const plain = heuristicPlan(input);
  expect(plain.degraded).toBe(true);
  expect(plain.degradedCode).toBeUndefined(); // no reason given → nothing invented

  const withReason = heuristicPlan(input, { code: "AI_RATE_LIMITED", message: "Limit 100000 reached" });
  expect(withReason.degradedCode).toBe("AI_RATE_LIMITED");
  expect(withReason.degradedMessage).toContain("Limit 100000");
});

// The style setting used to be accepted here and then ignored, so switching styles changed the
// plan's messages only by model luck. Each style must produce materially different instructions.
test("planSystemPrompt actually honors the commit-message style", () => {
  const conventional = planSystemPrompt("conventional");
  const concise = planSystemPrompt("concise");
  const detailed = planSystemPrompt("detailed");

  expect(conventional).not.toBe(concise);
  expect(conventional).not.toBe(detailed);
  expect(concise).not.toBe(detailed);

  // concise = subject only; the other two ask for a real body.
  expect(concise).toContain("Omit `body`");
  expect(conventional).toContain("`body` explaining WHAT changed and WHY");
  expect(detailed).toContain("`body`");
  // every style still forbids the type/scope prefix leaking into `subject` (the editor adds it)
  for (const p of [conventional, concise, detailed]) expect(p).toContain("BARE imperative summary");
});

// ── gitCommitGroups (real repo) ──────────────────────────────────────────────────

test("gitCommitGroups creates one commit per group, staging only that group's files", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "a.txt"), "a1\n"); // modify a
  writeFileSync(join(dir, "c.txt"), "c0\n"); // new untracked c

  const res = await gitCommitGroups(dir, ID, [
    { message: "feat: change a", paths: ["a.txt"] },
    { message: "chore: add c", paths: ["c.txt"] },
  ]);
  expect(res.ok).toBe(true);
  expect(res.committed.filter((g) => g.ok).length).toBe(2);

  const subjects = await logSubjects(dir);
  expect(subjects.slice(0, 2)).toEqual(["chore: add c", "feat: change a"]); // newest first
  expect(await dirtyCount(dir)).toBe(0); // everything committed → clean
});

test("gitCommitGroups leaves un-grouped changes safely in the working tree (partial coverage)", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "a.txt"), "a1\n");
  writeFileSync(join(dir, "b.txt"), "b1\n"); // changed but NOT in any group

  const res = await gitCommitGroups(dir, ID, [{ message: "feat: only a", paths: ["a.txt"] }]);
  expect(res.ok).toBe(true);
  expect((await logSubjects(dir))[0]).toBe("feat: only a");
  expect(await dirtyCount(dir)).toBe(1); // b.txt still pending — safe, recoverable
});

test("gitCommitGroups stages a deletion", async () => {
  const dir = await repo();
  rmSync(join(dir, "b.txt"));
  const res = await gitCommitGroups(dir, ID, [{ message: "chore: drop b", paths: ["b.txt"] }]);
  expect(res.ok).toBe(true);
  expect(await dirtyCount(dir)).toBe(0);
  // b.txt is gone from HEAD now
  const tracked = (await $`git -C ${dir} ls-files`.text()).trim().split("\n");
  expect(tracked).not.toContain("b.txt");
});

test("gitCommitGroups refuses a clean tree with NOTHING_TO_COMMIT", async () => {
  const dir = await repo();
  const res = await gitCommitGroups(dir, ID, [{ message: "noop", paths: ["a.txt"] }]);
  expect(res.ok).toBe(false);
  expect(res.code).toBe("NOTHING_TO_COMMIT");
});

test("gitCommitGroups works on an unborn HEAD (fresh repo, no initial commit)", async () => {
  // A brand-new repo with changes but NO commit yet: `git reset` would fail here, so the
  // executor must tolerate that and still create the first commits.
  const dir = mkScratchDir("gm-smart-unborn-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  const res = await gitCommitGroups(dir, ID, [
    { message: "feat: a", paths: ["a.txt"] },
    { message: "chore: b", paths: ["b.txt"] },
  ]);
  expect(res.ok).toBe(true);
  expect(res.committed.filter((g) => g.ok).length).toBe(2);
  expect(await dirtyCount(dir)).toBe(0);
});

// ── collectCommitPlanInput (real repo) ───────────────────────────────────────────

test("collectCommitPlanInput lists changed files with stats + a diff", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "a.txt"), "a0\nextra\n"); // +1 line
  writeFileSync(join(dir, "new.txt"), "brand new\n"); // untracked

  const input = await collectCommitPlanInput(dir);
  const paths = input.files.map((f) => f.path).sort();
  expect(paths).toEqual(["a.txt", "new.txt"]);
  expect(input.diff).toContain("a.txt");
});

test("isNoisyPath folds lockfiles / generated / minified, not real source", () => {
  expect(isNoisyPath("package-lock.json")).toBe(true);
  expect(isNoisyPath("web/pnpm-lock.yaml")).toBe(true);
  expect(isNoisyPath("Cargo.lock")).toBe(true);
  expect(isNoisyPath("dist/app.min.js")).toBe(true);
  expect(isNoisyPath("src/app.js.map")).toBe(true);
  expect(isNoisyPath("__snapshots__/x.snap")).toBe(true);
  expect(isNoisyPath("src/app.ts")).toBe(false);
  expect(isNoisyPath("README.md")).toBe(false);
});

test("collectCommitPlanInput folds a lockfile's body out of the diff but keeps it in the file list", async () => {
  const dir = mkScratchDir("gm-fold-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  writeFileSync(join(dir, "app.ts"), "const x = 1;\n");
  writeFileSync(join(dir, "package-lock.json"), '{ "name": "demo", "version": "1.0.0" }\n');
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
  // Change both: a real source file (should be diffed) and the lockfile (body should fold out).
  writeFileSync(join(dir, "app.ts"), "const x = 2; // UNIQUE_APP_MARKER\n");
  writeFileSync(join(dir, "package-lock.json"), '{ "name": "demo", "version": "2.0.0-UNIQUE_LOCK_MARKER" }\n');

  const input = await collectCommitPlanInput(dir);
  const paths = input.files.map((f) => f.path).sort();
  expect(paths).toEqual(["app.ts", "package-lock.json"]); // file list is complete
  expect(input.diff).toContain("UNIQUE_APP_MARKER"); // real source is diffed
  expect(input.diff).not.toContain("UNIQUE_LOCK_MARKER"); // lockfile body folded out
});

// ── smartCommitRepo (service) ────────────────────────────────────────────────────

async function registerRepo(): Promise<{ dir: string; id: string }> {
  const dir = await repo();
  return { dir, id: mustUpsertRepo(dir, "smart", "auto", false) };
}

test("smartCommitRepo validates against the live tree: PLAN_STALE for a vanished path", async () => {
  const { id } = await registerRepo();
  const r = await smartCommitRepo(id, [{ message: "x", paths: ["does-not-exist.txt"] }], false);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("PLAN_STALE");
});

test("smartCommitRepo rejects a path claimed by two commits (PLAN_PATHS_INVALID)", async () => {
  const { dir, id } = await registerRepo();
  writeFileSync(join(dir, "a.txt"), "a1\n");
  const r = await smartCommitRepo(
    id,
    [
      { message: "one", paths: ["a.txt"] },
      { message: "two", paths: ["a.txt"] },
    ],
    false,
  );
  expect(r.ok).toBe(false);
  expect(r.code).toBe("PLAN_PATHS_INVALID");
});

test("smartCommitRepo executes a multi-commit plan end to end", async () => {
  const { dir, id } = await registerRepo();
  writeFileSync(join(dir, "a.txt"), "a1\n");
  writeFileSync(join(dir, "b.txt"), "b1\n");
  const r = await smartCommitRepo(
    id,
    [
      { message: "feat: a", paths: ["a.txt"] },
      { message: "fix: b", paths: ["b.txt"] },
    ],
    false,
  );
  expect(r.ok).toBe(true);
  expect(r.committed!.filter((g) => g.ok).length).toBe(2);
  expect((await logSubjects(dir)).slice(0, 2)).toEqual(["fix: b", "feat: a"]);
});

// ── routes ───────────────────────────────────────────────────────────────────────

test("POST /smart-commit creates the commits (200) and 409s on a stale path", async () => {
  const { dir, id } = await registerRepo();
  writeFileSync(join(dir, "a.txt"), "a1\n");
  const app = createApp(localCfg());

  const ok = await app.request(`/api/repos/${id}/smart-commit`, J({ commits: [{ message: "feat: a", paths: ["a.txt"] }] }));
  expect(ok.status).toBe(200);
  expect((await ok.json()).ok).toBe(true);
  expect((await logSubjects(dir))[0]).toBe("feat: a");

  const stale = await app.request(`/api/repos/${id}/smart-commit`, J({ commits: [{ message: "x", paths: ["a.txt"] }] }));
  expect(stale.status).toBe(409);
  expect((await stale.json()).code).toBe("PLAN_STALE");
});

test("POST /smart-commit rejects an empty body with BAD_REQUEST", async () => {
  const { id } = await registerRepo();
  const app = createApp(localCfg());
  const res = await app.request(`/api/repos/${id}/smart-commit`, J({ commits: [] }));
  expect(res.status).toBe(400);
});

test("POST /commit-plan reports NO_AI_PROVIDER when no provider is configured", async () => {
  const { dir, id } = await registerRepo();
  writeFileSync(join(dir, "a.txt"), "a1\n");
  const app = createApp(localCfg());
  const res = await app.request(`/api/repos/${id}/commit-plan`, J({}));
  expect((await res.json()).code).toBe("NO_AI_PROVIDER");
});

test("POST /commit-plan 409s on a clean tree (NOTHING_TO_COMMIT) via planCommitInput", async () => {
  const { id } = await registerRepo();
  const r = await planCommitInput(id);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NOTHING_TO_COMMIT");
});

// ── per-commit regenerate (scoped diff) ──────────────────────────────────────────

test("collectPathsDiff scopes the diff to the requested paths only", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "a.txt"), "a-changed\n");
  writeFileSync(join(dir, "b.txt"), "b-changed\n");
  const diff = await collectPathsDiff(dir, ["a.txt"]);
  expect(diff).toContain("a.txt");
  expect(diff).not.toContain("b.txt"); // b's change must not leak into a's scoped diff
});

test("collectRepoPathsDiff returns a scoped diff (and refuses an empty selection)", async () => {
  const { dir, id } = await registerRepo();
  writeFileSync(join(dir, "a.txt"), "a-changed\n");
  const ok = await collectRepoPathsDiff(id, ["a.txt"]);
  expect(ok.ok).toBe(true);
  expect(ok.diff).toContain("a.txt");
  const empty = await collectRepoPathsDiff(id, []);
  expect(empty.code).toBe("NOTHING_TO_COMMIT");
});

test("POST /commit-message accepts a paths[] body (schema) — unconfigured AI → NO_AI_PROVIDER", async () => {
  const { dir, id } = await registerRepo();
  writeFileSync(join(dir, "a.txt"), "a-changed\n");
  const app = createApp(localCfg());
  const res = await app.request(`/api/repos/${id}/commit-message`, J({ paths: ["a.txt"] }));
  // The shape is valid (not BAD_REQUEST); it fails only because no provider is configured.
  expect((await res.json()).code).toBe("NO_AI_PROVIDER");
});
