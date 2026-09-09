/**
 * SQLite state (bun:sqlite). One file at ~/.repoyeti/repoyeti.db.
 *
 * WAL mode + NORMAL sync is what lets the watcher, the API, and git operations
 * write concurrently without corrupting a flat file. The full schema is created
 * up front; Phase 1 only exercises `repos`. Secrets never land here — only key
 * *paths* and (later) keychain *handles*.
 */
import { Database } from "bun:sqlite";
import { DB_PATH, ensureConfigDir } from "./config.ts";
import {
  parseCachedStatus,
  toView,
  type Identity,
  type IdentityInput,
  type RepoRow,
  type RepoSource,
  type RepoStatus,
  type RepoView,
} from "./db/types.ts";
import { natKey } from "./db/identities.ts";
import { markInterruptedAutomationRuns } from "./db/automation.ts";

// ── the facade ────────────────────────────────────────────────────────────────────────────────
// Every consumer imports "src/db.ts" by that literal path (44 source files and 36 test files at
// the time of writing), so the domain split (1.0 audit, item 27) keeps this module as the single
// public surface and re-exports each domain through it. Nothing outside src/db/ needs to know
// which file a symbol now lives in, and not one call site had to change to move one.
//
// What has moved so far: the connection, its migrations and the recovery tools (item 15); the
// shared row/view types; the three leaf repository reads; shares and collaboration; automation
// incidents and run history. What has NOT: the repository writes, identities, and the operational
// error log, which stay here because they are entangled by real transactions rather than by file
// position - forgetRepo alone deletes across five tables in one transaction, and splitting it
// would trade a tidy file listing for a merge that can half-apply.
export type { Identity, IdentityInput, RepoRow, RepoSource, RepoStatus, RepoView };
export { parseCachedStatus, toView };
export { getRepo, getRepos, getWatchableRepos } from "./db/repos-read.ts";
export * from "./db/repos.ts";
export * from "./db/errors.ts";
export * from "./db/identities.ts";
export * from "./db/shares.ts";
export * from "./db/automation.ts";
export {
  backupDatabase,
  backupDir,
  repairStatusCache,
  schemaHealth,
  verifyDatabase,
  type DatabaseBackupResult,
  type DatabaseVerification,
  type SchemaHealth,
  type SchemaMigrationRecord,
  type StatusCacheRepair,
} from "./db/connection.ts";

import {
  adoptDatabase,
  createMigrationLedger,
  currentDatabase,
  migrateAddColumn,
  registerBootstrap,
  reportSchemaHealth,
} from "./db/connection.ts";
import { isUnderTempDir } from "./paths.ts";

export function initDb(): Database {
  const open = currentDatabase();
  if (open) return open;
  ensureConfigDir();
  const handle = new Database(DB_PATH, { create: true });
  // First, before any other table, so every migration below leaves a record of whether it took
  // (1.0 audit, item 15). See src/db/connection.ts for why a failure here is still not fatal.
  createMigrationLedger(handle);
  // WAL + retry posture (Windows AV can briefly lock the -wal file).
  //
  // `PRAGMA journal_mode` mostly does NOT throw when it can't honour the request — it is a
  // query that RETURNS the mode actually in effect, so a try/catch alone proves nothing. The
  // header above stakes the watcher/API/git-ops concurrency story on WAL being on, so read the
  // answer back and say so out loud when it isn't, rather than running in a different mode with
  // no trace anywhere.
  try {
    handle.exec("PRAGMA journal_mode = WAL;");
  } catch {
    handle.exec("PRAGMA journal_mode = DELETE;");
  }
  try {
    const mode = String(
      (handle.query("PRAGMA journal_mode;").get() as { journal_mode?: string } | null)?.journal_mode ?? "",
    ).toLowerCase();
    if (mode !== "wal") {
      console.warn(
        `[repoyeti] SQLite is in "${mode || "unknown"}" journal mode, not WAL — concurrent reads and writes ` +
          `will contend. This is usually a network/synced folder or antivirus holding the -wal file.`,
      );
    }
  } catch {
    /* the read-back is diagnostic only; never let it stop the daemon from opening the DB */
  }
  handle.exec("PRAGMA synchronous = NORMAL;");
  handle.exec("PRAGMA busy_timeout = 5000;");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id            TEXT PRIMARY KEY,
      abs_path      TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'auto',
      vcs           TEXT NOT NULL DEFAULT 'git',
      identity_id   TEXT,
      is_submodule  INTEGER NOT NULL DEFAULT 0,
      hidden        INTEGER NOT NULL DEFAULT 0,
      pinned        INTEGER NOT NULL DEFAULT 0,
      starred       INTEGER NOT NULL DEFAULT 0,
      auto_commit   INTEGER NOT NULL DEFAULT 0,
      last_status   TEXT,
      sort_order    INTEGER,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identities (
      id             TEXT PRIMARY KEY,
      display_name   TEXT NOT NULL,
      git_username   TEXT NOT NULL,
      git_email      TEXT NOT NULL,
      ssh_key_path   TEXT,
      pat_handle     TEXT,
      signing_handle TEXT
    );
    -- Optional link from a machine GitHub account (gh host+login) to a saved commit identity.
    -- When the active account is switched to (host, login), the daemon also sets the global git
    -- author to that identity's name/email (see gh-cli.ts). Absent row = don't touch the author.
    CREATE TABLE IF NOT EXISTS account_identities (
      host        TEXT NOT NULL,
      login       TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      PRIMARY KEY (host, login)
    );
    -- Auth uses stateless, HMAC-signed cookies (see auth.ts) — there is no session row
    -- to store or revoke, so there is intentionally NO \`sessions\` table.
    --
    -- Share links (src/share/) are the ONE deliberate exception to that stateless posture, and
    -- the reason is revocation. An owner session is the owner's own cookie on the owner's own
    -- device; "sign out everywhere" rotates the signing key and is a fine blunt instrument. A
    -- share link is a credential held by SOMEONE ELSE, so "revoke this one link, right now,
    -- without touching my other links or my own session" is a hard requirement — and that is
    -- exactly what a stateless signed token cannot do. Hence rows: every guest request re-reads
    -- its share here, so revoking is a single UPDATE that takes effect on the next request.
    --
    -- token_hash is the ONLY value redemption consults. The plaintext is also retained in the
    -- migrated \`token\` column below so the owner can copy an existing link; that deliberately
    -- makes a database copy bearer-sensitive (see Share.token for the full tradeoff).
    CREATE TABLE IF NOT EXISTS shares (
      id            TEXT PRIMARY KEY,
      token_hash    TEXT NOT NULL UNIQUE,     -- sha256(secret) hex — never the secret itself
      label         TEXT NOT NULL,            -- owner's name for the link ("Brother — nights")
      perm          TEXT NOT NULL,            -- 'view' | 'control'
      collaborative INTEGER NOT NULL DEFAULT 0, -- holder may pair a second RepoYeti working tree
      scope_all     INTEGER NOT NULL DEFAULT 0, -- 1 = every repo, including ones added later
      created_at    INTEGER NOT NULL,         -- ms
      expires_at    INTEGER,                  -- ms; NULL = never expires
      revoked_at    INTEGER,                  -- ms; NULL = still live
      last_used_at  INTEGER,                  -- ms; NULL = never redeemed
      use_count     INTEGER NOT NULL DEFAULT 0
    );
    -- Which repos a share exposes. Ignored (and not required) when scope_all = 1.
    -- No REFERENCES clause on purpose: SQLite enforces foreign keys only under
    -- PRAGMA foreign_keys = ON, which this daemon does not set, so a REFERENCES here would be
    -- decoration that reads as a guarantee. Dangling grants are instead made harmless by
    -- construction — every read of this table INNER JOINs repos (see shareRepoIds /
    -- getSharedRepos), so a grant naming a removed repo resolves to nothing, and repo ids are
    -- UUIDs, so an id is never recycled into a different repo later.
    CREATE TABLE IF NOT EXISTS share_repos (
      share_id  TEXT NOT NULL,
      repo_id   TEXT NOT NULL,
      PRIMARY KEY (share_id, repo_id)
    );
    -- Audit trail: what a guest actually DID on the owner's machine. A control link can commit
    -- and push as the owner's own git identity (an explicit owner decision — it's the owner's
    -- tree, the guest is just syncing it), which means the git history alone cannot answer "did
    -- my brother push this, or did I?". This table is the only place that can, so it is written
    -- for every guest-attempted mutation, allowed or denied.
    CREATE TABLE IF NOT EXISTS share_events (
      id         TEXT PRIMARY KEY,
      share_id   TEXT NOT NULL,               -- NOT a FK: the audit trail must outlive the share
      at         INTEGER NOT NULL,            -- ms
      action     TEXT NOT NULL,               -- "METHOD /api/path" as attempted
      repo_id    TEXT,                        -- when the action targeted one repo
      outcome    TEXT NOT NULL                -- 'allowed' | 'denied'
    );
    CREATE INDEX IF NOT EXISTS share_events_share ON share_events (share_id, at DESC);
    -- Outbound peer mappings. A collaborator pastes an invitation into THEIR RepoYeti and maps
    -- one local repo to one repo named by the share. The share token is retained here for the same
    -- reason it is retained on the owner's share row: it is the end-to-end encryption key and the
    -- invitation credential. This table never syncs through Connections.
    CREATE TABLE IF NOT EXISTS collaboration_links (
      id              TEXT PRIMARY KEY,
      invite_url      TEXT NOT NULL,
      token           TEXT NOT NULL,
      relay_url       TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      remote_origin   TEXT NOT NULL,
      daemon_id       TEXT,
      participant_id  TEXT NOT NULL,
      local_repo_id   TEXT NOT NULL,
      remote_repo_id  TEXT NOT NULL,
      label           TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1
    );
    -- Immutable per-commit diff statistics used by the History activity chart. Live Git metadata
    -- still decides reachability, author identity, and calendar membership on every request; this
    -- table only saves re-diffing a full object hash that was already measured for this repo.
    CREATE TABLE IF NOT EXISTS git_commit_stats (
      repo_id        TEXT NOT NULL,
      commit_hash    TEXT NOT NULL,
      committed_at   INTEGER NOT NULL,
      files_changed  INTEGER NOT NULL CHECK (files_changed >= 0),
      added_lines    INTEGER NOT NULL CHECK (added_lines >= 0),
      removed_lines  INTEGER NOT NULL CHECK (removed_lines >= 0),
      stat_version   INTEGER NOT NULL,
      cached_at      INTEGER NOT NULL,
      PRIMARY KEY (repo_id, commit_hash)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS git_commit_stats_repo_date
      ON git_commit_stats (repo_id, committed_at);
  `);
  // Migrations: add columns to pre-existing databases. Each raises "duplicate column name" on a
  // DB that already has it (including every fresh one), which migrateAddColumn treats as the
  // normal path — and ONLY that error; anything else is reported rather than swallowed.
  // Which public origin a share link's URL was built against, so the Sharing panel can spot a
  // link whose address no longer exists (a quick tunnel re-hosts itself on every restart).
  migrateAddColumn(handle, "ALTER TABLE shares ADD COLUMN origin TEXT;");
  // The link's own secret, retained so the Sharing panel can offer "Copy link" on a share it
  // minted earlier rather than only in the one-shot panel at creation. See the `token` field on
  // Share for what this costs and why it is nonetheless the owner's call.
  migrateAddColumn(handle, "ALTER TABLE shares ADD COLUMN token TEXT;");
  // Early collaboration builds persisted the full invitation URL even though every durable
  // operation uses the separately stored token/origin fields. The URL embeds the same bearer
  // secret, so retaining it only duplicated the credential in database backups.
  handle.exec("UPDATE collaboration_links SET invite_url = '' WHERE invite_url <> '';");
  // Existing links stay ordinary links. New links opt into peer working-tree synchronization
  // explicitly (the UI defaults the new control on, but migration never widens an old grant).
  migrateAddColumn(handle, "ALTER TABLE shares ADD COLUMN collaborative INTEGER NOT NULL DEFAULT 0;");
  // Collaboration originally prototyped the hosted relay as a high-frequency mailbox. Presence
  // now goes straight to the owner's daemon; retain the resolved origin so publishes avoid a
  // relay request unless the quick tunnel has actually moved.
  migrateAddColumn(handle, "ALTER TABLE collaboration_links ADD COLUMN remote_origin TEXT NOT NULL DEFAULT '';");
  // Present only for invitations using app.repoyeti.com/r/:id. It lets a failed direct publish
  // re-resolve the owner's new quick-tunnel origin.
  migrateAddColumn(handle, "ALTER TABLE collaboration_links ADD COLUMN daemon_id TEXT;");
  migrateAddColumn(handle, "ALTER TABLE repos ADD COLUMN sort_order INTEGER;");
  migrateAddColumn(handle, "ALTER TABLE repos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;");
  migrateAddColumn(handle, "ALTER TABLE repos ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;");
  migrateAddColumn(handle, "ALTER TABLE repos ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;");
  migrateAddColumn(handle, "ALTER TABLE repos ADD COLUMN vcs TEXT NOT NULL DEFAULT 'git';");
  // Repo-level GitHub "sync account" (host + login) — the account fetch/pull/push authenticates as.
  migrateAddColumn(handle, "ALTER TABLE repos ADD COLUMN sync_account_host TEXT;");
  migrateAddColumn(handle, "ALTER TABLE repos ADD COLUMN sync_account_login TEXT;");
  // Per-repo opt-in for the auto-commit timer (src/auto-commit.ts).
  migrateAddColumn(handle, "ALTER TABLE repos ADD COLUMN auto_commit INTEGER NOT NULL DEFAULT 0;");
  // Owner-chosen display label (Rename). NULL = fall back to `name` (the folder basename).
  // It is a SEPARATE column on purpose: `upsertRepo` overwrites `name` from the basename on every
  // scan, so a label stored there would silently revert on the next rescan. Renaming NEVER touches
  // the folder on disk — this is a label, not a move.
  migrateAddColumn(handle, "ALTER TABLE repos ADD COLUMN display_name TEXT;");
  // Paths the owner explicitly removed from RepoYeti ("don't show me this again").
  //
  // Without this, "Remove" is a lie for any auto-discovered repo: the row is deleted, the next
  // scan walks the same folder, `upsertRepo` re-inserts it, and it reappears — the exact
  // "there's no button to do it" complaint, just moved one step later. So removal writes a
  // tombstone here and `upsertRepo` refuses to re-import a tombstoned path, the same
  // choke-point shape as the temp-dir guard. Undoable from Settings → Removed repos.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS ignored_paths (
      abs_path   TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      ignored_at INTEGER NOT NULL
    );
  `);
  // Grouped operational-error history (adapted from PostHog's issue-fingerprint grouping,
  // products/error_tracking/ - MIT). runAction (service/core.ts) is the single funnel every
  // mutating git action goes through; on failure it computes a fingerprint from repo + op + code
  // and upserts here instead of the daemon just logging to stderr and moving on. Without this an
  // owner sees only the CURRENT health/status - a fetch that has failed 6 times in a row reads
  // identically to one that failed once just now. `fingerprint` is a short hash (see
  // operationalErrorFingerprint below), not the raw "repoId:op:code" string, so it stays a clean
  // opaque path segment for the DELETE/mute routes.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS operational_errors (
      fingerprint   TEXT PRIMARY KEY,
      repo_id       TEXT NOT NULL,
      repo_name     TEXT NOT NULL,
      op            TEXT NOT NULL,
      code          TEXT NOT NULL,
      message       TEXT NOT NULL,
      occurrences   INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      muted         INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS operational_errors_last_seen ON operational_errors (last_seen_at);
  `);
  // Persisted counterpart to the repo_auto_commit_blocked / repo_auto_committed SSE broadcasts
  // (src/auto-commit.ts) — those reach only whoever happens to be connected to the dashboard at
  // the exact moment the timer fires. Without this table a skipped or partially-synced repo was
  // reviewable only by having been staring at the dashboard when it happened; this survives past
  // that so the owner can come back later and see what the unattended timer actually did.
  //
  // No REFERENCES on repo_id, same reasoning as share_events above: a repo can be removed or
  // renamed after the incident happened, and the historic row must not go dangling or blank.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS auto_commit_incidents (
      id         TEXT PRIMARY KEY,
      repo_id    TEXT NOT NULL,
      repo_name  TEXT NOT NULL,
      at         INTEGER NOT NULL,
      reason     TEXT NOT NULL,
      acked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS auto_commit_incidents_at ON auto_commit_incidents (at DESC);
  `);
  // Durable automation run history (1.0 audit, item 23). A DIFFERENT model from the incidents
  // table above, and the distinction is the whole point of having two.
  //
  //   auto_commit_incidents answers "what is WRONG right now": one row per open (repo, reason)
  //   problem, upserted while it persists, acknowledged by the owner and then closed. Its 500-row
  //   cap is sized for anomalies.
  //
  //   automation_runs answers "what HAPPENED while I was away": one row per round of a scheduled
  //   loop, with when it ran, why it started, how long it took, how it ended, and a child row per
  //   repository it actually did something to. These accrue on every tick whether or not anything
  //   is wrong, which is why they get their own, much smaller-per-row table and their own cap
  //   rather than being forced into the incidents model. Forcing success into an "incident" would
  //   also have destroyed the badge the incidents table exists to feed.
  //
  // A run row is IN FLIGHT while `outcome` is NULL. `ended_at` is only ever set by the process
  // that finished the run, so a run whose daemon was killed keeps a NULL `ended_at` forever and
  // is marked `interrupted` by markInterruptedAutomationRuns() on the next boot: an honest "we
  // never saw this end", rather than a fabricated end time hours after the fact.
  //
  // No REFERENCES on repo_id, same reasoning as share_events and the incidents table above.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER,
      outcome       TEXT,
      repos_total   INTEGER NOT NULL DEFAULT 0,
      repos_done    INTEGER NOT NULL DEFAULT 0,
      repos_blocked INTEGER NOT NULL DEFAULT 0,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_runs_started ON automation_runs (started_at DESC);
    CREATE TABLE IF NOT EXISTS automation_run_repos (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      repo_id     TEXT NOT NULL,
      repo_name   TEXT NOT NULL,
      at          INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      outcome     TEXT NOT NULL,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_run_repos_run ON automation_run_repos (run_id);
  `);
  // Dedup any pre-existing duplicate open (repo_id, reason) rows BEFORE the unique index below can
  // be created (a DB written by an earlier, pre-dedup build of this feature could already have more
  // than one unacked row for the same repo+reason), keep the newest by rowid, drop the rest. Same
  // merge-then-guard order as mergeDuplicateIdentities below: the index creation fails outright on
  // a table that still has duplicates, so the cleanup must run first, every boot, before it.
  handle.exec(`
    DELETE FROM auto_commit_incidents
    WHERE acked_at IS NULL
      AND rowid NOT IN (
        SELECT MAX(rowid) FROM auto_commit_incidents WHERE acked_at IS NULL GROUP BY repo_id, reason
      );
    -- A repo stuck in the same failure mode (e.g. an unresolved CONFLICT) ticks forever, and
    -- without this the shared 500-row cap belongs to whichever repo is currently noisiest,
    -- evicting every OTHER repo's incidents the owner never acknowledged. Partial (only while
    -- unacked) so a fresh occurrence AFTER an ack is a new, separately-reviewable incident, not a
    -- silent bump of the row the owner already dismissed. See recordAutoCommitIncident's upsert.
    CREATE UNIQUE INDEX IF NOT EXISTS auto_commit_incidents_open_repo_reason
      ON auto_commit_incidents (repo_id, reason) WHERE acked_at IS NULL;
  `);
  // Any run still marked in-flight belongs to a previous process: this one has not started a
  // round yet (the loops are armed from lifecycle.ts, long after the database is opened), so an
  // unfinished row can only mean the daemon went away mid-round. Close them honestly before
  // anything can read them, so "is a run in flight" never answers yes for a dead one.
  markInterruptedAutomationRuns(handle);
  // Repair any temp-path repo rows already sitting in a pre-existing DB (historic test-fixture
  // writes and old whole-machine scans indexed under the OS temp dir, e.g. `%TEMP%\gm-*`, before
  // upsertRepo's hard guard existed). Same prevention-first shape as the identity merge below:
  // clean up what's already there, THEN the choke-point guard (upsertRepo) stops it recurring.
  pruneTempRepos(handle);
  // One-time merge of any duplicate identities already sitting in a pre-existing DB (the
  // test-isolation-gap fixture garbage, "Required" x8 etc.), THEN the unique index that makes
  // new accumulation impossible. Order matters: the index creation would fail on a DB that still
  // has duplicates, so the merge must run first, every boot, before it.
  lastIdentityMergeSummary = mergeDuplicateIdentities(handle);
  try {
    handle.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS identities_natkey ON identities " +
        "(lower(trim(display_name)), lower(trim(git_username)), lower(trim(git_email)));",
    );
  } catch (e) {
    // Should be unreachable (the merge above just ran), but never block daemon boot over it;
    // surface it loudly instead of throwing out of initDb().
    console.error("[repoyeti] failed to create identities_natkey unique index:", e);
  }
  // Say once, loudly, if the schema this build expects is not the schema it got.
  reportSchemaHealth(handle);
  // Published LAST: nothing can read a half-built schema through getDb().
  adoptDatabase(handle);
  return handle;
}

// The connection module owns the handle but not the boot sequence, which needs every domain's
// repairs. This is the one link back, and it is a registration rather than an import so the
// domain modules can reach getDb() without importing this file and forming a cycle.
registerBootstrap(initDb);

/**
 * Delete every existing repo row whose absolute path is under the OS temp directory (see
 * `isUnderTempDir` in src/paths.ts). Repairs a pre-existing DB that accumulated temp-path rows
 * before `upsertRepo`'s hard guard existed (historic test-fixture writes and old whole-machine
 * scans indexed things like `%TEMP%\gm-*`); the guard stops it happening again, this cleans up
 * what already landed.
 *
 * SQLite can't compute `os.tmpdir()`/env-var containment itself, so this reads every row, filters
 * in JS, then deletes the matches by id inside one transaction: same pattern as
 * `mergeDuplicateIdentities`. Deletes EVEN IF the folder still exists on disk (unlike
 * `cleanupMissingRepos`, which is existence-based); a temp-path repo is unwanted regardless of
 * whether it's still there. Runs before the boot watch-hydrate (see initDb / cli/lifecycle.ts), so
 * no SSE broadcast or unwatch is needed here: no clients are connected yet, and the watch list is
 * built afterward from `getWatchableRepos()`, which simply won't include the deleted rows.
 *
 * Idempotent: a DB with no temp-path rows deletes nothing and logs nothing. Exported (in addition
 * to being called from initDb()) so tests can exercise it directly against a scratch `Database`,
 * the same way tests/identity-hygiene.test.ts exercises mergeDuplicateIdentities.
 */
export function pruneTempRepos(handle: Database): number {
  const rows = handle.query(`SELECT id, abs_path FROM repos`).all() as Array<{
    id: string;
    abs_path: string;
  }>;
  const victims = rows.filter((r) => isUnderTempDir(r.abs_path));
  if (victims.length === 0) return 0;

  const stmt = handle.query(`DELETE FROM repos WHERE id = ?`);
  // `pruneTempRepos` is also used as a pre-migration repair helper against minimal legacy DBs.
  const hasStatsTable = Boolean(
    handle
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'git_commit_stats' LIMIT 1`,
      )
      .get(),
  );
  const clearStats = hasStatsTable
    ? handle.query(`DELETE FROM git_commit_stats WHERE repo_id = ?`)
    : null;
  const tx = handle.transaction((xs: typeof victims) => {
    for (const v of xs) {
      clearStats?.run(v.id);
      stmt.run(v.id);
    }
  });
  tx(victims);

  console.log(`[repoyeti] repos: removed ${victims.length} temp-path row(s)`);
  return victims.length;
}

/** id to id remap produced by the last mergeDuplicateIdentities() run (empty until initDb() has
 *  run at least once). Read by the daemon boot sequence (src/cli/lifecycle.ts) to also repoint
 *  config.json's identityRules[].requiredIdentityId, those live outside this SQLite file. */
let lastIdentityMergeSummary: IdentityMergeSummary = { mergedCount: 0, remap: {} };

export function getLastIdentityMergeSummary(): IdentityMergeSummary {
  return lastIdentityMergeSummary;
}

export interface IdentityMergeSummary {
  /** How many duplicate rows were deleted (i.e. total rows merged away, across all groups). */
  mergedCount: number;
  /** Every merged-away identity id → the surviving identity id it was folded into. */
  remap: Record<string, string>;
}

/**
 * Merge existing duplicate identities by normalized natural key (case-insensitively trimmed
 * display name + git username + git email, same definition as natKey/createIdentity's
 * idempotency check and the identities_natkey index). For each group of duplicates: keep the
 * OLDEST row (lowest SQLite rowid; identities.id is a random UUID, not time-ordered, but rowid
 * increases with insertion order for an ordinary rowid table like this one), re-point every
 * reference to a merged-away id onto the survivor, then delete the losers.
 *
 * References repointed (searched the full schema for every place an identity id is stored):
 *   - repos.identity_id            (a repo's identity override)
 *   - account_identities.identity_id (a GitHub account to commit-identity link)
 * config.json's identityRules[].requiredIdentityId is NOT a SQLite reference; src/cli/lifecycle.ts
 * applies this function's `remap` to that separately at boot, right after initDb().
 *
 * Idempotent and safe to run on every boot: a DB with no duplicates (the common case after the
 * first merge, and every fresh install) does nothing and logs nothing.
 *
 * Exported (in addition to being called from initDb()) so tests can exercise it directly against
 * a scratch `Database` seeded with pre-migration duplicate rows, without needing a whole second
 * daemon process. See tests/identity-hygiene.test.ts.
 */
export function mergeDuplicateIdentities(handle: Database): IdentityMergeSummary {
  const rows = handle
    .query(
      `SELECT rowid AS rowid_, id, display_name, git_username, git_email FROM identities ORDER BY rowid_ ASC`,
    )
    .all() as Array<{ rowid_: number; id: string; display_name: string; git_username: string; git_email: string }>;

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = natKey(r.display_name, r.git_username, r.git_email);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const remap: Record<string, string> = {};
  let mergedCount = 0;

  const tx = handle.transaction(() => {
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Rows are already in ascending rowid order (the query's ORDER BY), so group[0] is the oldest.
      const survivor = group[0]!;
      const losers = group.slice(1);
      for (const loser of losers) {
        // Re-point every FK-style reference (no real FK constraints are declared, so this is
        // manual, same pattern deleteIdentity already uses for the same two tables). Both tables
        // key on something OTHER than identity_id (repos.id / account_identities' (host, login)
        // PK), so two duplicates linked from DIFFERENT accounts/repos both remap onto the same
        // survivor with no collision; account_identities' PK just can't collide here since a
        // given (host, login) row only ever pointed at ONE identity (the loser) to begin with.
        handle.query(`UPDATE repos SET identity_id = ? WHERE identity_id = ?`).run(survivor.id, loser.id);
        handle
          .query(`UPDATE account_identities SET identity_id = ? WHERE identity_id = ?`)
          .run(survivor.id, loser.id);
        handle.query(`DELETE FROM identities WHERE id = ?`).run(loser.id);
        remap[loser.id] = survivor.id;
        mergedCount++;
      }
    }
  });
  tx();

  if (mergedCount > 0) {
    const survivorCount = new Set(Object.values(remap)).size;
    console.log(`[repoyeti] identities: merged ${mergedCount} duplicate row(s) into ${survivorCount} survivor(s)`);
  }
  return { mergedCount, remap };
}
