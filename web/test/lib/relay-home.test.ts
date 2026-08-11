import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRotatingOrigin,
  rememberRelayHome,
  resolveMovedOrigin,
  storedResolveUrl,
} from "@/lib/relay-home";

const KEY = "repoyeti:relay-home";

describe("relay-home (PWA self-heal, issue #15)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("only rotating quick-tunnel origins are heal candidates", () => {
    expect(isRotatingOrigin("random-words.trycloudflare.com")).toBe(true);
    expect(isRotatingOrigin("Random.TRYCLOUDFLARE.com")).toBe(true);
    expect(isRotatingOrigin("localhost")).toBe(false);
    expect(isRotatingOrigin("app.repoyeti.com")).toBe(false);
    expect(isRotatingOrigin("yeti.example.com")).toBe(false);
    // A hostname merely CONTAINING the tunnel domain must not match.
    expect(isRotatingOrigin("trycloudflare.com.evil.example")).toBe(false);
  });

  it("remembers an announced relay home as its resolve endpoint", () => {
    rememberRelayHome("https://app.repoyeti.com/r/abc123def456", true);
    expect(storedResolveUrl()).toBe("https://app.repoyeti.com/resolve/abc123def456");
  });

  it("ignores unannounced addresses and malformed URLs, and keeps the last home on null", () => {
    rememberRelayHome("https://app.repoyeti.com/r/abc123def456", false);
    expect(storedResolveUrl()).toBeNull();

    rememberRelayHome("not a url", true);
    expect(storedResolveUrl()).toBeNull();

    rememberRelayHome("https://app.repoyeti.com/r/abc123def456", true);
    // The daemon reports nothing while the origin is dead — that must not erase the home,
    // because the dead-origin boot is exactly when the stored home is needed.
    rememberRelayHome(null, false);
    rememberRelayHome(undefined, true);
    expect(storedResolveUrl()).toBe("https://app.repoyeti.com/resolve/abc123def456");
  });

  it("survives a corrupt stored value", () => {
    localStorage.setItem(KEY, "{not json");
    expect(storedResolveUrl()).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ resolve: 42 }));
    expect(storedResolveUrl()).toBeNull();
  });

  it("resolves a genuine move to the new origin", async () => {
    rememberRelayHome("https://app.repoyeti.com/r/abc123def456", true);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, origin: "https://new-words.trycloudflare.com" })),
    ) as unknown as typeof fetch;

    await expect(
      resolveMovedOrigin("https://old-words.trycloudflare.com", fetchImpl),
    ).resolves.toBe("https://new-words.trycloudflare.com");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.repoyeti.com/resolve/abc123def456",
      expect.anything(),
    );
  });

  it("stays put when the relay still points at the current origin", async () => {
    rememberRelayHome("https://app.repoyeti.com/r/abc123def456", true);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, origin: "https://old-words.trycloudflare.com/" })),
    ) as unknown as typeof fetch;

    await expect(
      resolveMovedOrigin("https://old-words.trycloudflare.com", fetchImpl),
    ).resolves.toBeNull();
  });

  it("returns null on no stored home, relay errors, and junk answers", async () => {
    await expect(resolveMovedOrigin("https://x.trycloudflare.com")).resolves.toBeNull();

    rememberRelayHome("https://app.repoyeti.com/r/abc123def456", true);
    for (const res of [
      new Response("{}", { status: 404 }),
      new Response(JSON.stringify({ ok: false })),
      new Response(JSON.stringify({ ok: true, origin: "http://insecure.example" })),
      new Response(JSON.stringify({ ok: true, origin: "javascript:alert(1)" })),
      new Response("not json"),
    ]) {
      const fetchImpl = vi.fn(async () => res) as unknown as typeof fetch;
      await expect(
        resolveMovedOrigin("https://x.trycloudflare.com", fetchImpl),
      ).resolves.toBeNull();
    }

    const throwing = vi.fn(async () => {
      throw new TypeError("network dead");
    }) as unknown as typeof fetch;
    await expect(resolveMovedOrigin("https://x.trycloudflare.com", throwing)).resolves.toBeNull();
  });
});
