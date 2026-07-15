/**
 * SQLite state (bun:sqlite). One file at ~/.repoyeti/repoyeti.db.
 *
 * WAL mode + NORMAL sync is what lets the watcher, the API, and git operations
 * write concurrently without corrupting a flat file. The full schema is created
 * up front; Phase 1 only exercises `repos`. Secrets never land here — only key
 * *paths* and (later) keychain *handles*.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { DB_PATH, ensureConfigDir } from "./config.ts";
import { isUnderTempDir } from "./paths.ts";
import type { DiffStat } from "./read/diffstat.ts";
import type { VcsKind } from "./vcs/types.ts";

export type RepoSource = "auto" | "pinned" | "created";

export interface RepoStatus {
  branch: string | null;
  detached: boolean;
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
  last_status: string | null;
  updated_at: number;
}

/** The shape the API/UI consumes. */
export interface RepoView {
  id: string;
  name: string;
  absPath: string;
  source: RepoSource;
  /** Which VCS backs this repo ("git" | "lore"). Drives backend dispatch in service.ts. */
  vcs: VcsKind;
  isSubmodule: boolean;
  /** Repo-level identity override (null → inherit/none). */
  identityId: string | null;
  /** Repo-level GitHub "sync account" (host + login) to authenticate as for fetch/pull/push.
   *  Null → use the machine's currently-active account. */
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

export function initDb(): Database {
  if (db) return db;
  ensureConfigDir();
  const handle = new Database(DB_PATH, { create: true });
  // WAL + retry posture (Windows AV can briefly lock the -wal file).
  try {
    handle.exec("PRAGMA journal_mode = WAL;");
  } catch {
    handle.exec("PRAGMA journal_mode = DELETE;");
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
    -- INVARIANT (unchanged): no raw secret bytes land in SQLite. token_hash is sha256(secret);
    -- the plaintext link is shown to the owner EXACTLY ONCE, at mint, and is unrecoverable after.
    CREATE TABLE IF NOT EXISTS shares (
      id            TEXT PRIMARY KEY,
      token_hash    TEXT NOT NULL UNIQUE,     -- sha256(secret) hex — never the secret itself
      label         TEXT NOT NULL,            -- owner's name for the link ("Brother — nights")
      perm          TEXT NOT NULL,            -- 'view' | 'control'
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
  `);
  // Migrations: add columns to pre-existing databases. Each throws "duplicate column
  // name" on DBs that already have it (incl. fresh ones) — ignore.
  try {
    handle.exec("ALTER TABLE repos ADD COLUMN sort_order INTEGER;");
  } catch {
    /* column already present */
  }
  try {
    handle.exec("ALTER TABLE repos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;");
  } catch {
    /* column already present */
  }
  try {
    handle.exec("ALTER TABLE repos ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;");
  } catch {
    /* column already present */
  }
  try {
    handle.exec("ALTER TABLE repos ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;");
  } catch {
    /* column already present */
  }
  try {
    handle.exec("ALTER TABLE repos ADD COLUMN vcs TEXT NOT NULL DEFAULT 'git';");
  } catch {
    /* column already present */
  }
  // Repo-level GitHub "sync account" (host + login) — the account fetch/pull/push authenticates as.
  try {
    handle.exec("ALTER TABLE repos ADD COLUMN sync_account_host TEXT;");
  } catch {
    /* column already present */
  }
  try {
    handle.exec("ALTER TABLE repos ADD COLUMN sync_account_login TEXT;");
  } catch {
    /* column already present */
  }
  // Per-repo opt-in for the auto-commit timer (src/auto-commit.ts).
  try {
    handle.exec("ALTER TABLE repos ADD COLUMN auto_commit INTEGER NOT NULL DEFAULT 0;");
  } catch {
    /* column already present */
  }
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
  const tx = handle.transaction((xs: typeof victims) => {
    for (const v of xs) stmt.run(v.id);
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

/** Delete repos by id (used when a scan root is removed). Path/owner logic lives in the
 *  caller (service.ts) so this stays a dumb, transactional delete. */
export function deleteRepos(ids: string[]): void {
  if (ids.length === 0) return;
  const d = getDb();
  const stmt = d.query(`DELETE FROM repos WHERE id = ?`);
  const tx = d.transaction((xs: string[]) => {
    for (const id of xs) stmt.run(id);
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
 * Assign (or clear, with a null login) a repo's GitHub "sync account". When set, fetch/pull/push on
 * this repo first switch the machine's active gh account to (host, login) — see service/core.ts.
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

/** A share link as stored. `tokenHash` never leaves this module; the secret itself is never stored. */
export interface Share {
  id: string;
  label: string;
  perm: "view" | "control";
  /** Every repo, including ones discovered after the link was made. */
  scopeAll: boolean;
  createdAt: number;
  /** null = never expires. */
  expiresAt: number | null;
  /** null = still live. */
  revokedAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
}

interface ShareRow {
  id: string;
  label: string;
  perm: string;
  scope_all: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  use_count: number;
}

const SHARE_COLS =
  "id, label, perm, scope_all, created_at, expires_at, revoked_at, last_used_at, use_count";

function toShare(r: ShareRow): Share {
  return {
    id: r.id,
    label: r.label,
    perm: r.perm === "control" ? "control" : "view", // unknown value degrades to the LESSER tier
    scopeAll: r.scope_all === 1,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
  };
}

export interface ShareInput {
  label: string;
  perm: "view" | "control";
  scopeAll: boolean;
  /** Ignored when scopeAll — the grant is "everything", so a repo list would be a lie. */
  repoIds: string[];
  expiresAt: number | null;
}

/**
 * Insert a share. `tokenHash` is sha256(secret) computed by the caller (src/share/tokens.ts) —
 * this module never sees the secret, which is what makes "the plaintext link exists exactly once,
 * in the mint response" true by construction rather than by discipline.
 */
export function createShare(tokenHash: string, input: ShareInput): Share {
  const id = randomUUID();
  const now = Date.now();
  const db2 = getDb();
  db2
    .query(
      `INSERT INTO shares (id, token_hash, label, perm, scope_all, created_at, expires_at, revoked_at, last_used_at, use_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
    )
    .run(id, tokenHash, input.label, input.perm, input.scopeAll ? 1 : 0, now, input.expiresAt);
  if (!input.scopeAll) {
    const ins = db2.query(`INSERT OR IGNORE INTO share_repos (share_id, repo_id) VALUES (?, ?)`);
    for (const repoId of input.repoIds) ins.run(id, repoId);
  }
  return {
    id,
    label: input.label,
    perm: input.perm,
    scopeAll: input.scopeAll,
    createdAt: now,
    expiresAt: input.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
    useCount: 0,
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

/** Revoke a link. Idempotent; returns false when the id is unknown. The row stays (audit trail). */
export function revokeShare(id: string): boolean {
  const r = getDb()
    .query(`UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
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
  if (share.scopeAll) return getRepos();
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

/** Does this share cover this repo? The scope half of the guest gate. */
export function shareCoversRepo(share: Share, repoId: string): boolean {
  if (share.scopeAll) return true;
  const r = getDb()
    .query(`SELECT 1 AS hit FROM share_repos WHERE share_id = ? AND repo_id = ?`)
    .get(share.id, repoId) as { hit: number } | null;
  return !!r;
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
 * Record what a guest tried. Called for mutations (allowed or denied) — reads are far too chatty
 * to be worth a row each, and "he looked at the diff" isn't the question this table answers.
 * The question it answers is "did my brother push this, or did I?", which git history cannot,
 * because a guest's commits are authored as the owner by design.
 */
export function logShareEvent(
  shareId: string,
  action: string,
  repoId: string | null,
  outcome: "allowed" | "denied",
): void {
  getDb()
    .query(`INSERT INTO share_events (id, share_id, at, action, repo_id, outcome) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), shareId, Date.now(), action, repoId, outcome);
}

export function listShareEvents(shareId: string, limit = 100): ShareEvent[] {
  return (
    getDb()
      .query(
        `SELECT id, share_id, at, action, repo_id, outcome FROM share_events
         WHERE share_id = ? ORDER BY at DESC LIMIT ?`,
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
