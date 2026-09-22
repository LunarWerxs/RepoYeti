/**
 * The Lore backend's delete had the git backend's old hole: the path was confined only in spelling,
 * so a committed directory link let `rmSync`/`unlinkSync` reach outside the checkout. The guard
 * runs before any `lore` CLI call, so this needs no Lore install.
 */
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loreDeleteFile } from "../src/vcs/lore.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

test("loreDeleteFile refuses a folder or file reached through a link that leaves the checkout", async () => {
  const repo = mkScratchDir("lore-del-repo-");
  const outside = mkScratchDir("lore-del-outside-");
  mkdirSync(join(outside, "projects"));
  writeFileSync(join(outside, "projects", "keep.txt"), "not the repo's\n");
  writeFileSync(join(outside, "secrets.txt"), "not the repo's either\n");
  symlinkSync(outside, join(repo, "vendor"), "junction");

  const folder = await loreDeleteFile(repo, "vendor/projects", true);
  expect(folder.ok).toBe(false);
  expect(folder.message).toContain("escapes the repository");
  expect(existsSync(join(outside, "projects", "keep.txt"))).toBe(true);

  const file = await loreDeleteFile(repo, "vendor/secrets.txt");
  expect(file.ok).toBe(false);
  expect(existsSync(join(outside, "secrets.txt"))).toBe(true);
});
