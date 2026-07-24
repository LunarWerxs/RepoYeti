/**
 * Identity data-hygiene: idempotent/validated createIdentity + updateIdentity (src/db.ts), the
 * identities_natkey unique index (backstop), the one-time duplicate-merge migration
 * (mergeDuplicateIdentities), and the test-isolation hard guard (src/config.ts
 * assertNotRealHomeUnderTest, exercised via ensureConfigDir/initDb).
 *
 * Context: a historic gap (bun test running against the REAL ~/.repoyeti before tests/setup.ts
 * existed) left the owner's live DB with heavy duplicate identity rows ("Required" x8 etc). This
 * file proves: (1) that can't happen again test-side (the guard), (2) it can't happen app-side
 * either (idempotent create + the unique index), and (3) any duplicates already sitting in an
 * existing DB get merged cleanly on the next boot.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  createIdentity,
  updateIdentity,
  getIdentity,
  listIdentities,
  deleteIdentity,
  setAccountIdentity,
  getAccountIdentity,
  setRepoIdentity,
  getRepo,
  mergeDuplicateIdentities,
  IdentityValidationError,
} from "../src/db.ts";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const J = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ── createIdentity: idempotent by natural key ────────────────────────────────────────────

test("createIdentity is idempotent: an exact-duplicate submission returns the existing row's id", () => {
  const before = listIdentities().length;
  const id1 = createIdentity({ displayName: "Hygiene A", gitUsername: "hy-a", gitEmail: "hy-a@x.io" });
  const id2 = createIdentity({ displayName: "Hygiene A", gitUsername: "hy-a", gitEmail: "hy-a@x.io" });
  expect(id2).toBe(id1);
  expect(listIdentities().length).toBe(before + 1); // no duplicate row inserted
});

test("createIdentity idempotency is case-insensitive and trims whitespace", () => {
  const before = listIdentities().length;
  const id1 = createIdentity({ displayName: "Hygiene B", gitUsername: "hy-b", gitEmail: "hy-b@x.io" });
  const id2 = createIdentity({
    displayName: "  hygiene b  ",
    gitUsername: " HY-B ",
    gitEmail: " HY-B@X.IO ",
  });
  expect(id2).toBe(id1);
  expect(listIdentities().length).toBe(before + 1);
});

test("createIdentity treats a different natural key as a genuinely new identity", () => {
  const before = listIdentities().length;
  const id1 = createIdentity({ displayName: "Hygiene C1", gitUsername: "hy-c1", gitEmail: "hy-c1@x.io" });
  const id2 = createIdentity({ displayName: "Hygiene C2", gitUsername: "hy-c2", gitEmail: "hy-c2@x.io" });
  expect(id2).not.toBe(id1);
  expect(listIdentities().length).toBe(before + 2);
});

test("createIdentity rejects empty/whitespace-only name and malformed email", () => {
  expect(() => createIdentity({ displayName: "  ", gitUsername: "u", gitEmail: "u@x.io" })).toThrow(
    IdentityValidationError,
  );
  expect(() => createIdentity({ displayName: "Name", gitUsername: " ", gitEmail: "u@x.io" })).toThrow(
    IdentityValidationError,
  );
  expect(() => createIdentity({ displayName: "Name", gitUsername: "u", gitEmail: "not-an-email" })).toThrow(
    IdentityValidationError,
  );
  expect(() => createIdentity({ displayName: "Name", gitUsername: "u", gitEmail: "  " })).toThrow(
    IdentityValidationError,
  );
});

test("POST /api/identities is idempotent end-to-end and surfaces VALIDATION for bad input", async () => {
  const app = createApp(localCfg());
  const body = { displayName: "Hygiene Route", gitUsername: "hy-route", gitEmail: "hy-route@x.io" };

  const r1 = await app.request("/api/identities", J(body));
  expect(r1.status).toBe(201);
  const j1 = await r1.json();

  const r2 = await app.request("/api/identities", J(body));
  expect(r2.status).toBe(201);
  const j2 = await r2.json();
  expect(j2.identity.id).toBe(j1.identity.id); // same row, not a new one

  const bad = await app.request(
    "/api/identities",
    J({ displayName: "Bad Email", gitUsername: "bad", gitEmail: "not-an-email" }),
  );
  expect(bad.status).toBe(400);
  const badBody = await bad.json();
  expect(badBody.code).toBe("VALIDATION");
});

test("updateIdentity rejects a collision with a DIFFERENT identity's natural key", () => {
  const idA = createIdentity({ displayName: "Hygiene D1", gitUsername: "hy-d1", gitEmail: "hy-d1@x.io" });
  const idB = createIdentity({ displayName: "Hygiene D2", gitUsername: "hy-d2", gitEmail: "hy-d2@x.io" });

  const applied = updateIdentity(idB, { displayName: "Hygiene D1", gitUsername: "hy-d1", gitEmail: "hy-d1@x.io" });
  expect(applied).toBe(false);
  expect(getIdentity(idB)?.displayName).toBe("Hygiene D2"); // unchanged

  // Editing a row to match ITS OWN current key is fine (a no-op change).
  expect(updateIdentity(idA, { displayName: "Hygiene D1" })).toBe(true);
});

test("updateIdentity rejects blanking the name or setting a malformed email", () => {
  const id = createIdentity({ displayName: "Hygiene E", gitUsername: "hy-e", gitEmail: "hy-e@x.io" });
  expect(() => updateIdentity(id, { displayName: "   " })).toThrow(IdentityValidationError);
  expect(() => updateIdentity(id, { gitEmail: "nope" })).toThrow(IdentityValidationError);
  expect(getIdentity(id)?.displayName).toBe("Hygiene E"); // unchanged
});

// ── the identities_natkey unique index backstop ──────────────────────────────────────────

test("identities_natkey unique index rejects a raw duplicate INSERT that bypasses createIdentity", async () => {
  // Force initDb() to have run at least once in this process (every other test already does,
  // but be explicit) so the module-singleton handle + its unique index definitely exist.
  createIdentity({ displayName: "Hygiene Index Probe", gitUsername: "hy-idx", gitEmail: "hy-idx@x.io" });
  const { initDb } = await import("../src/db.ts");
  const handle = initDb();

  // Same natural key as the row createIdentity just made (case/whitespace-insensitively). A raw
  // INSERT bypasses createIdentity's idempotency check entirely, so this must fail on the unique
  // index itself, proving the backstop holds even if application code forgets to check first.
  expect(() =>
    handle
      .query(`INSERT INTO identities (id, display_name, git_username, git_email) VALUES (?, ?, ?, ?)`)
      .run("raw-1", " hygiene index probe ", " HY-IDX ", " HY-IDX@X.IO "),
  ).toThrow();
});

// ── mergeDuplicateIdentities: the one-time merge migration ───────────────────────────────

/** A fresh scratch DB with the same identities/repos/account_identities shape as db.ts's
 *  initDb(), but WITHOUT the merge or the unique index having run yet: exactly what a
 *  pre-existing polluted database looks like right before the fixed daemon's next boot. */
function scratchPreMigrationDb(): Database {
  const dir = mkScratchDir("repoyeti-hygiene-scratch-");
  const handle = new Database(join(dir, "scratch.db"), { create: true });
  handle.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY, abs_path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      identity_id TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE identities (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, git_username TEXT NOT NULL,
      git_email TEXT NOT NULL, ssh_key_path TEXT
    );
    CREATE TABLE account_identities (
      host TEXT NOT NULL, login TEXT NOT NULL, identity_id TEXT NOT NULL,
      PRIMARY KEY (host, login)
    );
  `);
  return handle;
}

test("mergeDuplicateIdentities collapses seeded duplicates, keeping the oldest row", () => {
  const handle = scratchPreMigrationDb();
  const insert = handle.query(
    `INSERT INTO identities (id, display_name, git_username, git_email) VALUES (?, ?, ?, ?)`,
  );
  // Mirrors the owner's live pattern: "Required" x8 (identical git_username/email), plus one
  // unrelated singleton that must survive untouched.
  insert.run("req-1-oldest", "Required", "req", "req@x.io");
  for (let i = 2; i <= 8; i++) insert.run(`req-${i}`, "Required", "req", "req@x.io");
  insert.run("solo-1", "Solo", "solo", "solo@x.io");

  const summary = mergeDuplicateIdentities(handle);
  expect(summary.mergedCount).toBe(7); // 8 duplicates → 1 survivor + 7 merged away

  const remaining = handle.query(`SELECT id FROM identities ORDER BY id`).all() as { id: string }[];
  const ids = remaining.map((r) => r.id).sort();
  expect(ids).toEqual(["req-1-oldest", "solo-1"]); // oldest (lowest rowid) survives, solo untouched
  expect(summary.remap["req-5"]).toBe("req-1-oldest");
});

test("mergeDuplicateIdentities re-points repos.identity_id and account_identities.identity_id onto the survivor", () => {
  const handle = scratchPreMigrationDb();
  const insert = handle.query(
    `INSERT INTO identities (id, display_name, git_username, git_email) VALUES (?, ?, ?, ?)`,
  );
  insert.run("work-1-oldest", "Work", "workbot", "work@x.io");
  insert.run("work-2", "Work", "workbot", "work@x.io");
  insert.run("work-3", "Work", "workbot", "work@x.io");

  // Two DIFFERENT duplicates, each linked from a DIFFERENT account/repo: the edge case the merge
  // must handle without collision.
  handle
    .query(`INSERT INTO repos (id, abs_path, name, identity_id, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run("repo-1", "C:/r1", "r1", "work-2", Date.now());
  handle
    .query(`INSERT INTO account_identities (host, login, identity_id) VALUES (?, ?, ?)`)
    .run("github.com", "octo-work", "work-3");

  const summary = mergeDuplicateIdentities(handle);
  expect(summary.mergedCount).toBe(2);

  const repo = handle.query(`SELECT identity_id FROM repos WHERE id = ?`).get("repo-1") as {
    identity_id: string;
  };
  expect(repo.identity_id).toBe("work-1-oldest");

  const link = handle
    .query(`SELECT identity_id FROM account_identities WHERE host = ? AND login = ?`)
    .get("github.com", "octo-work") as { identity_id: string };
  expect(link.identity_id).toBe("work-1-oldest");
});

test("mergeDuplicateIdentities is a no-op (and idempotent) on a DB with no duplicates", () => {
  const handle = scratchPreMigrationDb();
  handle
    .query(`INSERT INTO identities (id, display_name, git_username, git_email) VALUES (?, ?, ?, ?)`)
    .run("only-1", "Only", "only", "only@x.io");

  const first = mergeDuplicateIdentities(handle);
  expect(first.mergedCount).toBe(0);
  const second = mergeDuplicateIdentities(handle);
  expect(second.mergedCount).toBe(0);
  expect((handle.query(`SELECT COUNT(*) AS n FROM identities`).get() as { n: number }).n).toBe(1);
});

// ── account/identity cascade stays correct after the hygiene changes ─────────────────────

test("deleting an identity still clears repo + account links after the hygiene changes", () => {
  const id = createIdentity({ displayName: "Hygiene Del", gitUsername: "hy-del", gitEmail: "hy-del@x.io" });
  const path = mkScratchDir("repoyeti-hygiene-repo-");
  const repoId = mustUpsertRepo(path, "hy-del-repo", "auto", false);
  setRepoIdentity(repoId, id);
  setAccountIdentity("github.com", "octo-hy-del", id);

  expect(getRepo(repoId)?.identityId).toBe(id);
  expect(getAccountIdentity("github.com", "octo-hy-del")).toBe(id);

  deleteIdentity(id);
  expect(getRepo(repoId)?.identityId).toBeNull();
  expect(getAccountIdentity("github.com", "octo-hy-del")).toBeNull();
});

// ── test-isolation hard guard ─────────────────────────────────────────────────────────────
//
// Exercised in a genuinely separate `bun` subprocess via a tiny helper script (rather than
// re-importing src/config.ts in-process, which already has REPOYETI_HOME set by tests/setup.ts
// and caches CONFIG_DIR as a module-level const at import time: a fresh process is the only way
// to observe the guard deciding based on a DIFFERENT env). NODE_ENV=test (what bun test always
// sets) with NO REPOYETI_HOME must throw before touching any real state. HOME/USERPROFILE are
// ALSO redirected to a throwaway dir first, so even if the guard failed to fire, the subprocess
// still could not reach the real ~/.repoyeti (belt and suspenders).
const GUARD_PROBE_SCRIPT = join(import.meta.dir, "helpers", "guard-probe.ts");

async function runGuardProbe(env: Record<string, string | undefined>): Promise<string> {
  // Use the exact runtime executing the suite. A PowerShell/npm Bun install exposes `bun.ps1`
  // to the shell but no bare `bun.exe` on PATH, so Bun.spawn(["bun", ...]) is not portable.
  const proc = Bun.spawn([process.execPath, GUARD_PROBE_SCRIPT], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  return out.trim() || err.trim();
}

test("test-isolation guard throws when NODE_ENV=test and REPOYETI_HOME is unset", async () => {
  const fakeHome = mkScratchDir("repoyeti-hygiene-fakehome-");
  const out = await runGuardProbe({
    NODE_ENV: "test",
    REPOYETI_HOME: undefined,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  });
  expect(out).toContain("THREW:");
  expect(out).toContain("Refusing to touch the real ~/.repoyeti");
});

test("test-isolation guard does NOT throw when REPOYETI_HOME is set (the isolated case)", async () => {
  const fakeHome = mkScratchDir("repoyeti-hygiene-fakehome2-");
  const out = await runGuardProbe({
    NODE_ENV: "test",
    REPOYETI_HOME: join(fakeHome, "isolated-repoyeti-home"),
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  });
  expect(out).toBe("NO_THROW");
});
