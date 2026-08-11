// PWA self-heal for rotating Quick Tunnel origins (issue #15).
//
// An installed PWA is pinned to the origin it was installed from. A quick tunnel re-hosts the
// daemon on a fresh hostname every restart, so after an update the installed app opens onto a
// dead origin and looks bricked — the old fix was "reinstall the PWA", every time. But the
// daemon's permanent relay address never moves, and the relay already answers "where did this
// daemon go" (/resolve/<id> — the same endpoint peer daemons use, CORS-open for exactly this
// caller). So the shell remembers its relay home while connected, and when the event stream
// stays dead on a rotating origin it asks the relay where home is now and navigates there.
//
// Deliberately inert on localhost (a stopped daemon has not "moved") and on named-tunnel or
// custom origins (those are permanent, and the relay is off for them anyway). The service
// worker keeps serving the cached shell on the dead origin, which is what gives this code a
// place to run at all.

/** Where the last known relay home is remembered, across sessions and offline boots. */
const STORAGE_KEY = "repoyeti:relay-home";

/** Only rotating quick-tunnel origins are ever healed — everything else is a stable address. */
export function isRotatingOrigin(hostname: string = location.hostname): boolean {
  return hostname.toLowerCase().endsWith(".trycloudflare.com");
}

/**
 * Remember the daemon's permanent address whenever the daemon reports one as ANNOUNCED (an
 * unannounced address is a hope, not a home). `relayUrl` is `<base>/r/<id>`; what gets stored is
 * the matching resolve endpoint, because that is the only form the healer ever needs. Nothing is
 * removed on null: while the origin is dead the daemon reports nothing, and forgetting the home
 * at exactly that moment would defeat the feature.
 */
export function rememberRelayHome(relayUrl: string | null | undefined, announced: boolean): void {
  if (!relayUrl || !announced) return;
  const m = /^(https?:\/\/[^/]+)\/r\/([a-z0-9]+)$/i.exec(relayUrl.replace(/\/+$/, ""));
  if (!m) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ resolve: `${m[1]}/resolve/${m[2]}` }));
  } catch {
    /* storage full/blocked — the feature degrades to nothing, never to an error */
  }
}

/** The stored resolve endpoint, or null when no home was ever remembered. */
export function storedResolveUrl(storage: Pick<Storage, "getItem"> = localStorage): string | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const resolve = (JSON.parse(raw) as { resolve?: unknown }).resolve;
    return typeof resolve === "string" && /^https?:\/\//i.test(resolve) ? resolve : null;
  } catch {
    return null;
  }
}

/** How long the event stream must stay down before the relay is asked, and the floor between
 *  asks. Reconnect flaps are normal (a phone backgrounding, a blip); a genuine tunnel rotation
 *  is permanent, so patience costs one short wait and prevents pointless relay traffic. */
export const HEAL_DELAY_MS = 12_000;
export const HEAL_MIN_INTERVAL_MS = 60_000;

let healTimer: ReturnType<typeof setTimeout> | null = null;
let lastHealAttemptAt = 0;

/**
 * Arm the self-heal countdown — called whenever the event stream is NOT open. Inert unless this
 * page is on a rotating origin. When the countdown lands, ask the relay once (rate-limited);
 * a genuine move navigates the whole app to the daemon's new address, same path and hash.
 */
export function armSelfHeal(
  navigate: (url: string) => void = (url) => location.replace(url),
  fetchImpl: typeof fetch = fetch,
): void {
  if (healTimer || !isRotatingOrigin()) return;
  healTimer = setTimeout(() => {
    healTimer = null;
    if (Date.now() - lastHealAttemptAt < HEAL_MIN_INTERVAL_MS) return;
    lastHealAttemptAt = Date.now();
    void resolveMovedOrigin(location.origin, fetchImpl).then((origin) => {
      if (origin) navigate(`${origin}${location.pathname}${location.search}${location.hash}`);
    });
  }, HEAL_DELAY_MS);
}

/** Cancel the countdown — the stream is open again, this origin is alive after all. */
export function disarmSelfHeal(): void {
  if (healTimer) clearTimeout(healTimer);
  healTimer = null;
}

/**
 * Ask the relay where the daemon lives now. Returns the new origin ONLY when it is a genuine
 * move (a different origin than `currentOrigin`); null means "no home stored", "relay
 * unreachable", or "the relay still points here" — all of which mean: keep retrying the event
 * stream, there is nowhere better to go.
 */
export async function resolveMovedOrigin(
  currentOrigin: string,
  fetchImpl: typeof fetch = fetch,
  storage: Pick<Storage, "getItem"> = localStorage,
): Promise<string | null> {
  const resolve = storedResolveUrl(storage);
  if (!resolve) return null;
  try {
    const res = await fetchImpl(resolve, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; origin?: string };
    const origin = typeof body.origin === "string" ? body.origin.replace(/\/+$/, "") : "";
    if (!body.ok || !/^https:\/\//i.test(origin)) return null;
    return origin !== currentOrigin ? origin : null;
  } catch {
    return null;
  }
}
