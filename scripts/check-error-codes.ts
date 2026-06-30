#!/usr/bin/env bun
/**
 * Drift guard for string-literal unions hand-mirrored across the backend + the web app:
 *   - `ApiErrorCode`  src/contract.ts  ⇄  web/src/types.ts  (so the UI can switch on codes)
 *   - `CommitStyle`   src/config.ts    ⇄  web/src/types.ts  (so the AI style picker matches)
 * Each pair MUST stay identical. This script extracts both sides and fails (exit 1) on any
 * divergence, so adding a backend member without the frontend copy becomes a CI error instead
 * of a runtime surprise. Run: `bun run check:codes` (wired into CI).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Extract a string-literal union `export type <name> = "a" | "b" | …;` as a Set of members. */
function extractUnion(relFile: string, typeName: string): Set<string> {
  const src = readFileSync(join(ROOT, relFile), "utf8");
  // Capture the union body up to the terminating `;` (non-greedy → stops at the first one).
  const m = src.match(new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`));
  if (!m) throw new Error(`${typeName} union not found in ${relFile}`);
  const out = new Set<string>();
  for (const lit of m[1]!.matchAll(/"([A-Za-z0-9_:-]+)"/g)) out.add(lit[1]!);
  return out;
}

/** Fail (exit 1) if a union hand-mirrored in a backend + frontend file has diverged. */
function assertInSync(typeName: string, backendFile: string, frontendFile: string): number {
  const backend = extractUnion(backendFile, typeName);
  const frontend = extractUnion(frontendFile, typeName);
  const onlyBackend = [...backend].filter((c) => !frontend.has(c));
  const onlyFrontend = [...frontend].filter((c) => !backend.has(c));
  if (onlyBackend.length || onlyFrontend.length) {
    console.error(`✗ ${typeName} drift between ${backendFile} and ${frontendFile}:`);
    if (onlyBackend.length) console.error(`  backend-only (add to ${frontendFile}): ${onlyBackend.join(", ")}`);
    if (onlyFrontend.length) console.error(`  web-only (add to ${backendFile}):      ${onlyFrontend.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ ${typeName} in sync (${backend.size} members) across ${backendFile} + ${frontendFile}`);
  return backend.size;
}

assertInSync("ApiErrorCode", "src/contract.ts", "web/src/types.ts");
assertInSync("CommitStyle", "src/config.ts", "web/src/types.ts");
