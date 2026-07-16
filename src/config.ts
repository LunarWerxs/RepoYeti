/**
 * Daemon configuration + paths.
 *
 * All local state lives under ~/.repoyeti (never inside any tracked repo). The
 * config file holds only non-secret operational settings (roots, port, limits);
 * secrets (AI keys, OAuth client_secret) live in the OS keychain via secrets.ts —
 * `hydrateSecrets()` loads them into memory at boot and `saveConfig()` strips them
 * from disk. They only fall back into config.json (0600) if no OS keychain exists.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import {
  getSecret,
  setSecret,
  deleteSecret,
  keychainAvailable,
  aiKeyName,
  OAUTH_CLIENT_SECRET,
  TUNNEL_TOKEN,
  API_TOKEN,
} from "./secrets.ts";

export const VERSION = "0.6.0";

/** Local state dir. Override with REPOYETI_HOME (used by tests; also handy for relocating state). */
export const CONFIG_DIR = process.env.REPOYETI_HOME ?? join(homedir(), ".repoyeti");
export const DB_PATH = join(CONFIG_DIR, "repoyeti.db");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * "Sign in with Connections" (public OIDC) config. Present → auth is ENFORCED on
 * every /api/* route (and required before any tunnel is exposed). Absent → the
 * daemon is local-only (127.0.0.1) with no auth. See docs/ARCHITECTURE.md §7/§13.
 */
export interface OAuthConfig {
  /** IdP issuer origin, e.g. https://accounts.connections.icu */
  issuer: string;
  /** Public OAuth app client id (registered in the IdP). */
  clientId: string;
  /** Only for a confidential client; a public PKCE client omits it. */
  clientSecret?: string;
  /** Registered redirect URI — the fixed shim URL (Path A) or the loopback (Path B). */
  redirectUri: string;
  /** The single owner this daemon admits (match either). */
  ownerSub?: string;
  ownerEmail?: string;
  /** OAuth scopes (default: "openid profile email"). */
  scopes?: string;
}

/**
 * Bring-your-own-key AI config. The owner pastes a provider API key; RepoYeti uses it
 * SERVER-SIDE only (list models + draft commit messages) and never returns it to any
 * client. The key bytes live in the OS keychain (see secrets.ts) — config.json on disk
 * carries only the selected model; `apiKey` is hydrated into this in-memory shape at boot
 * by `hydrateSecrets()` and stripped again by `saveConfig()`.
 */
export type AiProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "groq"
  | "openrouter";

/**
 * Safe display metadata for one AI provider — contains NO secrets.
 * Served to the web via GET /api/ai/catalog so the Settings UI never drifts
 * from what the daemon actually accepts.
 */
export interface AiCatalogEntry {
  id: AiProviderId;
  /** Human-readable provider name shown in the Settings UI. */
  label: string;
  /** The console/key-management URL (without "https://") shown as a link. */
  url: string;
  /** API-key format hint shown in the password input placeholder. */
  keyPlaceholder: string;
  /** True when the provider offers a free tier (shows a "Free tier available" badge — this means
   *  the vendor's API has a free usage tier, NOT that a key is present or that only the free tier
   *  is supported; it's a signpost to a zero-cost option). */
  free?: boolean;
  /** The one provider we steer new owners to (Groq): free, fast, ~30s to set up. Renders a
   *  "Suggested" badge + a get-a-key nudge so a fresh install isn't stuck picking a provider. */
  suggested?: boolean;
  /**
   * Preferred chat model id for commit messages, used as the default the moment a key connects
   * (instead of blindly taking the first model the provider lists — which for Groq is a Whisper
   * transcription model that can't chat). Best-effort: if the live model list doesn't contain it,
   * the connect handler falls back to the first CHAT model. Bump this one line when a newer model
   * ships (e.g. a "v4 turbo") — that's the whole "dynamic" story.
   */
  recommended?: string;
}

/**
 * Single source of truth for every AI provider RepoYeti supports.
 * Derive AI_PROVIDERS from this so they can never diverge.
 * Order = display order in the Settings UI (free providers first).
 */
export const AI_CATALOG: readonly AiCatalogEntry[] = [
  { id: "groq",       label: "Groq",      url: "console.groq.com/keys",    keyPlaceholder: "gsk_…",     free: true, suggested: true, recommended: "llama-3.3-70b-versatile" },
  { id: "openrouter", label: "OpenRouter", url: "openrouter.ai/keys",       keyPlaceholder: "sk-or-…",   free: true, recommended: "meta-llama/llama-3.3-70b-instruct:free" },
  { id: "gemini",     label: "Gemini",     url: "aistudio.google.com",      keyPlaceholder: "AIza…",     free: true, recommended: "gemini-2.0-flash" },
  { id: "anthropic",  label: "Claude",     url: "console.anthropic.com",    keyPlaceholder: "sk-ant-…",              recommended: "claude-3-5-haiku-latest" },
  { id: "openai",     label: "ChatGPT",    url: "platform.openai.com",      keyPlaceholder: "sk-…",                  recommended: "gpt-4o-mini" },
  { id: "deepseek",   label: "DeepSeek",   url: "platform.deepseek.com",    keyPlaceholder: "sk-…",                  recommended: "deepseek-chat" },
];

/** Static catalogue — drives route validation. Derived from AI_CATALOG so they stay in sync. */
export const AI_PROVIDERS: readonly AiProviderId[] = AI_CATALOG.map((e) => e.id);

export type CommitStyle = "conventional" | "concise" | "detailed";

/**
 * How much of EACH changed file the smart-commit planner reads (see foldLargeFileDiffs in
 * git-actions/diff.ts for the mechanism, and DIFF_DETAIL_CAPS for the chars each maps to).
 *
 * It's a cost dial for GROUPING, which is unaffected by it: the planner always gets the COMPLETE
 * file list with every file's real +/- stat. Leaner = fewer tokens per commit, which on a
 * rate-limited free tier is directly more commits per day.
 *
 * It is NOT free for the commit MESSAGES the same call writes, and reading it as "not a quality
 * switch" is what let a real bug ship: an over-cap file used to fold down to a symbol map with no
 * line bodies at all, so the message-writer saw declaration names and +/- counts and nothing else.
 * It answered accordingly ("Modified `AI_ADAPTERS` record to accommodate changes") and looked
 * lazy, when it had simply never been shown the code. condenseFileChunk now spends the cap's
 * leftover room on verbatim lines, so a folded file still says something true — but the dial still
 * decides HOW MUCH of a large file anything downstream can describe. Raise it if bodies read thin.
 */
export type DiffDetail = "lean" | "balanced" | "thorough";

/**
 * The dial's default when the owner hasn't picked one. ONE constant on purpose: this default was
 * previously a `?? "balanced"` literal repeated across ~10 call sites (config, routes, service,
 * auto-commit, the collectors), which is a default nobody can change safely — you'd have to find
 * every copy and miss none.
 *
 * `lean` because it's the better default on evidence, not taste: measured live on a real tree, it
 * produced accurate, specific commit messages indistinguishable in quality from `balanced` while
 * sending ~30% fewer tokens (~13 plans/day vs ~10 on Groq's free 100k/day). It also costs nothing
 * on a TYPICAL commit — small files sit under the per-file cap and are sent verbatim either way,
 * so the dial only bites on large files, exactly where the savings are and where a summary is
 * enough. Owners who want more body from big files raise it in Settings → AI.
 */
export const DEFAULT_DIFF_DETAIL: DiffDetail = "lean";

export interface AiProviderCfg {
  /** Secret API key — kept in the OS keychain, hydrated into memory at boot, never on disk
   *  and never returned to a client. Optional because the on-disk shape omits it. */
  apiKey?: string;
  /** The model selected for this provider (null until the owner picks one). */
  model: string | null;
}

export interface AiConfig {
  providers: Partial<Record<AiProviderId, AiProviderCfg>>;
  /** Which configured provider the "Generate" button uses. */
  defaultProvider?: AiProviderId;
  /**
   * Whether the AI commit affordances (the ✨ Generate button + the "Auto" smart-commit button)
   * are SHOWN at all. Default ON — the buttons appear even with no key, and clicking one with no
   * usable provider nudges the owner to add a key (or turn this off). Set false to hide them
   * entirely for owners who write their own messages.
   */
  commitEnabled?: boolean;
  /** Commit-message style for the prompt (default "conventional"). Pickable from Settings → AI
   *  and from the smart-commit plan header; settable here too. */
  style?: CommitStyle;
  /** How much of each file's diff the smart-commit planner reads (default DEFAULT_DIFF_DETAIL). The cost
   *  dial — see the DiffDetail docs. Pickable from Settings → AI. */
  diffDetail?: DiffDetail;
  /**
   * Smart-commit "YOLO" mode (default off): when on, the Smart Commit button skips the
   * review editor — it generates the plan and commits it immediately (no review, no
   * auto-push). For an owner who trusts the AI and never edits the plan.
   */
  yolo?: boolean;
}

/**
 * Access mode (owner-toggleable in Settings):
 *  - "local"  → localhost-only; local requests need no login (the daemon binds 127.0.0.1).
 *  - "remote" → a Cloudflare tunnel is exposed; requests arriving over it ALWAYS require a
 *    signed-in owner. Local requests may still "continue local" without logging in.
 * Default "local" — a fresh install is frictionless and nudges the owner toward remote.
 */
export type AccessMode = "local" | "remote";

/**
 * A registered Lore server (centralized server-of-record). RepoYeti stores only the URL + a
 * display name — never credentials: Lore auth is delegated to the CLI's own session
 * (`lore login <url>`). Prefer an IP literal over `localhost` in the URL (a localhost→IPv6
 * QUIC handshake stalls ~30s before falling back to IPv4).
 */
export interface LoreServer {
  id: string;
  name: string;
  url: string;
}

/**
 * Remote-access tunnel config. Absent (the default) = a free, ephemeral cloudflared **quick
 * tunnel** → a rotating `*.trycloudflare.com` URL. Set `hostname` + `token` to run a **named**
 * Cloudflare tunnel instead: a STABLE public host (e.g. "app.repoyeti.com") that doesn't rotate
 * and — unlike trycloudflare, which DNS filters / mobile carriers widely block as abuse — resolves
 * on any network.
 *
 * The public-host → local-service mapping (e.g. app.repoyeti.com → http://localhost:7171) lives in
 * the Cloudflare dashboard (the tunnel's "public hostname"), so `cloudflared run --token` prints no
 * URL — the daemon advertises `https://<hostname>` directly once an edge connection is up. The
 * `token` is a connector credential (sensitive): like `oauth.clientSecret` it's kept in the OS
 * keychain and stripped from config.json. Env `CF_TUNNEL_TOKEN` overrides it (handy for the
 * launcher / rotation; never written to disk).
 */
export interface TunnelConfig {
  /** "quick" (default) = ephemeral trycloudflare; "named" = stable host via `token`. An explicit
   *  "quick" forces the quick tunnel even when a named tunnel is configured (without deleting it). */
  provider?: "quick" | "named";
  /** The stable public host a named tunnel serves, e.g. "app.repoyeti.com". */
  hostname?: string;
  /** Named-tunnel connector token (Cloudflare dashboard / `cloudflared tunnel token <name>`).
   *  SECRET — keychain-stored, never written to config.json. */
  token?: string;
}

export interface PulseConfig {
  /** Connections-compatible event collector URL. Absent means pulse is inert (nothing is ever
   *  sent). Env REPOYETI_PULSE_URL / CONNECTIONS_PULSE_URL override this when set. */
  endpoint?: string;
  /** Anonymous per-install id. Generated only after pulse is configured and first used. */
  installId?: string;
}

/**
 * Optional "Sync my settings with Connections" (settings-sync data locker). Off by default and
 * purely additive: when the owner opts in AND is signed in with Connections, the daemon (the BFF)
 * pushes a small allowlisted subset of portable settings (theme/accent + operational toggles) to
 * `studio.connections.icu/v1/app-data/{clientId}` and pulls them on every machine the same account
 * signs into. The refresh token that authorizes those calls lives in the OS keychain (see
 * secrets.ts CONNECTIONS_REFRESH_TOKEN), NEVER here; this block holds only non-secret sync state.
 * See src/connections-sync.ts.
 */
export interface CloudSyncConfig {
  /** The owner turned settings sync on. Absent/false = off (the whole feature is inert). */
  enabled?: boolean;
  /** ISO-8601 timestamp of the last successful push/pull, for the "Synced ✓ · just now" UI. */
  lastSyncedAt?: string;
  /** The store document version last seen — the optimistic-concurrency base for the next write. */
  version?: number;
  /** The last appearance blob (theme/accent) mirrored from the web, so a fresh page load can apply
   *  the synced look before the web has pushed anything this session. Non-secret, portable. */
  appearance?: Record<string, unknown>;
}

export interface RepoYetiConfig {
  /** Absolute root paths to recursively scan for git repos. */
  roots: string[];
  /** Registered Lore servers the owner can clone repos from (see LoreServer). */
  servers?: LoreServer[];
  /**
   * Whether the Lore-servers settings section is expanded (owner setting; pure stored
   * flag, no daemon-side effect). Absent = derive a sensible one-time default the first
   * time /api/status is read: true if the owner already has servers configured, else
   * false (see health.ts's GET /api/status). Once explicitly set, that value sticks.
   */
  loreServersEnabled?: boolean;
  /** Preferred HTTP port (auto-increments if taken). */
  port: number;
  /** Max BFS depth when discovering repos under a root. */
  maxDepth: number;
  /** Hard cap on auto-discovered repos (inotify-budget guard on Linux). */
  maxRepos: number;
  /** Local-only vs remote-exposed. See AccessMode. Defaults to "local". */
  mode?: AccessMode;
  /**
   * Show added/removed line + character counts per file and per repo (off by default).
   * Gated here because computing it adds a `git diff` parse to every status read; see
   * src/diffstat.ts.
   */
  diffStats?: boolean;
  /**
   * Allow editing & saving files through the viewer over the remote tunnel. Local (loopback)
   * edits are always allowed. Defaults to true (absent = enabled).
   */
  remoteEditing?: boolean;
  /**
   * File-viewer Diff-tab threshold (bytes): a changed file larger than this on either side
   * ships as a compact server-computed `git diff` patch instead of both whole copies for a
   * side-by-side view. Owner setting (the Settings UI writes it); clamped on read. See
   * getDiffPatchBytes / setDiffPatchBytes in src/service.ts. Absent = the built-in default.
   */
  diffPatchBytes?: number;
  /**
   * When false, the file viewer never switches large files to the compact patch — every diff
   * loads full side-by-side (and may be truncated past the read cap). Defaults to true (absent
   * = patch mode on). The Settings "Always side-by-side" toggle is the inverse of this.
   */
  diffPatchEnabled?: boolean;
  /**
   * Background remote-sync check: periodically fetch every repo so the dashboard can warn the
   * owner when a repo falls behind its remote. Absent = ON (a fresh install gets the check);
   * set false to disable. The cadence is `syncIntervalSecs`. See src/remote-sync.ts.
   */
  syncCheck?: boolean;
  /**
   * How often the background sync check fetches, in seconds. Clamped to [30, 3600] on read;
   * absent = the built-in default (120s). Owner setting (the Settings UI writes it).
   */
  syncIntervalSecs?: number;
  /**
   * "Keep in sync": after each background check, auto fast-forward repos that can safely take
   * the new commits (clean tree, no local divergence). Absent/false = OFF — auto-pulling mutates
   * the working copy, so it stays strictly opt-in. Only acts when `syncCheck` is on.
   */
  keepInSync?: boolean;
  /**
   * Auto-commit: a daemon-wide timer that, for each repo the owner OPTED IN per-repo (the repos
   * table's `auto_commit` flag), automatically Smart-Commits its uncommitted changes and (by
   * default) pulls + pushes — see src/auto-commit.ts. Absent/false = OFF: it commits AND pushes
   * unattended, so it is strictly opt-in both globally (here) and per repo. A repo with a merge
   * conflict or mid-merge/rebase state is always skipped (never auto-committed).
   */
  autoCommit?: boolean;
  /**
   * How the auto-commit timer fires: "interval" = every `autoCommitIntervalSecs`; "daily" = once
   * per day at `autoCommitAt` (local time). Absent = "interval".
   */
  autoCommitMode?: "interval" | "daily";
  /**
   * Auto-commit cadence in seconds for "interval" mode. Clamped to [60, 86400] on read; absent =
   * the built-in default (900s / 15 min). Owner setting (the Settings UI writes it).
   */
  autoCommitIntervalSecs?: number;
  /** Local wall-clock time "HH:MM" the "daily" mode fires at. Absent = "18:00". */
  autoCommitAt?: string;
  /** Whether auto-commit also `pull --ff-only`s before pushing (absent = true). */
  autoCommitPull?: boolean;
  /** Whether auto-commit pushes after committing (absent = true). false = commit locally only. */
  autoCommitPush?: boolean;
  /**
   * Auto-update the app on a schedule: check the update remote, and when a newer commit is
   * available AND the working tree is clean (canApply), pull + reinstall + rebuild, then
   * self-relaunch so the new code takes over — see src/auto-update.ts. Absent/false = OFF
   * (opt-in): it restarts the daemon unattended. A dirty tree is never updated.
   */
  autoUpdate?: boolean;
  /** Auto-update check cadence in seconds. Clamped to [900, 604800]; absent = 21600 (6 h). */
  autoUpdateIntervalSecs?: number;
  /**
   * Auto-scan the whole machine on every app start. Absent/false = OFF (opt-in) — a fresh
   * install never sweeps the filesystem unasked. Purely a stored flag: the WEB client reads
   * it at boot and decides whether to fire `POST /api/scan`; the daemon itself takes no
   * action on it. See AppShell.vue's `autoScanOnStart`.
   */
  autoScan?: boolean;
  /**
   * Open the app UI in a chromeless Chromium app window (msedge/chrome --app=URL) instead of a
   * normal browser tab. Absent/false = OFF (a plain tab). Applies both to the in-app toggle
   * (POST /api/portable-window, fired the moment it's switched on) and to the desktop
   * launcher/tray, which reads this flag off runtime.json (see src/instance.ts) so a cold start
   * follows the same preference before the daemon is even up. See src/portable-window.mjs.
   */
  portableMode?: boolean;
  /**
   * Hide the system-tray notification-area icon. Absent/false = OFF (icon shown). The tray
   * launcher reads this off runtime.json (see src/instance.ts), same pattern as portableMode —
   * it gates only the NotifyIcon's .Visible, never its creation, so Quit/menu/watchdog machinery
   * keeps working and the daemon keeps running in the background. Re-enabling from this Settings
   * UI restores the icon within a few seconds without restarting anything (see misc/RepoYeti-Tray.ps1).
   */
  hideTrayIcon?: boolean;
  /**
   * "Open with…" default external editor id (see src/service/editors.ts CATALOG — "vscode",
   * "cursor", "notepad++", the "system" file-manager pseudo-editor, …). The file viewer's
   * Open-with button launches this when the owner doesn't pick a specific editor from the
   * dropdown. Absent ⇒ the first installed editor is used. Purely a local convenience: editors
   * are launched on the daemon's machine, so the feature is loopback-only.
   */
  defaultEditor?: string;
  /** OIDC config. Always present (the public Connections client is baked into DEFAULTS),
   *  so "Sign in with Connections" works with zero setup; the owner just clicks the button. */
  oauth?: OAuthConfig;
  /** Remote-access tunnel config (quick trycloudflare by default; named for a stable host). */
  tunnel?: TunnelConfig;
  /** Optional product pulse, forwarded to a Connections-compatible endpoint when configured. */
  pulse?: PulseConfig;
  /** Optional "Sync my settings with Connections" state (off by default). See CloudSyncConfig. */
  cloudSync?: CloudSyncConfig;
  /** Bring-your-own-key AI config (optional). */
  ai?: AiConfig;
  /**
   * OPTIONAL, owner-minted API Bearer token (off by default). When present, a request carrying
   * `Authorization: Bearer <token>` passes the /api/* gate just like an owner session — so a
   * remote/headless agent can authenticate over the tunnel without a browser sign-in. It's a
   * separate, LOCAL credential (minted via POST /api/auth/token; never touches connections.icu).
   * Absent ⇒ auth behaves EXACTLY as OIDC-only (zero behavior change). Like the tunnel token, the
   * durable bytes live in the OS keychain (see secrets.ts API_TOKEN) — this in-memory slot is
   * hydrated at boot by `hydrateSecrets()` and stripped from config.json by `saveConfig()`.
   */
  apiToken?: string;
  /**
   * Agent Safety Rail (default ON): every MUTATING MCP tool call (git_commit, create_branch,
   * git_checkout, git_push, git_pull, git_fetch — the readOnly:false tools in src/mcp/tools.ts)
   * blocks pending a one-tap human approve/deny in the dashboard, over EITHER MCP transport
   * (stdio or the in-process HTTP adapter). Read-only tool calls and dashboard-originated HTTP
   * actions are never gated. Absent = ON (`b.mcpApprovalGate !== false` is the on-check). Set
   * false to restore pre-gate behavior exactly. See src/approvals.ts + src/mcp/core.ts.
   */
  mcpApprovalGate?: boolean;
  /**
   * Auto-deny timeout for a pending MCP approval, in seconds. Clamped to [10, 3600] on read;
   * absent = the built-in default (120s / src/approvals.ts APPROVAL_TIMEOUT_DEFAULT_MS). Only
   * armed when `mcpAutoDeny` is on (below).
   */
  mcpApprovalTimeoutSecs?: number;
  /**
   * Whether a pending approval auto-DENIES after `mcpApprovalTimeoutSecs`. Absent = ON (preserves
   * the historic always-times-out-and-denies behavior). Turn OFF to let a request wait for a manual
   * decision indefinitely (or until `mcpAutoApprove` resolves it). See src/approvals.ts.
   */
  mcpAutoDeny?: boolean;
  /**
   * Whether a pending approval auto-APPROVES after `mcpAutoApproveTimeoutSecs`. Absent = OFF (the
   * whole point of the gate is a human in the loop — opt in deliberately). When both auto-deny and
   * auto-approve are on, whichever duration elapses first wins. See src/approvals.ts.
   */
  mcpAutoApprove?: boolean;
  /**
   * Auto-approve timeout, in seconds (same [10, 3600] clamp as the deny timeout). Absent = the
   * built-in default (120s). Only armed when `mcpAutoApprove` is on.
   */
  mcpAutoApproveTimeoutSecs?: number;
  /**
   * Identity Firewall (default v1, kept dead simple): a list of rules pinning which saved
   * identity MUST be used to commit/push in repos matching a filesystem-path glob. Every
   * mutating action that resolves a commit identity (fetch/pull/push/commit/checkout/
   * createBranch/stash/tag in src/service/core.ts's runAction, plus smart-commit +
   * commit-selected in src/service/actions.ts) is preflight-checked against these rules — a
   * matching repo whose resolved identity (src/identity.ts resolveRepoIdentity) isn't
   * `requiredIdentityId` hard-blocks with IDENTITY_POLICY_VIOLATION, over BOTH the dashboard
   * HTTP routes and MCP (which call the exact same service functions). Absent/empty = no
   * rules — zero behavior change. See src/identity.ts matchIdentityRule / checkIdentityPolicy.
   */
  identityRules?: IdentityRule[];
  /**
   * Detected-identity suggestions the owner has dismissed (by their stable `id` hash from
   * src/identity-detect.ts). Detection re-reads the machine (git config / SSH keys / gh) on every
   * refresh, so without this a suggestion the owner "deleted" (or never wants) just comes back —
   * dismissed ids are filtered out of GET /api/identities/detected. Absent/empty = show everything.
   */
  dismissedIdentities?: string[];
}

/**
 * One Identity Firewall rule: repos whose absolute path matches `pathPattern` (a glob — see
 * src/identity.ts matchGlob for the tiny supported syntax) MUST resolve to `requiredIdentityId`
 * for any commit/push. First-match-wins when a repo matches more than one rule (rules are
 * checked in array order); a repo matching no rule is unrestricted (existing behavior).
 */
export interface IdentityRule {
  /** Glob against the repo's absolute filesystem path (case-insensitive on Windows). E.g.
   *  "D:/Work/**" or "**\/client-projects/*". */
  pathPattern: string;
  /** The only identity id allowed to commit/push in a matching repo. */
  requiredIdentityId: string;
}

/** The redacted AI view safe to send to any client — keys are dropped entirely. */
export interface RedactedAiConfig {
  providers: Partial<Record<AiProviderId, { configured: true; model: string | null }>>;
  defaultProvider: AiProviderId | null;
  style: CommitStyle;
  /** How much of each file's diff the smart-commit planner reads. Default DEFAULT_DIFF_DETAIL. */
  diffDetail: DiffDetail;
  /** Smart-commit YOLO mode (commit the AI plan without review). Default false. */
  yolo: boolean;
  /** Whether the AI commit buttons are shown (default true — visible even with no key). */
  commitEnabled: boolean;
}

/**
 * AI is bring-your-own-key: RepoYeti ships with NO baked-in key. Groq revokes any key committed to
 * a public repo (and GitHub secret-scanning blocks the push anyway), so a shipped "free" key is
 * dead on arrival — there's no safe way to bundle one. Owners add their own free key in Settings →
 * AI; Groq is the suggested provider (free + fast, ~30s to set up — see AI_CATALOG `suggested`).
 */

/** Effective API key for a provider — the owner's own key, or null when none is set. */
export function resolveApiKey(cfg: RepoYetiConfig, provider: AiProviderId): string | null {
  return cfg.ai?.providers?.[provider]?.apiKey ?? null;
}

/** Effective model for a provider — the owner's selection, or null when none is picked. */
export function resolveModel(cfg: RepoYetiConfig, provider: AiProviderId): string | null {
  return cfg.ai?.providers?.[provider]?.model ?? null;
}

/** Which provider "Generate" uses: the owner's choice if usable, else the first usable provider. */
export function effectiveDefaultProvider(cfg: RepoYetiConfig): AiProviderId | null {
  const pref = cfg.ai?.defaultProvider;
  if (pref && resolveApiKey(cfg, pref) && resolveModel(cfg, pref)) return pref;
  for (const id of AI_PROVIDERS) {
    if (resolveApiKey(cfg, id) && resolveModel(cfg, id)) return id;
  }
  return null;
}

/** Map the AI config to a key-free shape for the API. NEVER include `apiKey`. */
export function redactAi(cfg: RepoYetiConfig): RedactedAiConfig {
  const out: RedactedAiConfig = {
    providers: {},
    defaultProvider: null,
    style: cfg.ai?.style ?? "conventional",
    diffDetail: cfg.ai?.diffDetail ?? DEFAULT_DIFF_DETAIL,
    yolo: cfg.ai?.yolo ?? false,
    commitEnabled: cfg.ai?.commitEnabled !== false, // default ON
  };
  for (const id of AI_PROVIDERS) {
    if (resolveApiKey(cfg, id)) {
      out.providers[id] = { configured: true, model: resolveModel(cfg, id) };
    }
  }
  out.defaultProvider = effectiveDefaultProvider(cfg);
  return out;
}

/**
 * The public "Sign in with Connections" OAuth client for RepoYeti, baked in so login works
 * with zero owner setup. These are PUBLIC by nature (a PKCE client — no secret). Now that we own
 * a stable domain, login is done the RIGHT way: the daemon registers its OWN callback at its
 * current origin (`<origin>/oauth/callback`, see src/auth.ts) — the old rotating-URL "shim" Worker
 * is retired. The IdP allow-lists `https://app.repoyeti.com/oauth/callback` + the loopback. This
 * `redirectUri` is now just a presence marker for authEnforced(); auth.ts derives the live value.
 */
const CONNECTIONS_OAUTH: OAuthConfig = {
  issuer: "https://accounts.connections.icu",
  clientId: "a790090c23b353c15ed973fd5fe20563",
  redirectUri: "https://app.repoyeti.com/oauth/callback",
  scopes: "openid profile email photo",
};

const DEFAULTS: RepoYetiConfig = {
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  mode: "local",
  oauth: { ...CONNECTIONS_OAUTH },
};

/** Effective access mode (defaults to local). */
export function accessMode(cfg: RepoYetiConfig): AccessMode {
  return cfg.mode === "remote" ? "remote" : "local";
}

/** True when a sign-in flow is possible at all (an OIDC client is configured). With the
 *  baked-in Connections client this is true for every real install; only bare test configs
 *  (no `oauth`) are unauthenticated/local-open. The middleware layers `mode` on top. */
export function authEnforced(cfg: RepoYetiConfig): boolean {
  return !!(cfg.oauth?.issuer && cfg.oauth.clientId && cfg.oauth.redirectUri);
}

export function ownerConfigured(cfg: RepoYetiConfig): boolean {
  return !!(cfg.oauth?.ownerSub || cfg.oauth?.ownerEmail);
}

export function tunnelStartProblem(cfg: RepoYetiConfig): string | null {
  if (!authEnforced(cfg)) return "auth";
  if (!ownerConfigured(cfg)) return "owner";
  return null;
}

/**
 * Resolve named-tunnel credentials, or null to use the default quick tunnel. A named tunnel needs
 * BOTH a stable `hostname` and a connector `token`. The token may come from the env
 * (`CF_TUNNEL_TOKEN`, which wins — handy for the launcher / key rotation, and never on disk) or
 * the keychain-hydrated config. `provider: "quick"` forces the quick tunnel even when both are set.
 */
export function namedTunnel(cfg: RepoYetiConfig): { hostname: string; token: string } | null {
  if (cfg.tunnel?.provider === "quick") return null;
  const hostname = cfg.tunnel?.hostname?.trim();
  const token = (process.env.CF_TUNNEL_TOKEN ?? cfg.tunnel?.token ?? "").trim();
  return hostname && token ? { hostname, token } : null;
}

/** Key-free projection of the tunnel config, safe to send to any client (the Settings UI reads it
 *  from GET /api/status). NEVER carries the token bytes — only whether one is present. */
export interface RedactedTunnelConfig {
  /** The stable hostname a named tunnel serves (e.g. "app.repoyeti.com"), or null. Non-secret. */
  hostname: string | null;
  /** A connector token is available — from config OR the CF_TUNNEL_TOKEN env. Never the bytes. */
  hasToken: boolean;
  /** The token is supplied by the CF_TUNNEL_TOKEN env (read-only — the Settings UI can't edit it). */
  tokenFromEnv: boolean;
  /** A stable named tunnel is fully configured and not force-quick — exactly what namedTunnel() resolves. */
  named: boolean;
}

/** Redact the tunnel config for the API: hostname + token-presence flags, never the token itself. */
export function redactTunnel(cfg: RepoYetiConfig): RedactedTunnelConfig {
  const envToken = (process.env.CF_TUNNEL_TOKEN ?? "").trim();
  return {
    hostname: cfg.tunnel?.hostname?.trim() || null,
    hasToken: !!(envToken || cfg.tunnel?.token?.trim()),
    tokenFromEnv: !!envToken,
    named: namedTunnel(cfg) !== null,
  };
}

/**
 * One-time migration of pre-rename state (back when RepoYeti was "GitMob"): move
 * ~/.gitmob → ~/.repoyeti and rename the gitmob.db files inside. Only runs for the
 * DEFAULT home — an explicit REPOYETI_HOME (tests / relocation) opts out. Best-effort:
 * any failure just leaves a fresh ~/.repoyeti to be created normally.
 */
let legacyMigrated = false;
function migrateLegacyState(): void {
  if (legacyMigrated || process.env.REPOYETI_HOME) return;
  legacyMigrated = true;
  try {
    const legacyDir = join(homedir(), ".gitmob");
    if (!existsSync(CONFIG_DIR) && existsSync(legacyDir)) {
      renameSync(legacyDir, CONFIG_DIR);
    }
    const legacyDb = join(CONFIG_DIR, "gitmob.db");
    if (existsSync(legacyDb) && !existsSync(DB_PATH)) {
      renameSync(legacyDb, DB_PATH);
      for (const suf of ["-wal", "-shm"]) {
        if (existsSync(legacyDb + suf) && !existsSync(DB_PATH + suf)) {
          renameSync(legacyDb + suf, DB_PATH + suf);
        }
      }
    }
  } catch {
    /* best-effort: a fresh ~/.repoyeti will be created on demand */
  }
}

/**
 * Hard guard against the historic test-isolation accident: for a long stretch before
 * tests/setup.ts existed, `bun test` ran against the REAL ~/.repoyeti (no REPOYETI_HOME
 * override), so every test-fixture identity/repo row it created landed in the owner's actual
 * database. That's how "Required" x8, "Work" x3, "A" x2 ended up in the live identities table.
 *
 * `bun test` always sets NODE_ENV=test (verified: it's the signal tests/setup.ts's isolation
 * implicitly relies on continuing to work), so any code path under test that resolves to the
 * real default config dir (i.e. REPOYETI_HOME was never set) is the exact precondition for a
 * repeat. Throw immediately instead of silently writing into the owner's real state again.
 *
 * A legitimate test that truly needs the real CONFIG_DIR (there isn't one) would have to set
 * REPOYETI_ALLOW_REAL_HOME_IN_TESTS=1 explicitly, an intentional, greppable opt-out rather than
 * a silent gap.
 */
function assertNotRealHomeUnderTest(): void {
  if (process.env.NODE_ENV !== "test") return;
  if (process.env.REPOYETI_ALLOW_REAL_HOME_IN_TESTS === "1") return;
  if (process.env.REPOYETI_HOME) return; // isolated, exactly what tests/setup.ts sets up
  throw new Error(
    "Refusing to touch the real ~/.repoyeti while running under a test runner (NODE_ENV=test).\n" +
      "Set REPOYETI_HOME to an isolated temp dir before importing src/config.ts or src/db.ts, " +
      "see tests/setup.ts (it does this once, in bunfig.toml's [test] preload, for the whole suite).\n" +
      "This guard exists because test-fixture writes used to pollute the owner's real database " +
      "before that isolation existed; do not weaken or bypass it.",
  );
}

export function ensureConfigDir(): void {
  assertNotRealHomeUnderTest();
  migrateLegacyState();
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): RepoYetiConfig {
  ensureConfigDir();
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<RepoYetiConfig>;
    return {
      ...DEFAULTS,
      ...raw,
      roots: Array.isArray(raw.roots) ? raw.roots.map((r) => resolve(r)) : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * The on-disk projection of a config: secret bytes removed when the keychain is the store.
 * AI `apiKey`s and any confidential OAuth `clientSecret` live in the OS keychain, so they
 * must never be written to config.json. If the keychain is UNAVAILABLE on this host, we
 * keep the legacy behavior — leave the secrets in config.json (0600) — so a key isn't
 * silently lost; `secrets.ts` has already warned once in that case.
 */
function stripSecretsForDisk(cfg: RepoYetiConfig): RepoYetiConfig {
  if (!keychainAvailable()) return cfg; // degraded host → keep plaintext (no regression)
  const clone = JSON.parse(JSON.stringify(cfg)) as RepoYetiConfig;
  if (clone.ai?.providers) {
    for (const p of Object.values(clone.ai.providers)) {
      if (p) delete p.apiKey;
    }
  }
  if (clone.oauth) delete clone.oauth.clientSecret;
  if (clone.tunnel) delete clone.tunnel.token;
  delete clone.apiToken;
  return clone;
}

export function saveConfig(cfg: RepoYetiConfig): void {
  ensureConfigDir();
  // 0600 belt-and-suspenders; with the keychain available the file holds no secret at all.
  const onDisk = stripSecretsForDisk(cfg);
  const tmp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
    renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    throw e;
  }
}

/**
 * Load secrets from the OS keychain into the in-memory config, and MIGRATE any secrets
 * still sitting in a legacy plaintext config.json into the keychain (then re-save to strip
 * them). Call once at daemon boot, before serving, so every sync call site (resolveApiKey,
 * redactAi, …) sees the hydrated key without becoming async. Idempotent + best-effort: on a
 * keychain-less host it leaves the plaintext config untouched.
 */
export async function hydrateSecrets(cfg: RepoYetiConfig): Promise<void> {
  let migrated = false;

  if (cfg.ai?.providers) {
    for (const [id, p] of Object.entries(cfg.ai.providers)) {
      if (!p) continue;
      if (p.apiKey) {
        // Legacy plaintext key on disk → move it into the keychain (then it gets stripped).
        if (await setSecret(aiKeyName(id), p.apiKey)) migrated = true;
      } else {
        // No key in memory → hydrate from the keychain if one is stored.
        const k = await getSecret(aiKeyName(id));
        if (k) p.apiKey = k;
      }
    }
  }

  if (cfg.oauth) {
    // The baked-in Connections client is PUBLIC (PKCE is its only proof): AEGIS registers it with
    // token_endpoint_auth_method "none" and no secret hash, and its token endpoint refuses any
    // exchange that PRESENTS a client_secret — with invalid_client, BEFORE it consumes the code, so
    // every sign-in dies at /oauth/callback while the code sits unspent. The retired GitMob-era shim
    // registered this SAME client_id as confidential, so its secret can still be in the keychain —
    // and getSecret() re-homes it out of the old "gitmob" service, which is how a dead credential
    // reaches a client that must never send one. AEGIS kept no hash to verify it against: it is
    // unusable by construction, so purge it rather than re-attach it. A user's OWN confidential
    // client (their own issuer/clientId) is untouched and still hydrates below.
    if (cfg.oauth.clientId === CONNECTIONS_OAUTH.clientId) {
      delete cfg.oauth.clientSecret;
      if (await getSecret(OAUTH_CLIENT_SECRET)) {
        await deleteSecret(OAUTH_CLIENT_SECRET);
        migrated = true;
      }
    } else if (cfg.oauth.clientSecret) {
      if (await setSecret(OAUTH_CLIENT_SECRET, cfg.oauth.clientSecret)) migrated = true;
    } else {
      const cs = await getSecret(OAUTH_CLIENT_SECRET);
      if (cs) cfg.oauth.clientSecret = cs;
    }
  }

  if (cfg.tunnel) {
    if (cfg.tunnel.token) {
      if (await setSecret(TUNNEL_TOKEN, cfg.tunnel.token)) migrated = true;
    } else {
      const t = await getSecret(TUNNEL_TOKEN);
      if (t) cfg.tunnel.token = t;
    }
  }

  // Optional API Bearer token (off by default). Mirror the tunnel-token hydration: a legacy
  // plaintext token on disk gets moved into the keychain (then stripped), else hydrate from it.
  if (cfg.apiToken) {
    if (await setSecret(API_TOKEN, cfg.apiToken)) migrated = true;
  } else {
    const t = await getSecret(API_TOKEN);
    if (t) cfg.apiToken = t;
  }

  // Re-persist so the now-migrated plaintext secrets are stripped from config.json.
  if (migrated) saveConfig(cfg);
}

/** Add an absolute root to the config (idempotent). Returns the updated config. */
export function addRoot(path: string): RepoYetiConfig {
  const abs = resolve(path);
  const cfg = loadConfig();
  if (!cfg.roots.includes(abs)) cfg.roots.push(abs);
  saveConfig(cfg);
  return cfg;
}
