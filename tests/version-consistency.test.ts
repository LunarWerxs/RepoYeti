import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/config.ts";
import { findRepoRoot } from "./helpers/repo-root.ts";

// The version is written in three places, and nothing kept them honest. web/package.json drifted
// three releases behind (0.4.0 while the app shipped 0.7.0) purely because a release bump touched
// the root and nobody noticed the other two.
//
// Of the three, src/config.ts is the one that matters: VERSION is what /api/health reports and
// what the updater compares against, so a drift there means the app tells you it is a version it
// isn't. web/package.json is cosmetic (private, unpublished, read by nothing), but "cosmetic" is
// exactly why it rotted — it is the copy with no symptom to notice.
//
// So this is a guard, not a chore: a release that bumps one and forgets the others fails here
// instead of shipping a daemon that misreports itself.

const ROOT = findRepoRoot(import.meta.dir);

function versionOf(relPath: string): string {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), "utf8")).version;
}

test("src/config.ts VERSION matches package.json", () => {
  // The user-visible one: GET /api/health reports VERSION, and the updater reads package.json.
  // If these disagree, the update check compares two different notions of "current".
  expect(VERSION).toBe(versionOf("package.json"));
});

test("web/package.json matches the root package.json", () => {
  expect(versionOf("web/package.json")).toBe(versionOf("package.json"));
});

test("the version is a plain semver triple", () => {
  // The release workflow derives the changelog section and asset names from the tag, so a
  // pre-release suffix or a stray "v" would silently miss its CHANGELOG entry.
  expect(versionOf("package.json")).toMatch(/^\d+\.\d+\.\d+$/);
});
