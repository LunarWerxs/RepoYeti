/**
 * HTTP McpBackend: implements the backend by driving the ALREADY-RUNNING local daemon over its
 * loopback HTTP API (src/cli/client.ts). This is what the stdio MCP server uses — Claude
 * Desktop/Code/Cursor spawn `repoyeti mcp`, which proxies each tool call to the daemon.
 *
 * Like the CLI git verbs, it NEVER imports the in-process service/read/db/git-actions/vcs layers
 * (client.ts already obeys the CLI boundary). `resolveRepo` does id/name/basename resolution by
 * querying GET /api/repos; the daemon's existing /api/* auth gates the calls (open locally).
 * Response shapes mirror the read/service layers (only the fields we pass through).
 */
import { get, post, resolveRepo, type ApiError } from "../cli/client.ts";
import { buildTriageBriefing, type McpBackend, type LogOptions } from "./backend.ts";

interface RepoView {
  id: string;
  name: string;
  absPath: string;
  vcs: string;
  /** Opted into the auto-commit timer (see src/db.ts RepoView) — needed by triageBriefing. */
  autoCommit?: boolean;
  status: {
    branch: string | null;
    detached: boolean;
    dirty: number;
    ahead: number;
    behind: number;
    remote: string | null;
    error: string | null;
    /** Additive Conflict Concierge fields (src/read/status.ts) — see backend.ts TriageRepoInput. */
    conflicted?: boolean;
    gitOperation?: string | null;
  } | null;
}

export function httpBackend(): McpBackend {
  return {
    async listRepos() {
      return get<{ repos: RepoView[] }>("/api/repos");
    },

    async repoStatus(idOrName) {
      const repo = await resolveRepo(idOrName);
      return {
        id: repo.id,
        name: repo.name,
        absPath: repo.absPath,
        vcs: repo.vcs,
        status: repo.status,
      };
    },

    async log(idOrName, opts?: LogOptions) {
      const repo = await resolveRepo(idOrName);
      const params = new URLSearchParams();
      if (opts?.limit != null && Number.isFinite(opts.limit) && opts.limit > 0) {
        params.set("limit", String(Math.floor(opts.limit)));
      }
      if (opts?.merges === "only" || opts?.merges === "exclude") params.set("merges", opts.merges);
      const qs = params.toString();
      return get(`/api/repos/${repo.id}/log${qs ? `?${qs}` : ""}`);
    },

    async branches(idOrName) {
      const repo = await resolveRepo(idOrName);
      return get(`/api/repos/${repo.id}/branches`);
    },

    async diff(idOrName, path) {
      const repo = await resolveRepo(idOrName);
      return get(`/api/repos/${repo.id}/diff?path=${encodeURIComponent(path)}`);
    },

    async commit(idOrName, message, amend = false) {
      const repo = await resolveRepo(idOrName);
      return post(`/api/repos/${repo.id}/commit`, { message, amend });
    },

    async createBranch(idOrName, name, switchTo = true) {
      const repo = await resolveRepo(idOrName);
      return post(`/api/repos/${repo.id}/branch`, { name, switch: switchTo });
    },

    async checkout(idOrName, branch) {
      const repo = await resolveRepo(idOrName);
      return post(`/api/repos/${repo.id}/checkout`, { branch });
    },

    async push(idOrName) {
      const repo = await resolveRepo(idOrName);
      return post(`/api/repos/${repo.id}/push`, {});
    },

    async pull(idOrName) {
      const repo = await resolveRepo(idOrName);
      return post(`/api/repos/${repo.id}/pull`, {});
    },

    async fetch(idOrName) {
      const repo = await resolveRepo(idOrName);
      return post(`/api/repos/${repo.id}/fetch`, {});
    },

    async listStashes(idOrName) {
      const repo = await resolveRepo(idOrName);
      return get(`/api/repos/${repo.id}/stashes`);
    },

    async search(idOrName, query) {
      const repo = await resolveRepo(idOrName);
      return get(`/api/repos/${repo.id}/search?q=${encodeURIComponent(query)}`);
    },

    async drift() {
      const { repos } = await get<{ repos: RepoView[] }>("/api/repos");
      const drifted = repos.filter(
        (r) => (r.status?.ahead ?? 0) > 0 || (r.status?.behind ?? 0) > 0,
      );
      return { repos: drifted };
    },

    async triageBriefing() {
      const { repos } = await get<{ repos: RepoView[] }>("/api/repos");
      return buildTriageBriefing(repos);
    },
  };
}

// `ApiError` is re-exported as a type only so callers can narrow without re-importing client.ts.
export type { ApiError };
