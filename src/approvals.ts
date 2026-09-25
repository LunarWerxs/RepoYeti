/**
 * Agent Safety Rail — the approval queue for MUTATING MCP tool calls.
 *
 * Gate point: src/mcp/core.ts's contextFor() wraps every `readOnly:false` tool's `run` so BOTH
 * MCP transports (stdio → httpBackend, in-process POST /api/mcp → serviceBackend) pass through
 * ONE approval point before the backend is ever called. Dashboard-originated HTTP actions (the
 * web UI's own buttons, e.g. POST /api/repos/:id/commit) never touch this module — they call the
 * service layer directly and are never gated.
 *
 * Shape: an in-memory pending map. A gated call creates an entry, broadcasts `approval_pending`
 * over the existing SSE bus, and awaits a promise that resolves/rejects when the dashboard calls
 * approve()/deny(), or a timer auto-denies it after `timeoutMs`. Every resolution — human or
 * timeout — broadcasts `approval_resolved` and rejects/resolves the waiting MCP call with a
 * structured Error the engine turns into an MCP `isError` result (see mcp-stdio.mjs tools/call).
 *
 * The PENDING map does not persist across a daemon restart: an in-flight approval simply times out
 * (the agent gets the timeout error, same as it would if the owner never looked at the dashboard).
 * The DECISIONS do: every settle writes a signed receipt bound to the digest of the exact
 * {tool, args} it decided on (see "Receipts" below), and the MCP gate consumes that receipt once,
 * at execution time, before the backend runs. The receipt store is injected (setReceiptStore) so
 * this module still reaches no database itself; the daemon wires the SQLite store at boot.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { broadcast } from "./bus.ts";
import { key as signingKey } from "./signing.ts";

/** Default auto-deny window (ms) when no config override is supplied. Owner-configurable via
 *  cfg.mcpApprovalTimeoutSecs (see config.ts) — the gate call site converts secs → ms. */
export const APPROVAL_TIMEOUT_DEFAULT_MS = 120_000;
/** Owner-configurable timeout bounds (seconds): 10s floor (still gives the dashboard a fair
 *  shot), 1h ceiling (an agent shouldn't hang indefinitely). Mirrors auto-commit.ts's clamp style. */
export const APPROVAL_TIMEOUT_MIN_S = 10;
export const APPROVAL_TIMEOUT_MAX_S = 3_600;
export const APPROVAL_TIMEOUT_DEFAULT_S = APPROVAL_TIMEOUT_DEFAULT_MS / 1000;

export type ApprovalOutcome = "approved" | "denied" | "timeout";

// ── runtime state (mirrors cfg.mcpApprovalGate*; primed at boot in app.ts + the settings toggle,
// same shape as auto-commit.ts's enabled/intervalSecs pair) ──
let gateEnabled = true; // ON by default — the whole point of the feature is to be safe out of the box
let autoDenyEnabled = true; // ON by default — preserves the historic always-times-out-and-denies behavior
let timeoutSecs = APPROVAL_TIMEOUT_DEFAULT_S; // the auto-DENY duration
let autoApproveEnabled = false; // OFF by default — auto-approving mutations is opt-in (human-in-the-loop is the point)
let approveTimeoutSecs = APPROVAL_TIMEOUT_DEFAULT_S; // the auto-APPROVE duration

/** Whether the approval gate is currently active. Default ON (absent config = gated). */
export function approvalGateEnabled(): boolean {
  return gateEnabled;
}

/** Flip the gate on/off at runtime (called from app.ts boot + PUT /api/settings). */
export function setApprovalGateEnabled(value: boolean): void {
  gateEnabled = value;
}

/** Whether a pending request auto-denies once its deny timeout elapses. */
export function autoDenyIsEnabled(): boolean {
  return autoDenyEnabled;
}

/** Flip auto-deny on/off at runtime. */
export function setAutoDenyEnabled(value: boolean): void {
  autoDenyEnabled = value;
}

/** Whether a pending request auto-approves once its approve timeout elapses. */
export function autoApproveIsEnabled(): boolean {
  return autoApproveEnabled;
}

/** Flip auto-approve on/off at runtime. */
export function setAutoApproveEnabled(value: boolean): void {
  autoApproveEnabled = value;
}

/** Current auto-deny timeout, in seconds. */
export function getApprovalTimeoutSecs(): number {
  return timeoutSecs;
}

/** Current auto-approve timeout, in seconds. */
export function getApproveTimeoutSecs(): number {
  return approveTimeoutSecs;
}

/** Clamp a requested timeout into [MIN, MAX] seconds; a non-finite value falls back to the default. */
export function clampApprovalTimeoutSecs(secs: number): number {
  if (!Number.isFinite(secs)) return APPROVAL_TIMEOUT_DEFAULT_S;
  return Math.min(APPROVAL_TIMEOUT_MAX_S, Math.max(APPROVAL_TIMEOUT_MIN_S, Math.round(secs)));
}

/** Set the auto-deny timeout in seconds (clamped). Returns the clamped value to persist. */
export function setApprovalTimeoutSecs(secs: number): number {
  timeoutSecs = clampApprovalTimeoutSecs(secs);
  return timeoutSecs;
}

/** Set the auto-approve timeout in seconds (clamped). Returns the clamped value to persist. */
export function setApproveTimeoutSecs(secs: number): number {
  approveTimeoutSecs = clampApprovalTimeoutSecs(secs);
  return approveTimeoutSecs;
}

/** One pending (or just-resolved) approval request. Kept minimal + JSON-serialisable so it can
 *  ride straight over SSE and the approve/deny routes without a separate DTO. */
export interface PendingApproval {
  id: string;
  tool: string;
  /** Repo id/name(s) the call targets, as supplied in the tool arguments — best-effort display,
   *  not a resolved identity (the MCP backend resolves the real repo later). */
  repo: string | null;
  /** Human-readable one-line summary of the arguments (e.g. `message: "fix: …"`). Never the full
   *  raw args blob — keeps the SSE payload small and avoids echoing anything sensitive verbatim.
   *  The complete (bounded, secret-redacted) request is served on demand by GET /api/approvals/:id
   *  (see `pendingRequest`), so the owner can read exactly what they are approving. */
  argsSummary: string;
  requestedAt: number;
  /** When the soonest armed auto-resolution fires (0 when neither auto-deny nor auto-approve is on,
   *  i.e. the request waits for a manual decision indefinitely). Drives the dashboard countdown. */
  expiresAt: number;
  /** What the `expiresAt` timer will do — so the card can say "Auto-approve in Xs" vs "Auto-deny in
   *  Xs", or hide the countdown entirely (null = no timer armed). */
  autoAction: "approve" | "deny" | null;
  /** sha256 of the canonical {tool, args} this request will run with (actionDigest). The receipt
   *  the owner's decision produces carries the same value, and execution refuses any other. */
  digest: string;
}

/**
 * The full request behind a pending approval, as the owner may inspect it: the tool name and its
 * arguments, bounded and with secret-looking fields hidden. This is the request that WILL run if
 * approved (the entry is created from the same `args` object the tool is later invoked with), so
 * reading it is informed approval; the 80-character `argsSummary` is not (1.0 audit, item 13).
 */
export interface ApprovalRequestView {
  tool: string;
  /** Arguments as supplied, minus `repo` (shown separately). Strings and serialised values are
   *  clipped at APPROVAL_ARG_VALUE_MAX characters; secret-looking keys hold "[hidden]". */
  args: Record<string, unknown>;
  /** True when anything was clipped or dropped for size — the view is then a prefix, not the whole. */
  truncated: boolean;
  /** Keys whose values were replaced by "[hidden]" (named so the owner knows a field exists). */
  hidden: string[];
}

interface PendingEntry extends PendingApproval {
  request: ApprovalRequestView;
  resolve: (outcome: ApprovalOutcome) => void;
  denyTimer?: ReturnType<typeof setTimeout>;
  approveTimer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/** Snapshot of every currently-pending approval, oldest first — what the dashboard hydrates from
 *  on load (SSE only carries the live deltas after that). */
export function listPending(): PendingApproval[] {
  return [...pending.values()]
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map(({ resolve: _resolve, denyTimer: _d, approveTimer: _a, request: _r, ...rest }) => rest);
}

/** One pending approval with its full bounded request, or null when `id` is not pending. */
export function pendingRequest(id: string): (PendingApproval & { request: ApprovalRequestView }) | null {
  const entry = pending.get(id);
  if (!entry) return null;
  const { resolve: _resolve, denyTimer: _d, approveTimer: _a, ...rest } = entry;
  return rest;
}

/** Best-effort single-line summary of a tool's arguments for display — never dumps the raw
 *  object (keeps secrets/large blobs like commit messages readably short and bounded). */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === "repo" || value === undefined) continue;
    const s = typeof value === "string" ? value : JSON.stringify(value);
    const clipped = s.length > 80 ? `${s.slice(0, 77)}...` : s;
    parts.push(`${key}: ${clipped}`);
  }
  return parts.join(", ") || "(no arguments)";
}

/** Per-value and whole-request ceilings for the stored request view. A commit message or a
 *  branch name is far below both; the ceilings exist so an agent cannot park megabytes in the
 *  daemon's memory (or the owner's phone) by asking for approval. */
export const APPROVAL_ARG_VALUE_MAX = 4_096;
export const APPROVAL_ARGS_TOTAL_MAX = 32_768;
/** Argument names whose values are never stored or shown: the owner needs to know the field is
 *  there, never its bytes. Matches the MCP tools' own vocabulary and the obvious variants. */
const HIDDEN_ARG = /token|secret|password|passphrase|credential|authorization|api[-_]?key/i;

/**
 * Bound and redact a tool's arguments for storage and display. Deterministic and pure; exported
 * for tests. `repo` is omitted (it is shown separately as the card's repo label).
 */
export function boundedArgs(args: Record<string, unknown>): Omit<ApprovalRequestView, "tool"> {
  const out: Record<string, unknown> = {};
  const hidden: string[] = [];
  let truncated = false;
  let total = 0;
  for (const [key, value] of Object.entries(args)) {
    if (key === "repo" || value === undefined) continue;
    let stored: unknown;
    if (HIDDEN_ARG.test(key)) {
      stored = "[hidden]";
      hidden.push(key);
    } else if (typeof value === "string") {
      stored = value.length > APPROVAL_ARG_VALUE_MAX ? value.slice(0, APPROVAL_ARG_VALUE_MAX) : value;
      if (stored !== value) truncated = true;
    } else {
      const json = JSON.stringify(value) ?? "null";
      if (json.length > APPROVAL_ARG_VALUE_MAX) {
        stored = json.slice(0, APPROVAL_ARG_VALUE_MAX);
        truncated = true;
      } else {
        stored = value;
      }
    }
    const cost = key.length + (typeof stored === "string" ? stored.length : (JSON.stringify(stored) ?? "").length);
    if (total + cost > APPROVAL_ARGS_TOTAL_MAX) {
      truncated = true;
      break; // keep what fits, in argument order; the flag says the rest was dropped
    }
    total += cost;
    out[key] = stored;
  }
  return { args: out, truncated, hidden };
}

/**
 * Register a mutating call awaiting human approval, broadcast `approval_pending`, and return a
 * promise that settles once approve()/deny() is called for `id` or `timeoutMs` elapses (auto-deny).
 * Resolves to the outcome; never rejects itself (the caller decides what each outcome means).
 */
export function requestApproval(
  tool: string,
  repo: string | null,
  argsSummary: string,
  timeoutMs?: number,
  /** The tool's full arguments, stored bounded + redacted for GET /api/approvals/:id. Optional
   *  only for callers that have no arguments to show (tests); the MCP gate always passes them. */
  args: Record<string, unknown> = {},
): { id: string; result: Promise<ApprovalOutcome> } {
  const id = randomUUID();
  const requestedAt = Date.now();
  const request: ApprovalRequestView = { tool, ...boundedArgs(args) };
  // Digest the FULL arguments, not the bounded view: the view may clip or hide, the digest must
  // pin every byte the backend will be handed.
  const digest = actionDigest(tool, args);

  // Two independent, optional auto-resolution timers:
  //  · auto-DENY   — armed when enabled (or when an explicit `timeoutMs` override is passed, which
  //    the tests use for fast, deterministic auto-deny). Resolves the call to "timeout" (= denial).
  //  · auto-APPROVE — armed only when the owner opts in. Resolves the call to "approved".
  // When both are armed, whichever fires first wins (settle() clears the other). When NEITHER is
  // armed, the request simply waits for a manual approve/deny — no timer, no auto-resolution.
  const denyMs =
    timeoutMs != null ? Math.max(1, timeoutMs) : autoDenyEnabled ? Math.max(1, timeoutSecs * 1000) : null;
  const approveMs = autoApproveEnabled ? Math.max(1, approveTimeoutSecs * 1000) : null;

  // The soonest armed timer decides the card's countdown label + expiry (deny wins a tie).
  let autoAction: "approve" | "deny" | null = null;
  let expiresAt = 0;
  if (denyMs != null && (approveMs == null || denyMs <= approveMs)) {
    autoAction = "deny";
    expiresAt = requestedAt + denyMs;
  } else if (approveMs != null) {
    autoAction = "approve";
    expiresAt = requestedAt + approveMs;
  }

  const result = new Promise<ApprovalOutcome>((resolveOutcome) => {
    // Deliberately NOT unref'd: an armed auto-resolution is a safety guarantee (an agent must never
    // hang past it), so it must fire even if this were somehow the only pending work keeping the
    // process alive — never silently skipped by the event loop going idle.
    const denyTimer = denyMs != null ? setTimeout(() => settle(id, "timeout", "auto-deny"), denyMs) : undefined;
    const approveTimer =
      approveMs != null ? setTimeout(() => settle(id, "approved", "auto-approve"), approveMs) : undefined;

    pending.set(id, {
      id,
      tool,
      repo,
      argsSummary,
      requestedAt,
      expiresAt,
      autoAction,
      digest,
      request,
      resolve: resolveOutcome,
      denyTimer,
      approveTimer,
    });
  });

  broadcast("approval_pending", { id, tool, repo, argsSummary, requestedAt, expiresAt, autoAction, digest });
  return { id, result };
}

/** Settle a pending approval (human action or a timer) exactly once; a repeat/unknown id is a
 *  harmless no-op (e.g. a double-click Approve, or the entry already resolved). Clears BOTH the
 *  auto-deny and auto-approve timers so the loser can't fire after the winner. The signed receipt
 *  is written BEFORE the waiting call is resolved, so the gate always finds it when it looks. */
function settle(id: string, outcome: ApprovalOutcome, decidedBy: ApprovalDecider): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (entry.denyTimer) clearTimeout(entry.denyTimer);
  if (entry.approveTimer) clearTimeout(entry.approveTimer);
  pending.delete(id);
  recordReceipt(entry, outcome, decidedBy);
  entry.resolve(outcome);
  broadcast("approval_resolved", { id, tool: entry.tool, repo: entry.repo, outcome });
  return true;
}

/** Owner approved the call from the dashboard. Returns false if `id` is no longer pending
 *  (already resolved/timed out) — the route treats that as a 404. */
export function approve(id: string): boolean {
  return settle(id, "approved", "owner");
}

/** Owner denied the call from the dashboard. Returns false if `id` is no longer pending. */
export function deny(id: string): boolean {
  return settle(id, "denied", "owner");
}

// ── Receipts: an approval bound to the exact action it approved ─────────────────────────
//
// WHY. The gate used to approve a REQUEST: a promise resolved "approved" and the caller ran
// whatever `args` it was holding by then. Nothing tied the decision to the bytes the owner read,
// nothing stopped a decision from being used twice, and nothing survived a restart to say who
// approved which exact thing from a phone. Now each decision is a signed receipt over the sha256
// of the canonical {tool, args}, and the gate consumes it once, at execution, refusing with a
// distinct reason for each way it can be wrong.
//
// Idea from microsoft/ai-agents-for-beginners, 18-securing-ai-agents
// (human-authorization-receipts, MIT): receipt over a JCS digest, policy version, key id and
// expiry, verified with one reason per failure and a one-time consumption set. Written fresh
// for RepoYeti; the "key registry" here is the daemon's own signing key.

/** Who settled a request. "owner" is a human tap (dashboard or phone); the other two are timers. */
export type ApprovalDecider = "owner" | "auto-approve" | "auto-deny";

/** Why the gate refused to run an action, one reason per failure so the operator can tell a
 *  tampered request from a stale one. */
export type ApprovalRefusal =
  | "unknown" // no receipt for this id (never decided, or it was never stored)
  | "not-approved" // the receipt records a deny or a timeout
  | "rotated-key" // signed under a key the daemon no longer holds ("sign out everywhere")
  | "bad-signature" // the stored receipt was altered after signing
  | "replayed" // already consumed, or burned by an earlier refusal
  | "digest-mismatch" // the tool or arguments differ from what was approved
  | "stale-policy" // the gate's policy changed between the decision and the execution
  | "expired"; // executed later than APPROVAL_RECEIPT_TTL_MS after the decision

export interface ApprovalReceipt {
  id: string;
  tool: string;
  repo: string | null;
  digest: string;
  outcome: ApprovalOutcome;
  decidedBy: ApprovalDecider;
  policyVersion: string;
  keyId: string;
  requestedAt: number;
  decidedAt: number;
  validUntil: number;
  /** base64url HMAC-SHA256 over the canonical form of every field above. */
  sig: string;
  /** When the gate used it (or burned it with a refusal); null while unused. Not signed: it is
   *  the one field that legitimately changes after the decision. */
  consumedAt: number | null;
  refusal: ApprovalRefusal | null;
}

/** Where receipts live. The daemon injects the SQLite store at boot (src/db/approval-receipts.ts);
 *  the in-memory default keeps this module usable, and the gate fail-closed, without a database. */
export interface ApprovalReceiptStore {
  put(receipt: ApprovalReceipt): void;
  get(id: string): ApprovalReceipt | null;
  /** Mark unused -> used in one atomic step; false when it was already used. The single-use rule. */
  consume(id: string, at: number): boolean;
  /** Burn an unused receipt with the reason it was refused, so it can never run afterwards. */
  refuse(id: string, reason: ApprovalRefusal, at: number): void;
  /** Newest first. */
  list(limit: number): ApprovalReceipt[];
}

/** How long an approval stays executable after the decision. The gate runs the action in the
 *  same tick it learns the outcome, so this only bites a path that stalled, and a stalled
 *  approval is not the one the owner meant to give. */
export const APPROVAL_RECEIPT_TTL_MS = 30_000;
/** Housekeeping bound for either store, same posture as the automation ledgers. */
export const APPROVAL_RECEIPT_CAP = 500;
/** Bump when the meaning of a receipt changes, so an older receipt reads as stale-policy. */
const APPROVAL_POLICY_SCHEMA = 1;

function memoryReceiptStore(): ApprovalReceiptStore {
  const rows = new Map<string, ApprovalReceipt>();
  return {
    put(r) {
      rows.set(r.id, { ...r });
      while (rows.size > APPROVAL_RECEIPT_CAP) rows.delete(rows.keys().next().value as string);
    },
    get(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    consume(id, at) {
      const r = rows.get(id);
      if (!r || r.consumedAt != null) return false;
      r.consumedAt = at;
      return true;
    },
    refuse(id, reason, at) {
      const r = rows.get(id);
      if (!r || r.consumedAt != null) return;
      r.consumedAt = at;
      r.refusal = reason;
    },
    list(limit) {
      return [...rows.values()].reverse().slice(0, limit).map((r) => ({ ...r }));
    },
  };
}

let receiptStore: ApprovalReceiptStore = memoryReceiptStore();

/** Swap the receipt store (app.ts wires SQLite at boot; tests pass a fresh one). */
export function setReceiptStore(store: ApprovalReceiptStore): void {
  receiptStore = store;
}

/** Test helper: a fresh in-memory store, so specs never see each other's receipts. */
export function resetReceiptStore(): void {
  receiptStore = memoryReceiptStore();
}

/**
 * Canonical JSON, RFC 8785 (JCS) for the values MCP arguments can hold: object keys sorted by
 * UTF-16 code unit (what Array.prototype.sort does), no whitespace, `undefined` members dropped
 * as JSON.stringify drops them, numbers in ECMAScript form. Anything that is not plain JSON
 * throws rather than digesting to something the owner never saw.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** sha256 (hex) of the canonical {tool, args}: the identity of one exact action. */
export function actionDigest(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ tool, args })).digest("hex");
}

/** A receipt key derived from the daemon's signing key, never the key itself: a receipt MAC can
 *  then never double as a session-cookie MAC, and "sign out everywhere" (rotateKey) retires
 *  every receipt key along with every session. */
function receiptKey(): Buffer {
  return createHmac("sha256", signingKey()).update("repoyeti approval receipt v1").digest();
}

function keyIdOf(k: Buffer): string {
  return createHash("sha256").update(k).digest("hex").slice(0, 16);
}

/** The gate policy a decision was made under: which automatic verdicts could have produced it. */
export function approvalPolicyVersion(): string {
  const policy = { v: APPROVAL_POLICY_SCHEMA, gate: gateEnabled, autoDeny: autoDenyEnabled, autoApprove: autoApproveEnabled };
  return createHash("sha256").update(canonicalJson(policy)).digest("hex").slice(0, 16);
}

function receiptMac(r: Omit<ApprovalReceipt, "sig" | "consumedAt" | "refusal">, k: Buffer): string {
  const signed = {
    id: r.id,
    tool: r.tool,
    repo: r.repo,
    digest: r.digest,
    outcome: r.outcome,
    decidedBy: r.decidedBy,
    policyVersion: r.policyVersion,
    keyId: r.keyId,
    requestedAt: r.requestedAt,
    decidedAt: r.decidedAt,
    validUntil: r.validUntil,
  };
  return createHmac("sha256", k).update(canonicalJson(signed)).digest("base64url");
}

function macMatches(r: ApprovalReceipt, k: Buffer): boolean {
  const a = Buffer.from(r.sig);
  const b = Buffer.from(receiptMac(r, k));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sign and store the receipt for one decision. A storage failure is logged, not thrown: the
 *  gate then finds no receipt and refuses ("unknown"), which is the safe way to fail. */
function recordReceipt(entry: PendingEntry, outcome: ApprovalOutcome, decidedBy: ApprovalDecider): void {
  try {
    const k = receiptKey();
    const decidedAt = Date.now();
    const unsigned = {
      id: entry.id,
      tool: entry.tool,
      repo: entry.repo,
      digest: entry.digest,
      outcome,
      decidedBy,
      policyVersion: approvalPolicyVersion(),
      keyId: keyIdOf(k),
      requestedAt: entry.requestedAt,
      decidedAt,
      validUntil: decidedAt + APPROVAL_RECEIPT_TTL_MS,
    };
    receiptStore.put({ ...unsigned, sig: receiptMac(unsigned, k), consumedAt: null, refusal: null });
  } catch (e) {
    console.error("[repoyeti] failed to record approval receipt:", e);
  }
}

export type ApprovalVerdict = { ok: true; receipt: ApprovalReceipt } | { ok: false; reason: ApprovalRefusal };

/**
 * The execution-time check: may the action `{tool, args}` run on the strength of decision `id`?
 * Consumes the receipt on success (single use). A refusal burns an unused receipt with its reason,
 * so a retry with the originally approved arguments cannot ride the same decision either.
 */
export function consumeApproval(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  now: number = Date.now(),
): ApprovalVerdict {
  const r = receiptStore.get(id);
  if (!r) return { ok: false, reason: "unknown" };
  const refuse = (reason: ApprovalRefusal): ApprovalVerdict => {
    receiptStore.refuse(id, reason, now);
    return { ok: false, reason };
  };
  const k = receiptKey();
  // Key before signature: after a rotation every signature fails, and "rotated" is the reason.
  if (r.keyId !== keyIdOf(k)) return refuse("rotated-key");
  if (!macMatches(r, k)) return refuse("bad-signature");
  if (r.consumedAt != null) return { ok: false, reason: "replayed" };
  if (r.outcome !== "approved") return refuse("not-approved");
  if (r.tool !== tool || r.digest !== actionDigest(tool, args)) return refuse("digest-mismatch");
  if (r.policyVersion !== approvalPolicyVersion()) return refuse("stale-policy");
  if (now > r.validUntil) return refuse("expired");
  if (!receiptStore.consume(id, now)) return { ok: false, reason: "replayed" };
  return { ok: true, receipt: { ...r, consumedAt: now } };
}

/** A stored receipt as the owner audits it, with whether its signature still verifies. */
export interface ApprovalReceiptAudit extends ApprovalReceipt {
  /** "retired-key": signed under a key since rotated, so it can no longer be checked. */
  verified: "ok" | "bad-signature" | "retired-key";
}

/** Newest decisions first, each re-verified against the current key. */
export function listReceipts(limit = 100): ApprovalReceiptAudit[] {
  const k = receiptKey();
  const currentKeyId = keyIdOf(k);
  const n = Math.max(1, Math.min(Math.floor(limit) || 100, APPROVAL_RECEIPT_CAP));
  return receiptStore.list(n).map((r): ApprovalReceiptAudit => ({
    ...r,
    verified: r.keyId !== currentKeyId ? "retired-key" : macMatches(r, k) ? "ok" : "bad-signature",
  }));
}

/** Test/shutdown helper: clear every pending approval (and its timer) without resolving the
 *  waiting callers — used for deterministic test teardown between specs. */
export function clearAllPending(): void {
  for (const entry of pending.values()) {
    if (entry.denyTimer) clearTimeout(entry.denyTimer);
    if (entry.approveTimer) clearTimeout(entry.approveTimer);
  }
  pending.clear();
}
