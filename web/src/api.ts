// Thin REST client — one place that talks to the daemon. Throws an Error carrying
// the parsed `{ code, message }` on any non-2xx so callers can show a real reason.
import type {
  AccountsSnapshot,
  ActionResult,
  AiCatalogEntry,
  AiModel,
  AiProviderId,
  AiSettings,
  BranchList,
  CommitStyle,
  DiffDetail,
  ChangedFile,
  CommitPlanResponse,
  FetchAllResult,
  FileContent,
  FileDiff,
  Identity,
  IdentityRule,
  DetectedIdentity,
  LogResult,
  CommitDetail,
  LoreServer,
  PendingApproval,
  Repo,
  Share,
  ShareCreated,
  ShareDuration,
  ShareEvent,
  SharePerm,
  ShareViewer,
  SmartCommitResult,
  StashList,
  TagList,
  UpdateApplyResult,
  UpdateStatus,
} from "./types";
import { httpJson } from "@/lib/httpClient";
export { ApiError } from "@/lib/httpClient";

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const data = await httpJson<T>(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
    signal,
  });
  return (data ?? ({} as T)) as T;
}

export type AccessMode = "local" | "remote";

/** Redacted named-tunnel config (mirrors src/config.ts redactTunnel) — never carries the token. */
export interface TunnelStatus {
  /** Stable hostname for a named tunnel (e.g. "app.repoyeti.com"), or null. */
  hostname: string | null;
  /** A connector token is available (from config OR the CF_TUNNEL_TOKEN env). */
  hasToken: boolean;
  /** The token is supplied by CF_TUNNEL_TOKEN (read-only — the UI can't edit it). */
  tokenFromEnv: boolean;
  /** A stable named tunnel is fully configured (what the daemon's namedTunnel() resolves). */
  named: boolean;
}

/** Result of PUT /api/tunnel — the redacted config plus the live tunnel state. */
export interface TunnelResult {
  ok: boolean;
  tunnel: TunnelStatus;
  tunnelActive: boolean;
  tunnelUrl: string | null;
}

export interface AuthStatus {
  authEnforced: boolean;
  mode: AccessMode;
  authenticated: boolean;
  owner: string | null;
  /** Avatar image URL for the signed-in owner (photo scope), when available. */
  ownerPicture: string | null;
  /** An owner has been claimed (required before remote can be enabled). */
  ownerClaimed: boolean;
  /** This request is loopback → the "Continue local for now" option is offered. */
  canContinueLocal: boolean;
  /** A live local bypass is in effect (local request only). */
  localBypass: boolean;
  /** Set when this viewer is a SHARE-LINK GUEST rather than the owner — their link's label, tier,
   *  and expiry. null for the owner (and the owner always wins if both credentials are present).
   *  `authenticated` is true for a guest too: they hold a live credential, so they belong on the
   *  dashboard, not the sign-in gate. */
  share: ShareViewer | null;
}

export interface RuntimeStatus {
  ok: boolean;
  version: string;
  mode: AccessMode;
  tunnelActive: boolean;
  /** Set for a share-link guest. When present, this whole object is a NARROW projection: the
   *  owner's tunnel/MCP/auto-commit/editor settings are absent, not null (see routes/health.ts).
   *  Every other field here is therefore optional from a guest's point of view. */
  share?: ShareViewer | null;
  /** Public cloudflared tunnel URL, or null when no tunnel is running. */
  tunnelUrl: string | null;
  /** Redacted named-tunnel config (stable hostname + token-presence flags; never the token). */
  tunnel: TunnelStatus;
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
  /** Whether the auto-commit timer runs (owner setting; per-repo opt-in on each repo). */
  autoCommit: boolean;
  /** Auto-commit schedule: "interval" (every N seconds) or "daily" (once at a set time). */
  autoCommitMode: "interval" | "daily";
  /** Auto-commit cadence in seconds for "interval" mode (owner setting). */
  autoCommitIntervalSecs: number;
  /** Local "HH:MM" the auto-commit timer fires at in "daily" mode (owner setting). */
  autoCommitAt: string;
  /** Whether auto-commit pulls (--ff-only) before pushing (owner setting). */
  autoCommitPull: boolean;
  /** Whether auto-commit pushes after committing (owner setting; false = commit locally only). */
  autoCommitPush: boolean;
  /** Whether the app silently auto-updates + restarts on a schedule (owner setting; opt-in). */
  autoUpdate: boolean;
  /** Auto-update check cadence in seconds. */
  autoUpdateIntervalSecs: number;
  /** Whether the whole machine is auto-scanned for repos on every app start (owner setting). */
  autoScan: boolean;
  /** Whether the Lore-servers settings section is expanded (owner setting; a pure display
   *  preference; collapses to just its header when off). */
  loreServersEnabled: boolean;
  /** Whether the app UI opens in a chromeless Chromium app window instead of a browser tab
   *  (owner setting; off by default). The desktop launcher/tray follows the same preference. */
  portableMode: boolean;
  /** Whether the system-tray notification-area icon is hidden (owner setting; off by default).
   *  The daemon keeps running in the background either way; the desktop launcher/tray follows
   *  the same preference (read off runtime.json, not this) so it can act on it live. */
  hideTrayIcon: boolean;
  /** ⭐ Agent Safety Rail: whether mutating MCP tool calls are gated behind owner approve/deny
   *  (owner setting; default ON). */
  mcpApprovalGate: boolean;
  /** Auto-deny timeout for a pending MCP approval, in seconds (owner setting; default 120). */
  mcpApprovalTimeoutSecs: number;
  /** Whether a pending approval auto-DENIES after mcpApprovalTimeoutSecs (owner setting; default ON). */
  mcpAutoDeny: boolean;
  /** Whether a pending approval auto-APPROVES after mcpAutoApproveTimeoutSecs (owner setting; default OFF). */
  mcpAutoApprove: boolean;
  /** Auto-approve timeout for a pending MCP approval, in seconds (owner setting; default 120). */
  mcpAutoApproveTimeoutSecs: number;
  /** Providers whose AI key the boot-time liveness check found dead — the dashboard raises the
   *  "AI key problem" notification for each on load (so it isn't missed if opened after boot). */
  aiKeyInvalid?: Array<{ provider: string; label: string }>;
  /** "Open with…" default external editor id, or null to auto-pick the first installed one. */
  defaultEditor: string | null;
}

/** One "Open with…" editor's presence on the daemon's machine (from GET /api/editors). */
export interface EditorInfo {
  id: string;
  label: string;
  /** Opens a folder as a workspace (a file tree) vs a single file (Notepad). */
  folder: boolean;
  /** Detected as installed on this machine. */
  available: boolean;
}

/** The "Open with…" catalogue for the current host (GET /api/editors). */
export interface EditorsResult {
  ok: boolean;
  platform: string;
  /** The stored preference (may be null / unavailable). */
  defaultEditor: string | null;
  /** The resolved default the Open-with button actually launches. */
  effectiveDefault: string;
  editors: EditorInfo[];
}

/** Result of an "Open with…" launch (POST /api/repos/:id/open). */
export interface OpenResult {
  ok: boolean;
  code: string;
  message?: string;
  editor?: string;
}

/** Result of opening the app UI in a chromeless app window (POST /api/portable-window). */
export type PortableWindowResult =
  | { ok: true; browser: string }
  | { ok: false; reason: "no-browser" | "spawn-failed" };

export interface ModeResult {
  ok: boolean;
  mode: AccessMode;
  tunnelActive: boolean;
  tunnelUrl: string | null;
}

/** "Sync my settings with Connections" status (GET/PUT /api/settings/sync et al). */
export interface SyncStatus {
  ok: boolean;
  /** Owner turned sync on. */
  enabled: boolean;
  /** The daemon holds a Connections credential (owner has signed in with Connections). */
  connected: boolean;
  /** ISO timestamp of the last successful sync, or null. */
  lastSyncedAt: string | null;
  version: number;
  /** Last-synced appearance blob (e.g. `{ theme }`) to apply locally, or null. */
  appearance: Record<string, unknown> | null;
  /** Set on a handled failure (HTTP 200, `ok:false`) — show inline, non-blocking. */
  error?: string;
  retryAfterSeconds?: number;
}

/** The signed-in Connections identity (GET /api/auth/me). */
export interface AuthMe {
  email: string;
  sub: string;
}

export const api = {
  authStatus: () => req<AuthStatus>("GET", "/api/auth/status"),
  logout: () => req<{ ok: boolean }>("POST", "/api/auth/logout"),
  /** Sign out on every device — rotates the daemon's signing key so all session cookies die. */
  logoutAll: () => req<{ ok: boolean }>("POST", "/api/auth/logout-all"),
  /** Grant the localhost-only "Continue local for now" bypass (rejected over the tunnel). */
  continueLocal: () => req<{ ok: boolean }>("POST", "/api/auth/continue-local"),
  /** The signed-in Connections identity (email/sub). Throws ApiError when signed out. */
  authMe: () => req<AuthMe>("GET", "/api/auth/me"),

  // ── share links (owner-only; the daemon 403s a guest that tries any of these) ─────
  /** The owner's live share links. Never carries a link's token — see ShareCreated. */
  listShares: () => req<{ shares: Share[] }>("GET", "/api/shares"),
  /** Mint a link. The ONLY call that returns the secret token, and only this once: show it
   *  immediately, because nothing can recover it afterwards. */
  createShare: (input: {
    label: string;
    perm: SharePerm;
    duration: ShareDuration;
    scopeAll: boolean;
    repoIds: string[];
  }) => req<ShareCreated>("POST", "/api/shares", input),
  /** Revoke a link — effective on the guest's very next request. */
  revokeShare: (id: string) => req<{ ok: boolean }>("DELETE", `/api/shares/${encodeURIComponent(id)}`),
  /** What this link's holder actually did. The only place that can answer it: a guest's commits
   *  are authored as the owner, so git history can't. */
  shareEvents: (id: string) =>
    req<{ events: ShareEvent[] }>("GET", `/api/shares/${encodeURIComponent(id)}/events`),

  // ── "Sync my settings with Connections" (opt-in cloud sync of theme/appearance) ─────
  /** Current sync status: enabled/connected/last-synced/appearance. */
  getSyncStatus: () => req<SyncStatus>("GET", "/api/settings/sync"),
  /** Update sync settings. `{enabled:true, appearance}` turns sync on and seeds it with the
   *  current local appearance; `{enabled:false}` turns it off (keeps the connection);
   *  `{enabled:false, forget:true}` disconnects (deletes the remote doc + forgets the token);
   *  `{appearance}` alone updates the synced appearance (pushes if enabled). On a handled
   *  failure the daemon returns `{ok:false, error, retryAfterSeconds?}` with HTTP 200 — this
   *  does NOT throw for that shape, so callers can show it inline. */
  setSync: (body: { enabled?: boolean; forget?: boolean; appearance?: Record<string, unknown> }) =>
    req<SyncStatus>("PUT", "/api/settings/sync", body),
  /** Manually pull the synced settings from another device. */
  syncPull: () => req<SyncStatus>("POST", "/api/settings/sync/pull"),
  /** Manually push the current synced settings now. */
  syncPush: () => req<SyncStatus>("POST", "/api/settings/sync/push"),

  // ── scan roots (discovery directories) ──────────────────────────────────────
  roots: () => req<{ roots: string[] }>("GET", "/api/roots").then((r) => r.roots),
  addRoot: (path: string) => req<{ ok: boolean; roots: string[] }>("POST", "/api/roots", { path }),
  removeRoot: (path: string) =>
    req<{ ok: boolean; roots: string[]; removed: number }>("DELETE", "/api/roots", { path }),
  /** Start a scan — the whole machine (every drive) by default, or a single folder via `{ path }`.
   *  Fire-and-forget — progress + results stream back over the scan_* / repo_added SSE events.
   *  No-op if a scan is already running. */
  startScan: (body?: { path?: string }) =>
    req<{ ok: boolean; running: boolean; scope?: string }>("POST", "/api/scan", body ?? {}),
  /** Stop the in-flight scan. `cancelled` is false when no scan was running. */
  cancelScan: () => req<{ ok: boolean; cancelled: boolean }>("POST", "/api/scan/cancel"),

  // ── lore servers (registry + clone-from-server) ──────────────────────────────
  servers: () => req<{ servers: LoreServer[] }>("GET", "/api/servers").then((r) => r.servers),
  addServer: (url: string, name?: string) =>
    req<{ ok: boolean; server: LoreServer; servers: LoreServer[] }>("POST", "/api/servers", { url, name }),
  deleteServer: (id: string) => req<{ ok: boolean; servers: LoreServer[] }>("DELETE", `/api/servers/${id}`),
  cloneFromServer: (input: { url: string; parentPath: string; name?: string }) =>
    req<{ repo: Repo }>("POST", "/api/servers/clone", input).then((r) => r.repo),
  /** Fetch every repo that has a remote; returns a per-repo summary. */
  fetchAll: () => req<FetchAllResult>("POST", "/api/repos/fetch-all"),
  /** Remove every repo entry (any source) whose local path no longer exists on disk. */
  cleanupMissingRepos: () => req<{ ok: boolean; removed: number }>("POST", "/api/repos/cleanup-missing"),
  /** Cleanly stop the local daemon. */
  shutdown: () => req<{ ok: boolean }>("POST", "/api/shutdown"),

  /** Runtime status: access mode + the remote-access tunnel URL, if any. */
  status: () => req<RuntimeStatus>("GET", "/api/status"),
  /** Check the public source remote for an app update. */
  checkUpdate: () => req<UpdateStatus>("GET", "/api/updates"),
  /** Apply an available source update. The daemon should be restarted afterward. */
  applyUpdate: () => req<UpdateApplyResult>("POST", "/api/updates/apply"),
  /** Fire-and-forget product pulse; a no-op unless a collector endpoint is configured. */
  recordPulse: (event: string, properties?: Record<string, unknown>) =>
    req<{ ok: boolean; enabled: boolean }>("POST", "/api/pulse", { event, properties }),
  /** Flip local ↔ remote. Throws ApiError "NEEDS_OWNER" if remote needs a sign-in first. */
  setMode: (mode: AccessMode) => req<ModeResult>("PUT", "/api/mode", { mode }),
  /** Configure the stable named tunnel (hostname + connector token). Token is write-only — pass
   *  "" to clear a field, omit it to keep the saved one. The daemon persists + (if remote is on)
   *  restarts the tunnel so the new stable host takes effect immediately. */
  setTunnel: (input: { hostname?: string; token?: string }) =>
    req<TunnelResult>("PUT", "/api/tunnel", input),
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
  /** Toggle the auto-commit timer (owner setting; persisted). Per-repo opt-in still required. */
  setAutoCommit: (enabled: boolean) =>
    req<{ ok: boolean; autoCommit: boolean }>("PUT", "/api/settings", { autoCommit: enabled }),
  /** Set the auto-commit schedule mode ("interval" | "daily"; persisted). */
  setAutoCommitMode: (mode: "interval" | "daily") =>
    req<{ ok: boolean; autoCommitMode: "interval" | "daily" }>("PUT", "/api/settings", { autoCommitMode: mode }),
  /** Set the auto-commit interval cadence in seconds (server clamps to [60,86400] + persists). */
  setAutoCommitInterval: (secs: number) =>
    req<{ ok: boolean; autoCommitIntervalSecs: number }>("PUT", "/api/settings", { autoCommitIntervalSecs: secs }),
  /** Set the auto-commit daily fire time "HH:MM" (server normalises + persists). */
  setAutoCommitAt: (at: string) =>
    req<{ ok: boolean; autoCommitAt: string }>("PUT", "/api/settings", { autoCommitAt: at }),
  /** Toggle whether auto-commit pulls (--ff-only) before pushing (persisted). */
  setAutoCommitPull: (enabled: boolean) =>
    req<{ ok: boolean; autoCommitPull: boolean }>("PUT", "/api/settings", { autoCommitPull: enabled }),
  /** Toggle whether auto-commit pushes after committing (persisted). */
  setAutoCommitPush: (enabled: boolean) =>
    req<{ ok: boolean; autoCommitPush: boolean }>("PUT", "/api/settings", { autoCommitPush: enabled }),
  /** Toggle auto-scanning the whole machine on every app start (owner setting; persisted). */
  setAutoScan: (enabled: boolean) =>
    req<{ ok: boolean; autoScan: boolean }>("PUT", "/api/settings", { autoScan: enabled }),
  /** Toggle whether the Lore-servers settings section is expanded (owner setting; persisted). */
  setLoreServersEnabled: (enabled: boolean) =>
    req<{ ok: boolean; loreServersEnabled: boolean }>("PUT", "/api/settings", { loreServersEnabled: enabled }),
  /** Toggle opening the app UI in a chromeless app window instead of a browser tab (owner
   *  setting; persisted). The desktop launcher/tray follows the same preference. */
  setPortableMode: (enabled: boolean) =>
    req<{ ok: boolean; portableMode: boolean }>("PUT", "/api/settings", { portableMode: enabled }),
  /** Open THIS daemon's UI in a chromeless Chromium app window right now. */
  openPortableWindow: () => req<PortableWindowResult>("POST", "/api/portable-window"),
  /** Toggle hiding the system-tray notification-area icon (owner setting; persisted). The app
   *  keeps running in the background either way — the launcher shortcut still reopens the UI,
   *  and this can be flipped back here in Settings. */
  setHideTrayIcon: (enabled: boolean) =>
    req<{ ok: boolean; hideTrayIcon: boolean }>("PUT", "/api/settings", { hideTrayIcon: enabled }),
  /** Toggle silent auto-update + restart of the app on a schedule (owner setting; persisted). */
  setAutoUpdate: (enabled: boolean) =>
    req<{ ok: boolean; autoUpdate: boolean }>("PUT", "/api/settings", { autoUpdate: enabled }),
  /** ⭐ Agent Safety Rail: toggle the MCP mutating-call approval gate (owner setting; persisted). */
  setMcpApprovalGate: (enabled: boolean) =>
    req<{ ok: boolean; mcpApprovalGate: boolean }>("PUT", "/api/settings", { mcpApprovalGate: enabled }),
  /** Set the auto-deny timeout in seconds (server clamps to [10,3600] + persists). */
  setMcpApprovalTimeoutSecs: (secs: number) =>
    req<{ ok: boolean; mcpApprovalTimeoutSecs: number }>("PUT", "/api/settings", {
      mcpApprovalTimeoutSecs: secs,
    }),
  /** Toggle whether a pending approval auto-denies after its timeout (owner setting; persisted). */
  setMcpAutoDeny: (enabled: boolean) =>
    req<{ ok: boolean; mcpAutoDeny: boolean }>("PUT", "/api/settings", { mcpAutoDeny: enabled }),
  /** Toggle whether a pending approval auto-approves after its timeout (owner setting; persisted). */
  setMcpAutoApprove: (enabled: boolean) =>
    req<{ ok: boolean; mcpAutoApprove: boolean }>("PUT", "/api/settings", { mcpAutoApprove: enabled }),
  /** Set the auto-approve timeout in seconds (server clamps to [10,3600] + persists). */
  setMcpAutoApproveTimeoutSecs: (secs: number) =>
    req<{ ok: boolean; mcpAutoApproveTimeoutSecs: number }>("PUT", "/api/settings", {
      mcpAutoApproveTimeoutSecs: secs,
    }),

  // ── "Open with…" external editors (loopback-only) ─────────────────────────────
  /** Detected editors on the daemon's machine + the effective default. */
  editors: () => req<EditorsResult>("GET", "/api/editors"),
  /** Set the default "Open with…" editor id (""=auto-pick first installed; persisted). */
  setDefaultEditor: (id: string) =>
    req<{ ok: boolean; defaultEditor: string | null }>("PUT", "/api/settings", { defaultEditor: id }),
  /** Launch a repo folder (and optional changed file) in an external editor. `editor` omitted ⇒
   *  the owner's default; `path` omitted ⇒ the folder alone. Loopback-only (403 over the tunnel). */
  openInEditor: (repoId: string, body: { editor?: string; path?: string }) =>
    req<OpenResult>("POST", `/api/repos/${repoId}/open`, body),

  // ── ⭐ Agent Safety Rail — pending MCP tool-call approvals ────────────────────
  /** Every MCP mutating tool call currently awaiting owner approve/deny. */
  listApprovals: () => req<{ approvals: PendingApproval[] }>("GET", "/api/approvals").then((r) => r.approvals),
  approveCall: (id: string) => req<{ ok: boolean }>("POST", `/api/approvals/${id}/approve`),
  denyCall: (id: string) => req<{ ok: boolean }>("POST", `/api/approvals/${id}/deny`),

  listRepos: () => req<{ repos: Repo[] }>("GET", "/api/repos").then((r) => r.repos),
  listIdentities: () => req<{ identities: Identity[] }>("GET", "/api/identities").then((r) => r.identities),
  detectedIdentities: () =>
    req<{ detected: DetectedIdentity[]; dismissed: DetectedIdentity[] }>("GET", "/api/identities/detected"),
  /** Dismiss a detected suggestion (by its stable id) so it stops re-appearing. */
  dismissDetectedIdentity: (id: string) =>
    req<{ ok: boolean; dismissedCount: number }>("POST", `/api/identities/detected/${id}/dismiss`),
  /** Un-dismiss ONE suggestion (temporary undo + per-item restore). */
  restoreDetectedIdentity: (id: string) =>
    req<{ ok: boolean; dismissedCount: number }>("POST", `/api/identities/detected/${id}/restore`),
  /** Un-dismiss everything — bring previously-hidden suggestions back. */
  restoreDetectedIdentities: () =>
    req<{ ok: boolean }>("POST", "/api/identities/detected/restore"),

  createIdentity: (input: Omit<Identity, "id">) =>
    req<{ identity: Identity }>("POST", "/api/identities", input).then((r) => r.identity),

  // ── ⭐ Identity Firewall — rules pinning a required identity to a repo-path glob ────
  identityRules: () => req<{ rules: IdentityRule[] }>("GET", "/api/identity-rules").then((r) => r.rules),
  /** Replace the full rule list (v1 is dead simple: no per-rule CRUD). Throws ApiError
   *  (NOT_FOUND) when a rule names an identity that doesn't exist. */
  setIdentityRules: (rules: IdentityRule[]) =>
    req<{ ok: boolean; rules: IdentityRule[] }>("PUT", "/api/identity-rules", { rules }).then((r) => r.rules),

  // ── GitHub (gh) accounts — read + switch the machine's active account ──────────
  /** The machine's authenticated GitHub accounts + which is active + the global git author. */
  accounts: () => req<AccountsSnapshot>("GET", "/api/accounts"),
  /** Switch the active GitHub account (host defaults to github.com). Returns the fresh snapshot;
   *  throws ApiError (NOT_CONFIGURED / NOT_FOUND / ERROR) → the caller toasts. */
  switchAccount: (login: string, host?: string) =>
    req<AccountsSnapshot & { ok: boolean; switched: string }>(
      "POST",
      "/api/accounts/switch",
      host ? { login, host } : { login },
    ),
  /** Link (or unlink, with null) a GitHub account to a saved commit identity — applied on the next
   *  switch to that account. Returns the fresh snapshot; throws ApiError (NOT_FOUND) → caller toasts. */
  setAccountIdentity: (login: string, identityId: string | null, host?: string) =>
    req<AccountsSnapshot>("PUT", "/api/accounts/identity", { login, identityId, ...(host ? { host } : {}) }),
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

  /** Pin (or clear, with null login) the GitHub account a repo authenticates as for fetch/pull/push. */
  assignRepoAccount: (repoId: string, host: string | null, login: string | null) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/account`, { host, login }).then((r) => r.repo),

  setHidden: (repoId: string, hidden: boolean) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/hidden`, { hidden }).then((r) => r.repo),

  setPinned: (repoId: string, pinned: boolean) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/pinned`, { pinned }).then((r) => r.repo),

  setStarred: (repoId: string, starred: boolean) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/starred`, { starred }).then((r) => r.repo),

  /** Opt a repo in/out of the auto-commit timer (per-repo; the daemon only auto-commits opted-in repos). */
  setRepoAutoCommit: (repoId: string, autoCommit: boolean) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/auto-commit`, { autoCommit }).then((r) => r.repo),

  // Actions return a structured result even on a "handled" failure (409 etc.):
  // ApiError is thrown, carrying .code/.message — callers translate to a toast.
  fetch: (id: string) => req<ActionResult>("POST", `/api/repos/${id}/fetch`),
  pull: (id: string) => req<ActionResult>("POST", `/api/repos/${id}/pull`),
  push: (id: string) => req<ActionResult>("POST", `/api/repos/${id}/push`),
  commit: (id: string, message: string, amend = false) =>
    req<ActionResult>("POST", `/api/repos/${id}/commit`, { message, amend }),
  /** Commit ONLY the selected paths in one ordinary commit (per-file staging); the rest stay
   *  pending. A stale path (no longer changed) comes back as PLAN_STALE. */
  commitSelected: (id: string, message: string, paths: string[]) =>
    req<ActionResult>("POST", `/api/repos/${id}/commit-selected`, { message, paths }),
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
  log: (id: string, limit = 50, skip = 0, refs?: "head" | "local" | "all") =>
    req<LogResult>(
      "GET",
      `/api/repos/${id}/log?limit=${limit}&skip=${skip}${refs ? `&refs=${refs}` : ""}`,
    ),
  commitDetail: (id: string, hash: string) =>
    req<CommitDetail>("GET", `/api/repos/${id}/commit/${encodeURIComponent(hash)}`),
  /** Both sides of a file's change AT a commit (first-parent ↔ commit) — powers opening a
   *  history file in the Monaco diff viewer. Same FileDiff shape as `fileDiff`. */
  commitFile: (id: string, hash: string, path: string) =>
    req<FileDiff>(
      "GET",
      `/api/repos/${id}/commit/${encodeURIComponent(hash)}/file?path=${encodeURIComponent(path)}`,
    ),
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
  /** Stage one changed file's working-tree change into the index (non-destructive; doesn't
   *  commit — GitHub-Desktop-style per-file "Stage"). */
  stage: (id: string, path: string) =>
    req<{ ok: boolean; code: string; message?: string; path?: string }>(
      "POST",
      `/api/repos/${id}/stage`,
      { path },
    ),
  /** Append a path to the repo's .gitignore (idempotent; anchored to the repo root). */
  addToGitignore: (id: string, path: string) =>
    req<{ ok: boolean; code: string; message?: string; pattern?: string; alreadyIgnored?: boolean }>(
      "POST",
      `/api/repos/${id}/gitignore`,
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

  /** Move a changed file into another folder (drag-and-drop in the changes tree). Throws on 4xx/5xx. */
  moveFile: (id: string, from: string, toDir: string) =>
    req<{ ok: boolean; code: string; message?: string; from?: string; to?: string }>(
      "POST",
      `/api/repos/${id}/move`,
      { from, toDir },
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
    /** Toggle whether the AI commit buttons are shown at all (default on). */
    setCommitEnabled: (commitEnabled: boolean) => req<AiSettings>("PUT", "/api/ai/settings", { commitEnabled }),
    /** Set the AI commit-message style (conventional / concise / detailed). */
    setStyle: (style: CommitStyle) => req<AiSettings>("PUT", "/api/ai/settings", { style }),
    /** Set how much of each file's diff the smart-commit planner reads (the token-cost dial). */
    setDiffDetail: (diffDetail: DiffDetail) => req<AiSettings>("PUT", "/api/ai/settings", { diffDetail }),
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
        { ...(provider ? { provider } : {}), ...(paths?.length ? { paths } : {}) },
      ),
    /** Propose a multi-commit plan from the repo's working tree (commits nothing). With `paths`,
     *  scope the plan to just those files (the owner's checked selection); omit/empty for the
     *  whole working tree — an empty checked selection is treated as "plan everything". */
    commitPlan: (repoId: string, provider?: AiProviderId, paths?: string[]) =>
      req<CommitPlanResponse>(
        "POST",
        `/api/repos/${repoId}/commit-plan`,
        { ...(provider ? { provider } : {}), ...(paths?.length ? { paths } : {}) },
      ),
  },
};
