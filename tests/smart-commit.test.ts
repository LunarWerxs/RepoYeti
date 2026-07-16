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
  systemPromptFor,
  fewShotTurns,
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
import { DEFAULT_DIFF_DETAIL } from "../src/config.ts";
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

test("foldLargeFileDiffs bounds a big file and leaves small ones untouched", () => {
  const small = "diff --git a/small.ts b/small.ts\n@@ -1 +1 @@\n-a\n+b\n";
  // A generated data blob: no declarations for git to find, so this is the TRUNCATION path —
  // condensing it would mean inventing structure that isn't there. Bounded either way.
  const huge = `diff --git a/data/blob.json b/data/blob.json\n@@ -1 +1 @@\n${"+x".repeat(5000)}\n`;
  const { diff, folded } = foldLargeFileDiffs(small + huge, 2000);

  expect(folded).toBe(1);
  expect(diff).toContain("small.ts"); // the small file survives verbatim
  expect(diff).toContain("-a\n+b"); //   ...body intact
  expect(diff).toContain("data/blob.json"); // the big file is still PRESENT (name/header kept)
  expect(diff).toContain("diff lines folded"); // ...bounded, and it says so
  expect(diff).not.toContain("# condensed:"); // no map invented from a structureless blob
  expect(diff.length).toBeLessThan(small.length + 2_200); // and it costs its slice, not the world
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

// The map answers "which files belong together" — the job this fold was built for. It cannot
// answer "what changed", and the SAME call also writes each commit's body. Measured live: four
// fully-condensed files, and the model returned "Modified `AI_ADAPTERS` record to accommodate
// changes" — the best answer its input allowed. The cap already paid for more than the map spends
// (~670 chars of a 2,000 balanced cap), so the leftover buys real lines.
test("a condensed file still carries verbatim lines, within the same per-file cap", () => {
  const mk = (sym: string, n: number) =>
    `@@ -1,${n} +1,${n} @@ ${sym}\n${Array.from({ length: n }, (_, i) => `+  const answer${i} = ${i};`).join("\n")}\n`;
  const chunk = `diff --git a/src/a.ts b/src/a.ts\n${mk("export function alpha() {", 60)}${mk("export function omega() {", 60)}`;
  const cap = 2_000;
  const { diff, folded, condensed } = foldLargeFileDiffs(chunk, cap);

  expect(folded).toBe(1);
  expect(condensed).toBe(1); // a real map, not a blind head-cut
  expect(diff).toContain("# condensed:"); //        ...the map survives, so grouping still works
  expect(diff).toContain("export function omega()"); // ...naming every symbol, not just the head
  expect(diff).toContain("verbatim"); //            ...and it says the excerpt is real lines
  expect(diff).toContain("+  const answer0 = 0;"); // ...which are ACTUALLY THERE — the whole point
  // The dial's promise is the per-file cap. Spending its leftover must not break it: an over-cap
  // "summary" gets thrown away for a head-cut, which would lose the map it just paid for.
  expect(diff.length).toBeLessThanOrEqual(cap);
});

// A map that nearly fills the cap by itself leaves no room worth spending: a couple of orphaned
// diff lines are noise the reader has to explain away. The map alone stays a valid answer, and it
// must still respect the cap.
test("a file whose map nearly fills the cap returns the map alone, no stub excerpt", () => {
  const rows = Array.from({ length: 16 }, (_, i) =>
    `@@ -${i},4 +${i},4 @@ export function symbolNumber${i}(arg: SomeLongTypeName): ReturnType {\n` +
    Array.from({ length: 4 }, (_, j) => `+  const v${j} = ${j};`).join("\n") + "\n",
  ).join("");
  const chunk = `diff --git a/src/many.ts b/src/many.ts\n${rows}`;
  const cap = 1_800; // map lands ~1622: real, under cap, and with no room left worth spending
  const { diff, condensed } = foldLargeFileDiffs(chunk, cap);

  expect(condensed).toBe(1);
  expect(diff).toContain("# condensed:");
  expect(diff).toContain("symbolNumber15"); // every symbol still named — that is the map's job
  expect(diff).not.toContain("verbatim"); // no room left, so no half-excerpt
  expect(diff.length).toBeLessThanOrEqual(cap);
});

// Caught by a LIVE run, not by reasoning: fed a map of PowerShell `if` blocks (git's default
// heuristic finds no .ps1 functions), llama-3.3-70b confidently wrote "simplify conditionals for
// better readability" about what was actually a daemon-identity rewrite. A map is only worth
// sending if its labels are real; otherwise real-but-partial lines beat invented specifics.
test("a file whose hunk headers are control-flow noise is NOT condensed", () => {
  const mk = (ctx: string, n: number) =>
    `@@ -1,${n} +1,${n} @@ ${ctx}\n${Array.from({ length: n }, (_, i) => `+  stuff ${i}`).join("\n")}\n`;
  const psish =
    "diff --git a/misc/Restart-Daemon.ps1 b/misc/Restart-Daemon.ps1\n" +
    mk("if (-not (Test-Path $pkgPath)) {", 60) +
    mk("do {", 60);
  const { diff } = foldLargeFileDiffs(psish, 900);
  expect(diff).not.toContain("# condensed:"); // no map built from junk labels
  expect(diff).toContain("+  stuff 0"); // real lines instead — partial, but true
  expect(diff).toContain("diff lines folded"); // and it says it's partial
});

test("a file with REAL declarations still condenses", () => {
  const mk = (ctx: string, n: number) =>
    `@@ -1,${n} +1,${n} @@ ${ctx}\n${Array.from({ length: n }, (_, i) => `+  stuff ${i}`).join("\n")}\n`;
  const tsish =
    "diff --git a/src/a.ts b/src/a.ts\n" +
    mk("export function alpha(x: string) {", 60) +
    mk("const TIMEOUT_MS = 20_000;", 60);
  const { diff } = foldLargeFileDiffs(tsish, 900);
  expect(diff).toContain("# condensed:");
  expect(diff).toContain("export function alpha");
});

// git's default funcname heuristic is COLUMN-0 only, so an indented method never becomes the hunk
// label — edit two methods of one class and both hunks come back labelled with the class. Merging
// them to a bare "+2/-2" would claim one edit where there were two, and looksLikeDeclaration can't
// catch it (a class IS a real declaration, just too coarse). Verified against real git output.
test("hunks sharing one coarse label report how many edits they cover, and where", () => {
  const hunk = (line: number, n: number) =>
    `@@ -${line},${n} +${line},${n} @@ export class Widget {\n${Array.from({ length: n }, (_, i) => `+    this.v${i} = ${line};`).join("\n")}\n`;
  // two INDEPENDENT edits, both inside the same class → identical labels
  const chunk = `diff --git a/src/widget.ts b/src/widget.ts\n${hunk(3, 40)}${hunk(80, 40)}`;
  const { diff, condensed } = foldLargeFileDiffs(chunk, 900);

  expect(condensed).toBe(1);
  expect(diff).toContain("export class Widget {");
  expect(diff).toContain("2 edits"); // <- the fusion is DECLARED, not hidden
  expect(diff).toContain("@L3,L80"); // <- and both locations survive
  expect(diff).toContain("+80/-0"); // counts still cover the whole region
});

test("a single edit reports its line without pretending there were several", () => {
  const chunk =
    "diff --git a/src/a.ts b/src/a.ts\n" +
    `@@ -5,60 +5,60 @@ export function alpha() {\n${Array.from({ length: 60 }, (_, i) => `+  const v${i} = ${i};`).join("\n")}\n`;
  const { diff } = foldLargeFileDiffs(chunk, 500);
  expect(diff).toContain("@L5");
  expect(diff).not.toContain("edits @"); // singular edit → no "N edits" claim
});

// `folded` = shrunk at all; `condensed` = actually mapped. They diverge on a file that can't be
// mapped, and conflating them would let something downstream claim "summarised" for a blind cut.
test("foldLargeFileDiffs separates 'shrunk' from 'actually condensed'", () => {
  const blob = `diff --git a/data/blob.json b/data/blob.json\n@@ -1 +1 @@\n${"+x".repeat(5000)}\n`;
  const r = foldLargeFileDiffs(blob, 900);
  expect(r.folded).toBe(1); // it WAS shrunk...
  expect(r.condensed).toBe(0); // ...but truncated, not mapped — no structure to map
  expect(r.diff).toContain("diff lines folded");
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
  expect(foldLargeFileDiffs(d, 2000)).toEqual({ diff: d, folded: 0, condensed: 0 });
  expect(foldLargeFileDiffs("", 2000).folded).toBe(0);
});

// The web can't import from src/config.ts (separate builds), so web/src/store/ai.ts hand-mirrors
// the default. A mirror nobody checks is a mirror that drifts — and drift here means the UI shows
// one dial value while the daemon uses another, which stays invisible until a bill looks wrong.
// Assert the two literals agree.
test("DEFAULT_DIFF_DETAIL is valid and the web store mirrors it", async () => {
  expect(DIFF_DETAIL_CAPS[DEFAULT_DIFF_DETAIL]).toBeDefined();

  const webStore = await Bun.file(new URL("../web/src/store/ai.ts", import.meta.url)).text();
  const mirrored = /diffDetail:\s*"(lean|balanced|thorough)"/.exec(webStore)?.[1];
  expect(mirrored).toBe(DEFAULT_DIFF_DETAIL);
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
  expect(planMaxTokens(1, "conventional")).toBe(512); // floor: never so small the JSON gets cut off
  expect(planMaxTokens(11, "conventional")).toBe(1466); // a normal commit: still well under the ceiling
  expect(planMaxTokens(107, "conventional")).toBe(4096); // cap: a huge plan still gets the ceiling
  expect(planMaxTokens(10_000, "conventional")).toBe(4096); // never above the ceiling
});

// The reservation has to follow the STYLE, because the style decides whether there are bodies to
// pay for at all. Sizing every style like `concise` is what starved the bodies: a 14-file tree the
// model split 7 ways (rule 2 tells it to prefer small commits) left ~45-65 tokens per body once
// the JSON skeleton and `files` arrays were paid for — less than a body worth reading needs.
test("planMaxTokens reserves per style, since only some styles emit a body", () => {
  const files = 14; // the real tree behind the terse-body report: 7 groups, 1-4 files each
  expect(planMaxTokens(files, "concise")).toBeLessThan(planMaxTokens(files, "conventional"));
  expect(planMaxTokens(files, "conventional")).toBeLessThan(planMaxTokens(files, "detailed"));
  // G <= N always, so the worst split rule 2 can produce is one commit per file. Each body must
  // still fit in that case, or the prompt and the ceiling are fighting each other.
  for (const style of ["conventional", "detailed"] as const) {
    const perGroup = planMaxTokens(files, style) / files;
    expect(perGroup).toBeGreaterThan(100); // ~90-110 of JSON overhead, then room for real prose
  }
  // `concise` writes no body, so it should NOT pay for one.
  expect(planMaxTokens(files, "concise")).toBe(1096);
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
  expect(conventional).toContain("MECHANISM");
  expect(detailed).toContain("`body`");
  // detailed is not just a longer conventional: it asks one extra question.
  expect(detailed).toContain("REVIEWER NOTE");
  expect(conventional).not.toContain("REVIEWER NOTE");
  // every style still forbids the type/scope prefix leaking into `subject` (the editor adds it)
  for (const p of [conventional, concise, detailed]) expect(p).toContain("BARE imperative summary");
});

// The two prompt builders write the SAME artifact, and the owner can regenerate any plan card
// through the single-message call — so if they drift, the same button answers in two voices. They
// used to be mirrored by hand ("Mirrors systemPromptFor()" in a comment), which is precisely the
// arrangement that drifts silently. Now they share the doctrine, and this is what says so.
test("both prompt paths share one body doctrine, for every style that has a body", () => {
  for (const style of ["conventional", "detailed"] as const) {
    const message = systemPromptFor(style);
    const plan = planSystemPrompt(style);
    for (const clause of [
      "MECHANISM", // name the function/file/flag, never a bare verb
      "REASON", // only where the diff shows it
      "EFFECT", // hedged inference, never an observed fact
      "Never claim testing, deployment, live verification or a measured number", // anti-fabrication
    ]) {
      expect(message).toContain(clause);
      expect(plan).toContain(clause);
    }
  }
});

// No SYSTEM prompt renders a worked commit message any more — measured live, a rendered example
// leaks: the model attributed the example's `decodeRow` null-guard content to a function in the
// real diff. Each path keeps exactly one demonstration, in the channel where imitation is safe:
// the message path as a completed few-shot EXCHANGE (the example is visibly the answer to a
// different diff), the plan path as its populated JSON shape example.
test("worked examples live in imitation-safe channels, never loose in a system prompt", () => {
  for (const style of ["conventional", "detailed"] as const) {
    // System prompts state the ban in prose and render nothing that looks like a commit message.
    const sys = systemPromptFor(style);
    expect(sys).toContain("Never write a body that merely re-tenses the subject");
    expect(sys).not.toContain("decodeRow"); // the example's content stays OUT of the instructions
    // The message path's example is a real user/assistant exchange, envelope-matched to the live
    // call (porcelain header and all), with the message in the ASSISTANT turn.
    const turns = fewShotTurns(style);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[0]!.content).toContain("# git status --porcelain");
    expect(turns[0]!.content).toContain("decodeRow"); // the diff the example answers…
    expect(turns[1]!.content).toContain("`decodeRow()`"); // …and the answer, attributed to it
    // The plan path emits JSON, so its example is the JSON shape — carrying a POPULATED body
    // array. A `"body":"optional longer text"` here would demonstrate the terse failure itself.
    const plan = planSystemPrompt(style);
    expect(plan).toContain('"body":["');
    expect(plan).not.toContain('"body":"optional longer text"');
  }
  // The conventional example demonstrates the Conventional subject; detailed stays bare.
  expect(fewShotTurns("conventional")[1]!.content.startsWith("fix(codec):")).toBe(true);
  expect(fewShotTurns("detailed")[1]!.content.startsWith("fix(codec):")).toBe(false);
  // concise writes no body, so there is nothing to demonstrate — and no tokens to spend on it.
  expect(fewShotTurns("concise")).toEqual([]);
});

// The whole fix: prose has no countable unit, an array does. A model that answers "write a body"
// with one vague line is COMPLIANT; a model that must populate an array per non-trivial file has
// nothing to compress into. If this instruction ever softens back to a string, the terse bodies
// come back — so the array contract is pinned, not left to the prompt's goodwill.
test("the plan asks for body as a countable array, not a prose string", () => {
  for (const style of ["conventional", "detailed"] as const) {
    const plan = planSystemPrompt(style);
    expect(plan).toContain("JSON ARRAY of strings");
    expect(plan).toContain("Do NOT write `body` as one prose string");
    expect(plan).toContain("earns roughly K bullets"); // the count comes from the file list, not a guess
  }
  // ...and concise still opts out of the whole thing.
  expect(planSystemPrompt("concise")).not.toContain("JSON ARRAY of strings");
});

// The model will not always honour the array. A body that is right about the content and wrong
// about the container must survive: dropping a good body over its shape is the worst trade here.
test("parseCommitPlan renders a body array to bullets, and still accepts a plain string", () => {
  const known = ["src/a.ts"];
  const arr = parseCommitPlan(
    JSON.stringify({
      groups: [{ type: "fix", subject: "s", body: ["first thing", "- second thing"], files: ["src/a.ts"] }],
      leftovers: [],
    }),
    known,
  );
  // "- " is added exactly once, even when the model already prefixed it.
  expect(arr?.groups[0]?.body).toBe("- first thing\n- second thing");

  const str = parseCommitPlan(
    JSON.stringify({ groups: [{ type: "fix", subject: "s", body: "just prose", files: ["src/a.ts"] }], leftovers: [] }),
    known,
  );
  expect(str?.groups[0]?.body).toBe("just prose");

  // An empty array is not a body — it must not become a stray "- " or an empty string field.
  const empty = parseCommitPlan(
    JSON.stringify({ groups: [{ type: "fix", subject: "s", body: [], files: ["src/a.ts"] }], leftovers: [] }),
    known,
  );
  expect(empty?.groups[0]?.body).toBeUndefined();
});

// `concise` is a subject line and nothing else. It must not pay prompt tokens for body rules it
// will never follow, in EITHER path — the doctrine is opt-in, not ambient.
test("the body doctrine stays out of the concise style", () => {
  for (const p of [systemPromptFor("concise"), planSystemPrompt("concise")]) {
    expect(p).not.toContain("MECHANISM");
    expect(p).not.toContain("FORBIDDEN");
  }
});

// A deletion with NO context is unreadable, and the planner used to send exactly that (`-U0`).
// Measured against the live model: for a file whose only change was deleting an unused local, the
// hunk it received was
//
//     @@ -2 +1,0 @@ export function parseTag(raw: string): { … } {
//     -  const unused = false;
//
// — one deletion, and `parseTag` the most prominent name in it, from the hunk header. The model
// reported that the FUNCTION had been removed in 4 of 6 runs. It is a fair reading of the only
// evidence it was given, and one line of context on each side drops it to 0 of 6, because the
// signature then arrives as a CONTEXT line that is plainly still there. Zero context is a fine
// diff for classifying files and a trap for describing them, and this call does both.
test("the planner's diff carries context lines, so a deletion can't read as a removed function", async () => {
  const dir = mkScratchDir("gm-ctx-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  writeFileSync(
    join(dir, "parse.ts"),
    "export function parseTag(raw: string): string {\n  const unused = false;\n  return raw.split(':')[0] ?? '';\n}\n",
  );
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
  // The ONLY change: drop the unused local. parseTag itself survives.
  writeFileSync(
    join(dir, "parse.ts"),
    "export function parseTag(raw: string): string {\n  return raw.split(':')[0] ?? '';\n}\n",
  );

  const { diff } = await collectCommitPlanInput(dir, undefined, "balanced");
  expect(diff).toContain("-  const unused = false;"); // the deletion is there...
  // ...and so is the surviving signature, as CONTEXT (leading space), not as a deletion. That one
  // line is the whole difference between "removed a variable" and "removed the function".
  expect(diff).toContain(" export function parseTag");
  expect(diff).not.toContain("-export function parseTag");
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
