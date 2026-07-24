/**
 * Process-wide runtime state discovered AFTER the HTTP app is built, plus the live
 * Cloudflare tunnel lifecycle. Kept here (not in the HTTP layer) so both index.ts (boot)
 * and the /api/mode route can start/stop the tunnel and read its URL without an import
 * cycle. The web UI reads the URL at GET /api/status and gets live updates over SSE
 * (`daemon_status`), so the "remote access" panel shows a link/QR the moment it's ready.
 */
import { startTunnel, startNamedTunnel, type TunnelHandle } from "./tunnel.ts";
import { namedTunnel, relayEffective, type RepoYetiConfig } from "./config.ts";
import { broadcast } from "./bus.ts";
import { announce, createRelayIdentity, relayShareUrl, type RelayIdentity } from "./relay.ts";
import { saveConfig } from "./config.ts";
import { RELAY_PRIVATE_KEY, setSecret } from "./secrets.ts";

/**
 * Publish our current public address to the relay, if the owner turned it on.
 *
 * Mints this daemon's signing identity on first use and persists it, so the relay can pin the key
 * and refuse anyone else who later tries to move this id's address. Everything here is best-effort:
 * the relay exists to keep already-sent links working, and it going down must not surface as a
 * failure in a tool that manages local repositories perfectly well without it.
 */
export async function publishToRelay(cfg: RepoYetiConfig, origin: string): Promise<void> {
  const relay = relayEffective(cfg);
  if (!relay.enabled) return;
  const identity = await ensureRelayIdentity(cfg);
  const res = await announce(relay.url, identity, origin);
  relayAnnounced = res.ok;
  relayError = res.ok ? null : (res.error ?? "announce failed");
  if (!res.ok) console.warn(`repoyeti: relay announce failed — ${res.error}`);
  // Tell the UI whether the permanent link is actually live, so "relay on" and "relay working"
  // are visibly different states rather than one hopeful toggle.
  broadcast("daemon_status", { relayUrl: getRelayBase(cfg), relayAnnounced, relayError });
}

/**
 * This daemon's relay keypair, minted and persisted on first need.
 *
 * Split out of publishToRelay so turning the toggle ON can mint it immediately: the id is half of
 * the permanent URL, and a Settings panel that says "your link is ready" has to be able to show it
 * before the next tunnel restart, not after.
 */
export async function ensureRelayIdentity(cfg: RepoYetiConfig): Promise<RelayIdentity> {
  const existing = cfg.relay?.identity;
  if (existing?.privateKey) return existing as RelayIdentity;
  const identity = createRelayIdentity();
  cfg.relay = { ...cfg.relay, identity };
  // If the keychain is unavailable this returns false and saveConfig deliberately retains the
  // in-memory private key as the secure-degradation fallback. On normal hosts saveConfig strips it.
  await setSecret(RELAY_PRIVATE_KEY, identity.privateKey);
  try {
    saveConfig(cfg);
  } catch {
    /* an unwritable config shouldn't stop us announcing this session */
  }
  return identity;
}

/** Whether the last announce was accepted, and why not when it wasn't. Reset per attempt. */
let relayAnnounced = false;
let relayError: string | null = null;

/** Live relay state for the owner's UI — is the permanent URL actually registered? */
export function getRelayStatus(): { announced: boolean; error: string | null } {
  return { announced: relayAnnounced, error: relayError };
}

/**
 * This daemon's permanent forwarding base (`<relay>/r/<id>`), or null when the relay is off or
 * not yet configured. Not a share URL on its own — see shareLinkFor for why the token cannot
 * simply be appended to it.
 */
export function getRelayBase(cfg: RepoYetiConfig): string | null {
  const relay = relayEffective(cfg);
  if (!relay.enabled) return null;
  const base = relay.url.replace(/\/+$/, "");
  const id = cfg.relay?.identity?.id;
  return base && id ? `${base}/r/${id}` : null;
}

/**
 * The origin share links are currently handed out on: the relay when it's on, else the tunnel.
 *
 * ONE definition, used both when a link is minted (recorded as the share's origin) and when the
 * Sharing panel asks whether a link has gone stale. Keeping those two in step is the whole point —
 * with the relay on, a link's address genuinely stops changing, so comparing it against the
 * rotating tunnel hostname would flag every healthy link as broken. Links minted BEFORE the relay
 * was turned on still compare unequal, and those really are dead, so the warning stays honest.
 */
export function publicShareOrigin(cfg: RepoYetiConfig): string | null {
  return getRelayBase(cfg) ?? tunnelUrl;
}

/**
 * The full URL to hand someone for a share token.
 *
 * Built here rather than in the browser because the two forms differ in a way that matters: a
 * direct link is `<origin>/s/<token>`, but a relay link puts the token in the URL FRAGMENT
 * (`<relay>/r/<id>#/s/<token>`) so the relay can forward the visitor without ever receiving — or
 * being able to redeem — the secret it is forwarding. Appending the token to the relay base as a
 * path would quietly undo that, so there is exactly one place that knows the difference.
 *
 * `fallbackOrigin` is where the owner is reading this (the request's own origin) — used when no
 * tunnel is up, so a local-only owner still gets a link that works on their machine.
 */
export function shareLinkFor(cfg: RepoYetiConfig, token: string, fallbackOrigin: string): string {
  const url = cfg.relay?.url?.trim();
  const id = cfg.relay?.identity?.id;
  // relayShareUrl owns the fragment form; don't rebuild it here, or the two can drift apart and
  // the drift would leak the token to the relay rather than fail loudly.
  if (getRelayBase(cfg) && url && id) return relayShareUrl(url, id, token);
  return `${(tunnelUrl ?? fallbackOrigin).replace(/\/+$/, "")}/s/${token}`;
}

let tunnelUrl: string | null = null;
let tunnelHandle: TunnelHandle | null = null;
let tunnelStarting = false;
let serverPort = 0;

/** The port the daemon actually bound (set by index.ts once listening). */
export function setServerPort(port: number): void {
  serverPort = port;
}

export function getTunnelUrl(): string | null {
  return tunnelUrl;
}

/** True once a tunnel is up or in the middle of coming up. */
export function tunnelActive(): boolean {
  return tunnelHandle !== null || tunnelStarting;
}

/**
 * Start the Cloudflare tunnel (idempotent). The URL arrives asynchronously: it's broadcast over SSE
 * and exposed at /api/status when the tunnel is ready. `cfg` selects the flavour — a NAMED tunnel
 * (stable host) when `tunnel.hostname` + a token are configured, else the default QUICK tunnel.
 * `onReady` lets the CLI print the URL (with a QR) without coupling this module to the terminal.
 */
export function startManagedTunnel(cfg: RepoYetiConfig, onReady?: (url: string) => void): void {
  if (tunnelHandle || tunnelStarting || !serverPort) return;
  tunnelStarting = true;
  const onUrl = (url: string): void => {
    tunnelUrl = url;
    tunnelStarting = false;
    onReady?.(url);
    broadcast("daemon_status", { tunnelUrl: url, tunnelActive: true });
    // Tell the relay where we moved to, if the owner opted in. This is the moment that matters:
    // a quick tunnel hands out a NEW hostname here, which is exactly when every share link already
    // sent would otherwise go dead. Best-effort and non-blocking — the relay is a convenience, and
    // a failure to reach it must never affect local git management.
    void publishToRelay(cfg, url);
  };
  const onErr = (msg: string): void => {
    tunnelStarting = false;
    tunnelHandle = null;
    broadcast("daemon_status", { tunnelUrl: null, tunnelActive: false, error: msg });
  };
  const named = namedTunnel(cfg);
  tunnelHandle = named
    ? startNamedTunnel(named.token, named.hostname, onUrl, onErr)
    : startTunnel(serverPort, onUrl, onErr);
}

/** Tear the tunnel down (idempotent) and tell clients it's gone. */
export function stopManagedTunnel(): void {
  tunnelHandle?.stop();
  tunnelHandle = null;
  tunnelStarting = false;
  tunnelUrl = null;
  // The relay is still pointing at the address we just abandoned, so "registered" is no longer a
  // true statement about a link that works. Clear it rather than leave a stale green tick.
  relayAnnounced = false;
  relayError = null;
  broadcast("daemon_status", { tunnelUrl: null, tunnelActive: false, relayAnnounced: false });
}
