// The Settings relay toggle's store half: setRelay() writes the daemon's answer back into the refs
// the Access panel renders from, so "on" and "registered" stay two distinct, honest states. The
// panel claims a share link survives a restart only when `relayAnnounced` is true, and that value
// comes from the daemon's actual announce — not from the fact that the toggle was flipped.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useStore } from "@/store";
import { api } from "@/api";
import type { RelayResult, RelayStatus } from "@/api";

const DEFAULT_URL = "https://go.repoyeti.com";

function relayStatus(overrides: Partial<RelayStatus> = {}): RelayStatus {
  return { enabled: true, url: DEFAULT_URL, id: "a".repeat(32), defaultUrl: DEFAULT_URL, ...overrides };
}

function relayResult(overrides: Partial<RelayResult> = {}): RelayResult {
  return {
    ok: true,
    relay: relayStatus(),
    relayUrl: `${DEFAULT_URL}/r/${"a".repeat(32)}`,
    announced: true,
    error: null,
    ...overrides,
  };
}

describe("settings store — relay toggle", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("starts off, with no permanent URL", () => {
    const store = useStore();
    expect(store.relayConfig.enabled).toBe(false);
    expect(store.relayUrl).toBeNull();
    expect(store.relayAnnounced).toBe(false);
  });

  it("enabling adopts the daemon's answer: config, permanent URL, and registered state", async () => {
    const store = useStore();
    const spy = vi.spyOn(api, "setRelay").mockResolvedValue(relayResult());

    await store.setRelay({ enabled: true });

    expect(spy).toHaveBeenCalledWith({ enabled: true });
    expect(store.relayConfig.enabled).toBe(true);
    expect(store.relayUrl).toBe(`${DEFAULT_URL}/r/${"a".repeat(32)}`);
    expect(store.relayAnnounced).toBe(true);
  });

  it("stays UNregistered when the daemon could not announce (no tunnel up, or relay down)", async () => {
    const store = useStore();
    vi.spyOn(api, "setRelay").mockResolvedValue(
      relayResult({ announced: false, error: "no relay configured" }),
    );

    await store.setRelay({ enabled: true });

    // On, but the panel must not claim links survive a restart yet — that would be a false promise.
    expect(store.relayConfig.enabled).toBe(true);
    expect(store.relayAnnounced).toBe(false);
  });

  it("disabling clears the permanent URL", async () => {
    const store = useStore();
    vi.spyOn(api, "setRelay").mockResolvedValue(relayResult());
    await store.setRelay({ enabled: true });

    vi.spyOn(api, "setRelay").mockResolvedValue(
      relayResult({ relay: relayStatus({ enabled: false }), relayUrl: null, announced: false }),
    );
    await store.setRelay({ enabled: false });

    expect(store.relayConfig.enabled).toBe(false);
    expect(store.relayUrl).toBeNull();
  });

  it("passes a self-hosted relay URL straight through", async () => {
    const store = useStore();
    const spy = vi.spyOn(api, "setRelay").mockResolvedValue(
      relayResult({ relay: relayStatus({ url: "https://go.example.com" }) }),
    );

    await store.setRelay({ url: "https://go.example.com" });

    expect(spy).toHaveBeenCalledWith({ url: "https://go.example.com" });
    expect(store.relayConfig.url).toBe("https://go.example.com");
  });

  it("propagates a rejected URL to the caller so the panel can toast it", async () => {
    const store = useStore();
    vi.spyOn(api, "setRelay").mockRejectedValue(new Error("must be an https origin"));

    await expect(store.setRelay({ url: "http://nope.example.com" })).rejects.toThrow("https origin");
    // A refused save must not leave the UI showing a relay that was never accepted.
    expect(store.relayConfig.url).toBeNull();
  });
});
