/**
 * Git identities, GitHub account links, and the per-repository display flags (1.0 audit, item 27).
 *
 * Lifted out of db.ts as one unit because that is how they are actually used: an identity is only
 * meaningful once a repository points at it, so `setRepoIdentity` and `setRepoAccount` write the
 * repos table from here rather than being marooned in a different module from the rows they
 * validate against.
 *
 * The four display flags (hidden, pinned, starred, auto-commit) came along for a duller reason
 * worth writing down: they had been sitting in the middle of the identities section of the old
 * file for long enough that a split "by nearest section header" would have quietly misfiled them.
 * They are single-column updates on one table and belong wherever the repository flags live.
 *
 * `mergeDuplicateIdentities` stays in db.ts with the boot sequence: it runs once, at startup,
 * before the unique index that depends on it, and it writes three tables in one transaction.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./connection.ts";
import type { Identity, IdentityInput } from "./types.ts";

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
/** Exported for the boot-time duplicate merge in db.ts, which must group by the same key this
 *  module's unique index enforces. Nothing else should need it. */
export function natKey(displayName: string, gitUsername: string, gitEmail: string): string {
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
