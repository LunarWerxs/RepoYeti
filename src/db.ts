/**
 * SQLite state (bun:sqlite). One file at ~/.repoyeti/repoyeti.db.
 *
 * WAL mode + NORMAL sync is what lets the watcher, the API, and git operations
 * write concurrently without corrupting a flat file. The full schema is created
 * up front; Phase 1 only exercises `repos`. Secrets never land here — only key
 * *paths* and (later) keychain *handles*.
 */
import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { DB_PATH, ensureConfigDir } from "./config.ts";
import { isUnderTempDir } from "./paths.ts";
import type { DiffStat } from "./read/diffstat.ts";
import type { CommitStat } from "./read/inspect.ts";
import type { VcsKind } from "./vcs/types.ts";

export type RepoSource = "auto" | "pinned" | "created";

export interface RepoStatus {
  branch: string | null;
  detached: boolean;
  /**
   * Full object id currently resolved by HEAD. Unlike branch/ahead/behind counters, this changes
   * when another Git client commits + pushes, amends, or resets between watcher refreshes. Null
   * for an unborn/error state; optional so persisted pre-field and non-Git statuses still parse.
   */
  headOid?: string | null;
  /** Full object id of the configured upstream tip; null/absent when nothing is tracked. */
  upstreamOid?: string | null;
  /**
   * Deterministic identity of every ref included by History's Local/All scopes
   * (`refs/heads`, `refs/remotes`, and `refs/tags`). This catches external ref creation,
   * deletion, and force-moves even when HEAD/upstream/counters stay unchanged.
   */
  historyRefsHash?: string | null;
  /**
   * Opaque hash of changed paths and their index/worktree status letters. This deliberately
   * excludes contents: pull checkout safety changes when the affected path/state set changes.
   */
  worktreeStateHash?: string | null;
  dirty: number;
  ahead: number;
  /** From last fetch only — never auto-fetched on a watch event. */
  behind: number;
  remote: string | null;
  error: string | null;
  /** When `behind` was last refreshed by an explicit fetch (null until then). */
  fetchedAt: number | null;
  /**
   * Aggregate working-tree-vs-HEAD line/char delta. Null when the diff-stats setting is
   * off (the default) or the tree is clean — computing it is gated behind that setting.
   * Optional so a status literal can omit it; readStatus always sets it (null or a value).
   */
  diff?: DiffStat | null;
  /** Has any unmerged/conflicted path (git status "U"/"AA"/"DD"). Git-only for now — optional
   *  so the Lore backend's status literals (vcs/lore.ts) can omit it (defaults falsy in the UI).
   *  Drives the Conflict Concierge triage card (state-driven, not event-driven). */
  conflicted?: boolean;
  /** Which mid-git-operation marker is present ("MERGE_HEAD" | "rebase-merge" | "rebase-apply" |
   *  "CHERRY_PICK_HEAD" | "REVERT_HEAD"), or null when the repo isn't mid-operation. See
   *  src/git.ts currentGitOperation (shared with the auto-commit safety gate). Optional/git-only
   *  like `conflicted`. */
  gitOperation?: string | null;
  updatedAt: number;
}

interface RepoRow {
  id: string;
  abs_path: string;
  name: string;
  /** Owner-chosen label (Rename), or NULL to use `name`. Never the folder on disk. */
  display_name: string | null;
  source: RepoSource;
  vcs: string;
  identity_id: string | null;
  sync_account_host: string | null;
  sync_account_login: string | null;
  is_submodule: number;
  hidden: number;
  /** User "favorite" flags — organisation only. Distinct from source='pinned'. */
  pinned: number;
  starred: number;
  /** Owner opted this repo into the auto-commit timer (see src/auto-commit.ts). */
  auto_commit: number;
  /** Drag-persisted position; NULL for a repo the owner has never reordered. */
  sort_order: number | null;
  last_status: string | null;
  updated_at: number;
}

/** The shape the API/UI consumes. */
export interface RepoView {
  id: string;
  /** The folder's basename on disk. Always the real thing — a rename never changes it. */
  name: string;
  /** Owner-chosen label, or null when none is set. The UI shows `displayName ?? name`. */
  displayName: string | null;
  absPath: string;
  source: RepoSource;
  /** Which VCS backs this repo ("git" | "lore"). Drives backend dispatch in service.ts. */
  vcs: VcsKind;
  isSubmodule: boolean;
  /** Repo-level identity override (null → inherit/none). */
  identityId: string | null;
  /** Repo-level GitHub "sync account" (host + login) to authenticate as for fetch/pull/push.
   *  Null → resolve automatically from git config, remote ownership, or GitHub permissions. */
  syncAccountHost: string | null;
  syncAccountLogin: string | null;
  /** Owner-hidden from the dashboard (e.g. a deprecated repo). Display-only. */
  hidden: boolean;
  /** Favorited into the "Pinned" section. Organisation flag — NOT source='pinned'. */
  pinned: boolean;
  /** Favorited into the "Starred" section. Organisation flag, independent of pinned. */
  starred: boolean;
  /** Opted into the auto-commit timer (per-repo; the timer only touches repos with this on). */
  autoCommit: boolean;
  /** Drag-persisted list position, or null for a repo never manually reordered. Exposed so the
   *  dashboard can slot a live-discovered repo into the same place getRepos() would, instead of
   *  appending it to the bottom of whatever it already had. */
  sortOrder: number | null;
  status: RepoStatus | null;
  updatedAt: number;
}

/** A git identity. SSH key is stored as a *path* (never read by the daemon).
 * PAT / signing handles exist in the schema but are wired in Phase 5. */
export interface Identity {
  id: string;
  displayName: string;
  gitUsername: string;
  gitEmail: string;
  sshKeyPath: string | null;
}

export interface IdentityInput {
  displayName: string;
  gitUsername: string;
  gitEmail: string;
  sshKeyPath?: string | null;
}

let db: Database | null = null;

/**
 * Run one `ALTER TABLE … ADD COLUMN` migration, tolerating only the ONE failure that is expected.
 *
 * These all used to be `try { … } catch { /* column already present *​/ }`, which is true almost
 * every time — and indistinguishable from the times it isn't. A locked database (Windows AV
 * holding the -wal), a read-only directory, or a full disk raises a completely different error
 * and was swallowed just as quietly, so the daemon booted "successfully" with a column that does
 * not exist and then threw `no such column` from whatever request happened to touch it first.
 * That is a long way from the cause, at a moment with no context.
 *
 * Deliberately NOT fatal: a transient lock at boot should not stop the daemon from serving what
 * it can. But it says so, loudly, naming the statement, so the trail starts at the real problem.
 */
function migrateAddColumn(handle: Database, sql: string): void {
  try {
    handle.exec(sql);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/duplicate column name/i.test(message)) return; // already migrated — the normal path
    console.error(`[repoyeti] schema migration failed: ${sql}\n           ${message}`);
  }
}

export function initDb(): Database {
  if (db) return db;
  ensureConfigDir();
  const handle = new Database(DB_PATH, { create: true });
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
  db = handle;
  return db;
}

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

function getDb(): Database {
  return db ?? initDb();
}

export interface GitCommitStatCacheEntry {
  hash: string;
  date: number;
  stat: CommitStat;
}

/** Read immutable shortstats previously measured for this repo and commit-date window. */
export function getGitCommitStats(
  repoId: string,
  since: number,
  until: number,
  statVersion: number,
): Map<string, CommitStat> {
  const rows = getDb()
    .query(
      `SELECT commit_hash, files_changed, added_lines, removed_lines
       FROM git_commit_stats
       WHERE repo_id = ? AND stat_version = ? AND committed_at >= ? AND committed_at <= ?`,
    )
    .all(repoId, statVersion, Math.floor(since), Math.floor(until)) as Array<{
    commit_hash: string;
    files_changed: number;
    added_lines: number;
    removed_lines: number;
  }>;
  const stats = new Map<string, CommitStat>();
  for (const row of rows) {
    if (
      !row.commit_hash ||
      !Number.isSafeInteger(row.files_changed) ||
      row.files_changed < 0 ||
      !Number.isSafeInteger(row.added_lines) ||
      row.added_lines < 0 ||
      !Number.isSafeInteger(row.removed_lines) ||
      row.removed_lines < 0
    ) {
      continue;
    }
    stats.set(row.commit_hash, {
      filesChanged: row.files_changed,
      addedLines: row.added_lines,
      removedLines: row.removed_lines,
    });
  }
  return stats;
}

/** Transactionally persist a batch of successful measurements; explicit all-zero stats count. */
export function putGitCommitStats(
  repoId: string,
  entries: readonly GitCommitStatCacheEntry[],
  statVersion: number,
): void {
  if (entries.length === 0) return;
  const handle = getDb();
  const repoExists = handle.query(`SELECT 1 FROM repos WHERE id = ? LIMIT 1`);
  const statement = handle.query(
    `INSERT INTO git_commit_stats
       (repo_id, commit_hash, committed_at, files_changed, added_lines, removed_lines, stat_version, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, commit_hash) DO UPDATE SET
       committed_at = excluded.committed_at,
       files_changed = excluded.files_changed,
       added_lines = excluded.added_lines,
       removed_lines = excluded.removed_lines,
       stat_version = excluded.stat_version,
       cached_at = excluded.cached_at`,
  );
  const cachedAt = Date.now();
  const write = handle.transaction((rows: readonly GitCommitStatCacheEntry[]) => {
    // An activity read can finish after the repo was removed. Check inside the same transaction
    // as the upserts so that race cannot resurrect permanent orphan cache rows.
    if (!repoExists.get(repoId)) return;
    for (const entry of rows) {
      statement.run(
        repoId,
        entry.hash,
        Math.floor(entry.date),
        Math.max(0, Math.floor(entry.stat.filesChanged)),
        Math.max(0, Math.floor(entry.stat.addedLines)),
        Math.max(0, Math.floor(entry.stat.removedLines)),
        statVersion,
        cachedAt,
      );
    }
  });
  write(entries);
}

/**
 * Insert (or refresh name/submodule of) a repo by absolute path. Returns its id, or null if
 * `absPath` is under the OS temp directory (see `isUnderTempDir`): a repo living there is NEVER
 * imported, by owner directive, no matter which caller reaches this choke point (auto-discovery,
 * a manual "Point to Folder" pin, or a clone/create destination). This is the single write
 * choke point every import path shares, so this one check is the hard, unbypassable backstop;
 * src/discovery.ts's SKIP_DIRS pruning of "temp"/"tmp" during the walk is scan-time efficiency
 * only, not a guarantee (a pin or clone destination never goes through that walk at all).
 *
 * Deliberately non-throwing (a throw here would abort a scan loop mid-walk); callers check for
 * null instead. See src/service/repo-mgmt.ts (registerRepo/cloneRepo/cloneLoreRepo/createRepo
 * surface it as a RepoMutation) and the auto/boot/scan callers (which just skip the entry).
 */
export function upsertRepo(
  absPath: string,
  name: string,
  source: RepoSource,
  isSubmodule: boolean,
  vcs: VcsKind = "git",
): string | null {
  if (isUnderTempDir(absPath)) return null;
  // The owner removed this path — a rescan must not resurrect it. Checked here, at the same
  // choke point as the temp guard, so EVERY import route (scan, boot discovery, add-root,
  // "Point to Folder", clone) inherits it rather than each remembering to ask.
  if (isPathIgnored(absPath)) return null;
  const row = getDb()
    .query(
      `INSERT INTO repos (id, abs_path, name, source, vcs, is_submodule, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(abs_path) DO UPDATE SET
         name = excluded.name,
          source = CASE
            WHEN repos.source = 'created' OR excluded.source = 'created' THEN 'created'
            WHEN repos.source = 'pinned' OR excluded.source = 'pinned' THEN 'pinned'
            ELSE excluded.source
          END,
          vcs = excluded.vcs,
          is_submodule = excluded.is_submodule,
          updated_at = excluded.updated_at
       RETURNING id`,
    )
    .get(randomUUID(), absPath, name, source, vcs, isSubmodule ? 1 : 0, Date.now()) as
    | { id: string }
    | null;
  return row!.id;
}

export function setRepoStatus(id: string, status: RepoStatus): void {
  getDb()
    .query(`UPDATE repos SET last_status = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(status), status.updatedAt, id);
}

function toView(r: RepoRow): RepoView {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name ?? null,
    absPath: r.abs_path,
    source: r.source,
    vcs: (r.vcs as VcsKind) || "git",
    isSubmodule: r.is_submodule === 1,
    identityId: r.identity_id,
    syncAccountHost: r.sync_account_host,
    syncAccountLogin: r.sync_account_login,
    hidden: r.hidden === 1,
    pinned: r.pinned === 1,
    starred: r.starred === 1,
    autoCommit: r.auto_commit === 1,
    sortOrder: r.sort_order ?? null,
    status: r.last_status ? (JSON.parse(r.last_status) as RepoStatus) : null,
    updatedAt: r.updated_at,
  };
}

export function getRepos(): RepoView[] {
  // Manual drag order (sort_order) wins; repos never reordered yet (NULL) fall back
  // to the old grouping — real repos before submodule worktrees, then name.
  const rows = getDb()
    .query(
      `SELECT * FROM repos
       ORDER BY (sort_order IS NULL) ASC, sort_order ASC, is_submodule ASC, name COLLATE NOCASE ASC`,
    )
    .all() as RepoRow[];
  return rows.map(toView);
}

/**
 * Persist a full drag-to-reorder: assign each id its position as sort_order.
 * Clears every repo's sort_order first so any repo NOT in the list (e.g. one
 * discovered mid-drag) falls back to the name/submodule tiebreaker instead of
 * floating to a stale position.
 */
export function setRepoOrder(orderedIds: string[]): void {
  const d = getDb();
  const clear = d.query(`UPDATE repos SET sort_order = NULL`);
  const upd = d.query(`UPDATE repos SET sort_order = ? WHERE id = ?`);
  const tx = d.transaction((ids: string[]) => {
    clear.run();
    ids.forEach((id, i) => {
      upd.run(i, id);
    });
  });
  tx(orderedIds);
}

export function getRepo(id: string): RepoView | null {
  const r = getDb().query(`SELECT * FROM repos WHERE id = ?`).get(id) as RepoRow | null;
  return r ? toView(r) : null;
}

// ── Removal + rename ────────────────────────────────────────────────────────────────────
//
// "Remove" here means remove from RepoYeti's index. It NEVER touches the folder or a single byte
// of git history: RepoYeti's whole promise is "uninstall it and your repos are untouched", so a
// button that could delete real work would break that contract outright. The row goes; the code
// stays exactly where it is.

/** True when `absPath` sits on the owner's removed list (see the `ignored_paths` table). */
export function isPathIgnored(absPath: string): boolean {
  return (
    getDb().query(`SELECT 1 FROM ignored_paths WHERE abs_path = ?`).get(absPath) !== null
  );
}

/** Every path the owner has removed, newest first — the Settings → Removed repos list. */
export function listIgnoredPaths(): Array<{ absPath: string; name: string; ignoredAt: number }> {
  const rows = getDb()
    .query(`SELECT abs_path, name, ignored_at FROM ignored_paths ORDER BY ignored_at DESC`)
    .all() as Array<{ abs_path: string; name: string; ignored_at: number }>;
  return rows.map((r) => ({ absPath: r.abs_path, name: r.name, ignoredAt: r.ignored_at }));
}

/** Drop a path from the removed list, so the next scan may import it again. Idempotent. */
export function unignorePath(absPath: string): void {
  getDb().query(`DELETE FROM ignored_paths WHERE abs_path = ?`).run(absPath);
}

// ── Grouped operational-error history ───────────────────────────────────────────────────
//
// Adapted from PostHog's issue-fingerprint grouping (products/error_tracking/, MIT): cluster
// recurring failures by a stable signature instead of a flat log or a one-shot toast. See the
// `operational_errors` CREATE TABLE above for why this exists.

export interface OperationalErrorView {
  fingerprint: string;
  repoId: string;
  repoName: string;
  op: string;
  code: string;
  message: string;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  muted: boolean;
}

interface OperationalErrorRow {
  fingerprint: string;
  repo_id: string;
  repo_name: string;
  op: string;
  code: string;
  message: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  muted: number;
}

function toOperationalErrorView(r: OperationalErrorRow): OperationalErrorView {
  return {
    fingerprint: r.fingerprint,
    repoId: r.repo_id,
    repoName: r.repo_name,
    op: r.op,
    code: r.code,
    message: r.message,
    occurrences: r.occurrences,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    muted: r.muted === 1,
  };
}

/**
 * Stable id for one (repo, operation, code) group - same short-hash idiom as `idFor` in
 * identity-detect.ts (sha1, hex, 16 chars): plenty of collision resistance for a local per-machine
 * log, and a clean opaque path segment for the mute/dismiss routes, unlike the raw
 * "repoId:op:code" string, which would need URL-encoding and could still collide with a route
 * pattern if an op or code ever contained a slash.
 */
export function operationalErrorFingerprint(repoId: string, op: string, code: string): string {
  return createHash("sha1").update([repoId, op, code].join("\0")).digest("hex").slice(0, 16);
}

/**
 * Record one failed mutating action, grouped by (repo, op, code), see
 * `operationalErrorFingerprint`. The first occurrence inserts a row; every later one bumps
 * `occurrences` and refreshes `message`/`last_seen_at` (the newest failure's message is usually
 * the more useful one, e.g. a changed SSH host-key fingerprint) without disturbing
 * `first_seen_at` or a manually-set `muted` flag. Called from service/core.ts's `runAction`, the
 * single funnel every mutating VCS action goes through, so every call site is covered without
 * each action remembering to log its own failure.
 */
export function recordOperationalError(input: {
  repoId: string;
  repoName: string;
  op: string;
  code: string;
  message: string;
}): void {
  const fingerprint = operationalErrorFingerprint(input.repoId, input.op, input.code);
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO operational_errors
         (fingerprint, repo_id, repo_name, op, code, message, occurrences, first_seen_at, last_seen_at, muted)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0)
       ON CONFLICT(fingerprint) DO UPDATE SET
         repo_name = excluded.repo_name,
         message = excluded.message,
         occurrences = operational_errors.occurrences + 1,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(fingerprint, input.repoId, input.repoName, input.op, input.code, input.message, now, now);
}

/** Every grouped operational error, most-recently-seen first - the "this repo's fetch has failed
 *  N times" list next to the live health/status route. */
export function listOperationalErrors(): OperationalErrorView[] {
  const rows = getDb()
    .query(`SELECT * FROM operational_errors ORDER BY last_seen_at DESC`)
    .all() as OperationalErrorRow[];
  return rows.map(toOperationalErrorView);
}

/** Toggle a group's mute flag (silence it from an "unread" badge without deleting its history).
 *  Returns false if the fingerprint is unknown, so the route can answer 404 instead of a false ok. */
export function setOperationalErrorMuted(fingerprint: string, muted: boolean): boolean {
  const result = getDb()
    .query(`UPDATE operational_errors SET muted = ? WHERE fingerprint = ?`)
    .run(muted ? 1 : 0, fingerprint);
  return result.changes > 0;
}

/** Dismiss one group outright. The next matching failure starts a fresh row/count: dismissing is
 *  "I've dealt with this", not "stop telling me forever" (mute is that). Returns false if the
 *  fingerprint was already gone/unknown. */
export function dismissOperationalError(fingerprint: string): boolean {
  const result = getDb().query(`DELETE FROM operational_errors WHERE fingerprint = ?`).run(fingerprint);
  return result.changes > 0;
}

/**
 * Remove one repo from the index. `ignore: true` (the default for an owner-initiated removal)
 * also tombstones the path so a rescan can't bring it straight back; `ignore: false` is the
 * "just forget the row" variant used when a repo's folder is already gone.
 *
 * Returns the removed repo's view, or null if the id was unknown.
 */
export function forgetRepo(id: string, ignore = true): RepoView | null {
  const repo = getRepo(id);
  if (!repo) return null;
  const d = getDb();
  const tx = d.transaction(() => {
    if (ignore) {
      d.query(
        `INSERT INTO ignored_paths (abs_path, name, ignored_at) VALUES (?, ?, ?)
         ON CONFLICT(abs_path) DO UPDATE SET name = excluded.name, ignored_at = excluded.ignored_at`,
      ).run(repo.absPath, repo.name, Date.now());
    }
    d.query(`DELETE FROM share_repos WHERE repo_id = ?`).run(id);
    d.query(`DELETE FROM shares WHERE id NOT IN (SELECT share_id FROM share_repos)`).run();
    d.query(`DELETE FROM git_commit_stats WHERE repo_id = ?`).run(id);
    // Unlike share_events (an audit trail that must outlive the share it logged), an
    // operational-error group has no meaning once its repo is gone - there is nothing left to
    // mute/dismiss/retry against, so it is cleaned up here rather than kept.
    d.query(`DELETE FROM operational_errors WHERE repo_id = ?`).run(id);
    d.query(`DELETE FROM repos WHERE id = ?`).run(id);
  });
  tx();
  return repo;
}

/**
 * Set (or clear, with null) a repo's display label. Purely cosmetic — the folder is never
 * renamed. An empty/whitespace-only label clears back to the folder name rather than showing a
 * blank card.
 */
export function setRepoDisplayName(id: string, displayName: string | null): void {
  const label = displayName?.trim() ? displayName.trim() : null;
  getDb()
    .query(`UPDATE repos SET display_name = ?, updated_at = ? WHERE id = ?`)
    .run(label, Date.now(), id);
}

/** Delete repos by id (used when a scan root is removed). Path/owner logic lives in the
 *  caller (service.ts) so this stays a dumb, transactional delete. */
export function deleteRepos(ids: string[]): void {
  if (ids.length === 0) return;
  const d = getDb();
  const stmt = d.query(`DELETE FROM repos WHERE id = ?`);
  const clearStats = d.query(`DELETE FROM git_commit_stats WHERE repo_id = ?`);
  const clearErrors = d.query(`DELETE FROM operational_errors WHERE repo_id = ?`);
  const tx = d.transaction((xs: string[]) => {
    for (const id of xs) {
      clearStats.run(id);
      clearErrors.run(id);
      stmt.run(id);
    }
  });
  tx(ids);
}

/** Repos eligible for filesystem watching (real repos, not submodule worktrees). */
export function getWatchableRepos(): RepoView[] {
  return getRepos().filter((r) => !r.isSubmodule);
}

// ── identities ────────────────────────────────────────────────────────────────

interface IdentityRow {
  id: string;
  display_name: string;
  git_username: string;
  git_email: string;
  ssh_key_path: string | null;
}

function toIdentity(r: IdentityRow): Identity {
  return {
    id: r.id,
    displayName: r.display_name,
    gitUsername: r.git_username,
    gitEmail: r.git_email,
    sshKeyPath: r.ssh_key_path,
  };
}

/** Case-insensitively-trimmed natural key for an identity: (name, git username, git email). This
 *  is the identity's "same thing" test, used by createIdentity's idempotency check AND mirrored
 *  by the `identities_natkey` SQL expression index (see initDb) so accumulation is impossible even
 *  if a future code path skips this function. Keep the two in lockstep: `lower(trim(x))` here must
 *  match `lower(trim(x))` in the SQL index expression exactly. */
function natKey(displayName: string, gitUsername: string, gitEmail: string): string {
  return [displayName, gitUsername, gitEmail].map((s) => s.trim().toLowerCase()).join("\0");
}

/** Thrown by createIdentity on obviously-invalid input. Routes catch this and map it to the
 *  standard VALIDATION error code (see http/routes/identities.ts); kept as a plain Error (not an
 *  ApiErrorCode-aware type) so db.ts stays free of the HTTP contract layer's vocabulary, the route
 *  is the one place that translates "identity input is invalid" into the wire shape. */
export class IdentityValidationError extends Error {}

/** Reject empty/whitespace-only name or username, and an obviously malformed email (must contain
 *  an "@" with something on both sides, no whitespace), a deliberately low bar; RFC 5322-grade
 *  validation isn't the point, catching blank/garbage fixture-style input is. */
function assertValidIdentityInput(displayName: string, gitUsername: string, gitEmail: string): void {
  if (!displayName.trim()) throw new IdentityValidationError("display name is required");
  if (!gitUsername.trim()) throw new IdentityValidationError("git username is required");
  if (!gitEmail.trim()) throw new IdentityValidationError("git email is required");
  if (!/^\S+@\S+\.\S+$/.test(gitEmail.trim())) {
    throw new IdentityValidationError(`git email looks malformed: "${gitEmail.trim()}"`);
  }
}

/** Find an existing identity whose natural key matches, or null. Shared by createIdentity and the
 *  detected-suggestion accept flow (identity-detect's "Use" button goes through createIdentity, so
 *  it inherits this for free; see IdentityManager.vue's `shownDetected` client-side prefilter for
 *  the separate "don't even offer it" UX, which this backstops). */
function findByNatKey(displayName: string, gitUsername: string, gitEmail: string): Identity | null {
  const key = natKey(displayName, gitUsername, gitEmail);
  const rows = getDb()
    .query(`SELECT id, display_name, git_username, git_email, ssh_key_path FROM identities`)
    .all() as IdentityRow[];
  const hit = rows.find((r) => natKey(r.display_name, r.git_username, r.git_email) === key);
  return hit ? toIdentity(hit) : null;
}

/**
 * Create an identity, idempotent by natural key (case-insensitively trimmed display name + git
 * username + git email). Creating one that already matches an existing row does NOT insert a
 * second one; it returns the EXISTING row's id unchanged (this is the single choke point: every
 * entry point, the manual "Add identity" form, the inline editor's create path, and the detected-
 * suggestion "Use" button, all call this same function). The `identities_natkey` unique index
 * (initDb) is the backstop for any future code path that writes to the table directly.
 *
 * Throws IdentityValidationError on empty/whitespace name or username, or an obviously malformed
 * email; see assertValidIdentityInput.
 */
export function createIdentity(input: IdentityInput): string {
  assertValidIdentityInput(input.displayName, input.gitUsername, input.gitEmail);
  const existing = findByNatKey(input.displayName, input.gitUsername, input.gitEmail);
  if (existing) return existing.id;
  const id = randomUUID();
  getDb()
    .query(
      `INSERT INTO identities (id, display_name, git_username, git_email, ssh_key_path)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, input.displayName, input.gitUsername, input.gitEmail, input.sshKeyPath ?? null);
  return id;
}

export function listIdentities(): Identity[] {
  return (
    getDb()
      .query(`SELECT id, display_name, git_username, git_email, ssh_key_path
              FROM identities ORDER BY display_name COLLATE NOCASE ASC`)
      .all() as IdentityRow[]
  ).map(toIdentity);
}

export function getIdentity(id: string): Identity | null {
  const r = getDb()
    .query(`SELECT id, display_name, git_username, git_email, ssh_key_path FROM identities WHERE id = ?`)
    .get(id) as IdentityRow | null;
  return r ? toIdentity(r) : null;
}

/**
 * Update an identity. Validates the resulting (post-patch) name/username/email the same way
 * createIdentity does, and rejects (returns false, changes nothing) an edit that would collide
 * with a DIFFERENT existing identity's natural key: the friendly counterpart to the
 * `identities_natkey` unique index, which would otherwise surface as a raw SQLite constraint
 * error. Editing a row to match ITS OWN current key (a no-op change) is always fine.
 */
export function updateIdentity(id: string, patch: Partial<IdentityInput>): boolean {
  const existing = getIdentity(id);
  if (!existing) return false;
  const next: Identity = {
    ...existing,
    displayName: patch.displayName ?? existing.displayName,
    gitUsername: patch.gitUsername ?? existing.gitUsername,
    gitEmail: patch.gitEmail ?? existing.gitEmail,
    sshKeyPath: patch.sshKeyPath === undefined ? existing.sshKeyPath : patch.sshKeyPath,
  };
  assertValidIdentityInput(next.displayName, next.gitUsername, next.gitEmail);
  const collision = findByNatKey(next.displayName, next.gitUsername, next.gitEmail);
  if (collision && collision.id !== id) return false;
  getDb()
    .query(
      `UPDATE identities SET display_name = ?, git_username = ?, git_email = ?, ssh_key_path = ? WHERE id = ?`,
    )
    .run(next.displayName, next.gitUsername, next.gitEmail, next.sshKeyPath, id);
  return true;
}

export function deleteIdentity(id: string): boolean {
  const db2 = getDb();
  // detach from any repos that pointed at it (no FK cascade configured)
  db2.query(`UPDATE repos SET identity_id = NULL WHERE identity_id = ?`).run(id);
  // and from any GitHub-account links that pointed at it
  db2.query(`DELETE FROM account_identities WHERE identity_id = ?`).run(id);
  const res = db2.query(`DELETE FROM identities WHERE id = ?`).run(id);
  return res.changes > 0;
}

/** Assign (or clear, with null) a repo's identity override. */
export function setRepoIdentity(repoId: string, identityId: string | null): void {
  getDb()
    .query(`UPDATE repos SET identity_id = ?, updated_at = ? WHERE id = ?`)
    .run(identityId, Date.now(), repoId);
}

/**
 * Assign (or clear, with a null login) a repo's GitHub "sync account". When set, fetch/pull/push
 * receives that account's credential for the one operation — see service/core.ts.
 */
export function setRepoAccount(repoId: string, host: string | null, login: string | null): void {
  const h = login ? host || "github.com" : null;
  getDb()
    .query(`UPDATE repos SET sync_account_host = ?, sync_account_login = ?, updated_at = ? WHERE id = ?`)
    .run(h, login || null, Date.now(), repoId);
}

// ── GitHub account → commit-identity links ──────────────────────────────────────

interface AccountIdentityRow {
  host: string;
  login: string;
  identity_id: string;
}

/** All account→identity links as a `${host}\0${login}` → identityId map (for enriching a snapshot). */
export function accountIdentityMap(): Record<string, string> {
  const rows = getDb()
    .query(`SELECT host, login, identity_id FROM account_identities`)
    .all() as AccountIdentityRow[];
  const out: Record<string, string> = {};
  for (const r of rows) out[`${r.host}\0${r.login}`] = r.identity_id;
  return out;
}

/** The identity id linked to one account (host + login), or null. */
export function getAccountIdentity(host: string, login: string): string | null {
  const r = getDb()
    .query(`SELECT identity_id FROM account_identities WHERE host = ? AND login = ?`)
    .get(host, login) as { identity_id: string } | null;
  return r?.identity_id ?? null;
}

/** Link (or unlink, with null) a GitHub account to a saved commit identity. */
export function setAccountIdentity(host: string, login: string, identityId: string | null): void {
  const db2 = getDb();
  if (!identityId) {
    db2.query(`DELETE FROM account_identities WHERE host = ? AND login = ?`).run(host, login);
    return;
  }
  db2
    .query(
      `INSERT INTO account_identities (host, login, identity_id) VALUES (?, ?, ?)
       ON CONFLICT(host, login) DO UPDATE SET identity_id = excluded.identity_id`,
    )
    .run(host, login, identityId);
}

/** Hide (or unhide) a repo from the dashboard. Display-only — never affects watching. */
export function setRepoHidden(repoId: string, hidden: boolean): void {
  getDb()
    .query(`UPDATE repos SET hidden = ?, updated_at = ? WHERE id = ?`)
    .run(hidden ? 1 : 0, Date.now(), repoId);
}

/** Pin (or unpin) a repo into the "Pinned" section. Organisation only — display-only. */
export function setRepoPinned(repoId: string, pinned: boolean): void {
  getDb()
    .query(`UPDATE repos SET pinned = ?, updated_at = ? WHERE id = ?`)
    .run(pinned ? 1 : 0, Date.now(), repoId);
}

/** Star (or unstar) a repo into the "Starred" section. Independent of pinned. */
export function setRepoStarred(repoId: string, starred: boolean): void {
  getDb()
    .query(`UPDATE repos SET starred = ?, updated_at = ? WHERE id = ?`)
    .run(starred ? 1 : 0, Date.now(), repoId);
}

/** Opt a repo into (or out of) the auto-commit timer — see src/auto-commit.ts. */
export function setRepoAutoCommit(repoId: string, autoCommit: boolean): void {
  getDb()
    .query(`UPDATE repos SET auto_commit = ?, updated_at = ? WHERE id = ?`)
    .run(autoCommit ? 1 : 0, Date.now(), repoId);
}

// ── share links (see src/share/) ─────────────────────────────────────────────────
// The storage half of the guest principal. The policy half is src/share/policy.ts; the gate is
// auth.ts authMiddleware. Nothing here decides what a guest may DO — these are plain rows.

/** A share link as stored. `tokenHash` never leaves this module; `token` is the retained secret. */
export interface Share {
  id: string;
  label: string;
  perm: "view" | "control";
  /** Whether the holder may pair another RepoYeti and publish an encrypted working-tree view. */
  collaborative: boolean;
  /** Every repo, including ones discovered after the link was made. */
  scopeAll: boolean;
  createdAt: number;
  /** null = never expires. */
  expiresAt: number | null;
  /** null = still live. */
  revokedAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  /**
   * The public origin this link's URL was built against, e.g. "https://xyz.trycloudflare.com".
   * null for links minted before this was recorded (and for ones minted with no tunnel up).
   *
   * Stored so the owner can be TOLD when a link has gone stale. A zero-config quick tunnel gets a
   * fresh hostname on every restart, and a link that embeds the old one simply stops resolving —
   * silently, on the recipient's end. Comparing this to the live origin turns that into something
   * the Sharing panel can show and offer to fix.
   */
  origin: string | null;
  /**
   * The link's plaintext secret, so the panel can offer **Copy link** on a share it minted earlier.
   *
   * This is a deliberate, owner-made reversal of the original "the plaintext is unrecoverable"
   * stance, and the cost is stated plainly rather than buried: a copy of `repoyeti.db` is now a set
   * of working share links, where before it was a set of useless sha256 digests. What makes that
   * acceptable HERE is that the file never leaves the machine (settings sync ships an allowlist of
   * config keys and no secrets at all, see src/connections-sync.ts) and reading it already requires
   * running as the owner, who can simply mint a fresh link through the API anyway.
   *
   * `token_hash` remains the ONLY thing redemption consults (getShareByTokenHash), so this column
   * is display state, not an auth path: corrupting or clearing it can cost you the Copy button and
   * nothing else. NULL for every link minted before this existed, and cleared on revoke, since a
   * revoked link's secret has no use left and no reason to sit in the file.
   */
  token: string | null;
}

interface ShareRow {
  id: string;
  label: string;
  perm: string;
  collaborative: number;
  scope_all: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  use_count: number;
  origin: string | null;
  token: string | null;
}

const SHARE_COLS =
  "id, label, perm, collaborative, scope_all, created_at, expires_at, revoked_at, last_used_at, use_count, origin, token";

function toShare(r: ShareRow): Share {
  return {
    id: r.id,
    label: r.label,
    perm: r.perm === "control" ? "control" : "view", // unknown value degrades to the LESSER tier
    collaborative: r.collaborative === 1,
    scopeAll: r.scope_all === 1,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    origin: r.origin ?? null,
    token: r.token ?? null,
  };
}

export interface ShareInput {
  label: string;
  perm: "view" | "control";
  collaborative?: boolean;
  scopeAll: boolean;
  /** Ignored when scopeAll — the grant is "everything", so a repo list would be a lie. */
  repoIds: string[];
  expiresAt: number | null;
  /** The public origin the link will be handed out on; null when no tunnel is up. */
  origin?: string | null;
  /** The plaintext secret whose sha256 is `tokenHash`, retained so the panel can re-offer the link
   *  later (see Share.token). Passed alongside the hash rather than derived here so db.ts never
   *  grows a second definition of the hashing that redemption depends on. */
  token?: string | null;
}

/**
 * Insert a share. `tokenHash` is sha256(secret) computed by the caller (src/share/tokens.ts), and
 * `input.token` retains that same secret for the owner's Copy link action. Keeping both values
 * explicit lets tests assert they correspond while leaving redemption dependent on the hash only.
 */
export function createShare(tokenHash: string, input: ShareInput): Share {
  const id = randomUUID();
  const now = Date.now();
  const db2 = getDb();
  db2
    .query(
      `INSERT INTO shares (id, token_hash, label, perm, collaborative, scope_all, created_at, expires_at, revoked_at, last_used_at, use_count, origin, token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
    )
    .run(
      id,
      tokenHash,
      input.label,
      input.perm,
      input.collaborative ? 1 : 0,
      input.scopeAll ? 1 : 0,
      now,
      input.expiresAt,
      input.origin ?? null,
      input.token ?? null,
    );
  if (!input.scopeAll) {
    const ins = db2.query(`INSERT OR IGNORE INTO share_repos (share_id, repo_id) VALUES (?, ?)`);
    for (const repoId of input.repoIds) ins.run(id, repoId);
  }
  return {
    id,
    label: input.label,
    perm: input.perm,
    collaborative: input.collaborative === true,
    scopeAll: input.scopeAll,
    createdAt: now,
    expiresAt: input.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
    useCount: 0,
    origin: input.origin ?? null,
    token: input.token ?? null,
  };
}

/** Every share the owner hasn't revoked (expired ones included — the UI shows + lets them clean up). */
export function listShares(): Share[] {
  return (
    getDb()
      .query(`SELECT ${SHARE_COLS} FROM shares WHERE revoked_at IS NULL ORDER BY created_at DESC`)
      .all() as ShareRow[]
  ).map(toShare);
}

export function getShare(id: string): Share | null {
  const r = getDb().query(`SELECT ${SHARE_COLS} FROM shares WHERE id = ?`).get(id) as ShareRow | null;
  return r ? toShare(r) : null;
}

/**
 * Look a share up by the sha256 of a presented secret. Returns the row whatever its state — the
 * caller decides what "usable" means (see share/index.ts shareIsLive), because redemption and the
 * per-request gate want to tell "revoked" apart from "never existed" for logging, while both refuse.
 */
export function getShareByTokenHash(tokenHash: string): Share | null {
  const r = getDb()
    .query(`SELECT ${SHARE_COLS} FROM shares WHERE token_hash = ?`)
    .get(tokenHash) as ShareRow | null;
  return r ? toShare(r) : null;
}

/**
 * Edit a live share in place: its label, tier, expiry and repo scope. Everything here is a
 * property of the GRANT, not of the secret, so none of it touches token_hash — the link someone
 * already holds keeps working and simply means something different from now on. That is the whole
 * point: narrowing a link's repos or shortening its expiry should not force the owner to revoke
 * and re-send.
 *
 * A revoked share is NOT editable. Reviving one by editing would resurrect a secret the owner
 * already decided to kill, which is not something a PATCH should be able to do.
 *
 * Fields are optional; an omitted field is left alone. `repoIds` is only consulted when the share
 * ends up scoped (scopeAll false), matching createShare's rule that a repo list alongside
 * "everything" is a lie.
 */
export interface ShareUpdate {
  label?: string;
  perm?: "view" | "control";
  collaborative?: boolean;
  scopeAll?: boolean;
  repoIds?: string[];
  expiresAt?: number | null;
}

export function updateShare(id: string, patch: ShareUpdate): Share | null {
  const db2 = getDb();
  const current = getShare(id);
  if (!current || current.revokedAt !== null) return null;

  const label = patch.label ?? current.label;
  const perm = patch.perm ?? current.perm;
  const collaborative = patch.collaborative ?? current.collaborative;
  const scopeAll = patch.scopeAll ?? current.scopeAll;
  const expiresAt = patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt;

  db2
    .query(`UPDATE shares SET label = ?, perm = ?, collaborative = ?, scope_all = ?, expires_at = ? WHERE id = ?`)
    .run(label, perm, collaborative ? 1 : 0, scopeAll ? 1 : 0, expiresAt, id);

  // Rewrite the scope only when this call actually says something about it. Replacing the set
  // wholesale (delete-then-insert) rather than diffing keeps "the grant is exactly this list"
  // true even if a previous write left rows behind.
  if (scopeAll) {
    db2.query(`DELETE FROM share_repos WHERE share_id = ?`).run(id);
  } else if (patch.repoIds !== undefined) {
    db2.query(`DELETE FROM share_repos WHERE share_id = ?`).run(id);
    const ins = db2.query(`INSERT OR IGNORE INTO share_repos (share_id, repo_id) VALUES (?, ?)`);
    for (const repoId of patch.repoIds) ins.run(id, repoId);
  }
  return getShare(id);
}

/**
 * Point a share at a NEW secret, returning the share so the caller can hand back the new link.
 * The old token stops working the instant this lands.
 *
 * Originally this was the ONLY way back to a link the owner had lost, because the plaintext was
 * unrecoverable by design. It no longer is (see Share.token, which powers Copy link), so rotating
 * has narrowed to what its name says: re-keying, for when the link itself should stop working.
 * That still costs whoever holds the old URL their access, which the UI has to say plainly.
 *
 * `next` is an object rather than positional arguments on purpose: `token` and `origin` are both
 * optional and both `string | null`, so side by side they would be trivial to transpose and the
 * mistake would be silent — a link that copies as somebody else's address, or a stored secret that
 * doesn't match the stored hash.
 */
export function rotateShareToken(
  id: string,
  next: { tokenHash: string; token?: string | null; origin?: string | null },
): Share | null {
  const current = getShare(id);
  if (!current || current.revokedAt !== null) return null;
  // The re-keyed URL is handed out fresh, so it belongs to wherever we live NOW — otherwise
  // regenerating a stale link would produce another link still flagged stale.
  getDb()
    .query(
      `UPDATE shares SET token_hash = ?, token = ?, last_used_at = NULL, use_count = 0, origin = ? WHERE id = ?`,
    )
    .run(next.tokenHash, next.token ?? null, next.origin ?? current.origin ?? null, id);
  return getShare(id);
}

/** Revoke a link. Idempotent; returns false when the id is unknown. The row stays (audit trail). */
export function revokeShare(id: string): boolean {
  // The retained plaintext goes with the revocation. The row stays for the audit trail, but a
  // revoked link's secret can never authenticate anything again, so keeping it would be pure
  // liability: a growing pile of dead credentials in the file, none of which buys the owner a
  // Copy button they could use. `token_hash` is left alone — it is what marks the digest as spent.
  const r = getDb()
    .query(`UPDATE shares SET revoked_at = ?, token = NULL WHERE id = ? AND revoked_at IS NULL`)
    .run(Date.now(), id);
  return r.changes > 0;
}

/** Record a redemption: bump the counter and stamp "last used" for the owner's Sharing panel. */
export function touchShare(id: string): void {
  getDb()
    .query(`UPDATE shares SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?`)
    .run(Date.now(), id);
}

/**
 * The repo ids a share grants, INNER JOINed against `repos` so a grant for a repo that has since
 * been removed simply resolves to nothing. That join is why this doesn't need SQLite's foreign_keys
 * pragma (off by default) to be correct: a dangling grant can never name a live repo, and repo ids
 * are UUIDs, so an id is never recycled into a different repo.
 * Meaningless for a scopeAll share — callers must check that first.
 */
export function shareRepoIds(shareId: string): string[] {
  return (
    getDb()
      .query(
        `SELECT sr.repo_id AS repo_id FROM share_repos sr
         JOIN repos r ON r.id = sr.repo_id
         WHERE sr.share_id = ?`,
      )
      .all(shareId) as Array<{ repo_id: string }>
  ).map((r) => r.repo_id);
}

/** Repos a share exposes, as full rows — the scoped substitute for getRepos() on a guest request. */
export function getSharedRepos(share: Share): RepoView[] {
  // "Share all repositories" means all the repos the owner actually keeps on their dashboard, not
  // every row in the table. Hiding a repo is how you retire one here, so a hidden repo is one the
  // owner has already decided they don't want to look at — silently handing it to a guest reads as
  // a leak, and is the one case where scopeAll would show a stranger something the owner cannot
  // see themselves. An EXPLICIT per-repo grant is the opposite and is honoured below: naming a
  // repo in the share list is a decision that outranks a dashboard-declutter flag.
  if (share.scopeAll) return getRepos().filter((r) => !r.hidden);
  return (
    getDb()
      .query(
        `SELECT r.* FROM repos r
         JOIN share_repos sr ON sr.repo_id = r.id
         WHERE sr.share_id = ?
         ORDER BY r.sort_order IS NULL, r.sort_order ASC, r.name COLLATE NOCASE ASC`,
      )
      .all(share.id) as RepoRow[]
  ).map(toView);
}

/**
 * Does this share cover this repo? The scope half of the guest gate.
 *
 * This is the single choke point for per-repo access: auth.ts's guestGate 404s every scoped route
 * on it, and share/events.ts filters the SSE stream through it. So the hidden-repo rule belongs
 * HERE and not in getSharedRepos alone — filtering only the list would hide a repo from the guest's
 * dashboard while leaving `/api/repos/<id>/changes` wide open to anyone who kept the id.
 */
export function shareCoversRepo(share: Share, repoId: string): boolean {
  if (share.scopeAll) {
    // Same rule as getSharedRepos: for an all-repos share, hidden means out of scope.
    //
    // A MISSING row still counts as covered, and that is not sloppiness. `repo_removed` is
    // broadcast AFTER the row is deleted (service/repo-mgmt.ts deleteRepos → broadcast), so
    // answering "no" for a row that no longer exists would swallow exactly the event that tells
    // the guest's dashboard to drop the card, stranding it until a reload. "Not covered" has to
    // mean deliberately withheld, not merely absent — this branch returned an unconditional
    // `true` before hidden repos were excluded, and a nonexistent repo keeps that answer, with
    // the route handler 404ing on its own as it always did.
    const r = getDb().query(`SELECT hidden FROM repos WHERE id = ?`).get(repoId) as {
      hidden: number;
    } | null;
    return !r || r.hidden === 0;
  }
  const r = getDb()
    .query(`SELECT 1 AS hit FROM share_repos WHERE share_id = ? AND repo_id = ?`)
    .get(share.id, repoId) as { hit: number } | null;
  return !!r;
}

// ── peer collaboration links ────────────────────────────────────────────────────

export interface CollaborationLink {
  id: string;
  /** Bearer-sensitive share token; also the end-to-end snapshot encryption secret. */
  token: string;
  relayUrl: string;
  channelId: string;
  remoteOrigin: string;
  daemonId: string | null;
  participantId: string;
  localRepoId: string;
  remoteRepoId: string;
  label: string;
  createdAt: number;
  enabled: boolean;
}

interface CollaborationLinkRow {
  id: string;
  token: string;
  relay_url: string;
  channel_id: string;
  remote_origin: string;
  daemon_id: string | null;
  participant_id: string;
  local_repo_id: string;
  remote_repo_id: string;
  label: string;
  created_at: number;
  enabled: number;
}

function toCollaborationLink(r: CollaborationLinkRow): CollaborationLink {
  return {
    id: r.id,
    token: r.token,
    relayUrl: r.relay_url,
    channelId: r.channel_id,
    remoteOrigin: r.remote_origin,
    daemonId: r.daemon_id ?? null,
    participantId: r.participant_id,
    localRepoId: r.local_repo_id,
    remoteRepoId: r.remote_repo_id,
    label: r.label,
    createdAt: r.created_at,
    enabled: r.enabled === 1,
  };
}

export interface CollaborationLinkInput {
  token: string;
  relayUrl: string;
  channelId: string;
  remoteOrigin: string;
  daemonId: string | null;
  participantId: string;
  localRepoId: string;
  remoteRepoId: string;
  label: string;
}

/** Persist one outbound repo mapping. Rejoining the same invitation/repo pair replaces it. */
export function createCollaborationLink(input: CollaborationLinkInput): CollaborationLink {
  const id = randomUUID();
  const createdAt = Date.now();
  const d = getDb();
  // A local repo can map to a given remote repo only once. Re-pairing intentionally replaces the
  // old participant id/token so a rotated invitation does not leave a dead publisher beside it.
  d.query(`DELETE FROM collaboration_links WHERE local_repo_id = ? AND remote_repo_id = ?`).run(
    input.localRepoId,
    input.remoteRepoId,
  );
  d.query(
    `INSERT INTO collaboration_links
       (id, invite_url, token, relay_url, channel_id, remote_origin, daemon_id, participant_id, local_repo_id, remote_repo_id, label, created_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    id,
    "",
    input.token,
    input.relayUrl,
    input.channelId,
    input.remoteOrigin,
    input.daemonId,
    input.participantId,
    input.localRepoId,
    input.remoteRepoId,
    input.label,
    createdAt,
  );
  return {
    id,
    ...input,
    createdAt,
    enabled: true,
  };
}

export function listCollaborationLinks(): CollaborationLink[] {
  return (
    getDb()
      .query(`SELECT * FROM collaboration_links ORDER BY created_at DESC`)
      .all() as CollaborationLinkRow[]
  ).map(toCollaborationLink);
}

export function deleteCollaborationLink(id: string): boolean {
  return getDb().query(`DELETE FROM collaboration_links WHERE id = ?`).run(id).changes > 0;
}

export function updateCollaborationOrigin(id: string, origin: string): void {
  getDb().query(`UPDATE collaboration_links SET remote_origin = ? WHERE id = ?`).run(origin, id);
}

// ── audit trail ──────────────────────────────────────────────────────────────────

export interface ShareEvent {
  id: string;
  shareId: string;
  at: number;
  action: string;
  repoId: string | null;
  outcome: "allowed" | "denied";
}

interface ShareEventRow {
  id: string;
  share_id: string;
  at: number;
  action: string;
  repo_id: string | null;
  outcome: string;
}

/**
 * How many audit rows a single share link keeps. Older ones are dropped on write.
 *
 * The table is written by the guest's own requests, so without a cap the link-holder controls how
 * big it grows — hammer a forbidden route (or a failing commit) in a loop and it grows forever.
 * They're someone the owner deliberately chose, and it's a local SQLite file, so this is a
 * housekeeping bound rather than a defence. 500 is far more than anyone will read and still
 * bounded: worst case a link costs a few hundred KB, no matter who holds it or for how long.
 */
const SHARE_EVENT_CAP = 500;

/**
 * Record what a guest tried. Called for mutations (allowed or denied) — reads are far too chatty
 * to be worth a row each, and "he looked at the diff" isn't the question this table answers.
 * The question it answers is "did my brother push this, or did I?", which git history cannot,
 * because a guest's commits are authored as the owner by design.
 *
 * Keeps only the newest SHARE_EVENT_CAP rows per share. The prune is a no-op below the cap: the
 * subquery returns NULL when the share has fewer rows than the offset, and `rowid < NULL` matches
 * nothing, so the common path deletes nothing.
 *
 * Pruned by `rowid`, NOT by `at`. `at` is Date.now() — millisecond resolution — so the rows a
 * hammering client produces all share one timestamp, and a `at < cutoff` prune would match nothing
 * and silently fail to cap in exactly the case the cap exists for. rowid is monotonic per insert,
 * so "newest" is unambiguous and tie-free (and immune to a clock stepping backwards).
 */
export function logShareEvent(
  shareId: string,
  action: string,
  repoId: string | null,
  outcome: "allowed" | "denied",
): void {
  const db2 = getDb();
  db2
    .query(`INSERT INTO share_events (id, share_id, at, action, repo_id, outcome) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), shareId, Date.now(), action, repoId, outcome);
  db2
    .query(
      // OFFSET cap-1 selects the CAP-th newest row; deleting everything strictly older than it
      // leaves exactly CAP. (OFFSET cap would name the CAP+1-th and leave one row too many.)
      `DELETE FROM share_events
       WHERE share_id = ?1
         AND rowid < (SELECT rowid FROM share_events WHERE share_id = ?1 ORDER BY rowid DESC LIMIT 1 OFFSET ?2)`,
    )
    .run(shareId, SHARE_EVENT_CAP - 1);
}

/** How many audit rows a share is holding. Exists so the cap can be asserted against the TABLE
 *  rather than against a already-limited read, which would pass no matter how big it grew. */
export function countShareEvents(shareId: string): number {
  const r = getDb()
    .query(`SELECT count(*) AS n FROM share_events WHERE share_id = ?`)
    .get(shareId) as { n: number };
  return r.n;
}

export function listShareEvents(shareId: string, limit = 100): ShareEvent[] {
  return (
    getDb()
      .query(
        // `at DESC, rowid DESC`, not `at DESC` alone: `at` is millisecond-resolution, so a burst of
        // events shares one timestamp and ordering by it alone leaves ties in arbitrary order —
        // "newest first" would be a lie exactly when the trail is busiest. rowid breaks the tie in
        // true insertion order.
        `SELECT id, share_id, at, action, repo_id, outcome FROM share_events
         WHERE share_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(shareId, Math.max(1, Math.min(limit, 500))) as ShareEventRow[]
  ).map((r) => ({
    id: r.id,
    shareId: r.share_id,
    at: r.at,
    action: r.action,
    repoId: r.repo_id,
    outcome: r.outcome === "allowed" ? "allowed" : "denied",
  }));
}
