/**
 * Grouped operational-error history: adapted from PostHog's issue-fingerprint grouping
 * (products/error_tracking/, MIT). Three layers, each would silently regress without its own
 * test: the db.ts grouping primitives, runAction (service/core.ts) actually calling them on a
 * real failure, and the read/mute/dismiss HTTP surface (src/http/routes/errors.ts).
 */
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import {
  recordOperationalError,
  listOperationalErrors,
  setOperationalErrorMuted,
  dismissOperationalError,
  operationalErrorFingerprint,
} from "../src/db.ts";
import { pushRepo } from "../src/service/actions.ts";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

/** A real repo with a commit but NO remote - pushRepo then fails deterministically (NO_REMOTE),
 *  with no network round trip involved, so this is fast and repeatable. */
async function repoWithNoRemote(prefix: string): Promise<string> {
  const dir = mkScratchDir(prefix);
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "a.txt"), "a\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q -m seed`.quiet();
  return mustUpsertRepo(dir, "err-grp", "pinned", false);
}

test("recordOperationalError groups repeated (repo, op, code) failures into one row with a rising count", () => {
  const repoId = `test-repo-${crypto.randomUUID()}`;
  const input = { repoId, repoName: "demo", op: "fetch", code: "NETWORK_TIMEOUT", message: "attempt 1" };

  recordOperationalError(input);
  recordOperationalError({ ...input, message: "attempt 2" });
  recordOperationalError({ ...input, message: "attempt 3" });

  const fingerprint = operationalErrorFingerprint(repoId, "fetch", "NETWORK_TIMEOUT");
  const row = listOperationalErrors().find((e) => e.fingerprint === fingerprint);
  expect(row).toBeTruthy();
  expect(row?.occurrences).toBe(3);
  // The newest failure's message wins - the most recent detail is usually the useful one.
  expect(row?.message).toBe("attempt 3");
  expect(row?.firstSeenAt).toBeLessThanOrEqual(row!.lastSeenAt);
});

test("a different code for the same repo+op is a SEPARATE group, not a merge", () => {
  const repoId = `test-repo-${crypto.randomUUID()}`;
  recordOperationalError({ repoId, repoName: "demo", op: "push", code: "NO_REMOTE", message: "m1" });
  recordOperationalError({ repoId, repoName: "demo", op: "push", code: "NON_FAST_FORWARD", message: "m2" });

  const rows = listOperationalErrors().filter((e) => e.repoId === repoId);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.occurrences === 1)).toBe(true);
});

test("mute toggles the flag and dismiss removes the row; both report false for an unknown fingerprint", () => {
  const repoId = `test-repo-${crypto.randomUUID()}`;
  recordOperationalError({ repoId, repoName: "demo", op: "pull", code: "SSH_AUTH_FAILED", message: "m" });
  const fingerprint = operationalErrorFingerprint(repoId, "pull", "SSH_AUTH_FAILED");

  expect(setOperationalErrorMuted(fingerprint, true)).toBe(true);
  expect(listOperationalErrors().find((e) => e.fingerprint === fingerprint)?.muted).toBe(true);

  expect(dismissOperationalError(fingerprint)).toBe(true);
  expect(listOperationalErrors().find((e) => e.fingerprint === fingerprint)).toBeUndefined();

  expect(setOperationalErrorMuted("no-such-fingerprint", true)).toBe(false);
  expect(dismissOperationalError("no-such-fingerprint")).toBe(false);
});

test("a real failed action (push with no remote) is recorded by runAction without any call site logging it itself", async () => {
  const id = await repoWithNoRemote("err-push-");

  const outcome = await pushRepo(id);
  expect(outcome.ok).toBe(false);
  expect(outcome.code).toBe("NO_REMOTE");

  const fingerprint = operationalErrorFingerprint(id, "push", "NO_REMOTE");
  const row = listOperationalErrors().find((e) => e.fingerprint === fingerprint);
  expect(row).toBeTruthy();
  expect(row?.repoId).toBe(id);
  expect(row?.occurrences).toBe(1);

  // Fail the SAME repo+op again - this is the whole point of the feature: the dashboard can now
  // say "this repo's push has failed twice" instead of the history collapsing to "failed" once.
  await pushRepo(id);
  const again = listOperationalErrors().find((e) => e.fingerprint === fingerprint);
  expect(again?.occurrences).toBe(2);
}, 30_000);

test("a submodule-blocked action is recorded too, even though it never reaches the git child process", async () => {
  const dir = mkScratchDir("err-submodule-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  const id = mustUpsertRepo(dir, "submod", "pinned", true); // isSubmodule = true

  const outcome = await pushRepo(id);
  expect(outcome.ok).toBe(false);
  expect(outcome.code).toBe("SUBMODULE_NOT_ACTIONABLE");
  // Preserves the pre-existing contract (see tests/action-status.test.ts): a run that never
  // reaches a refresh reports no status at all - this feature must not change that.
  expect(outcome.status).toBeUndefined();

  const fingerprint = operationalErrorFingerprint(id, "push", "SUBMODULE_NOT_ACTIONABLE");
  expect(listOperationalErrors().find((e) => e.fingerprint === fingerprint)).toBeTruthy();
}, 30_000);

test("GET/mute/dismiss over HTTP round-trip against a real recorded failure", async () => {
  const app = createApp(localCfg());
  const id = await repoWithNoRemote("err-http-");
  await pushRepo(id);
  const fingerprint = operationalErrorFingerprint(id, "push", "NO_REMOTE");

  const listRes = await app.request("/api/errors");
  expect(listRes.status).toBe(200);
  const listed = (await listRes.json()).errors as Array<{ fingerprint: string }>;
  expect(listed.some((e) => e.fingerprint === fingerprint)).toBe(true);

  const muteRes = await app.request(`/api/errors/${fingerprint}/mute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ muted: true }),
  });
  expect(muteRes.status).toBe(200);
  expect((await muteRes.json()).muted).toBe(true);

  const delRes = await app.request(`/api/errors/${fingerprint}`, { method: "DELETE" });
  expect(delRes.status).toBe(200);

  const afterRes = await app.request("/api/errors");
  const afterListed = (await afterRes.json()).errors as Array<{ fingerprint: string }>;
  expect(afterListed.some((e) => e.fingerprint === fingerprint)).toBe(false);

  // Dismissing again (or muting something that never existed) is a 404, not a false "ok".
  const redelRes = await app.request(`/api/errors/${fingerprint}`, { method: "DELETE" });
  expect(redelRes.status).toBe(404);
}, 30_000);
