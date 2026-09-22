/**
 * Removing a repository must only take back what was shared FROM that repository.
 *
 * forgetRepo's cleanup used to be `DELETE FROM shares WHERE id NOT IN (SELECT share_id FROM
 * share_repos)`. A "share all repositories" link has no share_repos rows by design, so removing ANY
 * repo from the dashboard hard-deleted every such link: the recipient's link started answering 404
 * and the owner's Sharing panel lost the row. The scan-root path (deleteRepos) had the opposite
 * gap: it removed no grants at all, leaving empty scoped links that still signed in.
 */
import { test, expect, beforeAll } from "bun:test";
import { $ } from "bun";
import { initDb, createShare, getShare, shareRepoIds, forgetRepo, deleteRepos, type Share } from "../src/db.ts";
import { hashToken, mintToken } from "../src/share/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

useSuiteTimeout();

async function gitRepo(name: string): Promise<string> {
  const dir = mkScratchDir(name);
  await $`git init -q ${dir}`.quiet();
  return mustUpsertRepo(dir, name, "pinned", false);
}

function share(scopeAll: boolean, repoIds: string[]): Share {
  return createShare(hashToken(mintToken()), {
    label: scopeAll ? "everything" : `only ${repoIds.length}`,
    perm: "view",
    collaborative: false,
    scopeAll,
    repoIds,
    expiresAt: null,
  });
}

beforeAll(() => {
  initDb();
});

test("forgetting one repo keeps every share-all link and every scoped link that still names a repo", async () => {
  const a = await gitRepo("share-removal-a");
  const b = await gitRepo("share-removal-b");
  const everything = share(true, []);
  const onlyA = share(false, [a]);
  const aAndB = share(false, [a, b]);

  forgetRepo(a);

  expect(getShare(everything.id)).not.toBeNull(); // the bug: this row used to be deleted
  expect(getShare(onlyA.id)).toBeNull(); // nothing left to show: removed, as before
  expect(getShare(aAndB.id)).not.toBeNull();
  expect(shareRepoIds(aAndB.id)).toEqual([b]);
});

test("removing repos through a scan root releases their grants the same way", async () => {
  const c = await gitRepo("share-removal-c");
  const d = await gitRepo("share-removal-d");
  const everything = share(true, []);
  const onlyC = share(false, [c]);
  const cAndD = share(false, [c, d]);

  deleteRepos([c]);

  expect(getShare(everything.id)).not.toBeNull();
  expect(getShare(onlyC.id)).toBeNull();
  expect(shareRepoIds(cAndD.id)).toEqual([d]);
});
