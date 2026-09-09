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
 * Nothing here persists across a daemon restart — an in-flight approval simply times out (the
 * agent gets the timeout error, same as it would if the owner never looked at the dashboard).
 */
import { randomUUID } from "node:crypto";
import { broadcast } from "./bus.ts";

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
    const denyTimer = denyMs != null ? setTimeout(() => settle(id, "timeout"), denyMs) : undefined;
    const approveTimer = approveMs != null ? setTimeout(() => settle(id, "approved"), approveMs) : undefined;

    pending.set(id, {
      id,
      tool,
      repo,
      argsSummary,
      requestedAt,
      expiresAt,
      autoAction,
      request,
      resolve: resolveOutcome,
      denyTimer,
      approveTimer,
    });
  });

  broadcast("approval_pending", { id, tool, repo, argsSummary, requestedAt, expiresAt, autoAction });
  return { id, result };
}

/** Settle a pending approval (human action or a timer) exactly once; a repeat/unknown id is a
 *  harmless no-op (e.g. a double-click Approve, or the entry already resolved). Clears BOTH the
 *  auto-deny and auto-approve timers so the loser can't fire after the winner. */
function settle(id: string, outcome: ApprovalOutcome): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (entry.denyTimer) clearTimeout(entry.denyTimer);
  if (entry.approveTimer) clearTimeout(entry.approveTimer);
  pending.delete(id);
  entry.resolve(outcome);
  broadcast("approval_resolved", { id, tool: entry.tool, repo: entry.repo, outcome });
  return true;
}

/** Owner approved the call from the dashboard. Returns false if `id` is no longer pending
 *  (already resolved/timed out) — the route treats that as a 404. */
export function approve(id: string): boolean {
  return settle(id, "approved");
}

/** Owner denied the call from the dashboard. Returns false if `id` is no longer pending. */
export function deny(id: string): boolean {
  return settle(id, "denied");
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
