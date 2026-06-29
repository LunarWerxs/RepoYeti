// Thin REST client — one place that talks to the daemon. Throws an Error carrying
// the parsed `{ code, message }` on any non-2xx so callers can show a real reason.
import type {
  ActionResult,
  AiCatalogEntry,
  AiModel,
  AiProviderId,
  AiSettings,
  BranchList,
  ChangedFile,
  CommitPlanResponse,
  FetchAllResult,
  FileContent,
  FileDiff,
  Identity,
  LogResult,
  Repo,
  SmartCommitResult,
  StashList,
  TagList,
} from "./types";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
    signal,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, data.code ?? "ERROR", data.message ?? data.error ?? res.statusText);
  }
  return data as T;
}

export type AccessMode = "local" | "remote";

export interface AuthStatus {
  authEnforced: boolean;
  mode: AccessMode;
  authenticated: boolean;
  owner: string | null;
  /** An owner has been claimed (required before remote can be enabled). */
  ownerClaimed: boolean;
  /** This request is loopback → the "Continue local for now" option is offered. */
  canContinueLocal: boolean;
  /** A live local bypass is in effect (local request only). */
  localBypass: boolean;
}

export interface RuntimeStatus {
  ok: boolean;
  version: string;
  mode: AccessMode;
  tunnelActive: boolean;
  /** Public cloudflared tunnel URL, or null when no tunnel is running. */
  tunnelUrl: string | null;
  /** Whether per-file/per-repo diff statistics are enabled (owner setting). */
  diffStats: boolean;
  /** Min query length before "search content" greps — server-owned, so the UI can't drift. */
  minContentSearch: number;
  /** Whether editing/saving files is allowed over the remote tunnel (owner setting). */
  remoteEditing: boolean;
  /** Diff-tab threshold (bytes): changed files larger than this open as a compact patch. */
  diffPatchBytes: number;
  /** Whether large files may use the compact patch view at all (false = always side-by-side). */
  diffPatchEnabled: boolean;
  /** Whether the background remote-sync check runs (owner setting). */
  syncCheck: boolean;
  /** How often the background sync check fetches, in seconds (owner setting). */
  syncIntervalSecs: number;
  /** Whether the check also auto fast-forwards safe repos ("keep in sync"; owner setting). */
  keepInSync: boolean;
}

export interface ModeResult {
  ok: boolean;
  mode: AccessMode;
  tunnelActive: boolean;
  tunnelUrl: string | null;
}

export const api = {
  authStatus: () => req<AuthStatus>("GET", "/api/auth/status"),
  logout: () => req<{ ok: boolean }>("POST", "/api/auth/logout"),
  /** Sign out on every device — rotates the daemon's signing key so all session cookies die. */
  logoutAll: () => req<{ ok: boolean }>("POST", "/api/auth/logout-all"),
  /** Grant the localhost-only "Continue local for now" bypass (rejected over the tunnel). */
  continueLocal: () => req<{ ok: boolean }>("POST", "/api/auth/continue-local"),

  // ── scan roots (discovery directories) ──────────────────────────────────────
  roots: () => req<{ roots: string[] }>("GET", "/api/roots").then((r) => r.roots),
  addRoot: (path: string) => req<{ ok: boolean; roots: string[] }>("POST", "/api/roots", { path }),
  removeRoot: (path: string) =>
    req<{ ok: boolean; roots: string[]; removed: number }>("DELETE", "/api/roots", { path }),
  /** Fetch every repo that has a remote; returns a per-repo summary. */
  fetchAll: () => req<FetchAllResult>("POST", "/api/repos/fetch-all"),

  /** Runtime status: access mode + the remote-access tunnel URL, if any. */
  status: () => req<RuntimeStatus>("GET", "/api/status"),
  /** Flip local ↔ remote. Throws ApiError "NEEDS_OWNER" if remote needs a sign-in first. */
  setMode: (mode: AccessMode) => req<ModeResult>("PUT", "/api/mode", { mode }),
  /** Toggle per-file/per-repo diff statistics (owner setting; persisted in config). */
  setDiffStats: (enabled: boolean) =>
    req<{ ok: boolean; diffStats: boolean }>("PUT", "/api/settings", { diffStats: enabled }),
  /** Toggle whether files can be edited over the remote tunnel (owner setting; persisted). */
  setRemoteEditing: (enabled: boolean) =>
    req<{ ok: boolean; remoteEditing: boolean }>("PUT", "/api/settings", { remoteEditing: enabled }),
  /** Set the large-file Diff threshold in bytes (owner setting; server clamps + persists). */
  setDiffPatchBytes: (bytes: number) =>
    req<{ ok: boolean; diffPatchBytes: number }>("PUT", "/api/settings", { diffPatchBytes: bytes }),
  /** Toggle compact patch mode for large files (false = always side-by-side; persisted). */
  setDiffPatchEnabled: (enabled: boolean) =>
    req<{ ok: boolean; diffPatchEnabled: boolean }>("PUT", "/api/settings", { diffPatchEnabled: enabled }),
  /** Toggle the background remote-sync check (owner setting; persisted). */
  setSyncCheck: (enabled: boolean) =>
    req<{ ok: boolean; syncCheck: boolean }>("PUT", "/api/settings", { syncCheck: enabled }),
  /** Set the background sync-check cadence in seconds (server clamps to [30,3600] + persists). */
  setSyncInterval: (secs: number) =>
    req<{ ok: boolean; syncIntervalSecs: number }>("PUT", "/api/settings", { syncIntervalSecs: secs }),
  /** Toggle "keep in sync" auto fast-forward (owner setting; persisted). */
  setKeepInSync: (enabled: boolean) =>
    req<{ ok: boolean; keepInSync: boolean }>("PUT", "/api/settings", { keepInSync: enabled }),

  listRepos: () => req<{ repos: Repo[] }>("GET", "/api/repos").then((r) => r.repos),
  listIdentities: () => req<{ identities: Identity[] }>("GET", "/api/identities").then((r) => r.identities),

  createIdentity: (input: Omit<Identity, "id">) =>
    req<{ identity: Identity }>("POST", "/api/identities", input).then((r) => r.identity),
  updateIdentity: (id: string, patch: Partial<Omit<Identity, "id">>) =>
    req<{ identity: Identity }>("PUT", `/api/identities/${id}`, patch).then((r) => r.identity),
  deleteIdentity: (id: string) => req<{ ok: boolean }>("DELETE", `/api/identities/${id}`),

  registerRepo: (path: string) =>
    req<{ repo: Repo }>("POST", "/api/repos/register", { path }).then((r) => r.repo),
  createRepo: (path: string) =>
    req<{ repo: Repo }>("POST", "/api/repos/create", { path }).then((r) => r.repo),
  /** Clone a remote into `<parentPath>/<name>` (name defaults from the URL). */
  cloneRepo: (input: { url: string; parentPath: string; name?: string; identityId?: string | null }) =>
    req<{ ok: boolean; repo: Repo }>("POST", "/api/repos/clone", input).then((r) => r.repo),

  reorderRepos: (order: string[]) => req<{ ok: boolean }>("POST", "/api/repos/reorder", { order }),

  assignIdentity: (repoId: string, identityId: string | null) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/identity`, { identityId }).then((r) => r.repo),

  setHidden: (repoId: string, hidden: boolean) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/hidden`, { hidden }).then((r) => r.repo),

  setPinned: (repoId: string, pinned: boolean) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/pinned`, { pinned }).then((r) => r.repo),

  setStarred: (repoId: string, starred: boolean) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/starred`, { starred }).then((r) => r.repo),

  // Actions return a structured result even on a "handled" failure (409 etc.):
  // ApiError is thrown, carrying .code/.message — callers translate to a toast.
  fetch: (id: string) => req<ActionResult>("POST", `/api/repos/${id}/fetch`),
  pull: (id: string) => req<ActionResult>("POST", `/api/repos/${id}/pull`),
  push: (id: string) => req<ActionResult>("POST", `/api/repos/${id}/push`),
  commit: (id: string, message: string, amend = false) =>
    req<ActionResult>("POST", `/api/repos/${id}/commit`, { message, amend }),
  /** Execute an (owner-edited) multi-commit plan. Each entry = a final message + its paths.
   *  `sync` runs pull --ff-only then push after all commits land. */
  smartCommit: (id: string, commits: Array<{ message: string; paths: string[] }>, sync = false) =>
    req<SmartCommitResult>("POST", `/api/repos/${id}/smart-commit`, { commits, sync }),
  refresh: (id: string) => req<{ repo: Repo }>("POST", `/api/repos/${id}/refresh`).then((r) => r.repo),

  // ── branches / history / stash ──────────────────────────────────────────────
  branches: (id: string) => req<BranchList>("GET", `/api/repos/${id}/branches`),
  /** Switch to an existing branch. Throws ApiError "DIRTY_WORKING_TREE" on a dirty tree. */
  checkout: (id: string, branch: string) =>
    req<ActionResult>("POST", `/api/repos/${id}/checkout`, { branch }),
  /** Create a branch from HEAD (optionally switch to it; default true). */
  createBranch: (id: string, name: string, switchTo = true) =>
    req<ActionResult>("POST", `/api/repos/${id}/branch`, { name, switch: switchTo }),
  /** Safe-delete a local branch (`-d`; never force). */
  deleteBranch: (id: string, name: string) =>
    req<ActionResult>("DELETE", `/api/repos/${id}/branch`, { name }),
  /** Commit history of the current branch, newest first. Paginate with `skip`. */
  log: (id: string, limit = 50, skip = 0) =>
    req<LogResult>("GET", `/api/repos/${id}/log?limit=${limit}&skip=${skip}`),
  stashes: (id: string) => req<StashList>("GET", `/api/repos/${id}/stashes`),
  stashSave: (id: string, message?: string) =>
    req<ActionResult>("POST", `/api/repos/${id}/stash`, message ? { message } : {}),
  stashPop: (id: string, index = 0) =>
    req<ActionResult>("POST", `/api/repos/${id}/stash/pop`, { index }),
  stashDrop: (id: string, index = 0) =>
    req<ActionResult>("POST", `/api/repos/${id}/stash/drop`, { index }),
  /** Read-only tag list (newest first). */
  tags: (id: string) => req<TagList>("GET", `/api/repos/${id}/tags`),
  /** Create a tag (annotated when a message is given), optionally pushing it to origin. */
  createTag: (id: string, input: { name: string; message?: string; push?: boolean }) =>
    req<ActionResult>("POST", `/api/repos/${id}/tag`, input),
  /** Add or update a remote (default origin). Throws ApiError on a bad URL. */
  setRemote: (id: string, url: string, name?: string) =>
    req<ActionResult>("POST", `/api/repos/${id}/remote`, name ? { url, name } : { url }),
  /** Remove a remote (default origin). */
  removeRemote: (id: string, name?: string) =>
    req<ActionResult>("DELETE", `/api/repos/${id}/remote`, name ? { name } : {}),
  /** Discard one changed file's working-tree changes (destructive — confirm in the UI). */
  discard: (id: string, path: string) =>
    req<{ ok: boolean; code: string; message?: string; path?: string }>(
      "POST",
      `/api/repos/${id}/discard`,
      { path },
    ),
  /** Changed-file list. `total`/`truncated` are set when the server capped an oversized
   *  list (MAX_CHANGED_FILES) so the UI can show a "showing N of M" notice. */
  changes: (id: string) =>
    req<{ files: ChangedFile[]; total?: number; truncated?: boolean }>(
      "GET",
      `/api/repos/${id}/changes`,
    ),
  fileContent: (id: string, path: string, ref?: "work" | "head") =>
    req<FileContent>(
      "GET",
      `/api/repos/${id}/file?path=${encodeURIComponent(path)}${ref ? `&ref=${ref}` : ""}`,
    ),
  /** Repo-relative paths of CHANGED files whose content matches `q`. Pass an AbortSignal
   *  so a superseded keystroke's request can be cancelled (the search box debounces). */
  searchContent: (id: string, q: string, signal?: AbortSignal) =>
    req<{ paths: string[] }>(
      "GET",
      `/api/repos/${id}/search?q=${encodeURIComponent(q)}`,
      undefined,
      signal,
    ).then((r) => r.paths),
  fileDiff: (id: string, path: string) =>
    req<FileDiff>("GET", `/api/repos/${id}/diff?path=${encodeURIComponent(path)}`),

  /** Save edited text back to a working-tree file (viewer Edit mode). Throws on 4xx/5xx. */
  saveFile: (id: string, path: string, content: string) =>
    req<{ ok: boolean; code: string; message?: string; path?: string; size?: number }>(
      "PUT",
      `/api/repos/${id}/file?path=${encodeURIComponent(path)}`,
      { content },
    ),

  // ── bring-your-own-key AI ───────────────────────────────────────────────────
  // Keys are sent here once (to connect) and never returned; the daemon proxies
  // all provider calls. `commitMessage` drafts a message from the repo's diff.
  ai: {
    /** Static provider catalog — safe display metadata (no secrets). */
    catalog: () =>
      req<{ catalog: AiCatalogEntry[] }>("GET", "/api/ai/catalog").then((r) => r.catalog),
    settings: () => req<AiSettings>("GET", "/api/ai/settings"),
    /** Toggle smart-commit YOLO mode (commit the AI plan without the review editor). */
    setYolo: (yolo: boolean) => req<AiSettings>("PUT", "/api/ai/settings", { yolo }),
    connect: (provider: AiProviderId, apiKey: string) =>
      req<{ ok: boolean; models: AiModel[]; settings: AiSettings }>(
        "POST",
        `/api/ai/providers/${provider}/connect`,
        { apiKey },
      ),
    models: (provider: AiProviderId) =>
      req<{ ok: boolean; models: AiModel[] }>("GET", `/api/ai/providers/${provider}/models`),
    setProvider: (provider: AiProviderId, patch: { model?: string | null; makeDefault?: boolean }) =>
      req<AiSettings>("PUT", `/api/ai/providers/${provider}`, patch),
    removeProvider: (provider: AiProviderId) =>
      req<AiSettings>("DELETE", `/api/ai/providers/${provider}`),
    /** Draft a commit message from the repo's diff. With `paths`, scope it to just those
     *  files (smart-commit per-group regenerate); omit for the whole working tree. */
    commitMessage: (repoId: string, provider?: AiProviderId, paths?: string[]) =>
      req<{ ok: boolean; message: string; provider: AiProviderId; model: string }>(
        "POST",
        `/api/repos/${repoId}/commit-message`,
        { ...(provider ? { provider } : {}), ...(paths && paths.length ? { paths } : {}) },
      ),
    /** Propose a multi-commit plan from the repo's working tree (commits nothing). */
    commitPlan: (repoId: string, provider?: AiProviderId) =>
      req<CommitPlanResponse>(
        "POST",
        `/api/repos/${repoId}/commit-plan`,
        provider ? { provider } : {},
      ),
  },
};
