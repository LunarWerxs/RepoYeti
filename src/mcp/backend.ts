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
  /** One compact "what needs attention across all repos" snapshot: conflicted/mid-op repos,
   *  ahead/behind repos, repos the auto-commit timer would currently skip, and dirty repos. */
  triageBriefing(): Promise<unknown>;
}

/** The minimal repo shape triageBriefing needs — a subset both adapters' repo lists satisfy
 *  (db.ts's RepoView and the HTTP /api/repos JSON shape alike), so the grouping logic lives here
 *  ONCE instead of being duplicated per adapter. */
export interface TriageRepoInput {
  id: string;
  name: string;
  autoCommit?: boolean;
  status: {
    branch: string | null;
    detached: boolean;
    dirty: number;
    ahead: number;
    behind: number;
    error: string | null;
    conflicted?: boolean;
    gitOperation?: string | null;
  } | null;
}

/** One repo entry in a triageBriefing group: just enough to act on without a follow-up read. */
export interface TriageEntry {
  id: string;
  name: string;
  branch: string | null;
  reason: string;
}

/** Compact "what needs attention" snapshot, grouped by concern (repo/branch/reason each). Pure
 *  and transport-agnostic — both adapters call this with their own repo list shape. Mirrors the
 *  Conflict Concierge triage card's web-side derivation (needsAttentionRepos in store/repo.ts)
 *  and the auto-commit safety gate's isAutoCommitActionable/hasConflict (src/auto-commit.ts) so
 *  all three agree on what "needs attention" means. */
export function buildTriageBriefing(repos: TriageRepoInput[]): {
  conflicted: TriageEntry[];
  drifted: TriageEntry[];
  autoCommitBlocked: TriageEntry[];
  dirty: TriageEntry[];
} {
  const conflicted: TriageEntry[] = [];
  const drifted: TriageEntry[] = [];
  const autoCommitBlocked: TriageEntry[] = [];
  const dirty: TriageEntry[] = [];

  for (const r of repos) {
    const s = r.status;
    if (!s) continue;
    const branch = s.branch;
    const isConflictedOrMidOp = !!s.conflicted || !!s.gitOperation;

    if (isConflictedOrMidOp) {
      const reason = s.conflicted ? "conflict" : (s.gitOperation ?? "mid-operation");
      conflicted.push({ id: r.id, name: r.name, branch, reason });
    }
    if (s.ahead > 0 || s.behind > 0) {
      const reason = s.ahead > 0 && s.behind > 0 ? "diverged" : s.ahead > 0 ? "ahead" : "behind";
      drifted.push({ id: r.id, name: r.name, branch, reason });
    }
    // Mirrors auto-commit.ts's gates: opted in, actionable (on a branch, not errored/detached),
    // and currently blocked (conflicted/mid-op) or simply not actionable at all.
    if (r.autoCommit) {
      const actionable = !s.error && !s.detached && !!s.branch;
      if (!actionable || isConflictedOrMidOp) {
        const reason = isConflictedOrMidOp ? "conflict" : s.error ? "error" : s.detached ? "detached" : "no-branch";
        autoCommitBlocked.push({ id: r.id, name: r.name, branch, reason });
      }
    }
    if (s.dirty > 0) {
      dirty.push({ id: r.id, name: r.name, branch, reason: `${s.dirty} uncommitted` });
    }
  }

  return { conflicted, drifted, autoCommitBlocked, dirty };
}
