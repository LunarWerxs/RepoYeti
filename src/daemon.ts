/**
 * HTTP surface (Hono) + the SSE endpoint.
 *
 * Phase 1: read API + SSE. Phase 3 adds identity CRUD, repo-identity assignment,
 * and the safe git actions (fetch/pull/push) with first-class error codes. There
 * is still NO auth here — that's Phase 2's single middleware in front of /api/*
 * (MARCHING_ORDERS §7). The daemon binds to 127.0.0.1 only (see index.ts).
 */
import { join, normalize, dirname } from "node:path";
import { existsSync } from "node:fs";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import { VERSION, authEnforced, type GitmobConfig } from "./config.ts";
import { authMiddleware, handleLogin, handleComplete, handleLogout, readSession } from "./auth.ts";
import {
  getRepos,
  getRepo,
  listIdentities,
  getIdentity,
  createIdentity,
  updateIdentity,
  deleteIdentity,
  setRepoIdentity,
} from "./db.ts";
import { addListener, removeListener, broadcast } from "./bus.ts";
import {
  fetchRepo,
  pullRepo,
  pushRepo,
  commitRepo,
  forceRefresh,
  registerRepo,
  createRepo,
  type ActionOutcome,
} from "./service.ts";
import type { ActionCode } from "./git-actions.ts";

/** Map an action result code to an HTTP status. */
function httpStatusFor(code: ActionCode): ContentfulStatusCode {
  switch (code) {
    case "OK":
      return 200;
    case "DIRTY_WORKING_TREE":
    case "NON_FAST_FORWARD":
    case "DETACHED_HEAD":
    case "NO_UPSTREAM":
    case "NO_REMOTE":
    case "NOTHING_TO_COMMIT":
      return 409;
    case "SSH_AUTH_FAILED":
      return 502;
    case "SSH_PASSPHRASE_REQUIRED":
      return 504;
    default:
      return 500;
  }
}

export function createApp(cfg: GitmobConfig): Hono {
  const app = new Hono();

  // Auth gate — applies to /api/* only; no-op when OIDC isn't configured (local mode).
  app.use("/api/*", authMiddleware(cfg));

  // ── auth surface ───────────────────────────────────────────────────────────
  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "gitmob", version: VERSION, ts: Date.now() }),
  );
  // Public: lets the PWA decide whether to show the "Sign in with Connections" screen.
  app.get("/api/auth/status", (c) => {
    const enforced = authEnforced(cfg);
    const session = enforced ? readSession(c, cfg.oauth!) : null;
    return c.json({
      authEnforced: enforced,
      authenticated: enforced ? !!session : true,
      owner: session?.email || session?.sub || null,
    });
  });
  app.get("/api/auth/me", (c) => {
    const s = authEnforced(cfg) ? readSession(c, cfg.oauth!) : null;
    return c.json({ ok: true, sub: s?.sub ?? null, email: s?.email ?? null });
  });
  app.post("/api/auth/logout", (c) => handleLogout(c));

  // OIDC dance (only meaningful when configured).
  const oauthGuard = (h: (c: Context) => Promise<Response>) => (c: Context) =>
    authEnforced(cfg) ? h(c) : c.text("Sign-in is not configured for this daemon.", 404);
  app.get("/oauth/login", oauthGuard((c) => handleLogin(c, cfg)));
  app.get("/oauth/finish", oauthGuard((c) => handleComplete(c, cfg)));
  app.get("/oauth/callback", oauthGuard((c) => handleComplete(c, cfg)));

  // ── repos ────────────────────────────────────────────────────────────────
  app.get("/api/repos", (c) => c.json({ repos: getRepos() }));

  // "Point to Folder" (register existing) + "Create New" (git init).
  const repoFromPath = (handler: (path: string) => Promise<{ ok: boolean; code: string; message: string }>) =>
    async (c: Context) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const path = String(b.path ?? "").trim();
      if (!path) return c.json({ error: "path is required" }, 400);
      const r = await handler(path);
      const status: ContentfulStatusCode = r.ok
        ? 201
        : r.code === "NOT_FOUND" || r.code === "NOT_A_REPO"
          ? 400
          : 409;
      return c.json(r, status);
    };
  app.post("/api/repos/register", repoFromPath(registerRepo));
  app.post("/api/repos/create", repoFromPath(createRepo));

  // ── identities (CRUD) ──────────────────────────────────────────────────────
  app.get("/api/identities", (c) => c.json({ identities: listIdentities() }));

  app.post("/api/identities", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const displayName = String(b.displayName ?? "").trim();
    const gitUsername = String(b.gitUsername ?? "").trim();
    const gitEmail = String(b.gitEmail ?? "").trim();
    if (!displayName || !gitUsername || !gitEmail) {
      return c.json({ error: "displayName, gitUsername and gitEmail are required" }, 400);
    }
    const sshKeyPath = b.sshKeyPath ? String(b.sshKeyPath) : null;
    const id = createIdentity({ displayName, gitUsername, gitEmail, sshKeyPath });
    return c.json({ identity: getIdentity(id) }, 201);
  });

  app.put("/api/identities/:id", async (c) => {
    const id = c.req.param("id");
    if (!getIdentity(id)) return c.json({ error: "identity not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    updateIdentity(id, {
      displayName: b.displayName != null ? String(b.displayName) : undefined,
      gitUsername: b.gitUsername != null ? String(b.gitUsername) : undefined,
      gitEmail: b.gitEmail != null ? String(b.gitEmail) : undefined,
      sshKeyPath: b.sshKeyPath === undefined ? undefined : b.sshKeyPath ? String(b.sshKeyPath) : null,
    });
    return c.json({ identity: getIdentity(id) });
  });

  app.delete("/api/identities/:id", (c) => {
    const id = c.req.param("id");
    return deleteIdentity(id) ? c.json({ ok: true }) : c.json({ error: "identity not found" }, 404);
  });

  // ── assign identity to a repo ──────────────────────────────────────────────
  app.post("/api/repos/:id/identity", async (c) => {
    const repoId = c.req.param("id");
    if (!getRepo(repoId)) return c.json({ error: "repo not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const identityId = b.identityId == null ? null : String(b.identityId);
    if (identityId && !getIdentity(identityId)) return c.json({ error: "identity not found" }, 404);
    setRepoIdentity(repoId, identityId);
    broadcast("repo_identity_changed", { id: repoId, identityId });
    return c.json({ ok: true, repo: getRepo(repoId) });
  });

  // ── safe git actions ───────────────────────────────────────────────────────
  const action = (fn: (id: string) => Promise<ActionOutcome>) => async (c: Context) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing repo id" }, 400);
    const r = await fn(id);
    return c.json(r, r.ok ? 200 : httpStatusFor(r.code));
  };
  app.post("/api/repos/:id/fetch", action(fetchRepo));
  app.post("/api/repos/:id/pull", action(pullRepo));
  app.post("/api/repos/:id/push", action(pushRepo));
  app.post("/api/repos/:id/commit", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing repo id" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const message = String(b.message ?? "").trim();
    if (!message) return c.json({ ok: false, code: "NO_MESSAGE", message: "commit message required" }, 400);
    const r = await commitRepo(id, message);
    return c.json(r, r.ok ? 200 : httpStatusFor(r.code as ActionCode));
  });

  app.post("/api/repos/:id/refresh", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing repo id" }, 400);
    const repo = await forceRefresh(id);
    return repo ? c.json({ repo }) : c.json({ error: "repo not found" }, 404);
  });

  // ── SSE stream ─────────────────────────────────────────────────────────────
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: Array<{ event: string; data: string }> = [];
      let wake: (() => void) | null = null;
      let aborted = false;

      const listener = (event: string, data: string): void => {
        queue.push({ event, data });
        wake?.();
        wake = null;
      };
      addListener(listener);
      stream.onAbort(() => {
        aborted = true;
        removeListener(listener);
        wake?.();
        wake = null;
      });

      await stream.writeSSE({ event: "hello", data: JSON.stringify({ ok: true, version: VERSION }) });

      while (!aborted) {
        if (queue.length === 0) {
          let timeout: ReturnType<typeof setTimeout> | null = null;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timeout = setTimeout(resolve, 25_000);
          });
          if (timeout) clearTimeout(timeout);
          if (aborted) break;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: String(Date.now()) });
            continue;
          }
        }
        while (queue.length > 0 && !aborted) {
          const m = queue.shift()!;
          await stream.writeSSE({ event: m.event, data: m.data });
        }
      }
    }),
  );

  // ── static PWA — LAST, so it only catches non-API routes ────────────────────
  mountWeb(app);

  return app;
}

/** Path to the built PWA (`web/dist`). Works in dev (relative to this source) and
 * when compiled (a `web/dist` shipped next to the binary). */
function resolveWebRoot(): string {
  const candidates = [
    normalize(join(import.meta.dir, "..", "web", "dist")), // dev: src/../web/dist
    normalize(join(dirname(process.execPath), "web", "dist")), // compiled: next to the binary
  ];
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
  return candidates[0]!;
}
const WEB_ROOT = resolveWebRoot();

const EXTRA_MIME: Record<string, string> = {
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

/** Serve the SPA + assets with SPA fallback to index.html and traversal protection. */
function mountWeb(app: Hono): void {
  app.get("/*", async (c) => {
    let pathname = decodeURIComponent(new URL(c.req.url).pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const filePath = normalize(join(WEB_ROOT, pathname));
    if (!filePath.startsWith(WEB_ROOT)) return c.text("forbidden", 403);

    let file = Bun.file(filePath);
    if (!(await file.exists())) {
      file = Bun.file(join(WEB_ROOT, "index.html")); // SPA fallback
      if (!(await file.exists())) {
        return c.text("web app not built — run: bun run --cwd web build:fast", 503);
      }
    }
    const ext = filePath.slice(filePath.lastIndexOf("."));
    const headers = EXTRA_MIME[ext] ? { "content-type": EXTRA_MIME[ext] } : undefined;
    return new Response(file, headers ? { headers } : undefined);
  });
}
