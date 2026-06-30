/**
 * The MCP backend contract — the set of repo operations the MCP tools (src/mcp/tools.ts) need,
 * expressed in RepoYeti's vocabulary and returning plain JSON-serialisable objects.
 *
 * Two adapters implement it (the SAME tool catalog runs over either):
 *   - adapter-service.ts → in-process, calling src/service + src/db directly (the HTTP endpoint).
 *   - adapter-http.ts    → over the daemon's loopback HTTP API via src/cli/client.ts (the stdio server).
 *
 * Repo identification: every op takes a user-supplied `idOrName` and EACH adapter does its own
 * id/name/basename resolution (service via getRepos/getRepo, http via resolveRepo) — that logic
 * never leaks into the transport-agnostic core. Ops throw a plain Error on a tool-level failure
 * (unknown repo, dirty tree, …); core.ts turns a throw into an MCP `isError` result.
 *
 * This file is a pure contract: it MUST NOT import service/read/db/git-actions/vcs (the boundary
 * guard enforces it). The adapters are the bridges that may.
 */

/** Optional filters for the commit-history op. */
export interface LogOptions {
  /** Max commits to return (page size). */
  limit?: number;
  /** "only" → just merge commits · "exclude" → drop them · absent → all. */
  merges?: "only" | "exclude";
}

/** The repo operations the MCP tools expose. Returns are plain JSON-serialisable objects. */
export interface McpBackend {
  /** Every known repository (id / name / path / vcs / cached status). */
  listRepos(): Promise<unknown>;
  /** One repo's resolved identity + cached status block. */
  repoStatus(idOrName: string): Promise<unknown>;
  /** Commit history (newest first), optionally limited / merge-filtered. */
  log(idOrName: string, opts?: LogOptions): Promise<unknown>;
  /** Local branches with their upstream + ahead/behind. */
  branches(idOrName: string): Promise<unknown>;
  /** Both sides (or a unified patch) of one changed file's diff. */
  diff(idOrName: string, path: string): Promise<unknown>;
  /** MUTATES: commit the working tree with `message` (optionally amend). */
  commit(idOrName: string, message: string, amend?: boolean): Promise<unknown>;
  /** MUTATES: create a branch (optionally switch to it). */
  createBranch(idOrName: string, name: string, switchTo?: boolean): Promise<unknown>;
  /** MUTATES: switch to an existing branch. */
  checkout(idOrName: string, branch: string): Promise<unknown>;
  /** MUTATES: git push. */
  push(idOrName: string): Promise<unknown>;
  /** MUTATES: git pull (fast-forward). */
  pull(idOrName: string): Promise<unknown>;
  /** MUTATES: git fetch. */
  fetch(idOrName: string): Promise<unknown>;
  /** A repo's stash entries. */
  listStashes(idOrName: string): Promise<unknown>;
  /** Paths of changed files whose content matches `query`. */
  search(idOrName: string, query: string): Promise<unknown>;
  /** Every repo currently ahead of or behind its remote. */
  drift(): Promise<unknown>;
}
