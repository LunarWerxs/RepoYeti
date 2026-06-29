#!/usr/bin/env bun
/**
 * Architectural boundary guard (zero-dependency, like check-error-codes.ts). Enforces RepoYeti's
 * intended layering so it can't silently drift as the codebase grows:
 *   - daemon.ts (HTTP routes) must go through service.ts — never import git-actions/status/inspect.
 *   - read-only layers (status.ts, inspect.ts) must not import the orchestration layer (service.ts).
 *   - VCS backends (src/vcs/*) must not depend on service.ts (would invert the dependency / cycle).
 *   - vcs/types.ts (the VcsBackend CONTRACT) must not import the git implementation (git-actions.ts);
 *     shared result types live in contract.ts. (vcs/git.ts, the git ADAPTER, may import it.)
 * Run: `bun run check:boundaries` (wired into CI via `bun run check`).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const violations: string[] = [];

// Per-file forbidden imports.
const rules: Array<{ file: string; forbid: RegExp; why: string }> = [
  {
    file: "src/daemon.ts",
    forbid: /from\s+"\.\/(git-actions|status|inspect)(\.ts)?"/g,
    why: "daemon.ts (routes) must call service.ts, not the git/inspection layers directly",
  },
  {
    file: "src/status.ts",
    forbid: /from\s+"\.\/service(\.ts)?"/g,
    why: "status.ts (read-only) must not import the orchestration layer",
  },
  {
    file: "src/inspect.ts",
    forbid: /from\s+"\.\/service(\.ts)?"/g,
    why: "inspect.ts (read-only) must not import the orchestration layer",
  },
  {
    file: "src/vcs/types.ts",
    forbid: /from\s+"(\.\.\/)+git-actions(\.ts)?"/g,
    why: "the VcsBackend contract must not depend on the git implementation — use contract.ts",
  },
];

for (const r of rules) {
  for (const m of read(r.file).matchAll(r.forbid)) {
    violations.push(`${r.file}: forbidden import \`${m[0]}\` — ${r.why}`);
  }
}

// VCS backends must not import the service layer (would create a cycle).
for (const f of readdirSync(join(ROOT, "src/vcs")).filter((n) => n.endsWith(".ts"))) {
  for (const m of read(`src/vcs/${f}`).matchAll(/from\s+"(\.\.\/)+service(\.ts)?"/g)) {
    violations.push(`src/vcs/${f}: forbidden import \`${m[0]}\` — VCS backends must not depend on service.ts`);
  }
}

if (violations.length) {
  console.error("✗ Architectural boundary violations:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("✓ Architecture boundaries hold (daemon→service · read-only ⊥ service · vcs ⊥ service)");
