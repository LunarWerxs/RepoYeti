/**
 * A mutating action reports the repo state it produced, in its OWN response.
 *
 * The daemon has always re-read status after an action and broadcast it (service/core.ts
 * refreshRepo). What it did not do was hand that status back to the caller, so the client that
 * pressed the button had to wait for its own `repo_state_changed` frame to loop back around. Every
 * assertion here therefore deliberately ignores the SSE bus: the point is that the answer is
 * complete without it. That gap is what left a pushed repo's button green until someone hit
 * Refresh — Refresh being the one action that already patched status from its own response.
 *
 * The guest projection is covered too, because the status carries `remote`, and a remote URL
 * routinely embeds a PAT. Adding a second way to deliver a status means adding it to the redaction.
 */
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { pushRepo, commitRepo, stashSaveRepo } from "../src/service/actions.ts";
import { forceRefresh } from "../src/service/core.ts";
import { guestStatus } from "../src/share/redact.ts";

/** A repo with an origin it is exactly one commit ahead of. */
async function aheadByOne(prefix: string): Promise<{ id: string; dir: string }> {
  const base = mkScratchDir(prefix);
  const origin = join(base, "origin.git");
  const dir = join(base, "local");
  await $`git -c init.defaultBranch=main init -q --bare ${origin}`.quiet();
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "a.txt"), "a0\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q -m seed`.quiet();
  await $`git -C ${dir} remote add origin ${origin}`.quiet();
  await $`git -C ${dir} push -q -u origin main`.quiet();
  writeFileSync(join(dir, "a.txt"), "a1\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q -m ahead`.quiet();
  return { id: mustUpsertRepo(dir, "act-status", "pinned", false), dir };
}

test("a successful push answers with ahead back at zero, without consulting the bus", async () => {
  const { id } = await aheadByOne("act-push-");
  expect((await forceRefresh(id))?.status?.ahead).toBe(1);

  const outcome = await pushRepo(id);

  expect(outcome.ok).toBe(true);
  // The whole point: the caller learns this from the RESPONSE. No SSE listener is attached above.
  expect(outcome.status?.ahead).toBe(0);
}, 60_000);

test("a commit answers with the new dirty count and the new head", async () => {
  const { id, dir } = await aheadByOne("act-commit-");
  writeFileSync(join(dir, "b.txt"), "b0\n");
  const before = await forceRefresh(id);
  expect(before?.status?.dirty).toBe(1);

  const outcome = await commitRepo(id, "add b");

  expect(outcome.ok).toBe(true);
  expect(outcome.status?.dirty).toBe(0);
  expect(outcome.status?.headOid).not.toBe(before?.status?.headOid);
}, 60_000);

test("an action that never reaches a refresh reports no status rather than a stale one", async () => {
  const outcome = await pushRepo("no-such-repo-id");
  expect(outcome.ok).toBe(false);
  expect(outcome.code).toBe("NOT_FOUND");
  // Absent, NOT the last known status: a client patching from this would resurrect stale state.
  expect(outcome.status).toBeUndefined();
});

test("stashing reports the cleaned tree, so every runAction path carries status, not just push", async () => {
  const { id, dir } = await aheadByOne("act-stash-");
  writeFileSync(join(dir, "a.txt"), "dirty\n");
  expect((await forceRefresh(id))?.status?.dirty).toBe(1);

  const outcome = await stashSaveRepo(id, "wip");

  expect(outcome.ok).toBe(true);
  expect(outcome.status?.dirty).toBe(0);
}, 60_000);

test("the guest projection of an action status redacts the remote credential", async () => {
  const { id } = await aheadByOne("act-guest-");
  const outcome = await pushRepo(id);
  expect(outcome.status).toBeTruthy();

  // The route hands ActionOutcome.status through guestStatus for a share-link holder
  // (http/respond.ts withGuestStatus) — the same projection the SSE broadcast already used.
  const credentialed = { ...outcome.status!, remote: "https://user:ghp_secrettoken@github.com/o/r.git" };
  const projected = guestStatus(credentialed);

  expect(projected?.remote).not.toContain("ghp_secrettoken");
  expect(projected?.ahead).toBe(0); // everything else survives the projection
}, 60_000);
