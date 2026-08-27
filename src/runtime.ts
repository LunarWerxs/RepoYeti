/**
 * Process-wide runtime state discovered AFTER the HTTP app is built, plus the live
 * Cloudflare tunnel lifecycle. Kept here (not in the HTTP layer) so both index.ts (boot)
 * and the /api/mode route can start/stop the tunnel and read its URL without an import
 * cycle. The web UI reads the URL at GET /api/status and gets live updates over SSE
 * (`daemon_status`), so the "remote access" panel shows a link/QR the moment it's ready.
 */
import { startTunnel, startNamedTunnel, type TunnelHandle } from "./tunnel.ts";
import {
  namedTunnel,
  redactRelay,
  relayEffective,
  saveConfig,
  type RepoYetiConfig,
} from "./config.ts";
import { broadcast } from "./bus.ts";
import {
  announce,
  createRelayIdentity,
  OAUTH_CALLBACK_CAPABILITY,
  publicKeyFor,
  relayShareUrl,
  type AnnounceResult,
  type RelayIdentity,
} from "./relay.ts";

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
  broadcast("daemon_status", {
    relay: redactRelay(cfg),
    relayUrl: getRelayBase(cfg),
    relayAnnounced,
    relayError,
  });
}

interface OAuthCallbackRoute {
  origin: string;
  redirectUri: string;
  relayId: string;
  status: "ready" | "retrying" | "failed" | "incompatible";
  error?: string;
}

let oauthCallbackRoute: OAuthCallbackRoute | null = null;
let remoteRouteGeneration = 0;
const OAUTH_CALLBACK_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
let pendingRemoteRouteRetry: { timer: ReturnType<typeof setTimeout>; cancel: () => void } | null = null;

export interface PublishRemoteRoutesOptions {
  retryDelaysMs?: readonly number[];
}

function cancelRemoteRouteRetry(): void {
  pendingRemoteRouteRetry?.cancel();
}

function waitForRemoteRouteRetry(delayMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (retry: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingRemoteRouteRetry = null;
      resolve(retry);
    };
    const timer = setTimeout(() => finish(true), delayMs);
    pendingRemoteRouteRetry = { timer, cancel: () => finish(false) };
  });
}

function isQuickTunnelOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.hostname.toLowerCase().endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}

/**
 * Announce the OAuth callback route to the relay, retrying per `retryDelays`, and keep the
 * module-level `oauthCallbackRoute` updated after every attempt so a status read mid-retry still
 * sees the current state. Returns the final announce result, or null when a newer
 * `publishRemoteRoutes` call superseded this one mid-retry — the caller must then do nothing
 * further, since `oauthCallbackRoute` already belongs to that newer generation.
 */
async function announceOAuthCallbackWithRetry(
  callbackBase: string,
  identity: RelayIdentity,
  origin: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
  retryDelays: readonly number[],
  generation: number,
): Promise<AnnounceResult | null> {
  for (let attempt = 0; ; attempt++) {
    const callbackResult = await announce(callbackBase, identity, origin, fetchImpl);
    const callbackCompatible = callbackResult.capabilities?.includes(OAUTH_CALLBACK_CAPABILITY) ?? false;
    if (generation !== remoteRouteGeneration) return null;
    oauthCallbackRoute = {
      origin,
      redirectUri,
      relayId: identity.id,
      status: callbackResult.ok
        ? callbackCompatible
          ? "ready"
          : "incompatible"
        : attempt < retryDelays.length
          ? "retrying"
          : "failed",
      ...(callbackResult.ok
        ? callbackCompatible
          ? {}
          : { error: `relay does not support ${OAUTH_CALLBACK_CAPABILITY}` }
        : { error: callbackResult.error ?? "announce failed" }),
    };
    if (callbackResult.ok || attempt >= retryDelays.length) return callbackResult;
    if (!(await waitForRemoteRouteRetry(retryDelays[attempt]!))) return null;
    if (generation !== remoteRouteGeneration) return null;
  }
}

/** Publish every remote route needed by one freshly-created tunnel without per-login writes. */
export async function publishRemoteRoutes(
  cfg: RepoYetiConfig,
  origin: string,
  fetchImpl: typeof fetch = fetch,
  options: PublishRemoteRoutesOptions = {},
): Promise<void> {
  cancelRemoteRouteRetry();
  const generation = ++remoteRouteGeneration;
  if (!isQuickTunnelOrigin(origin)) {
    oauthCallbackRoute = null;
    await publishToRelay(cfg, origin);
    return;
  }

  const redirectUri = cfg.oauth?.redirectUri;
  if (!redirectUri) {
    oauthCallbackRoute = null;
    await publishToRelay(cfg, origin);
    return;
  }

  const callbackBase = new URL(redirectUri).origin;
  const relay = relayEffective(cfg);
  const identity = await ensureRelayIdentity(cfg);
  if (generation !== remoteRouteGeneration) return;
  const sameRelay = relay.enabled && relay.url.replace(/\/+$/, "") === callbackBase;
  // With the relay toggled OFF, this announce is the one call that still leaves the machine, and it
  // used to be zero. It has to happen — sign-in cannot return to a rotating hostname without it —
  // but it must not be silent, or "relay off" quietly stops being a true statement about network
  // behavior. Same (id, origin, ts, signature) payload as a relay announce; nothing else is sent.
  // An owner who wants no announcement at all uses a named tunnel, which completes OAuth directly.
  if (!relay.enabled) {
    console.log(
      `repoyeti: announcing this tunnel's address to ${callbackBase} so Quick Tunnel sign-in can return (share-link relay stays off; a named tunnel avoids this entirely)`,
    );
  }
  const retryDelays = options.retryDelaysMs ?? OAUTH_CALLBACK_RETRY_DELAYS_MS;
  // A stopped or replaced tunnel must not become login-ready just because its older announce
  // finished last. Only the newest publication attempt may update process-wide route state —
  // announceOAuthCallbackWithRetry re-checks `generation` itself on every attempt and returns
  // null the moment a newer call has taken over.
  const callbackResult = await announceOAuthCallbackWithRetry(
    callbackBase,
    identity,
    origin,
    redirectUri,
    fetchImpl,
    retryDelays,
    generation,
  );
  if (!callbackResult) return;

  if (sameRelay) {
    relayAnnounced = callbackResult.ok;
    relayError = callbackResult.ok ? null : (callbackResult.error ?? "announce failed");
    broadcast("daemon_status", {
      relay: redactRelay(cfg),
      relayUrl: getRelayBase(cfg),
      relayAnnounced,
      relayError,
    });
  } else if (relay.enabled) {
    await publishToRelay(cfg, origin);
  }
}

/** Exact callback route available for this request origin, or null while its announce is unavailable. */
export function getOAuthCallback(
  cfg: RepoYetiConfig,
  origin: string,
): { redirectUri: string; relayId?: string } | null {
  if (!isQuickTunnelOrigin(origin)) return { redirectUri: `${origin}/oauth/callback` };
  if (
    oauthCallbackRoute?.origin !== origin ||
    oauthCallbackRoute.redirectUri !== cfg.oauth?.redirectUri ||
    oauthCallbackRoute.status !== "ready"
  ) {
    return null;
  }
  return {
    redirectUri: oauthCallbackRoute.redirectUri,
    relayId: oauthCallbackRoute.relayId,
  };
}

export type OAuthCallbackStatus = "ready" | "pending" | "retrying" | "failed" | "incompatible";

/** Browser-facing readiness without exposing raw relay errors to an unauthenticated request. */
export function getOAuthCallbackStatus(cfg: RepoYetiConfig, origin: string): OAuthCallbackStatus {
  if (!isQuickTunnelOrigin(origin)) return "ready";
  if (
    oauthCallbackRoute?.origin !== origin ||
    oauthCallbackRoute.redirectUri !== cfg.oauth?.redirectUri
  ) {
    return "pending";
  }
  return oauthCallbackRoute.status;
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
  if (existing?.privateKey && /^[a-f0-9]{32}$/.test(existing.id)) {
    try {
      if (publicKeyFor(existing.privateKey) === existing.publicKey) {
        return existing as RelayIdentity;
      }
    } catch {
      /* malformed private key — rotate the complete identity below */
    }
  }
  if (existing) {
    console.warn(
      "repoyeti: relay identity is incomplete or mismatched; rotating the stable address",
    );
  }
  const identity = createRelayIdentity();
  cfg.relay = { ...cfg.relay, identity };
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

/** Clear a relay result that is no longer applicable (opt-out or tunnel teardown). */
export function resetRelayStatus(): void {
  relayAnnounced = false;
  relayError = null;
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
 * `onFailed` does the same for the failure: without it a launch error is only ever broadcast over
 * SSE, so a CLI run with no dashboard open (the first thing a source user does) sat at "Starting
 * cloudflared tunnel…" forever with the reason discarded.
 */
export function startManagedTunnel(
  cfg: RepoYetiConfig,
  onReady?: (url: string) => void,
  onFailed?: (message: string) => void,
): void {
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
    void publishRemoteRoutes(cfg, url);
  };
  const onErr = (msg: string): void => {
    tunnelStarting = false;
    tunnelHandle = null;
    onFailed?.(msg);
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
  cancelRemoteRouteRetry();
  remoteRouteGeneration++;
  oauthCallbackRoute = null;
  // The relay is still pointing at the address we just abandoned, so "registered" is no longer a
  // true statement about a link that works. Clear it rather than leave a stale green tick.
  resetRelayStatus();
  broadcast("daemon_status", {
    tunnelUrl: null,
    tunnelActive: false,
    relayAnnounced: false,
    relayError: null,
  });
}
