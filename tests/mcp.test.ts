import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { handleRpc } from "../src/mcp/core.ts";
import { serviceBackend } from "../src/mcp/adapter-service.ts";
import { processLine } from "../src/mcp/stdio.ts";
import { TOOLS } from "../src/mcp/tools.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { VERSION } from "../src/config.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

const backend = serviceBackend();

// ── protocol: initialize ──────────────────────────────────────────────────────────
test("initialize echoes protocolVersion and reports serverInfo.name 'repoyeti'", async () => {
  const res = (await handleRpc(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    backend,
  )) as { id: number; result: { protocolVersion: string; capabilities: object; serverInfo: { name: string; version: string } } };

  expect(res.id).toBe(1);
  expect(res.result.protocolVersion).toBe("2025-03-26");
  expect(res.result.capabilities).toEqual({ tools: {} });
  expect(res.result.serverInfo.name).toBe("repoyeti");
  expect(res.result.serverInfo.version).toBe(VERSION);
});

test("initialize falls back to the default protocolVersion when none is supplied", async () => {
  const res = (await handleRpc(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    backend,
  )) as { result: { protocolVersion: string } };
  expect(res.result.protocolVersion).toBe("2024-11-05");
});

test("ping returns an empty result", async () => {
  const res = (await handleRpc({ jsonrpc: "2.0", id: 7, method: "ping" }, backend)) as {
    id: number;
    result: object;
  };
  expect(res.id).toBe(7);
  expect(res.result).toEqual({});
});

// ── protocol: tools/list ────────────────────────────────────────────────────────────
test("tools/list returns the catalog including the key tools", async () => {
  const res = (await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, backend)) as {
    result: { tools: Array<{ name: string; description: string; inputSchema: object }> };
  };
  const names = res.result.tools.map((t) => t.name);
  for (const expected of [
    "list_repos",
    "repo_changes",
    "git_log",
    "git_commit",
    "list_branches",
    "drift",
    "list_collaborations",
    "collaboration_status",
    "collaboration_diff",
    "collaboration_commit_sync",
  ]) {
    expect(names).toContain(expected);
  }
  // Every advertised tool carries a description + a JSON-Schema inputSchema.
  for (const t of res.result.tools) {
    expect(typeof t.description).toBe("string");
    expect((t.inputSchema as { type: string }).type).toBe("object");
  }
  expect(res.result.tools.length).toBe(TOOLS.length);
});

test("collaboration MCP reads are read-only, while remote commit+sync uses the approval rail", () => {
  expect(TOOLS.find((tool) => tool.name === "list_collaborations")?.readOnly).toBe(true);
  expect(TOOLS.find((tool) => tool.name === "collaboration_status")?.readOnly).toBe(true);
  expect(TOOLS.find((tool) => tool.name === "collaboration_diff")?.readOnly).toBe(true);
  expect(TOOLS.find((tool) => tool.name === "collaboration_commit_sync")?.readOnly).toBe(false);
});

// ── protocol: tools/call (service backend against a seeded repo) ───────────────────────
test("tools/call list_repos returns content listing a seeded repo", async () => {
  const path = mkScratchDir("gm-mcp-list-");
  const id = mustUpsertRepo(path, "mcp-list-repo", "auto", false);

  const res = (await handleRpc(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_repos", arguments: {} } },
    backend,
  )) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };

  expect(res.result.isError).toBeUndefined();
  expect(res.result.content[0]!.type).toBe("text");
  const payload = JSON.parse(res.result.content[0]!.text) as { repos: Array<{ id: string; name: string }> };
  expect(payload.repos.some((r) => r.id === id && r.name === "mcp-list-repo")).toBe(true);
});

test("tools/call repo_status resolves a seeded repo by name", async () => {
  const path = mkScratchDir("gm-mcp-status-");
  mustUpsertRepo(path, "mcp-status-repo", "auto", false);

  const res = (await handleRpc(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "repo_status", arguments: { repo: "mcp-status-repo" } },
    },
    backend,
  )) as { result: { content: Array<{ text: string }>; isError?: boolean } };

  expect(res.result.isError).toBeUndefined();
  const payload = JSON.parse(res.result.content[0]!.text) as { name: string };
  expect(payload.name).toBe("mcp-status-repo");
});

test("tools/call repo_changes discovers dirty paths", async () => {
  const path = mkScratchDir("gm-mcp-changes-");
  await $`git -c init.defaultBranch=main init -q ${path}`.quiet();
  await $`git -C ${path} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  writeFileSync(join(path, "new-file.txt"), "pending work\n");
  mustUpsertRepo(path, "mcp-changes-repo", "auto", false);

  const res = (await handleRpc(
    {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: { name: "repo_changes", arguments: { repo: "mcp-changes-repo" } },
    },
    backend,
  )) as {
    result: {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
  };

  expect(res.result.isError).toBeUndefined();
  const payload = JSON.parse(res.result.content[0]!.text) as { files: Array<{ path: string }> };
  expect(payload.files.map((file) => file.path)).toContain("new-file.txt");
});

test("tools/call with a missing required arg comes back as an error result (isError)", async () => {
  const res = (await handleRpc(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "repo_status", arguments: {} } },
    backend,
  )) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0]!.text).toContain("repo");
});

test("tools/call of an unknown tool → JSON-RPC error -32602", async () => {
  const res = (await handleRpc(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
    backend,
  )) as { error?: { code: number; message: string } };
  expect(res.error?.code).toBe(-32602);
});

// ── protocol: error / notification handling ──────────────────────────────────────────
test("an unknown method → JSON-RPC error -32601", async () => {
  const res = (await handleRpc({ jsonrpc: "2.0", id: 9, method: "does/not/exist" }, backend)) as {
    error?: { code: number; message: string };
  };
  expect(res.error?.code).toBe(-32601);
  expect(res.error?.message).toBe("Method not found");
});

test("a notification (no id) yields no response (null)", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, backend);
  expect(res).toBeNull();
});

// ── stdio framing: two newline-delimited messages → two responses ──────────────────────
test("stdio framing: two newline-delimited messages produce two responses", async () => {
  const frame = (s: string): string[] => s.split("\n");
  const input =
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }) +
    "\n";

  const outputs: string[] = [];
  for (const line of frame(input)) {
    if (line.trim() === "") continue;
    const out = await processLine(line);
    if (out !== null) outputs.push(out);
  }

  expect(outputs.length).toBe(2);
  const first = JSON.parse(outputs[0]!) as { id: number; result: object };
  const second = JSON.parse(outputs[1]!) as { id: number; result: { serverInfo: { name: string } } };
  expect(first.id).toBe(1);
  expect(first.result).toEqual({});
  expect(second.id).toBe(2);
  expect(second.result.serverInfo.name).toBe("repoyeti");
});

test("stdio processLine returns a -32700 parse error for malformed JSON", async () => {
  const out = await processLine("{ not json");
  expect(out).not.toBeNull();
  const res = JSON.parse(out!) as { error: { code: number } };
  expect(res.error.code).toBe(-32700);
});
