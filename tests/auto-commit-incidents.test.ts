/**
 * Auto-commit incident review: the db.ts CRUD (record/list/ack/cap), the HTTP surface
 * (GET /api/auto-commit/incidents, POST .../ack), and the tick() wiring that records an
 * incident when a repo is blocked - without needing a real git fixture, since the point being
 * tested is that a repo the timer could not even READ its status for still leaves a row (the
 * `catch { return true }` branch of auto-commit.ts's hasConflict).
 */
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/http/app.ts";
import {
  upsertRepo,
  setRepoAutoCommit,
  setRepoStatus,
  recordAutoCommitIncident,
  listAutoCommitIncidents,
  ackAutoCommitIncident,
  type RepoStatus,
} from "../src/db.ts";
import { runAutoCommitNow } from "../src/auto-commit.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

useSuiteTimeout(); // runAutoCommitNow's blocked-repo test reaches a real (fast-failing) git spawn

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

test("recordAutoCommitIncident + listAutoCommitIncidents + ackAutoCommitIncident round-trip", () => {
  const repoId = `db-test-${randomUUID()}`;
  recordAutoCommitIncident({ repoId, repoName: "widget", reason: "CONFLICT" });

  const mine = listAutoCommitIncidents({ limit: 500 }).filter((i) => i.repoId === repoId);
  expect(mine.length).toBe(1);
  expect(mine[0]!.reason).toBe("CONFLICT");
  expect(mine[0]!.repoName).toBe("widget");
  expect(mine[0]!.ackedAt).toBeNull();

  // Unknown id: ack fails, doesn't throw.
  expect(ackAutoCommitIncident("no-such-id")).toBe(false);

  expect(ackAutoCommitIncident(mine[0]!.id)).toBe(true);
  const acked = listAutoCommitIncidents({ limit: 500 }).find((i) => i.id === mine[0]!.id)!;
  expect(acked.ackedAt).not.toBeNull();

  // Acking again is a no-op success, not a fresh timestamp.
  const firstAckedAt = acked.ackedAt;
  expect(ackAutoCommitIncident(mine[0]!.id)).toBe(true);
  const stillAcked = listAutoCommitIncidents({ limit: 500 }).find((i) => i.id === mine[0]!.id)!;
  expect(stillAcked.ackedAt).toBe(firstAckedAt);
});

test("recordAutoCommitIncident dedupes on (repoId, reason) while unacked, instead of piling up rows", () => {
  const repoId = `dedup-test-${randomUUID()}`;
  recordAutoCommitIncident({ repoId, repoName: "stuck-repo", reason: "CONFLICT" });
  const first = listAutoCommitIncidents({ limit: 500 }).filter((i) => i.repoId === repoId);
  expect(first.length).toBe(1);
  const firstAt = first[0]!.at;

  // A repeat tick of the SAME still-unresolved problem must bump the existing row, not mint a
  // second one - a repo stuck in CONFLICT forever would otherwise, over enough ticks, fill the
  // shared 500-row cap by itself and evict every other repo's incidents (the bug this guards).
  recordAutoCommitIncident({ repoId, repoName: "stuck-repo", reason: "CONFLICT" });
  const stillOne = listAutoCommitIncidents({ limit: 500 }).filter((i) => i.repoId === repoId);
  expect(stillOne.length).toBe(1);
  expect(stillOne[0]!.id).toBe(first[0]!.id); // same row, not a new insert
  expect(stillOne[0]!.at).toBeGreaterThanOrEqual(firstAt); // bumped forward ("last seen")

  // A DIFFERENT reason for the same repo is a distinct open problem, not a dedup match.
  recordAutoCommitIncident({ repoId, repoName: "stuck-repo", reason: "AI_UNAVAILABLE" });
  expect(listAutoCommitIncidents({ limit: 500 }).filter((i) => i.repoId === repoId).length).toBe(2);

  // Once acked, the SAME (repoId, reason) recurring is new news, not a bump of dismissed news.
  ackAutoCommitIncident(stillOne[0]!.id);
  recordAutoCommitIncident({ repoId, repoName: "stuck-repo", reason: "CONFLICT" });
  const afterAck = listAutoCommitIncidents({ limit: 500 }).filter((i) => i.repoId === repoId);
  expect(afterAck.length).toBe(3);
  expect(afterAck.filter((i) => i.reason === "CONFLICT").length).toBe(2);
  expect(afterAck.some((i) => i.reason === "CONFLICT" && i.ackedAt === null)).toBe(true);
});

test("unackedOnly narrows to rows not yet reviewed", () => {
  const repoId = `unacked-test-${randomUUID()}`;
  recordAutoCommitIncident({ repoId, repoName: "a", reason: "CONFLICT" });
  recordAutoCommitIncident({ repoId, repoName: "a", reason: "AI_UNAVAILABLE" });
  const [first, second] = listAutoCommitIncidents({ limit: 500 }).filter((i) => i.repoId === repoId);
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  ackAutoCommitIncident(first!.id);

  const unacked = listAutoCommitIncidents({ unackedOnly: true, limit: 500 }).filter(
    (i) => i.repoId === repoId,
  );
  expect(unacked.map((i) => i.id)).toEqual([second!.id]);
});

test("GET/POST /api/auto-commit/incidents: list, unackedOnly, ack, 404 on unknown id", async () => {
  const app = createApp(localCfg());
  const repoId = `route-test-${randomUUID()}`;
  recordAutoCommitIncident({ repoId, repoName: "route-repo", reason: "CONFLICT" });

  const listRes = await app.request("/api/auto-commit/incidents?limit=500");
  expect(listRes.status).toBe(200);
  const listBody = (await listRes.json()) as { incidents: Array<{ id: string; repoId: string }>; unacked: number };
  const mine = listBody.incidents.filter((i) => i.repoId === repoId);
  expect(mine.length).toBe(1);
  expect(listBody.unacked).toBeGreaterThanOrEqual(1);

  const ackRes = await app.request(`/api/auto-commit/incidents/${mine[0]!.id}/ack`, { method: "POST" });
  expect(ackRes.status).toBe(200);
  expect(await ackRes.json()).toEqual({ ok: true });

  const afterAck = await app.request(`/api/auto-commit/incidents?unackedOnly=1&limit=500`);
  const afterBody = (await afterAck.json()) as { incidents: Array<{ id: string }> };
  expect(afterBody.incidents.some((i) => i.id === mine[0]!.id)).toBe(false);

  const missing = await app.request("/api/auto-commit/incidents/no-such-id/ack", { method: "POST" });
  expect(missing.status).toBe(404);
});

test("runAutoCommitNow() persists an incident when a repo is blocked", async () => {
  // A path RepoYeti will happily register (outside the OS temp roots, so upsertRepo's temp-dir
  // guard doesn't refuse it) but that does not exist on disk. hasConflict's `git status` call
  // fails against it, which is exactly the "couldn't read the tree -> safest to skip" branch
  // auto-commit.ts already treats as CONFLICT - no real git fixture required to prove the wiring.
  const absPath = resolve("/", `repoyeti-incident-test-missing-${randomUUID()}`);
  const id = upsertRepo(absPath, "incident-test-repo", "created", false)!;
  expect(id).toBeTruthy(); // fails loudly if this ever regresses into the temp-dir guard
  setRepoAutoCommit(id, true);
  const status: RepoStatus = {
    branch: "main",
    detached: false,
    dirty: 1, // makes the round consider it, without needing ahead/behind/remote
    ahead: 0,
    behind: 0,
    remote: null,
    error: null,
    fetchedAt: null,
    diff: null,
    updatedAt: Date.now(),
  };
  setRepoStatus(id, status);

  const { blocked } = await runAutoCommitNow();
  expect(blocked.some((b) => b.id === id && b.reason === "CONFLICT")).toBe(true);

  const mine = listAutoCommitIncidents({ limit: 500 }).filter((i) => i.repoId === id);
  expect(mine.length).toBe(1);
  expect(mine[0]!.reason).toBe("CONFLICT");
  expect(mine[0]!.repoName).toBe("incident-test-repo");
  expect(mine[0]!.ackedAt).toBeNull(); // countUnackedAutoCommitIncidents would double-count this
});

// LAST on purpose: this saturates the global 500-row cap, so any test relying on an unpolluted
// count (unacked totals, etc.) must run before it, not after.
test("incidents are capped at the newest 500 (pruned by insertion order)", () => {
  const repoId = `cap-test-${randomUUID()}`;
  for (let i = 0; i < 510; i++) {
    recordAutoCommitIncident({ repoId, repoName: "cap-repo", reason: `CAP_TEST_${i}` });
  }
  const mine = listAutoCommitIncidents({ limit: 1000 }).filter((i) => i.repoId === repoId);
  // All 510 were the newest rows in the whole table at the moment they were written (nothing else
  // in this run could be newer), so exactly 500 survive the global cap: the oldest 10 of OUR OWN
  // batch, not some mix with pre-existing rows.
  expect(mine.length).toBe(500);
  expect(mine.some((i) => i.reason === "CAP_TEST_0")).toBe(false);
  expect(mine.some((i) => i.reason === "CAP_TEST_9")).toBe(false);
  expect(mine.some((i) => i.reason === "CAP_TEST_509")).toBe(true);
});
