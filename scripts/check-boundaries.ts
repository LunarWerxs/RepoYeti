#!/usr/bin/env bun
/**
 * Architectural boundary guard (zero-dependency, like check-error-codes.ts). Enforces RepoYeti's
 * intended layering so it can't silently drift as the codebase grows:
 *   - src/http/** (HTTP routes) must go through service.ts — never import git-actions/read/status/read/inspect.
 *   - read-only layers (status.ts, inspect.ts) must not import the orchestration layer (service.ts).
 *   - VCS backends (src/vcs/*) must not depend on service.ts (would invert the dependency / cycle).
 *   - vcs/types.ts (the VcsBackend CONTRACT) must not import the git implementation (git-actions.ts);
 *     shared result types live in contract.ts. (vcs/git.ts, the git ADAPTER, may import it.)
 * Run: `bun run check:boundaries` (wired into CI via `bun run check`).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const violations: string[] = [];

// Per-file forbidden imports.
const rules: Array<{ file: string; forbid: RegExp; why: string }> = [
  {
    file: "src/read/status.ts",
    forbid: /from\s+"(\.\.\/)+service(\.ts|\/|")/g,
    why: "status.ts (read-only) must not import the orchestration layer",
  },
  {
    file: "src/read/inspect.ts",
    forbid: /from\s+"(\.\.\/)+service(\.ts|\/|")/g,
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

// HTTP routes (src/http/**, incl. routes/) must call service.ts — never the git/inspection
// layers directly. NOTE: read/diffstat is ALLOWED (the settings route uses its runtime toggles).
const HTTP_FORBID = /from\s+"[^"]*\/(git-actions|read\/status|read\/inspect)(\.ts|")/g;
const HTTP_WHY = "http routes must call service.ts, not the git/inspection layers directly";
const walkHttp = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      walkHttp(abs);
    } else if (name.endsWith(".ts")) {
      const rel = relative(ROOT, abs).replaceAll("\\", "/");
      for (const m of read(rel).matchAll(HTTP_FORBID)) {
        violations.push(`${rel}: forbidden import \`${m[0]}\` — ${HTTP_WHY}`);
      }
    }
  }
};
walkHttp(join(ROOT, "src/http"));

// CLI verbs (src/cli/**) drive the daemon over HTTP — they must NOT import the in-process
// service/read/git-actions/vcs layers. lifecycle.ts IS the daemon boot (it legitimately wires
// those layers up), and main.ts only dispatches, so both are exempt.
const CLI_FORBID = /from\s+"[^"]*\/(service|read|git-actions|vcs)(\/|\.ts|")/g;
const CLI_WHY = "CLI verbs must drive the daemon over HTTP, not import the service/git layers in-process";
const CLI_EXEMPT = new Set(["lifecycle.ts", "main.ts"]);
for (const name of readdirSync(join(ROOT, "src/cli")).filter((n) => n.endsWith(".ts"))) {
  if (CLI_EXEMPT.has(name)) continue;
  for (const m of read(`src/cli/${name}`).matchAll(CLI_FORBID)) {
    violations.push(`src/cli/${name}: forbidden import \`${m[0]}\` — ${CLI_WHY}`);
  }
}

// VCS backends must not import the service layer (would create a cycle).
for (const f of readdirSync(join(ROOT, "src/vcs")).filter((n) => n.endsWith(".ts"))) {
  for (const m of read(`src/vcs/${f}`).matchAll(/from\s+"(\.\.\/)+service(\.ts|\/|")/g)) {
    violations.push(`src/vcs/${f}: forbidden import \`${m[0]}\` — VCS backends must not depend on service.ts`);
  }
}

// MCP core/contract layer (src/mcp/{core,tools,backend}.ts) must stay transport-agnostic + pure —
// the backend is INJECTED, so these three files must not import the service/git/db layers. The two
// adapters (adapter-service.ts, adapter-http.ts) ARE the bridges and are deliberately exempt.
const MCP_FORBID = /from\s+"[^"]*\/(service|read|git-actions|vcs|db)(\/|\.ts|")/g;
const MCP_WHY = "mcp core/tools/backend must be transport-agnostic — use an injected backend, not the service/git/db layers";
const MCP_PURE = new Set(["core.ts", "tools.ts", "backend.ts"]);
for (const name of readdirSync(join(ROOT, "src/mcp")).filter((n) => n.endsWith(".ts"))) {
  if (!MCP_PURE.has(name)) continue; // adapter-service.ts + adapter-http.ts are the bridges → exempt
  for (const m of read(`src/mcp/${name}`).matchAll(MCP_FORBID)) {
    violations.push(`src/mcp/${name}: forbidden import \`${m[0]}\` — ${MCP_WHY}`);
  }
}

if (violations.length) {
  console.error("✗ Architectural boundary violations:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("✓ Architecture boundaries hold (http→service · read-only ⊥ service · vcs ⊥ service)");
