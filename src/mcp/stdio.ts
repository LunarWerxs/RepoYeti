/**
 * The stdio MCP server: what `repoyeti mcp` runs, and what an MCP client (Claude Desktop/Code,
 * Cursor) spawns. It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and proxies every tool
 * call to the LOCAL daemon over HTTP (httpBackend → cli/client.ts).
 *
 * The protocol dispatch + the stdin→dispatch→stdout loop live in the SHARED engine
 * (./mcp-stdio.mjs, part of the shared kit). This file is just the thin RepoYeti binding:
 * it wires the http-backed dispatch context to the engine, and keeps `processLine` exported for the
 * unit tests. STDOUT stays the protocol channel; the engine sends all diagnostics to STDERR.
 */
import { processLine as engineProcessLine, runMcpStdio } from "./mcp-stdio.mjs";
import { contextFor } from "./core.ts";
import { httpBackend } from "./adapter-http.ts";

/** Process one already-trimmed line; return the JSON string to write (or null for a notification).
 *  Dispatches against the http-backed context (kept as a named export for the stdio unit tests). */
export function processLine(line: string): Promise<string | null> {
  return engineProcessLine(line, contextFor(httpBackend()));
}

/** Run the stdio server loop until stdin closes, proxying tool calls to the daemon over HTTP. */
export function runStdioMcp(): Promise<void> {
  return runMcpStdio(contextFor(httpBackend()));
}
