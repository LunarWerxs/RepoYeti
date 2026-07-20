import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import {
  accessMode,
  ownerConfigured,
  redactTunnel,
  redactRelay,
  saveConfig,
  DEFAULT_RELAY_URL,
} from "../../config.ts";
import {
  getTunnelUrl,
  tunnelActive,
  startManagedTunnel,
  stopManagedTunnel,
  ensureRelayIdentity,
  publishToRelay,
  getRelayBase,
  getRelayStatus,
} from "../../runtime.ts";
import { broadcast } from "../../bus.ts";
import { jsonError } from "../../contract.ts";
import { setSecret, deleteSecret, TUNNEL_TOKEN } from "../../secrets.ts";
import { parseBody, TunnelSettingsSchema, RelaySettingsSchema } from "../../schemas.ts";

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

  // Turn the RELAY on or off, and choose which one.
  //
  // The relay gives this daemon one permanent URL that forwards to wherever its quick tunnel
  // currently lives, so share links survive a restart (see relay/README.md). It is off until asked:
  // a self-hosted tool should not phone anywhere by default, and enabling it here is that ask.
  //
  // Enabling mints the signing identity immediately and announces straight away when a tunnel is
  // already up, so the owner leaves this call with a permanent URL they can actually copy — rather
  // than one that only materialises after the next restart.
  app.put("/api/relay", async (c) => {
    const p = await parseBody(c, RelaySettingsSchema);
    if (!p.ok) return p.res;
    cfg.relay ??= {};
    const r = cfg.relay;
    if (p.data.url !== undefined) {
      const u = p.data.url.trim().replace(/\/+$/, "");
      if (u) r.url = u;
      else delete r.url;
    }
    if (p.data.enabled !== undefined) r.enabled = p.data.enabled;
    // Turning it on with no relay named is the common path — the toggle should just work, so fall
    // back to the documented public instance rather than refusing or silently doing nothing.
    if (r.enabled && !r.url) r.url = DEFAULT_RELAY_URL;
    if (r.enabled) {
      // Mint before saving so the id (half of the permanent URL) exists for the response below.
      ensureRelayIdentity(cfg);
    }
    // Collapse an emptied-out block, but KEEP a minted identity: dropping it would re-register a
    // fresh id on the relay next time and silently break every link already handed out.
    if (!r.enabled && !r.url && !r.identity) delete cfg.relay;
    saveConfig(cfg);
    // Apply live: announce now if we already know our public address, so the permanent link is
    // registered by the time the owner pastes it. Best-effort, like every other relay call.
    const origin = getTunnelUrl();
    if (r.enabled && origin) await publishToRelay(cfg, origin);
    broadcast("settings_changed", { relay: redactRelay(cfg) });
    return c.json({
      ok: true,
      relay: redactRelay(cfg),
      relayUrl: getRelayBase(cfg),
      ...getRelayStatus(),
    });
  });
}
