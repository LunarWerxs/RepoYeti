import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { Deps } from "../deps.ts";
import { type RepoYetiConfig, saveConfig } from "../../config.ts";
import { applyUpdate, checkForUpdate } from "../../updater.ts";
import { jsonError } from "../../contract.ts";

// Fire-and-forget product pulse to the owner's collector — a no-op until
// REPOYETI_PULSE_URL (or the shared CONNECTIONS_PULSE_URL) is set. Lives here with
// the update-event pulses that use it, rather than in a file of its own.
async function recordPulse(cfg: RepoYetiConfig, event: string, properties?: unknown) {
  const url =
    process.env.REPOYETI_PULSE_URL?.trim() ||
    process.env.CONNECTIONS_PULSE_URL?.trim() ||
    cfg.pulse?.endpoint?.trim();
  if (!url) return { ok: true, enabled: false };
  cfg.pulse ??= {};
  if (!cfg.pulse.installId) {
    cfg.pulse.installId = (cfg as { analytics?: { installId?: string } }).analytics?.installId ?? randomUUID();
    saveConfig(cfg);
  }
  const token = process.env.REPOYETI_PULSE_TOKEN?.trim() || process.env.CONNECTIONS_PULSE_TOKEN?.trim();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        source: "connections",
        app: "repoyeti",
        installId: cfg.pulse.installId,
        event,
        properties,
        ts: new Date().toISOString(),
      }),
    });
    return { ok: res.ok, enabled: true };
  } catch {
    return { ok: false, enabled: true };
  }
}

export function register(app: Hono, { cfg }: Deps): void {
  app.post("/api/pulse", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await recordPulse(cfg, String(body.event ?? ""), body.properties);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.get("/api/updates", async (c) => {
    const status = await checkForUpdate();
    void recordPulse(cfg, "update_check", {
      available: status.updateAvailable,
      canApply: status.canApply,
      reason: status.reason,
    });
    return c.json(status);
  });

  app.post("/api/updates/apply", async (c) => {
    void recordPulse(cfg, "update_apply_clicked");
    try {
      const result = await applyUpdate();
      void recordPulse(cfg, "update_apply_result", {
        ok: result.ok,
        restartRequired: result.restartRequired,
      });
      return c.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void recordPulse(cfg, "update_apply_result", { ok: false, message });
      return jsonError(c, "ERROR", message);
    }
  });
}
