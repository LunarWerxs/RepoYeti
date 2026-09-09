/**
 * The database recovery boundary (1.0 audit, item 15).
 *
 * Three things had no cover and no owner-visible answer before this:
 *
 *   1. A migration that failed for a reason other than "already applied" was written to the
 *      console of a background process and nowhere else, so the daemon ran indefinitely with a
 *      column that does not exist. It is still deliberately non-fatal; it is no longer invisible.
 *   2. One unparsable cached status row failed the WHOLE repository list, because the parse had
 *      no guard. A cache row is the cheapest thing in the database to lose and it was taking the
 *      dashboard down with it.
 *   3. There was no way to ask "is this database healthy" and no way to take a snapshot of it
 *      that is actually consistent, which for a WAL database a file copy is not.
 */
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { getRepos, initDb, upsertRepo } from "../src/db.ts";
import {
  backupDatabase,
  migrateAddColumn,
  repairStatusCache,
  schemaHealth,
  verifyDatabase,
} from "../src/db/connection.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

/** Register a repo and then wreck its cached status blob, the way a torn write would. */
function repoWithCorruptStatus(): string {
  const absPath = resolve("/", `repoyeti-corrupt-status-${randomUUID()}`);
  const id = upsertRepo(absPath, "corrupt-status-repo", "created", false)!;
  expect(id).toBeTruthy();
  initDb().query(`UPDATE repos SET last_status = ? WHERE id = ?`).run('{"branch":"main"', id);
  return id;
}

test("one unparsable cached status costs that repo its status, not the whole list", () => {
  const id = repoWithCorruptStatus();

  // The load-bearing assertion: this used to throw out of JSON.parse and take every repository
  // with it, so the dashboard showed nothing at all over one stale cache row.
  const repos = getRepos();
  const mine = repos.find((r) => r.id === id);
  expect(mine).toBeDefined();
  expect(mine!.status).toBeNull(); // reads as "not scanned yet", which is exactly what it is
  expect(repos.length).toBeGreaterThan(0);

  // And it is counted, so the owner can find out on purpose rather than by noticing a gap.
  expect(verifyDatabase().corruptStatusRows).toBeGreaterThanOrEqual(1);
});

test("repairing the status cache clears exactly the rows that do not parse", () => {
  const id = repoWithCorruptStatus();
  const before = verifyDatabase().corruptStatusRows;
  expect(before).toBeGreaterThanOrEqual(1);

  const repaired = repairStatusCache();
  expect(repaired.cleared).toBe(before);
  expect(verifyDatabase().corruptStatusRows).toBe(0);
  expect(getRepos().find((r) => r.id === id)!.status).toBeNull();

  // Safe to repeat, because it only ever clears a cache the next refresh rewrites.
  expect(repairStatusCache().cleared).toBe(0);
});

test("verifyDatabase reports a structurally healthy database and changes nothing", () => {
  repairStatusCache(); // start from clean, so this asserts the healthy shape
  const report = verifyDatabase();

  expect(report.integrity).toEqual(["ok"]);
  expect(report.foreignKeyViolations).toBe(0);
  expect(report.journalMode.toLowerCase()).toBe("wal");
  expect(report.sizeBytes).toBeGreaterThan(0);
  expect(report.schema.recorded).toBeGreaterThan(0); // the ledger recorded the real migrations
  expect(report.ok).toBe(true);

  // Read-only: running it twice gives the same answer and leaves nothing behind.
  expect(verifyDatabase().ok).toBe(true);
});

test("a backup is a real SQLite snapshot, and never silently replaces an earlier one", () => {
  const stamp = `test-${randomUUID()}`;
  const first = backupDatabase(stamp);
  expect(first.ok).toBe(true);
  expect(existsSync(first.path!)).toBe(true);
  expect(first.sizeBytes).toBeGreaterThan(0);

  try {
    // The snapshot is a database in its own right, not a partial file copy: it opens and answers.
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const snapshot = new Database(first.path!, { readonly: true });
    const tables = snapshot
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    snapshot.close();
    expect(tables.map((t) => t.name)).toContain("repos");
    expect(tables.map((t) => t.name)).toContain("schema_migrations");

    // A second backup with the same name is refused rather than overwriting: a backup you can
    // silently replace is a backup you cannot go back through.
    const again = backupDatabase(stamp);
    expect(again.ok).toBe(false);
    expect(again.message).toContain("already exists");
  } finally {
    rmSync(first.path!, { force: true });
  }
});

test("a migration that fails for an unexpected reason is recorded, and the daemon still runs", () => {
  const handle = initDb();
  const bad = `ALTER TABLE no_such_table_${randomUUID().replace(/-/g, "")} ADD COLUMN x TEXT;`;
  try {
    // Deliberately NOT fatal - that posture is documented and intentional. What item 15 changed
    // is that it now leaves a trail instead of only a console line nobody reads.
    expect(() => migrateAddColumn(handle, bad)).not.toThrow();

    const health = schemaHealth();
    expect(health.ok).toBe(false);
    const row = health.failed.find((f) => f.id === bad);
    expect(row).toBeDefined();
    expect(row!.error).toContain("no such table");

    // And the database is still perfectly usable, which is the entire reason it is not fatal.
    expect(getRepos()).toBeDefined();
    expect(verifyDatabase().integrity).toEqual(["ok"]);
  } finally {
    handle.query(`DELETE FROM schema_migrations WHERE id = ?`).run(bad);
  }
  expect(schemaHealth().ok).toBe(true);
});

test("an already-applied migration is recorded as applied, not as a failure", () => {
  const handle = initDb();
  const sql = "ALTER TABLE repos ADD COLUMN vcs TEXT NOT NULL DEFAULT 'git';";
  // Every boot re-runs this against a database that already has the column. That is the normal
  // path, and it must not look like damage.
  migrateAddColumn(handle, sql);
  expect(schemaHealth().failed.some((f) => f.id === sql)).toBe(false);
});

test("the HTTP surface exposes verify, backup and repair as three separate verbs", async () => {
  const app = createApp(localCfg());

  const verified = await app.request("/api/db/verify");
  expect(verified.status).toBe(200);
  const report = (await verified.json()) as { ok: boolean; report: { integrity: string[] } };
  expect(report.report.integrity).toEqual(["ok"]);

  repoWithCorruptStatus();
  const repaired = await app.request("/api/db/repair-status-cache", { method: "POST" });
  expect(repaired.status).toBe(200);
  expect(((await repaired.json()) as { cleared: number }).cleared).toBeGreaterThanOrEqual(1);

  const backed = await app.request("/api/db/backup", { method: "POST" });
  expect(backed.status).toBe(200);
  const body = (await backed.json()) as { ok: boolean; path: string };
  expect(body.ok).toBe(true);
  try {
    expect(existsSync(body.path)).toBe(true);
  } finally {
    rmSync(body.path, { force: true });
  }
});
