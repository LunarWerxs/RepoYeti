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
let timeoutSecs = APPROVAL_TIMEOUT_DEFAULT_S;

/** Whether the approval gate is currently active. Default ON (absent config = gated). */
export function approvalGateEnabled(): boolean {
  return gateEnabled;
}

/** Flip the gate on/off at runtime (called from app.ts boot + PUT /api/settings). */
export function setApprovalGateEnabled(value: boolean): void {
  gateEnabled = value;
}

/** Current auto-deny timeout, in seconds. */
export function getApprovalTimeoutSecs(): number {
  return timeoutSecs;
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

/** One pending (or just-resolved) approval request. Kept minimal + JSON-serialisable so it can
 *  ride straight over SSE and the approve/deny routes without a separate DTO. */
export interface PendingApproval {
  id: string;
  tool: string;
  /** Repo id/name(s) the call targets, as supplied in the tool arguments — best-effort display,
   *  not a resolved identity (the MCP backend resolves the real repo later). */
  repo: string | null;
  /** Human-readable one-line summary of the arguments (e.g. `message: "fix: …"`). Never the full
   *  raw args blob — keeps the SSE payload small and avoids echoing anything sensitive verbatim. */
  argsSummary: string;
  requestedAt: number;
  expiresAt: number;
}

interface PendingEntry extends PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/** Snapshot of every currently-pending approval, oldest first — what the dashboard hydrates from
 *  on load (SSE only carries the live deltas after that). */
export function listPending(): PendingApproval[] {
  return [...pending.values()]
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map(({ resolve: _resolve, timer: _timer, ...rest }) => rest);
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

/**
 * Register a mutating call awaiting human approval, broadcast `approval_pending`, and return a
 * promise that settles once approve()/deny() is called for `id` or `timeoutMs` elapses (auto-deny).
 * Resolves to the outcome; never rejects itself (the caller decides what each outcome means).
 */
export function requestApproval(
  tool: string,
  repo: string | null,
  argsSummary: string,
  timeoutMs: number = getApprovalTimeoutSecs() * 1000,
): { id: string; result: Promise<ApprovalOutcome> } {
  const id = randomUUID();
  const requestedAt = Date.now();
  const expiresAt = requestedAt + Math.max(1, timeoutMs);

  const result = new Promise<ApprovalOutcome>((resolveOutcome) => {
    // Deliberately NOT unref'd: the auto-deny timeout is a safety guarantee (an agent must never
    // hang past it), so it must fire even if this were somehow the only pending work keeping the
    // process alive — never silently skipped by the event loop going idle.
    const timer = setTimeout(() => settle(id, "timeout"), Math.max(1, timeoutMs));

    pending.set(id, {
      id,
      tool,
      repo,
      argsSummary,
      requestedAt,
      expiresAt,
      resolve: resolveOutcome,
      timer,
    });
  });

  broadcast("approval_pending", { id, tool, repo, argsSummary, requestedAt, expiresAt });
  return { id, result };
}

/** Settle a pending approval (human action or timeout) exactly once; a repeat/unknown id is a
 *  harmless no-op (e.g. a double-click Approve, or the entry already timed out). */
function settle(id: string, outcome: ApprovalOutcome): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
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
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
}
