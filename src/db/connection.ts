/**
 * The database connection, its migrations, and the owner's recovery tools (1.0 audit, items 15
 * and 27).
 *
 * WHY THIS IS ITS OWN MODULE. db.ts had grown to carry the connection, six data domains, and the
 * migration system in one file, so every feature that touched storage edited the same hotspot.
 * This is the first domain lifted out, and deliberately the one item 15 needs: opening the
 * database, changing its shape, and telling the owner whether either of those actually worked.
 *
 * WHAT ITEM 15 CHANGED, AND WHAT IT DELIBERATELY DID NOT.
 *
 * A failed `ALTER TABLE` is still NOT fatal. That posture is deliberate and was already
 * documented: a transient lock at boot (Windows antivirus holding the -wal) should not stop the
 * daemon from serving what it can, and a hard failure would turn a five-second annoyance into an
 * app that will not start. What was wrong is that the only trace was a console line in a process
 * nobody is watching, so the daemon ran indefinitely with a column that does not exist and threw
 * `no such column` from whatever request happened to touch it first, a long way from the cause.
 *
 * So every migration now writes a ledger row saying whether it worked, and there is a verb that
 * reads it. The daemon still starts; it just stops being the only thing that knows it is hurt.
 *
 * DIAGNOSIS AND REPAIR ARE SEPARATE VERBS, and stay separate. `verifyDatabase` reads and reports.
 * `backupDatabase` writes somewhere new and touches nothing. Anything that CHANGES stored data to
 * fix it is a different call the owner makes on purpose, after reading the first two. A recovery
 * tool that quietly repairs while it diagnoses is a tool nobody can safely run twice.
 *
 * THE BACKUP IS A SQLITE SNAPSHOT, NOT A FILE COPY. The database runs in WAL mode, so copying
 * repoyeti.db while the daemon is live captures a torn page set with the committed tail sitting
 * in a -wal file nobody copied. `VACUUM INTO` asks SQLite for a consistent snapshot of the whole
 * database as of one point in time, with no lock the daemon's own readers would notice.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, DB_PATH, ensureConfigDir } from "../config.ts";

let db: Database | null = null;
/** Set by db.ts, which owns the boot sequence (schema, then each domain's repairs). */
let bootstrap: (() => Database) | null = null;

/**
 * Register the full boot sequence. db.ts calls this at module load; it exists so the domain
 * modules can reach the connection without importing db.ts back and forming a cycle.
 */
export function registerBootstrap(fn: () => Database): void {
  bootstrap = fn;
}

/** The open handle, or null before the first initDb. */
export function currentDatabase(): Database | null {
  return db;
}

/** Publish the fully-migrated handle. Called once, at the END of the boot sequence, so nothing
 *  can read a half-built schema through getDb(). */
export function adoptDatabase(handle: Database): void {
  db = handle;
}

/** The handle every query goes through, opening the database on first use. */
export function getDb(): Database {
  if (db) return db;
  if (!bootstrap) {
    // Unreachable in the daemon (db.ts registers at import), and a clear message rather than a
    // null dereference if a future refactor ever imports a domain module in isolation.
    throw new Error("database bootstrap was never registered - import src/db.ts before querying");
  }
  return bootstrap();
}

// ── the migration ledger ──────────────────────────────────────────────────────────────────────

/** One recorded schema change: what was attempted, when, and whether it took. */
export interface SchemaMigrationRecord {
  id: string;
  appliedAt: number;
  ok: boolean;
  error: string | null;
}

/**
 * Create the ledger. Called FIRST, before any other table, so it can record everything after it -
 * including its own inability to record, which surfaces as the ledger simply being empty rather
 * than as a boot failure.
 */
export function createMigrationLedger(handle: Database): void {
  try {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        ok         INTEGER NOT NULL,
        error      TEXT
      );
    `);
  } catch (e) {
    console.error("[repoyeti] could not create the schema migration ledger:", e);
  }
}

function recordMigration(handle: Database, id: string, ok: boolean, error: string | null): void {
  try {
    handle
      .query(
        `INSERT INTO schema_migrations (id, applied_at, ok, error) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET applied_at = excluded.applied_at,
                                         ok = excluded.ok,
                                         error = excluded.error`,
      )
      .run(id, Date.now(), ok ? 1 : 0, error);
  } catch {
    // The ledger is the diagnostic, never the thing that stops a boot. A database too broken to
    // write this row will say so through PRAGMA integrity_check instead.
  }
}

/**
 * Run one `ALTER TABLE … ADD COLUMN` migration, tolerating only the ONE failure that is expected.
 *
 * These all used to be `try { … } catch { /* column already present *​/ }`, which is true almost
 * every time - and indistinguishable from the times it isn't. A locked database, a read-only
 * directory, or a full disk raises a completely different error and was swallowed just as
 * quietly, so the daemon booted "successfully" with a column that does not exist.
 *
 * Deliberately NOT fatal (see the module header). But it now says so in three places instead of
 * one: the console, the ledger row, and `schemaHealth()`, which the owner can actually read.
 */
export function migrateAddColumn(handle: Database, sql: string): void {
  try {
    handle.exec(sql);
    recordMigration(handle, sql, true, null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/duplicate column name/i.test(message)) {
      recordMigration(handle, sql, true, null); // already migrated - the normal path
      return;
    }
    console.error(`[repoyeti] schema migration failed: ${sql}\n           ${message}`);
    recordMigration(handle, sql, false, message);
  }
}

export interface SchemaHealth {
  /** True when no recorded migration is currently in a failed state. */
  ok: boolean;
  /** How many migrations the ledger knows about at all. */
  recorded: number;
  /** The ones that did not take. Each one is a column some request will fail on. */
  failed: SchemaMigrationRecord[];
}

/** What the migration ledger says about this database right now. */
export function schemaHealth(handle?: Database): SchemaHealth {
  const h = handle ?? getDb();
  try {
    const counted = h.query(`SELECT count(*) AS n FROM schema_migrations`).get() as { n: number };
    const rows = h
      .query(
        `SELECT id, applied_at, ok, error FROM schema_migrations WHERE ok = 0 ORDER BY applied_at DESC`,
      )
      .all() as Array<{ id: string; applied_at: number; ok: number; error: string | null }>;
    const failed = rows.map((r) => ({ id: r.id, appliedAt: r.applied_at, ok: false, error: r.error }));
    return { ok: failed.length === 0, recorded: counted.n, failed };
  } catch (e) {
    // No ledger at all is itself an answer, and a negative one: this build expects it to exist.
    return {
      ok: false,
      recorded: 0,
      failed: [
        {
          id: "schema_migrations",
          appliedAt: Date.now(),
          ok: false,
          error: `the migration ledger could not be read: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }
}

/** Say it once, loudly, at boot, when the schema is not what this build expects. */
export function reportSchemaHealth(handle: Database): SchemaHealth {
  const health = schemaHealth(handle);
  if (!health.ok) {
    console.error(
      `[repoyeti] ${health.failed.length} schema migration(s) did not apply. The daemon will run, ` +
        `but requests touching the missing columns will fail. Run "db verify" for the list.`,
    );
    for (const f of health.failed) console.error(`           ${f.id}\n             ${f.error ?? "unknown"}`);
  }
  return health;
}

// ── diagnosis ─────────────────────────────────────────────────────────────────────────────────

export interface DatabaseVerification {
  /** True when every check below passed. */
  ok: boolean;
  path: string;
  /** Bytes on disk, excluding the -wal and -shm sidecars. */
  sizeBytes: number;
  /** The journal mode actually in effect, which is not always the one that was asked for. */
  journalMode: string;
  /** SQLite's own structural check. "ok" is the single-row answer for a healthy file. */
  integrity: string[];
  /** Rows whose declared foreign key has no parent. Empty on a healthy database. */
  foreignKeyViolations: number;
  schema: SchemaHealth;
  /** Cached repository statuses that no longer parse as JSON. A cache, so this is recoverable. */
  corruptStatusRows: number;
}

/**
 * Read-only health check. Runs SQLite's own integrity verification, counts dangling foreign keys,
 * reads the migration ledger, and counts cache rows this build can no longer parse.
 *
 * Changes nothing. Everything it finds that IS fixable is fixed by a separate, explicit call.
 */
export function verifyDatabase(handle?: Database): DatabaseVerification {
  const h = handle ?? getDb();
  const integrity: string[] = [];
  let journalMode = "unknown";
  let foreignKeyViolations = 0;
  let corruptStatusRows = 0;

  try {
    const rows = h.query(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>;
    for (const r of rows) if (r.integrity_check) integrity.push(r.integrity_check);
  } catch (e) {
    integrity.push(`integrity_check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    journalMode = String(
      (h.query(`PRAGMA journal_mode`).get() as { journal_mode?: string } | null)?.journal_mode ?? "unknown",
    );
  } catch {
    /* diagnostic only */
  }
  try {
    foreignKeyViolations = (h.query(`PRAGMA foreign_key_check`).all() as unknown[]).length;
  } catch {
    /* diagnostic only */
  }
  try {
    // The status blob is a CACHE of what git last reported, so a row that no longer parses costs
    // nothing to discard and is worth counting: before item 15 one such row failed the WHOLE
    // repository list, because toView parsed it with no guard.
    const rows = h.query(`SELECT last_status FROM repos WHERE last_status IS NOT NULL`).all() as Array<{
      last_status: string;
    }>;
    for (const r of rows) {
      try {
        JSON.parse(r.last_status);
      } catch {
        corruptStatusRows++;
      }
    }
  } catch {
    /* diagnostic only */
  }

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(DB_PATH).size;
  } catch {
    /* a database that has never been written has no file yet */
  }

  const schema = schemaHealth(h);
  const structurallyOk = integrity.length === 1 && integrity[0] === "ok";
  return {
    ok: structurallyOk && foreignKeyViolations === 0 && schema.ok && corruptStatusRows === 0,
    path: DB_PATH,
    sizeBytes,
    journalMode,
    integrity,
    foreignKeyViolations,
    schema,
    corruptStatusRows,
  };
}

// ── backup ────────────────────────────────────────────────────────────────────────────────────

export interface DatabaseBackupResult {
  ok: boolean;
  code: "OK" | "ERROR";
  message?: string;
  path?: string;
  sizeBytes?: number;
}

/** Where snapshots land by default: beside the database, in a directory of their own. */
export function backupDir(): string {
  return join(CONFIG_DIR, "backups");
}

/**
 * Take a consistent snapshot of the database.
 *
 * `VACUUM INTO` is the whole point (see the module header): it is SQLite writing a complete,
 * internally consistent copy as of one moment, which a file copy of a live WAL database is not.
 * It also compacts, so the snapshot is usually smaller than the original.
 *
 * `stamp` is passed in rather than read from the clock here so the caller owns the file name and
 * the tests are deterministic.
 */
export function backupDatabase(stamp: string, handle?: Database): DatabaseBackupResult {
  const h = handle ?? getDb();
  try {
    ensureConfigDir();
    const dir = backupDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe = stamp.replace(/[^0-9A-Za-z._-]/g, "-");
    const dest = join(dir, `repoyeti-${safe}.db`);
    if (existsSync(dest)) {
      // VACUUM INTO refuses to overwrite, and that refusal is correct: a backup that silently
      // replaces an earlier one is a backup you cannot go back through.
      return { ok: false, code: "ERROR", message: `a backup already exists at ${dest}` };
    }
    // Bun's sqlite binds parameters for VACUUM INTO fine, and binding is what keeps a path with a
    // quote in it from being a SQL problem.
    h.query(`VACUUM INTO ?`).run(dest);
    return { ok: true, code: "OK", path: dest, sizeBytes: statSync(dest).size };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

// ── repair (explicit, and separate from everything above) ─────────────────────────────────────

export interface StatusCacheRepair {
  /** Rows whose cached status could not be parsed and was cleared. */
  cleared: number;
}

/**
 * Clear cached repository statuses that no longer parse.
 *
 * Safe to run and safe to run twice: `last_status` is a cache of what git last reported, and the
 * next status refresh rewrites it. This is the one repair item 15 adds, and it is a separate verb
 * from `verifyDatabase` on purpose - the owner reads first, then decides.
 */
export function repairStatusCache(handle?: Database): StatusCacheRepair {
  const h = handle ?? getDb();
  const bad: string[] = [];
  const rows = h.query(`SELECT id, last_status FROM repos WHERE last_status IS NOT NULL`).all() as Array<{
    id: string;
    last_status: string;
  }>;
  for (const r of rows) {
    try {
      JSON.parse(r.last_status);
    } catch {
      bad.push(r.id);
    }
  }
  if (bad.length === 0) return { cleared: 0 };
  const clear = h.query(`UPDATE repos SET last_status = NULL WHERE id = ?`);
  const tx = h.transaction((ids: string[]) => {
    for (const id of ids) clear.run(id);
  });
  tx(bad);
  return { cleared: bad.length };
}
