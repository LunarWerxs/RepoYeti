/**
 * F015 regression: an in-flight relay announce must not resurrect `relayAnnounced` after the
 * tunnel that produced it has already been stopped.
 *
 * `publishRemoteRoutes` runs `void ...` off `onUrl` (runtime.ts startManagedTunnel), and its
 * non-Quick-Tunnel / no-`redirectUri` branches hand straight to `publishToRelay`, whose announce is
 * a network round-trip. `stopManagedTunnel` clears the status and bumps `remoteRouteGeneration`
 * while that call is still awaiting; before the fix the resolving announce wrote "registered" back
 * over the reset, leaving the UI with a green tick for a relay pointing at an abandoned address.
 *
 * The announce here is a fetch we resolve by hand so the stop lands squarely mid-flight.
 */
import { test, expect, afterEach } from "bun:test";
import type { RepoYetiConfig } from "../src/config.ts";
import { createRelayIdentity } from "../src/relay.ts";
import { getRelayStatus, publishRemoteRoutes, stopManagedTunnel } from "../src/runtime.ts";

/** Minimal valid config; spread overrides for each case. */
const base = (over: Partial<RepoYetiConfig> = {}): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  ...over,
});

/** A config with the relay on and an identity minted — the post-toggle steady state. */
function enabledCfg(): RepoYetiConfig {
  return base({ relay: { enabled: true, url: "https://go.example.com", identity: createRelayIdentity() } });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Replace global fetch with one that never settles until `release`, and expose when it was first
 * called so the test can stop the tunnel while the announce is genuinely outstanding.
 */
function holdAnnounce(): { started: Promise<void>; release: (res: Response) => void } {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: (res: Response) => void;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    markStarted();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as unknown as typeof fetch;
  // Late-bound: the real resolver only exists once fetch is actually called, after this returns.
  return { started, release: (res) => release(res) };
}

const accepted = (): Response =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// Both direct-publish branches named by the finding: a non-Quick-Tunnel origin, and a Quick Tunnel
// with no configured OAuth redirect URI. Both call publishToRelay without an intervening await.
for (const origin of ["https://stable.example.com", "https://quick-yeti.trycloudflare.com"]) {
  test(`stopping the tunnel mid-announce keeps 'not announced' for ${origin}`, async () => {
    const cfg = enabledCfg();
    const { started, release } = holdAnnounce();

    const publish = publishRemoteRoutes(cfg, origin);
    await started;
    // The tunnel goes down while the announce is still on the wire.
    stopManagedTunnel();
    release(accepted());
    await publish;

    // The stale announce must not have flipped the status back on.
    expect(getRelayStatus()).toEqual({ announced: false, error: null });
  });
}

test("an announce that is NOT superseded still registers the relay", async () => {
  const cfg = enabledCfg();
  const { started, release } = holdAnnounce();

  const publish = publishRemoteRoutes(cfg, "https://stable.example.com");
  await started;
  release(accepted());
  await publish;

  expect(getRelayStatus()).toEqual({ announced: true, error: null });
});
