/**
 * "Sync my settings with Connections" HTTP surface.
 *
 * Thin adapter over src/connections-sync.ts (the daemon-side BFF). The browser only ever talks to
 * these local daemon routes; the daemon holds the Connections refresh token and calls the store.
 * All routes live under /api/* so the standard auth gate fronts them (open on loopback in local
 * mode; owner-session-required over the tunnel).
 */
import type { Hono, Context } from "hono";
import type { Deps } from "../deps.ts";
import { authEnforced } from "../../config.ts";
import {
  syncStatus,
  enable,
  disable,
  updateAppearance,
  pullNow,
  pushNow,
  type SyncStatus,
} from "../../connections-sync.ts";

/** Run a sync op and translate failures into a JSON error the UI can show inline (never a 500). */
async function guard(c: Context, run: () => Promise<SyncStatus | { ok: true }>): Promise<Response> {
  try {
    return c.json({ ok: true, ...(await run()) });
  } catch (e) {
    const err = e as { code?: string; status?: number; message?: string };
    const code = err.code ?? (err.message === "not_signed_in" ? "not_signed_in" : "sync_failed");
    // 401/403/404 from the store, our own "not signed in", or a transient network error — the UI
    // keeps using local settings and surfaces the reason; nothing here is fatal to the daemon.
    return c.json({ ok: false, error: code, retryAfterSeconds: (err as { retryAfterSeconds?: number }).retryAfterSeconds }, 200);
  }
}

export function register(app: Hono, { cfg }: Deps): void {
  // Current sync state (enabled? connected? last synced? the appearance to apply).
  app.get("/api/settings/sync", (c) => {
    if (!authEnforced(cfg)) return c.json({ ok: true, enabled: false, connected: false, lastSyncedAt: null, version: 0, appearance: null });
    return c.json({ ok: true, ...syncStatus(cfg) });
  });

  // Enable / disable / update-appearance in one PUT. Body: { enabled?, forget?, appearance? }.
  app.put("/api/settings/sync", async (c) => {
    if (!authEnforced(cfg)) return c.text("Sign-in is not configured for this daemon.", 404);
    const b = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      forget?: boolean;
      appearance?: Record<string, unknown>;
    };
    return guard(c, async () => {
      if (b.enabled === true) return enable(cfg, cfg.oauth!, b.appearance);
      if (b.enabled === false) return disable(cfg, cfg.oauth!, { forget: b.forget === true });
      if (b.appearance && typeof b.appearance === "object") {
        await updateAppearance(cfg, cfg.oauth!, b.appearance);
      }
      return syncStatus(cfg);
    });
  });

  // Manual "pull from another device now".
  app.post("/api/settings/sync/pull", (c) => {
    if (!authEnforced(cfg)) return c.text("Sign-in is not configured for this daemon.", 404);
    return guard(c, async () => {
      await pullNow(cfg, cfg.oauth!);
      return syncStatus(cfg);
    });
  });

  // Manual "push my current settings now".
  app.post("/api/settings/sync/push", (c) => {
    if (!authEnforced(cfg)) return c.text("Sign-in is not configured for this daemon.", 404);
    return guard(c, async () => {
      await pushNow(cfg, cfg.oauth!);
      return syncStatus(cfg);
    });
  });
}
