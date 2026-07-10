import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { accessMode, ownerConfigured, redactTunnel, saveConfig } from "../../config.ts";
import {
  getTunnelUrl,
  tunnelActive,
  startManagedTunnel,
  stopManagedTunnel,
} from "../../runtime.ts";
import { broadcast } from "../../bus.ts";
import { jsonError } from "../../contract.ts";
import { setSecret, deleteSecret, TUNNEL_TOKEN } from "../../secrets.ts";
import { parseBody, TunnelSettingsSchema } from "../../schemas.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // Flip local ↔ remote. Enabling remote auto-manages the Cloudflare tunnel, but refuses
  // until an owner is claimed (a signed-in owner) so a stranger can't race TOFU over a
  // freshly-opened tunnel. Disabling tears the tunnel down.
  app.put("/api/mode", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mode = b.mode === "remote" ? "remote" : b.mode === "local" ? "local" : null;
    if (!mode) return jsonError(c, "BAD_MODE", "mode must be 'local' or 'remote'");
    if (mode === "remote") {
      if (!ownerConfigured(cfg)) {
        return jsonError(
          c,
          "NEEDS_OWNER",
          "Sign in with Connections once to claim this RepoYeti before enabling remote access.",
        );
      }
      cfg.mode = "remote";
      saveConfig(cfg);
      startManagedTunnel(cfg);
    } else {
      cfg.mode = "local";
      saveConfig(cfg);
      stopManagedTunnel();
    }
    return c.json({ ok: true, mode: cfg.mode, tunnelActive: tunnelActive(), tunnelUrl: getTunnelUrl() });
  });

  // Configure the STABLE named tunnel (hostname + connector token) so the remote URL stops rotating
  // on every restart. The token is a secret → stored in the OS keychain, stripped from config.json,
  // and never echoed back (only redactTunnel's presence flags are). Each field is write-only:
  // undefined = leave unchanged · "" = clear · a value = set. Saving while remote is live rebuilds
  // the tunnel so the new stable host (or the fallback to quick) takes effect immediately.
  app.put("/api/tunnel", async (c) => {
    const p = await parseBody(c, TunnelSettingsSchema);
    if (!p.ok) return p.res;
    cfg.tunnel ??= {};
    const t = cfg.tunnel;
    if (p.data.hostname !== undefined) {
      const h = p.data.hostname.trim();
      if (h) t.hostname = h;
      else delete t.hostname;
    }
    if (p.data.token !== undefined) {
      const tok = p.data.token.trim();
      if (tok) {
        t.token = tok;
        await setSecret(TUNNEL_TOKEN, tok); // keychain holds the bytes; saveConfig strips them from disk
      } else {
        delete t.token;
        await deleteSecret(TUNNEL_TOKEN);
      }
    }
    // A fully-configured stable address means the owner wants it — clear any leftover force-quick override.
    if (t.hostname && t.token) delete t.provider;
    // Collapse an emptied-out block so config.json doesn't keep a bare `"tunnel": {}`.
    if (!t.hostname && !t.token && !t.provider) delete cfg.tunnel;
    saveConfig(cfg);
    // Apply live when remote is on: tear down + restart so the new config (named↔quick / new host) takes effect.
    if (accessMode(cfg) === "remote") {
      stopManagedTunnel();
      startManagedTunnel(cfg);
    }
    broadcast("settings_changed", { tunnel: redactTunnel(cfg) });
    return c.json({
      ok: true,
      tunnel: redactTunnel(cfg),
      tunnelActive: tunnelActive(),
      tunnelUrl: getTunnelUrl(),
    });
  });
}
