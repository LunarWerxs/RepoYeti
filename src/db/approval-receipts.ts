/**
 * The durable approval-receipt ledger: one signed row per decision the MCP approval gate made
 * (src/approvals.ts, "Receipts").
 *
 * WHY IT IS PERSISTED. A phone tap is the only record that a human let an agent commit or push,
 * and the pending map it settles lives in memory. Without this table, a daemon restart erased
 * who approved which exact action, and "did I really approve that push?" had no answer. Each row
 * carries the digest of the canonical {tool, args}, so the audit names the exact action, not the
 * request's one-line summary.
 *
 * WHY approvals.ts DOES NOT IMPORT THIS. The MCP core (src/mcp/core.ts) imports approvals.ts and
 * must not reach the db layer (scripts/check-boundaries.ts), so the store is injected at boot by
 * app.ts through setReceiptStore. The type import below is erased at runtime.
 *
 * Self-contained: nothing here reaches into another domain's tables. Schema creation lives in
 * db.ts's initDb, which owns the boot sequence.
 */
import type { ApprovalReceipt, ApprovalReceiptStore, ApprovalRefusal } from "../approvals.ts";
import { getDb } from "./connection.ts";

/** Row bound, the same number as approvals.ts APPROVAL_RECEIPT_CAP. Kept local (not imported) so
 *  this module depends on approvals.ts for types only and loads none of its runtime. */
const APPROVAL_RECEIPT_ROW_CAP = 500;

interface ApprovalReceiptRow {
  id: string;
  tool: string;
  repo: string | null;
  digest: string;
  outcome: ApprovalReceipt["outcome"];
  decided_by: ApprovalReceipt["decidedBy"];
  policy_version: string;
  key_id: string;
  requested_at: number;
  decided_at: number;
  valid_until: number;
  sig: string;
  consumed_at: number | null;
  refusal: ApprovalRefusal | null;
}

const COLUMNS =
  "id, tool, repo, digest, outcome, decided_by, policy_version, key_id, requested_at, decided_at, valid_until, sig, consumed_at, refusal";

function toReceipt(r: ApprovalReceiptRow): ApprovalReceipt {
  return {
    id: r.id,
    tool: r.tool,
    repo: r.repo,
    digest: r.digest,
    outcome: r.outcome,
    decidedBy: r.decided_by,
    policyVersion: r.policy_version,
    keyId: r.key_id,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    validUntil: r.valid_until,
    sig: r.sig,
    consumedAt: r.consumed_at,
    refusal: r.refusal,
  };
}

/** The SQLite-backed receipt store app.ts injects. `consume` and `refuse` are single UPDATEs
 *  guarded by `consumed_at IS NULL`, so two racing executions cannot both use one approval. */
export const sqliteReceiptStore: ApprovalReceiptStore = {
  put(r) {
    const d = getDb();
    d.query(
      `INSERT INTO approval_receipts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.tool,
      r.repo,
      r.digest,
      r.outcome,
      r.decidedBy,
      r.policyVersion,
      r.keyId,
      r.requestedAt,
      r.decidedAt,
      r.validUntil,
      r.sig,
      r.consumedAt,
      r.refusal,
    );
    // Same OFFSET cap-1 prune as the automation ledgers, by rowid so "newest" is unambiguous.
    d.query(
      `DELETE FROM approval_receipts
       WHERE rowid < (SELECT rowid FROM approval_receipts ORDER BY rowid DESC LIMIT 1 OFFSET ?)`,
    ).run(APPROVAL_RECEIPT_ROW_CAP - 1);
  },
  get(id) {
    const row = getDb().query(`SELECT ${COLUMNS} FROM approval_receipts WHERE id = ?`).get(id) as
      | ApprovalReceiptRow
      | null;
    return row ? toReceipt(row) : null;
  },
  consume(id, at) {
    const res = getDb()
      .query(`UPDATE approval_receipts SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
      .run(at, id);
    return res.changes === 1;
  },
  refuse(id, reason, at) {
    getDb()
      .query(`UPDATE approval_receipts SET consumed_at = ?, refusal = ? WHERE id = ? AND consumed_at IS NULL`)
      .run(at, reason, id);
  },
  list(limit) {
    return (
      getDb()
        .query(`SELECT ${COLUMNS} FROM approval_receipts ORDER BY rowid DESC LIMIT ?`)
        .all(limit) as ApprovalReceiptRow[]
    ).map(toReceipt);
  },
};
