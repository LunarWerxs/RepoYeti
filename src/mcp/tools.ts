/**
 * The MCP tool catalog — one tool per McpBackend operation, with a JSON-Schema `inputSchema`
 * (what `tools/list` advertises) and a `run` that validates args and calls the backend.
 *
 * Tools are transport-agnostic: the same catalog is dispatched by core.ts over BOTH the stdio
 * server (→ httpBackend) and the in-process HTTP endpoint (→ serviceBackend). `readOnly` tags the
 * non-mutating tools; mutating tools also say "MUTATES" in their description so an agent (and the
 * human approving its calls) can tell them apart.
 *
 * This file is pure: it imports only ./backend.ts and MUST NOT touch service/read/db/git-actions/vcs
 * (the boundary guard enforces it).
 */
import type { McpBackend, LogOptions } from "./backend.ts";

/** A JSON Schema object describing a tool's arguments (a subset — what we emit). */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** One MCP tool: metadata for `tools/list` plus the `run` invoked by `tools/call`. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True for non-mutating tools (no working-tree / remote change). */
  readOnly: boolean;
  /** Validate `args`, then call the backend. Throws on a missing required arg or a tool failure. */
  run(backend: McpBackend, args: Record<string, unknown>): Promise<unknown>;
}

/** Pull a required string arg, trimming; throw a tool-level Error when missing/blank. */
function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`missing required argument "${key}" (expected a non-empty string)`);
  }
  return v.trim();
}

/** Pull an optional boolean arg (default false); a non-boolean is coerced loosely. */
function optBool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  return v === true || v === "true";
}

/** A common single-`repo` input schema, reused by the many repo-scoped tools. */
const repoOnlySchema = (): JsonSchema => ({
  type: "object",
  properties: {
    repo: { type: "string", description: "Repository id, name, or folder basename." },
  },
  required: ["repo"],
  additionalProperties: false,
});

export const TOOLS: McpTool[] = [
  {
    name: "list_repos",
    description: "List every repository RepoYeti knows about (id, name, path, vcs, cached status).",
    readOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (b) => b.listRepos(),
  },
  {
    name: "repo_status",
    description: "Get one repository's status block: branch, dirty count, ahead/behind, remote.",
    readOnly: true,
    inputSchema: repoOnlySchema(),
    run: (b, a) => b.repoStatus(reqString(a, "repo")),
  },
  {
    name: "git_log",
    description: "List a repository's commit history (newest first). Optional limit and merge filter.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository id, name, or folder basename." },
        limit: { type: "number", description: "Max commits to return (page size)." },
        merges: {
          type: "string",
          enum: ["only", "exclude"],
          description: "'only' for just merges, 'exclude' to drop them; omit for all.",
        },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    run: (b, a) => {
      const opts: LogOptions = {};
      if (typeof a.limit === "number" && Number.isFinite(a.limit)) opts.limit = a.limit;
      if (a.merges === "only" || a.merges === "exclude") opts.merges = a.merges;
      return b.log(reqString(a, "repo"), opts);
    },
  },
  {
    name: "list_branches",
    description: "List a repository's local branches with their upstream and ahead/behind counts.",
    readOnly: true,
    inputSchema: repoOnlySchema(),
    run: (b, a) => b.branches(reqString(a, "repo")),
  },
  {
    name: "git_diff",
    description: "Show the diff (HEAD vs working tree) of one changed file in a repository.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository id, name, or folder basename." },
        path: { type: "string", description: "Repo-relative path of the changed file." },
      },
      required: ["repo", "path"],
      additionalProperties: false,
    },
    run: (b, a) => b.diff(reqString(a, "repo"), reqString(a, "path")),
  },
  {
    name: "git_search",
    description: "Search the content of a repository's changed files for a query string.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository id, name, or folder basename." },
        query: { type: "string", description: "Text to search for (min 3 chars)." },
      },
      required: ["repo", "query"],
      additionalProperties: false,
    },
    run: (b, a) => b.search(reqString(a, "repo"), reqString(a, "query")),
  },
  {
    name: "list_stashes",
    description: "List a repository's stash entries.",
    readOnly: true,
    inputSchema: repoOnlySchema(),
    run: (b, a) => b.listStashes(reqString(a, "repo")),
  },
  {
    name: "drift",
    description: "List every repository that is currently ahead of or behind its remote.",
    readOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (b) => b.drift(),
  },
  {
    name: "triage_briefing",
    description:
      "One compact 'what needs attention across all repos' snapshot: conflicted/mid-git-operation " +
      "repos, repos ahead/behind their remote, repos the auto-commit timer would currently skip, " +
      "and repos with uncommitted changes. Grouped arrays, each entry {id, name, branch, reason}.",
    readOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (b) => b.triageBriefing(),
  },
  {
    name: "git_commit",
    description: "MUTATES: commit a repository's working tree with the given message (optionally amend).",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository id, name, or folder basename." },
        message: { type: "string", description: "Commit message." },
        amend: { type: "boolean", description: "Amend the previous commit instead of creating a new one." },
      },
      required: ["repo", "message"],
      additionalProperties: false,
    },
    run: (b, a) => b.commit(reqString(a, "repo"), reqString(a, "message"), optBool(a, "amend")),
  },
  {
    name: "create_branch",
    description: "MUTATES: create a new branch in a repository (optionally switch to it).",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository id, name, or folder basename." },
        name: { type: "string", description: "New branch name." },
        switch: { type: "boolean", description: "Switch to the new branch after creating it (default true)." },
      },
      required: ["repo", "name"],
      additionalProperties: false,
    },
    run: (b, a) => {
      const switchTo = a.switch === undefined ? true : optBool(a, "switch");
      return b.createBranch(reqString(a, "repo"), reqString(a, "name"), switchTo);
    },
  },
  {
    name: "git_checkout",
    description: "MUTATES: switch a repository to an existing branch.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository id, name, or folder basename." },
        branch: { type: "string", description: "Branch to switch to." },
      },
      required: ["repo", "branch"],
      additionalProperties: false,
    },
    run: (b, a) => b.checkout(reqString(a, "repo"), reqString(a, "branch")),
  },
  {
    name: "git_push",
    description: "MUTATES: push a repository to its remote.",
    readOnly: false,
    inputSchema: repoOnlySchema(),
    run: (b, a) => b.push(reqString(a, "repo")),
  },
  {
    name: "git_pull",
    description: "MUTATES: pull (fast-forward) a repository from its remote.",
    readOnly: false,
    inputSchema: repoOnlySchema(),
    run: (b, a) => b.pull(reqString(a, "repo")),
  },
  {
    name: "git_fetch",
    description: "MUTATES: fetch a repository's remote (updates ahead/behind; no working-tree change).",
    readOnly: false,
    inputSchema: repoOnlySchema(),
    run: (b, a) => b.fetch(reqString(a, "repo")),
  },
];

/** Look up a tool by its advertised name (used by tools/call). */
export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
