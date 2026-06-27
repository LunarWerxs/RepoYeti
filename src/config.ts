/**
 * Daemon configuration + paths.
 *
 * All local state lives under ~/.gitmob (never inside any tracked repo). The
 * config file holds only non-secret operational settings (roots, port, limits);
 * secrets live in the OS keychain in later phases, never here.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const VERSION = "0.0.1";

export const CONFIG_DIR = join(homedir(), ".gitmob");
export const DB_PATH = join(CONFIG_DIR, "gitmob.db");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * "Sign in with Connections" (public OIDC) config. Present → auth is ENFORCED on
 * every /api/* route (and required before any tunnel is exposed). Absent → the
 * daemon is local-only (127.0.0.1) with no auth. See MARCHING_ORDERS §7/§13.
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

export interface GitmobConfig {
  /** Absolute root paths to recursively scan for git repos. */
  roots: string[];
  /** Preferred HTTP port (auto-increments if taken). */
  port: number;
  /** Max BFS depth when discovering repos under a root. */
  maxDepth: number;
  /** Hard cap on auto-discovered repos (inotify-budget guard on Linux). */
  maxRepos: number;
  /** OIDC config; when set, auth is enforced. */
  oauth?: OAuthConfig;
}

const DEFAULTS: GitmobConfig = {
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
};

/** Auth is enforced exactly when OIDC is configured. */
export function authEnforced(cfg: GitmobConfig): boolean {
  return !!(cfg.oauth && cfg.oauth.issuer && cfg.oauth.clientId && cfg.oauth.redirectUri);
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): GitmobConfig {
  ensureConfigDir();
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<GitmobConfig>;
    return {
      ...DEFAULTS,
      ...raw,
      roots: Array.isArray(raw.roots) ? raw.roots.map((r) => resolve(r)) : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: GitmobConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** Add an absolute root to the config (idempotent). Returns the updated config. */
export function addRoot(path: string): GitmobConfig {
  const abs = resolve(path);
  const cfg = loadConfig();
  if (!cfg.roots.includes(abs)) cfg.roots.push(abs);
  saveConfig(cfg);
  return cfg;
}
