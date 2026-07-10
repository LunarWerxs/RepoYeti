/**
 * ⭐ Identity Firewall — rule matching (src/identity.ts globMatch/matchIdentityRule/
 * checkIdentityPolicy) + the preflight block it enforces on every mutating action
 * (src/service/core.ts's runAction + src/service/actions.ts's smartCommitRepo/
 * commitSelectedRepo), and that MCP mutating tool calls inherit the same block because they
 * funnel through those exact same service functions.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  globMatch,
  matchIdentityRule,
  checkIdentityPolicy,
  enforceIdentityPolicy,
  setIdentityRulesConfig,
  currentIdentityRules,
} from "../src/identity.ts";
import { upsertRepo, createIdentity, getRepo, setRepoIdentity, type RepoView } from "../src/db.ts";
import { commitRepo, pushRepo } from "../src/service/index.ts";
import { smartCommitRepo, commitSelectedRepo } from "../src/service/actions.ts";
import { setApprovalGateEnabled } from "../src/approvals.ts";
import { contextFor } from "../src/mcp/core.ts";
import { serviceBackend } from "../src/mcp/adapter-service.ts";
import type { RepoYetiConfig, IdentityRule } from "../src/config.ts";

/** A real git repo with one seed commit + local author, registered with the daemon. */
async function gitRepo(name: string): Promise<{ dir: string; id: string; view: RepoView }> {
  const dir = mkdtempSync(join(tmpdir(), `gm-idfw-${name}-`));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  writeFileSync(join(dir, "a.txt"), "a0\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
  const id = upsertRepo(dir, name, "auto", false);
  return { dir, id, view: getRepo(id)! };
}

const cfgWithRules = (rules: IdentityRule[]): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  identityRules: rules,
});

// The Agent Safety Rail gate would otherwise intercept MCP mutating calls before they even
// reach the identity-firewall check — disable it here so these tests exercise the firewall
// specifically (mirrors how approvals.test.ts disables it for its own gate-off case).
beforeEach(() => setApprovalGateEnabled(false));
afterEach(() => {
  setApprovalGateEnabled(true);
  setIdentityRulesConfig({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 }); // reset to no rules
});

// ── glob / rule matching ────────────────────────────────────────────────────────────
test("globMatch supports *, **, and ? against a normalized path", () => {
  expect(globMatch("D:/Work/*", "D:/Work/foo")).toBe(true);
  expect(globMatch("D:/Work/*", "D:\\Work\\foo")).toBe(true); // backslashes normalize
  expect(globMatch("D:/Work/*", "D:/Work/foo/bar")).toBe(false); // single * doesn't cross /
  expect(globMatch("D:/Work/**", "D:/Work/foo/bar")).toBe(true); // ** does
  expect(globMatch("**/client-projects/*", "D:/anywhere/client-projects/acme")).toBe(true);
  expect(globMatch("D:/Work/repo?", "D:/Work/repo1")).toBe(true);
  expect(globMatch("D:/Work/repo?", "D:/Work/repo12")).toBe(false);
  expect(globMatch("", "D:/Work/foo")).toBe(false); // empty pattern never matches
});

test("globMatch is case-insensitive (Windows paths)", () => {
  expect(globMatch("d:/work/*", "D:/Work/Foo")).toBe(true);
});

// Pins the shared matcher (src/glob-match.ts — also imported by the web's display-only
// identity-firewall mirror) to its documented edge-case behavior, so neither side can drift.
test("globMatch edge cases: literal metacharacters, no char classes/negation, slash trimming", () => {
  // Regex metacharacters in a pattern match themselves literally.
  expect(globMatch("D:/Work/a+b (1)", "D:/Work/a+b (1)")).toBe(true);
  expect(globMatch("D:/Work/a+b (1)", "D:/Work/aab (1)")).toBe(false);
  expect(globMatch("D:/Work/repo.git", "D:/Work/repoXgit")).toBe(false); // '.' is literal
  // No character classes or negation — '[', ']', '!' are literal characters.
  expect(globMatch("D:/Work/[ab]", "D:/Work/[ab]")).toBe(true);
  expect(globMatch("D:/Work/[ab]", "D:/Work/a")).toBe(false);
  expect(globMatch("!D:/Work/foo", "D:/Work/foo")).toBe(false);
  expect(globMatch("!D:/Work/foo", "!D:/Work/foo")).toBe(true);
  // Backslashes normalize on BOTH sides; a trailing slash on the path is trimmed.
  expect(globMatch("D:\\Work\\*", "D:/Work/foo")).toBe(true);
  expect(globMatch("D:/Work/foo", "D:/Work/foo/")).toBe(true);
  // Anchored full-string match — a pattern never matches a mere substring.
  expect(globMatch("Work/*", "D:/Work/foo")).toBe(false);
});

test("matchIdentityRule: first-match-wins, no-rule passthrough on an empty/undefined list", () => {
  expect(matchIdentityRule("D:/Work/foo", undefined)).toBeNull();
  expect(matchIdentityRule("D:/Work/foo", [])).toBeNull();
  const rules: IdentityRule[] = [
    { pathPattern: "D:/Work/**", requiredIdentityId: "id-work" },
    { pathPattern: "D:/Work/foo", requiredIdentityId: "id-foo-specific" }, // shadowed — first wins
  ];
  expect(matchIdentityRule("D:/Work/foo", rules)?.requiredIdentityId).toBe("id-work");
  expect(matchIdentityRule("D:/Elsewhere/foo", rules)).toBeNull();
});

test("checkIdentityPolicy: ok when no rule matches, or the resolved identity satisfies the rule", () => {
  const idA = createIdentity({ displayName: "A", gitUsername: "a", gitEmail: "a@x.io" });
  const { view } = { view: null as unknown as RepoView }; // placeholder to keep structure explicit
  void view;
  const repoNoMatch: RepoView = {
    id: "r1",
    name: "n",
    absPath: "D:/Elsewhere/repo",
    source: "auto",
    vcs: "git",
    isSubmodule: false,
    identityId: null,
    syncAccountHost: null,
    syncAccountLogin: null,
    hidden: false,
    pinned: false,
    starred: false,
    autoCommit: false,
    status: null,
    updatedAt: 0,
  };
  expect(checkIdentityPolicy(repoNoMatch, [{ pathPattern: "D:/Work/**", requiredIdentityId: idA }]).ok).toBe(true);

  const repoMatchOk: RepoView = { ...repoNoMatch, absPath: "D:/Work/repo", identityId: idA };
  expect(checkIdentityPolicy(repoMatchOk, [{ pathPattern: "D:/Work/**", requiredIdentityId: idA }]).ok).toBe(true);
});

test("checkIdentityPolicy: violation when the resolved identity (or none) doesn't match the rule", () => {
  const idA = createIdentity({ displayName: "A", gitUsername: "a", gitEmail: "a@x.io" });
  const idB = createIdentity({ displayName: "B", gitUsername: "b", gitEmail: "b@x.io" });
  const rules: IdentityRule[] = [{ pathPattern: "D:/Work/**", requiredIdentityId: idA }];

  const repoWrongIdentity: RepoView = {
    id: "r2",
    name: "n",
    absPath: "D:/Work/repo",
    source: "auto",
    vcs: "git",
    isSubmodule: false,
    identityId: idB,
    syncAccountHost: null,
    syncAccountLogin: null,
    hidden: false,
    pinned: false,
    starred: false,
    autoCommit: false,
    status: null,
    updatedAt: 0,
  };
  const check1 = checkIdentityPolicy(repoWrongIdentity, rules);
  expect(check1.ok).toBe(false);
  if (!check1.ok) expect(check1.resolvedIdentityId).toBe(idB);

  const repoNoIdentity: RepoView = { ...repoWrongIdentity, identityId: null };
  const check2 = checkIdentityPolicy(repoNoIdentity, rules);
  expect(check2.ok).toBe(false);
  if (!check2.ok) expect(check2.resolvedIdentityId).toBeNull();
});

// ── enforceIdentityPolicy (the live-config-backed preflight helper) ─────────────────
test("enforceIdentityPolicy reads the live config ref set by setIdentityRulesConfig", async () => {
  const { view } = await gitRepo("live-ref");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });

  setIdentityRulesConfig(cfgWithRules([{ pathPattern: `${view.absPath.replace(/\\/g, "/")}`, requiredIdentityId: idRequired }]));
  expect(currentIdentityRules().length).toBe(1);

  const violation = enforceIdentityPolicy(getRepo(view.id)!);
  expect(violation).not.toBeNull();
  expect(violation?.code).toBe("IDENTITY_POLICY_VIOLATION");

  setRepoIdentity(view.id, idRequired);
  expect(enforceIdentityPolicy(getRepo(view.id)!)).toBeNull();
});

test("enforceIdentityPolicy is a no-op before setIdentityRulesConfig / with no rules configured", async () => {
  const { view } = await gitRepo("no-rules");
  setIdentityRulesConfig({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 }); // no identityRules field
  expect(enforceIdentityPolicy(view)).toBeNull();
});

// ── block behavior on commit / push (service/core.ts runAction + service/actions.ts) ────
test("commitRepo hard-blocks with IDENTITY_POLICY_VIOLATION when the repo violates its rule", async () => {
  const { dir, id, view } = await gitRepo("commit-block");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });
  setIdentityRulesConfig(cfgWithRules([{ pathPattern: view.absPath.replace(/\\/g, "/"), requiredIdentityId: idRequired }]));

  writeFileSync(join(dir, "a.txt"), "a1\n");
  const result = await commitRepo(id, "feat: change");
  expect(result.ok).toBe(false);
  expect(result.code).toBe("IDENTITY_POLICY_VIOLATION");

  // Nothing was actually committed — the working tree is still dirty.
  const status = (await $`git -C ${dir} status --porcelain`.text()).trim();
  expect(status).not.toBe("");
});

test("pushRepo hard-blocks with IDENTITY_POLICY_VIOLATION before ever touching the network", async () => {
  const { id, view } = await gitRepo("push-block");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });
  setIdentityRulesConfig(cfgWithRules([{ pathPattern: view.absPath.replace(/\\/g, "/"), requiredIdentityId: idRequired }]));

  const result = await pushRepo(id);
  expect(result.ok).toBe(false);
  expect(result.code).toBe("IDENTITY_POLICY_VIOLATION");
});

test("commitRepo succeeds once the repo is assigned the rule's required identity", async () => {
  const { dir, id, view } = await gitRepo("commit-ok");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });
  setIdentityRulesConfig(cfgWithRules([{ pathPattern: view.absPath.replace(/\\/g, "/"), requiredIdentityId: idRequired }]));
  setRepoIdentity(id, idRequired);

  writeFileSync(join(dir, "a.txt"), "a1\n");
  const result = await commitRepo(id, "feat: change");
  expect(result.ok).toBe(true);
});

test("smartCommitRepo hard-blocks a policy-violating repo before staging anything", async () => {
  const { dir, id, view } = await gitRepo("smart-block");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });
  setIdentityRulesConfig(cfgWithRules([{ pathPattern: view.absPath.replace(/\\/g, "/"), requiredIdentityId: idRequired }]));

  writeFileSync(join(dir, "a.txt"), "a1\n");
  const outcome = await smartCommitRepo(id, [{ message: "feat: change", paths: ["a.txt"] }]);
  expect(outcome.ok).toBe(false);
  expect(outcome.code).toBe("IDENTITY_POLICY_VIOLATION");
});

test("commitSelectedRepo hard-blocks a policy-violating repo before staging anything", async () => {
  const { dir, id, view } = await gitRepo("selected-block");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });
  setIdentityRulesConfig(cfgWithRules([{ pathPattern: view.absPath.replace(/\\/g, "/"), requiredIdentityId: idRequired }]));

  writeFileSync(join(dir, "a.txt"), "a1\n");
  const outcome = await commitSelectedRepo(id, "feat: change", ["a.txt"]);
  expect(outcome.ok).toBe(false);
  expect(outcome.code).toBe("IDENTITY_POLICY_VIOLATION");
});

test("a repo NOT matching any rule is completely unaffected (existing behavior)", async () => {
  const { dir, id, view } = await gitRepo("passthrough");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });
  setIdentityRulesConfig(
    cfgWithRules([{ pathPattern: `${view.absPath.replace(/\\/g, "/")}-DOES-NOT-EXIST`, requiredIdentityId: idRequired }]),
  );

  writeFileSync(join(dir, "a.txt"), "a1\n");
  const result = await commitRepo(id, "feat: change");
  expect(result.ok).toBe(true);
});

// ── MCP-path rejection: MCP mutating calls funnel through the SAME service functions ────
test("MCP git_commit inherits the Identity Firewall block (funnels through the same commitRepo)", async () => {
  const { dir, id, view } = await gitRepo("mcp-commit-block");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });
  setIdentityRulesConfig(cfgWithRules([{ pathPattern: view.absPath.replace(/\\/g, "/"), requiredIdentityId: idRequired }]));

  writeFileSync(join(dir, "a.txt"), "a1\n");
  const ctx = contextFor(serviceBackend());
  const tool = ctx.tools.find((t) => t.name === "git_commit")!;

  await expect(tool.run({ repo: id, message: "feat: change" })).rejects.toThrow(/IDENTITY_POLICY_VIOLATION|requires identity/);
});

test("MCP git_push inherits the Identity Firewall block (funnels through the same pushRepo)", async () => {
  const { id, view } = await gitRepo("mcp-push-block");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });
  setIdentityRulesConfig(cfgWithRules([{ pathPattern: view.absPath.replace(/\\/g, "/"), requiredIdentityId: idRequired }]));

  const ctx = contextFor(serviceBackend());
  const tool = ctx.tools.find((t) => t.name === "git_push")!;

  await expect(tool.run({ repo: id })).rejects.toThrow(/IDENTITY_POLICY_VIOLATION|requires identity/);
});

test("MCP read-only tools (repo_status) are never blocked by the Identity Firewall", async () => {
  const { id, view } = await gitRepo("mcp-readonly");
  const idRequired = createIdentity({ displayName: "Required", gitUsername: "req", gitEmail: "req@x.io" });
  setIdentityRulesConfig(cfgWithRules([{ pathPattern: view.absPath.replace(/\\/g, "/"), requiredIdentityId: idRequired }]));

  const ctx = contextFor(serviceBackend());
  const tool = ctx.tools.find((t) => t.name === "repo_status")!;
  const result = (await tool.run({ repo: id })) as { id: string };
  expect(result.id).toBe(id);
});
