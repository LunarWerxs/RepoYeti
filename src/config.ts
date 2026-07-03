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
  keychainAvailable,
  aiKeyName,
  OAUTH_CLIENT_SECRET,
  TUNNEL_TOKEN,
  API_TOKEN,
} from "./secrets.ts";

export const VERSION = "0.1.0";

/** Local state dir. Override with REPOYETI_HOME (used by tests; also handy for relocating state). */
export const CONFIG_DIR = process.env.REPOYETI_HOME ?? join(homedir(), ".repoyeti");
export const DB_PATH = join(CONFIG_DIR, "repoyeti.db");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * "Sign in with Connections" (public OIDC) config. Present → auth is ENFORCED on
 * every /api/* route (and required before any tunnel is exposed). Absent → the
 * daemon is local-only (127.0.0.1) with no auth. See ARCHITECTURE.md §7/§13.
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
  /** True when the provider offers a free tier (shows a "Free tier" badge). */
  free?: boolean;
}

/**
 * Single source of truth for every AI provider RepoYeti supports.
 * Derive AI_PROVIDERS from this so they can never diverge.
 * Order = display order in the Settings UI (free providers first).
 */
export const AI_CATALOG: readonly AiCatalogEntry[] = [
  { id: "groq",       label: "Groq",      url: "console.groq.com/keys",    keyPlaceholder: "gsk_…",     free: true },
  { id: "openrouter", label: "OpenRouter", url: "openrouter.ai/keys",       keyPlaceholder: "sk-or-…",   free: true },
  { id: "gemini",     label: "Gemini",     url: "aistudio.google.com",      keyPlaceholder: "AIza…",     free: true },
  { id: "anthropic",  label: "Claude",     url: "console.anthropic.com",    keyPlaceholder: "sk-ant-…"              },
  { id: "openai",     label: "ChatGPT",    url: "platform.openai.com",      keyPlaceholder: "sk-…"                  },
  { id: "deepseek",   label: "DeepSeek",   url: "platform.deepseek.com",    keyPlaceholder: "sk-…"                  },
];

/** Static catalogue — drives route validation. Derived from AI_CATALOG so they stay in sync. */
export const AI_PROVIDERS: readonly AiProviderId[] = AI_CATALOG.map((e) => e.id);

export type CommitStyle = "conventional" | "concise" | "detailed";

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
  /** Commit-message style for the prompt (default "conventional"). Owners can override
   *  here in config.json; the UI no longer exposes a picker (conventional is the norm). */
  style?: CommitStyle;
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
  /** Explicit opt-out switch. Pulse only sends when a Connections endpoint is configured. */
  enabled?: boolean;
  /** Connections-compatible event collector URL. Env CONNECTIONS_PULSE_URL wins when set. */
  endpoint?: string;
  /** Anonymous per-install id. Generated only after pulse is configured and first used. */
  installId?: string;
}

export interface RepoYetiConfig {
  /** Absolute root paths to recursively scan for git repos. */
  roots: string[];
  /** Registered Lore servers the owner can clone repos from (see LoreServer). */
  servers?: LoreServer[];
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
  /** OIDC config. Always present (the public Connections client is baked into DEFAULTS),
   *  so "Sign in with Connections" works with zero setup; the owner just clicks the button. */
  oauth?: OAuthConfig;
  /** Remote-access tunnel config (quick trycloudflare by default; named for a stable host). */
  tunnel?: TunnelConfig;
  /** Transparent product pulse, forwarded to a Connections-compatible endpoint when configured. */
  pulse?: PulseConfig;
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
}

/** The redacted AI view safe to send to any client — keys are dropped entirely. */
export interface RedactedAiConfig {
  providers: Partial<
    Record<AiProviderId, { configured: true; model: string | null; builtin?: boolean }>
  >;
  defaultProvider: AiProviderId | null;
  style: CommitStyle;
  /** Smart-commit YOLO mode (commit the AI plan without review). Default false. */
  yolo: boolean;
}

/**
 * Free built-in AI so "✨ Generate" works out of the box with ZERO setup: an
 * intentionally-PUBLIC, throwaway Groq key + a default model. The owner's own
 * key/provider ALWAYS wins over this (see resolveApiKey / isBuiltinProvider).
 * Abuse only burns this key's rate limit — rotate by swapping the constant below.
 *
 * The key is read at call time from REPOYETI_BUILTIN_GROQ_KEY (handy for dev / tests /
 * rotation) and otherwise falls back to the hardcoded constant. It counts as ACTIVE
 * only when it looks like a real Groq key (`gsk_…`), so the placeholder leaves the
 * feature DORMANT until a real key is dropped in, and `REPOYETI_BUILTIN_GROQ_KEY=""`
 * force-disables it (used by the tests to assert the unconfigured baseline).
 */
const BUILTIN_GROQ_KEY = "gsk_REPLACE_WITH_YOUR_THROWAWAY_GROQ_KEY";
export const BUILTIN_AI = {
  provider: "groq" as AiProviderId,
  model: process.env.REPOYETI_BUILTIN_GROQ_MODEL ?? "llama-3.1-8b-instant",
};

/** The active built-in key, or null when unset / placeholder / force-disabled. Read at call time. */
export function builtinApiKey(): string | null {
  const k = (process.env.REPOYETI_BUILTIN_GROQ_KEY ?? BUILTIN_GROQ_KEY).trim();
  return k.startsWith("gsk_") && !k.includes("REPLACE") ? k : null;
}

/** True when `provider` is served by the built-in key (the owner has set no key of their own). */
export function isBuiltinProvider(cfg: RepoYetiConfig, provider: AiProviderId): boolean {
  return (
    provider === BUILTIN_AI.provider &&
    !cfg.ai?.providers?.[provider]?.apiKey &&
    builtinApiKey() !== null
  );
}

/** Effective API key for a provider: the owner's key wins, else the built-in key (Groq only). */
export function resolveApiKey(cfg: RepoYetiConfig, provider: AiProviderId): string | null {
  const own = cfg.ai?.providers?.[provider]?.apiKey;
  if (own) return own;
  if (provider === BUILTIN_AI.provider) return builtinApiKey();
  return null;
}

/** Effective model for a provider: the owner's selection wins, else the built-in default model. */
export function resolveModel(cfg: RepoYetiConfig, provider: AiProviderId): string | null {
  const own = cfg.ai?.providers?.[provider]?.model;
  if (own) return own;
  if (isBuiltinProvider(cfg, provider)) return BUILTIN_AI.model;
  return null;
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
    yolo: cfg.ai?.yolo ?? false,
  };
  for (const id of AI_PROVIDERS) {
    // "configured" = the owner set a key OR the built-in key covers it (Groq).
    if (resolveApiKey(cfg, id)) {
      const builtin = isBuiltinProvider(cfg, id);
      out.providers[id] = {
        configured: true,
        model: resolveModel(cfg, id),
        ...(builtin ? { builtin: true } : {}),
      };
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
  scopes: "openid profile email",
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

export function ensureConfigDir(): void {
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
    if (cfg.oauth.clientSecret) {
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
