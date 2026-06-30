/**
 * The stdio MCP server: what `repoyeti mcp` runs, and what an MCP client (Claude Desktop/Code,
 * Cursor) spawns. It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout — ONE message per
 * line, no embedded newlines — and proxies every tool call to the LOCAL daemon over HTTP
 * (httpBackend → cli/client.ts).
 *
 * STDOUT is the protocol channel: only JSON-RPC responses (one per line) go there. ALL
 * diagnostics go to STDERR, so a stray log can never corrupt the stream. Partial reads are
 * buffered until a newline; a line that doesn't parse yields a -32700 parse-error response.
 */
import { handleRpc, parseErrorResponse } from "./core.ts";
import { httpBackend } from "./adapter-http.ts";

/** Process one already-trimmed line; return the JSON string to write (or null for a notification). */
export async function processLine(line: string): Promise<string | null> {
  const trimmed = line.trim();
  if (trimmed === "") return null; // blank keep-alive line — ignore
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return JSON.stringify(parseErrorResponse());
  }
  const res = await handleRpc(msg, httpBackend());
  return res ? JSON.stringify(res) : null;
}

/**
 * Read stdin as newline-delimited JSON, dispatch each line, and write each non-null response as
 * one line to stdout. Resolves when stdin closes (the client disconnected). Logging → stderr.
 */
export async function runStdioMcp(): Promise<void> {
  process.stderr.write("repoyeti mcp: stdio server ready\n");

  const decoder = new TextDecoder();
  let buffer = "";

  /** Flush every complete line currently in the buffer (keeps any trailing partial line). */
  const drain = async (): Promise<void> => {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const out = await processLine(line);
        if (out !== null) process.stdout.write(`${out}\n`);
      } catch (e) {
        // A processing failure is logged to stderr only — never poison stdout with non-protocol text.
        process.stderr.write(`repoyeti mcp: error handling line: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  };

  // Read stdin via a stream reader (well-typed across TS libs, unlike async-iterating the stream).
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    await drain();
  }
  // Stream closed: flush any final line that lacked a trailing newline.
  if (buffer.trim() !== "") {
    const out = await processLine(buffer);
    if (out !== null) process.stdout.write(out + "\n");
    buffer = "";
  }
}
