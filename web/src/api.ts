// Thin REST client — one place that talks to the daemon. Throws an Error carrying
// the parsed `{ code, message }` on any non-2xx so callers can show a real reason.
import type { ActionResult, Identity, Repo } from "./types";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, data.code ?? "ERROR", data.message ?? data.error ?? res.statusText);
  }
  return data as T;
}

export interface AuthStatus {
  authEnforced: boolean;
  authenticated: boolean;
  owner: string | null;
}

export const api = {
  authStatus: () => req<AuthStatus>("GET", "/api/auth/status"),
  logout: () => req<{ ok: boolean }>("POST", "/api/auth/logout"),

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

  assignIdentity: (repoId: string, identityId: string | null) =>
    req<{ repo: Repo }>("POST", `/api/repos/${repoId}/identity`, { identityId }).then((r) => r.repo),

  // Actions return a structured result even on a "handled" failure (409 etc.):
  // ApiError is thrown, carrying .code/.message — callers translate to a toast.
  fetch: (id: string) => req<ActionResult>("POST", `/api/repos/${id}/fetch`),
  pull: (id: string) => req<ActionResult>("POST", `/api/repos/${id}/pull`),
  push: (id: string) => req<ActionResult>("POST", `/api/repos/${id}/push`),
  commit: (id: string, message: string) =>
    req<ActionResult>("POST", `/api/repos/${id}/commit`, { message }),
  refresh: (id: string) => req<{ repo: Repo }>("POST", `/api/repos/${id}/refresh`).then((r) => r.repo),
};
