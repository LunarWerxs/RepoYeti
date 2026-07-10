/**
 * Tiny HTTP client the CLI git verbs use to drive the ALREADY-RUNNING local daemon over its
 * HTTP API. It deliberately does NOT touch git or the in-process service/read layers — every
 * verb is just a fetch against `http://127.0.0.1:<port>/api/…` (see check-boundaries.ts, which
 * forbids the CLI from importing those layers).
 *
 * Base URL resolution: REPOYETI_BASE_URL wins (testability + a power-user override), else the
 * running daemon located via findLiveInstance(); if neither, a friendly "start the daemon" error.
 * REPOYETI_TOKEN, when set, is forwarded as a Bearer token (forward-compat for remote use).
 */
import { findLiveInstance } from "../instance.ts";
import type { RepoView } from "../db.ts";

/**
 * Resolve the daemon's base origin (e.g. "http://127.0.0.1:7171"), no trailing slash.
 * Throws a friendly Error when nothing is running so the CLI can print it and exit 1.
 */
export async function resolveBaseUrl(): Promise<string> {
  const override = process.env.REPOYETI_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  const live = await findLiveInstance();
  if (live?.url) return live.url.replace(/\/+$/, "");
  throw new Error("RepoYeti daemon isn't running — start it with: repoyeti start");
}

/** An Error carrying the API's machine-readable code, so the CLI can print "✗ <code>: <message>". */
export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/**
 * Fetch `${base}${path}`, attach a Bearer token when REPOYETI_TOKEN is set, parse JSON, and on a
 * non-ok HTTP status OR an `{ok:false}` body throw an ApiError carrying the envelope's code+message.
 * `path` is a leading-slash API path like "/api/repos".
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await resolveBaseUrl();
  const headers = new Headers(init?.headers);
  const token = process.env.REPOYETI_TOKEN?.trim();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const res = await fetch(`${base}${path}`, { ...init, headers });
  // 204 / empty body → nothing to parse; treat a 2xx as success.
  const text = await res.text();
  let body: unknown ;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (!res.ok) throw new ApiError("ERROR", text.slice(0, 300) || `HTTP ${res.status}`);
      body = undefined;
    }
  }
  const env = body as { ok?: boolean; code?: string; message?: string } | undefined;
  if (!res.ok || env?.ok === false) {
    throw new ApiError(env?.code ?? "ERROR", env?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const get = <T>(path: string): Promise<T> => api<T>(path);
export const post = <T>(path: string, json?: unknown): Promise<T> =>
  api<T>(path, { method: "POST", body: json === undefined ? undefined : JSON.stringify(json) });
export const put = <T>(path: string, json?: unknown): Promise<T> =>
  api<T>(path, { method: "PUT", body: json === undefined ? undefined : JSON.stringify(json) });
export const del = <T>(path: string, json?: unknown): Promise<T> =>
  api<T>(path, { method: "DELETE", body: json === undefined ? undefined : JSON.stringify(json) });

/**
 * Resolve a user-supplied repo identifier to its repo id by querying GET /api/repos. Matching is
 * tried in order: exact id, then exact name, then the basename of the absolute path. Throws when
 * nothing matches, or when a name/basename is ambiguous (so a wrong repo is never silently acted on).
 */
export async function resolveRepo(idOrName: string): Promise<RepoView> {
  const needle = idOrName.trim();
  if (!needle) throw new ApiError("BAD_REQUEST", "a repo (id or name) is required");
  const { repos } = await get<{ repos: RepoView[] }>("/api/repos");

  const byId = repos.find((r) => r.id === needle);
  if (byId) return byId;

  const byName = repos.filter((r) => r.name === needle);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new ApiError("BAD_REQUEST", `ambiguous repo "${needle}" — matches ${byName.length} repos; use the id`);
  }

  const basename = (p: string): string => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  const byBase = repos.filter((r) => basename(r.absPath) === needle);
  if (byBase.length === 1) return byBase[0]!;
  if (byBase.length > 1) {
    throw new ApiError("BAD_REQUEST", `ambiguous repo "${needle}" — matches ${byBase.length} paths; use the id`);
  }

  throw new ApiError("NOT_FOUND", `no repo matches "${needle}"`);
}
