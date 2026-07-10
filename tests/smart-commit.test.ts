import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  parseCommitPlan,
  heuristicPlan,
  generateCommitPlan,
  planSystemPrompt,
  planUserPrompt,
  type CommitPlanInput,
  type FetchFn,
} from "../src/ai.ts";
import { gitCommitGroups, collectCommitPlanInput, collectPathsDiff, isNoisyPath } from "../src/git-actions.ts";
import { smartCommitRepo, planCommitInput, collectRepoPathsDiff } from "../src/service/index.ts";
import { createApp } from "../src/http/app.ts";
import { upsertRepo } from "../src/db.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import type { Identity } from "../src/db.ts";

// Force the built-in Groq key OFF so "no provider configured" is deterministic regardless of
// any REPOYETI_BUILTIN_GROQ_KEY in a dev .env (mirrors tests/ai.test.ts).
process.env.REPOYETI_BUILTIN_GROQ_KEY = "";

const ID: Identity = { id: "x", displayName: "T", gitUsername: "Tester", gitEmail: "t@test.io", sshKeyPath: null };
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const J = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A git repo with one seed commit, local author configured (so null-identity commits work). */
async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-smart-"));
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
  const dir = mkdtempSync(join(tmpdir(), "gm-smart-unborn-"));
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
  const dir = mkdtempSync(join(tmpdir(), "gm-fold-"));
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
  return { dir, id: upsertRepo(dir, "smart", "auto", false) };
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
