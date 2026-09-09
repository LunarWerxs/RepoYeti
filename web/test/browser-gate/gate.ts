/**
 * The handoff between the browser gate's global setup and its specs.
 *
 * global-setup.ts boots an isolated daemon and a SECOND loopback origin, then publishes both
 * here as JSON on REPOYETI_GATE. Playwright forks its workers after global setup returns, so a
 * `process.env` written there is inherited by every spec — no import-order coupling, no shared
 * module state across processes. The same object is also written to `<gate root>/gate.json`
 * purely so a failed run leaves something readable behind.
 */

export interface GateHandoff {
  /** Where the isolated daemon actually bound, e.g. `http://127.0.0.1:53411`. */
  daemonOrigin: string;
  /** A different loopback PORT, serving the attack page. Same site, different origin. */
  foreignOrigin: string;
  /** Absolute paths of the scratch repositories created for this run. */
  fixtures: {
    /** Registered before the browser opens, so the dashboard has something to hydrate. */
    seeded: string;
    /** What the daemon's OWN page registers, proving the request shape is acceptable. */
    attackTarget: string;
    /** What the foreign page tries to register. It must never appear. */
    refusedTarget: string;
    /** Registered while the browser is offline. It must appear after the stream reconnects. */
    offlineArrival: string;
  };
  /** Folder names of the fixtures above, which is what the dashboard shows. */
  names: { seeded: string; attackTarget: string; refusedTarget: string; offlineArrival: string };
}

/**
 * The handoff, or a failure that says how to run these specs properly. Deliberately throws
 * rather than defaulting to a port: a gate that quietly points at the OWNER's live daemon would
 * register scratch repositories into their real database.
 */
export function gate(): GateHandoff {
  const raw = process.env.REPOYETI_GATE;
  if (!raw) {
    throw new Error(
      "browser gate: REPOYETI_GATE is not set. These specs must run through " +
        "playwright.gate.config.ts (`bun run test:gate` in web/), whose global setup boots the " +
        "isolated daemon they talk to. They are deliberately NOT runnable against a live daemon.",
    );
  }
  return JSON.parse(raw) as GateHandoff;
}
