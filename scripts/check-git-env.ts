#!/usr/bin/env bun
/**
 * Drift guard for `BLOCKED_GIT_ENV` (src/git.ts) against `simple-git`'s block-unsafe guard.
 *
 * simple-git refuses to run at all when certain environment variables are merely PRESENT in the
 * env handed to a task, throwing `Use of "X" is not permitted without enabling allowUnsafeY`
 * before git is spawned. `safeGitEnv()` strips that whole family, so ambient values from whoever
 * launched the daemon cannot break (or redirect) every git operation. The failure mode is nasty
 * precisely because it is environmental: the daemon works from a plain shell and fails from a
 * VS Code / Claude Code / GitHub Desktop terminal, which all export `GIT_ASKPASS`.
 *
 * A hand-written list rots the moment simple-git adds a guard, and its blocked names are built
 * dynamically inside a minified bundle, so they cannot simply be read out of it. Instead this
 * script PROBES: it runs a real `git --version` through simple-git once per candidate variable and
 * records which ones the guard rejects. Two assertions follow:
 *
 *   1. every variable simple-git blocks must be in BLOCKED_GIT_ENV  (the drift that bites)
 *   2. with all of them set, `gitFor()` must still run a git command  (the end-to-end proof)
 *
 * Assertion 2 is the one that cannot go stale: it holds even for a variable nobody thought to put
 * in the candidate list, as long as safeGitEnv() removes it. Run: `bun run check:gitenv`.
 */
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { BLOCKED_GIT_ENV, gitFor, safeGitEnv } from "../src/git.ts";

/**
 * Every environment variable documented as changing what git runs or reads, whether or not
 * simple-git currently objects. Probing a superset is the point: a name that moves from allowed to
 * blocked in a future simple-git release is exactly the regression this script exists to catch.
 */
const CANDIDATES = [
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "PAGER",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_PROXY_COMMAND",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_NAMESPACE",
  "GIT_ATTR_NOSYSTEM",
  "GIT_MERGE_AUTOEDIT",
  "GIT_TRACE",
] as const;

const ROOT = join(import.meta.dir, "..");

/** Does simple-git's guard reject a task whose env carries `name`? Returns its message if so. */
async function blockedBy(name: string): Promise<string | null> {
  try {
    // A minimal env: PATH only, so the answer is about `name` and nothing else in the ambient set.
    await simpleGit({ baseDir: ROOT })
      .env({ PATH: process.env.PATH ?? "", [name]: "x" })
      .raw(["--version"]);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only the guard's own refusal counts. Anything else (a broken PATH, a missing git) is a
    // problem with this script's setup, not evidence that `name` is blocked.
    return /is not permitted without enabling/.test(message) ? message : null;
  }
}

const stripped = new Set<string>(BLOCKED_GIT_ENV);
const missing: string[] = [];
let blockedCount = 0;

for (const name of CANDIDATES) {
  const message = await blockedBy(name);
  if (!message) continue;
  blockedCount++;
  if (!stripped.has(name)) missing.push(`  ${name.padEnd(32)} ${message}`);
}

if (missing.length) {
  console.error("✗ simple-git blocks environment variables that safeGitEnv() does not strip.");
  console.error("  Every git call fails outright when one of these is present in the daemon's env.");
  console.error("  Add them to BLOCKED_GIT_ENV in src/git.ts:");
  console.error(missing.join("\n"));
  process.exit(1);
}

// The assertion that survives a stale CANDIDATES list: set the whole blocked family and prove a
// real git command still runs through the daemon's own construction path.
const saved = new Map<string, string | undefined>();
for (const name of BLOCKED_GIT_ENV) {
  saved.set(name, process.env[name]);
  // An EMPTY string is the realistic hostile case, not a synthetic one: that is exactly what
  // Claude Code exports for GIT_ASKPASS, and it still trips the guard.
  process.env[name] = name === "GIT_ASKPASS" ? "" : "x";
}
try {
  for (const name of BLOCKED_GIT_ENV) {
    if (safeGitEnv()[name] !== undefined) {
      console.error(`✗ safeGitEnv() left ${name} in the environment.`);
      process.exit(1);
    }
  }
  await gitFor(ROOT).raw(["--version"]);
} catch (err) {
  console.error(`✗ gitFor() failed with the blocked family set: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
} finally {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log(
  `✓ safeGitEnv() strips all ${blockedCount} env vars simple-git blocks ` +
    `(${BLOCKED_GIT_ENV.length} listed, ${CANDIDATES.length} probed); gitFor() runs clean with every one set`,
);
