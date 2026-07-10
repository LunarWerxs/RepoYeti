/**
 * Thin adapter binding RepoYeti's MCP tool catalog + a backend to the SHARED stdio engine
 * (./mcp-stdio.mjs — part of the shared kit; keep it app-agnostic). The
 * JSON-RPC 2.0 / MCP dispatch now lives in the engine; this file only preserves RepoYeti's
 * (msg, backend) API so the same catalog can serve BOTH transports — the stdio server binds
 * `httpBackend`, the in-process POST /api/mcp binds `serviceBackend` — each injecting its backend
 * here at dispatch time.
 *
 * ⭐ Agent Safety Rail gate point: this is the ONE place both transports funnel through, so it's
 * where every MUTATING tool (readOnly:false in ./tools.ts) is wrapped to await a human
 * approve/deny (see ../approvals.ts) before the backend call ever runs. Read-only tools and
 * dashboard-originated HTTP actions (which never reach this module) are untouched.
 *
 * Boundary: imports ONLY the engine, ./tools.ts, ./backend.ts, ../config.ts (VERSION), and
 * ../approvals.ts. It MUST NOT import service/read/db/git-actions/vcs — the backend is injected
 * (the guard still holds; approvals.ts itself only imports ../bus.ts).
 */
import { VERSION } from "../config.ts";
import { handleRpc as engineHandleRpc, parseErrorResponse as engineParseError } from "./mcp-stdio.mjs";
import type { McpServerContext, McpEngineTool } from "./mcp-stdio.mjs";
import type { McpBackend } from "./backend.ts";
import { TOOLS } from "./tools.ts";
import { approvalGateEnabled, requestApproval, summarizeArgs } from "../approvals.ts";

const SERVER_INFO = { name: "repoyeti", version: VERSION };

/** Pull a best-effort repo label out of a tool's arguments for the approval card (never resolved
 *  against the backend — just what the caller passed). */
function repoArg(args: Record<string, unknown>): string | null {
  const r = args.repo;
  return typeof r === "string" && r.trim() !== "" ? r.trim() : null;
}

/**
 * Build the engine dispatch context for a backend: bind it into every tool so each matches the
 * engine's backend-agnostic `run(args)` contract. Exported so stdio.ts reuses the same binding.
 *
 * A `readOnly:false` tool's `run` is wrapped: when the gate is on, the call is registered as a
 * pending approval and the backend is only invoked after the owner approves. A deny or timeout
 * throws a plain Error (the engine turns it into an MCP `isError` result) naming the reason, so
 * the calling agent sees "denied by owner" / "approval timed out" instead of a silent hang.
 */
export function contextFor(backend: McpBackend): McpServerContext {
  const tools: McpEngineTool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    run: async (args) => {
      if (t.readOnly || !approvalGateEnabled()) return t.run(backend, args);

      const { result } = requestApproval(t.name, repoArg(args), summarizeArgs(args));
      const outcome = await result;
      if (outcome === "denied") throw new Error(`${t.name} was denied by owner`);
      if (outcome === "timeout") throw new Error(`${t.name} approval timed out`);
      return t.run(backend, args);
    },
  }));
  return { serverInfo: SERVER_INFO, tools };
}

/** Dispatch one JSON-RPC message against a backend — the (msg, backend) API the route + tests use. */
export function handleRpc(msg: unknown, backend: McpBackend): Promise<object | null> {
  return engineHandleRpc(msg, contextFor(backend));
}

/** A -32700 parse-error response (id null) — used by transports on malformed input. */
export function parseErrorResponse(): object {
  return engineParseError();
}
