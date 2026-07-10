/**
 * In-process McpBackend: implements the backend by calling src/service + src/db directly.
 *
 * This is the bridge used by the HTTP endpoint (POST /api/mcp) — the request already arrived at
 * THIS daemon, so there's no reason to loop back over HTTP; we drive the in-process service layer.
 * Repo resolution (id → name → path basename) mirrors cli/client.ts's resolveRepo so a tool's
 * `repo` argument behaves identically over either transport.
 *
 * This adapter is EXEMPT from the mcp boundary guard (it's allowed to import service/db) — the
 * pure layers (core/tools/backend) are not.
 */
import { getRepos, getRepo, type RepoView } from "../db.ts";
import {
  getLog,
  getBranches,
  getStashes,
  searchChangedContent,
  readFileDiff,
  fetchRepo,
  pullRepo,
  pushRepo,
  commitRepo,
  checkoutRepo,
  createBranchRepo,
} from "../service/index.ts";
import { buildTriageBriefing, type McpBackend, type LogOptions } from "./backend.ts";

/**
 * Resolve a user-supplied repo identifier to its RepoView, in process. Matching order mirrors
 * cli/client.ts: exact id, then exact name, then path basename — throwing on no match or an
 * ambiguous name/basename so a wrong repo is never silently acted on.
 */
function resolveRepoView(idOrName: string): RepoView {
  const needle = (idOrName ?? "").trim();
  if (!needle) throw new Error("a repo (id or name) is required");
  const repos = getRepos();

  const byId = getRepo(needle);
  if (byId) return byId;

  const byName = repos.filter((r) => r.name === needle);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(`ambiguous repo "${needle}" — matches ${byName.length} repos; use the id`);
  }

  const basename = (p: string): string => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  const byBase = repos.filter((r) => basename(r.absPath) === needle);
  if (byBase.length === 1) return byBase[0]!;
  if (byBase.length > 1) {
    throw new Error(`ambiguous repo "${needle}" — matches ${byBase.length} paths; use the id`);
  }

  throw new Error(`no repo matches "${needle}"`);
}

/** Throw on a non-ok action/read envelope so core.ts turns it into an MCP error result. */
function ensureOk<T extends { ok: boolean; code?: string; message?: string }>(r: T): T {
  if (!r.ok) throw new Error(r.message || r.code || "operation failed");
  return r;
}

export function serviceBackend(): McpBackend {
  return {
    async listRepos() {
      return { repos: getRepos() };
    },

    async repoStatus(idOrName) {
      const repo = resolveRepoView(idOrName);
      return {
        id: repo.id,
        name: repo.name,
        absPath: repo.absPath,
        vcs: repo.vcs,
        status: repo.status,
      };
    },

    async log(idOrName, opts?: LogOptions) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await getLog(repo.id, opts?.limit, undefined, opts?.merges));
    },

    async branches(idOrName) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await getBranches(repo.id));
    },

    async diff(idOrName, path) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await readFileDiff(repo.id, path));
    },

    async commit(idOrName, message, amend = false) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await commitRepo(repo.id, message, amend));
    },

    async createBranch(idOrName, name, switchTo = true) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await createBranchRepo(repo.id, name, switchTo));
    },

    async checkout(idOrName, branch) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await checkoutRepo(repo.id, branch));
    },

    async push(idOrName) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await pushRepo(repo.id));
    },

    async pull(idOrName) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await pullRepo(repo.id));
    },

    async fetch(idOrName) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await fetchRepo(repo.id));
    },

    async listStashes(idOrName) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await getStashes(repo.id));
    },

    async search(idOrName, query) {
      const repo = resolveRepoView(idOrName);
      return ensureOk(await searchChangedContent(repo.id, query));
    },

    async drift() {
      const drifted = getRepos().filter(
        (r) => (r.status?.ahead ?? 0) > 0 || (r.status?.behind ?? 0) > 0,
      );
      return { repos: drifted };
    },

    async triageBriefing() {
      return buildTriageBriefing(getRepos());
    },
  };
}
