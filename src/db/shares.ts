/**
 * Share links, peer collaboration links, and the share audit trail (1.0 audit, item 27).
 *
 * Lifted out of db.ts whole: this domain was already contiguous and self-contained, which is why
 * it is one of the first to move. It owns four tables (shares, share_repos, collaboration_links,
 * share_events) and reaches outside itself in exactly two places, both read-only and both
 * deliberate: `getSharedRepos` and `shareCoversRepo` query the repos table directly, because the
 * whole point of a share is to answer "which of the owner's repositories does this token see" in
 * one statement rather than by listing everything and filtering in JavaScript.
 *
 * Schema creation still lives in db.ts's initDb, which owns the boot sequence. This module owns
 * the queries.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./connection.ts";
import { getRepos } from "./repos-read.ts";
import { toView, type RepoRow, type RepoView } from "./types.ts";

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
