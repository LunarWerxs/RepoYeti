/**
 * Regression for the identity dedupe key in detectIdentities() (src/identity-detect.ts).
 *
 * The key used to be built from source/username/email/sshKeyPath/title only. Two repos that share
 * a basename but live in different directories (discovery names a repo after its basename) and
 * carry the same local user.name/user.email produced an identical key, so the second repo's
 * git-local identity suggestion was silently dropped. Detail holds the absPath and now separates
 * them.
 */
import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { detectIdentities } from "../src/identity-detect.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

async function initRepoWithIdentity(path: string, name: string, email: string): Promise<void> {
  await $`git -c init.defaultBranch=main init -q ${path}`.quiet();
  await $`git -C ${path} config user.name ${name}`.quiet();
  await $`git -C ${path} config user.email ${email}`.quiet();
}

test("two same-named repos with identical local identity both survive dedupe", async () => {
  const base = mkScratchDir("ident-dedupe-");
  const workApi = join(base, "work", "api");
  const backupApi = join(base, "backup", "api");
  mkdirSync(workApi, { recursive: true });
  mkdirSync(backupApi, { recursive: true });
  await initRepoWithIdentity(workApi, "Shared Author", "shared@example.com");
  await initRepoWithIdentity(backupApi, "Shared Author", "shared@example.com");

  const detected = await detectIdentities([
    { name: "api", absPath: workApi },
    { name: "api", absPath: backupApi },
  ]);

  const repoLocal = detected.filter((item) => item.source === "git-local" && item.title === "Repo Git config: api");
  expect(repoLocal).toHaveLength(2);
  expect(repoLocal.map((item) => item.detail)).toEqual(
    expect.arrayContaining([expect.stringContaining(workApi), expect.stringContaining(backupApi)]),
  );
});
