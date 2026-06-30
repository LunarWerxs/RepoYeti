/**
 * Transport-agnostic MCP dispatch: turn one parsed JSON-RPC 2.0 message into a response object
 * (or null for a notification). Pure logic — NO io. Both transports (the stdio server and the
 * in-process HTTP endpoint) read/write the bytes and call `handleRpc`.
 *
 * Protocol (JSON-RPC 2.0 + MCP):
 *   - request:      { jsonrpc:"2.0", id, method, params }  → a result or error response
 *   - notification: { jsonrpc:"2.0", method, params }       → NO response (returns null)
 * Methods: initialize · notifications/initialized · ping · tools/list · tools/call.
 *
 * This file imports only ./tools.ts, ./backend.ts and ../config.ts (VERSION). It MUST NOT import
 * service/read/db/git-actions/vcs (the boundary guard enforces it) — the backend is injected.
 */
import { VERSION } from "../config.ts";
import type { McpBackend } from "./backend.ts";
import { TOOLS, findTool } from "./tools.ts";

const PROTOCOL_VERSION = "2024-11-05";

/** Standard JSON-RPC error codes we use. */
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/** A JSON-RPC id: a string, a number, or null (per spec). */
type RpcId = string | number | null;

interface RpcRequest {
  jsonrpc?: unknown;
  id?: RpcId;
  method?: unknown;
  params?: unknown;
}

function result(id: RpcId, value: object): object {
  return { jsonrpc: "2.0", id, result: value };
}

function errorResponse(id: RpcId, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Build a -32700 parse-error response (id null) — used by transports on malformed input. */
export function parseErrorResponse(): object {
  return errorResponse(null, ERR.PARSE, "Parse error");
}

/** The advertised tool catalog for `tools/list` (name/description/inputSchema only). */
function toolCatalog(): object {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

/**
 * Dispatch one parsed JSON-RPC message against `backend`. Returns the response object, or null
 * when the message is a notification (no `id`) — the caller must then emit nothing.
 */
export async function handleRpc(msg: unknown, backend: McpBackend): Promise<object | null> {
  if (msg === null || typeof msg !== "object") {
    return errorResponse(null, ERR.INVALID_REQUEST, "Invalid Request");
  }
  const req = msg as RpcRequest;
  const method = typeof req.method === "string" ? req.method : "";
  // A message with no `id` is a notification → never produces a response.
  const isNotification = !("id" in req) || req.id === undefined;
  const id: RpcId = isNotification ? null : (req.id ?? null);

  // Notifications: handle the ones we care about, otherwise silently ignore. Never respond.
  if (isNotification) {
    // notifications/initialized + any other notification → no response.
    return null;
  }

  switch (method) {
    case "initialize": {
      const params = (req.params ?? {}) as { protocolVersion?: unknown };
      const protocolVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
      return result(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "repoyeti", version: VERSION },
      });
    }

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, toolCatalog());

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      const tool = findTool(name);
      if (!tool) {
        return errorResponse(id, ERR.INVALID_PARAMS, `Unknown tool: ${name || "(none)"}`);
      }
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const value = await tool.run(backend, args);
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        });
      } catch (e) {
        // A tool-level failure (missing arg, dirty tree, unknown repo…) → an MCP error result,
        // NOT a JSON-RPC protocol error — the agent sees it as tool output it can react to.
        const message = e instanceof Error ? e.message : String(e);
        return result(id, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }

    default:
      return errorResponse(id, ERR.METHOD_NOT_FOUND, "Method not found");
  }
}
