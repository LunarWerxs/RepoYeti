// Issue #21: the cold-start half of the Quick Tunnel self-heal.
//
// relay-home.ts recovers a LIVE page whose origin has rotated away. It cannot recover a cold
// start, because the navigation itself fails at the network and no bundle ever executes — its own
// header assumes "the service worker keeps serving the cached shell", which the workbox config
// (rightly) does not do for index.html. public/offline-heal.html is the standalone page the
// service worker falls back to in exactly that case.
//
// It must run with NO bundle, so it cannot import relay-home.ts and instead re-states the storage
// contract inline. These tests are what stop the two copies drifting apart silently, which would
// break the feature in the one situation nobody can reproduce on a desktop.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const HEAL = readFileSync(resolve(ROOT, "public/offline-heal.html"), "utf8");
const RELAY_HOME = readFileSync(resolve(ROOT, "src/lib/relay-home.ts"), "utf8");

describe("offline-heal.html", () => {
  it("reads the same localStorage key relay-home.ts writes", () => {
    const key = /const STORAGE_KEY = "([^"]+)"/.exec(RELAY_HOME)?.[1];
    expect(key).toBe("repoyeti:relay-home");
    expect(HEAL).toContain(`var STORAGE_KEY = "${key}"`);
  });

  it("reads the same `resolve` field out of that entry", () => {
    // rememberRelayHome stores {resolve: "<base>/resolve/<id>"}; the heal page must look for the
    // same field name, not a plausible-looking synonym.
    expect(RELAY_HOME).toMatch(/JSON\.stringify\(\{\s*resolve:/);
    expect(HEAL).toMatch(/JSON\.parse\(raw\)\.resolve/);
  });

  it("applies the same answer guards as resolveMovedOrigin", () => {
    // https-only, and never navigate back to the origin that just failed — without the second
    // guard a dead host would bounce the PWA into a reload loop instead of showing a way out.
    expect(HEAL).toMatch(/\/\^https:\\\/\\\/\/i\.test\(origin\)/);
    expect(HEAL).toContain("origin === location.origin");
    expect(RELAY_HOME).toContain("origin !== currentOrigin");
  });

  it("references NO build assets, so it can never go stale like index.html did", () => {
    // This is the property that makes it safe as a precached fallback at all: index.html was
    // excluded from the precache precisely because a surviving tab reloaded into a shell whose
    // hashed chunk names no longer existed on disk. A page with no external references cannot.
    expect(HEAL).not.toMatch(/<script[^>]+src=/i);
    expect(HEAL).not.toMatch(/<link[^>]+stylesheet/i);
    expect(HEAL).not.toMatch(/assets\//);
  });

  it("bounds the lookup instead of spinning forever on a hung tunnel", () => {
    // A dead Quick Tunnel can hang rather than refuse the connection, and a spinner with no
    // timeout is indistinguishable from the bricked app this exists to replace.
    expect(HEAL).toMatch(/setTimeout\(/);
    expect(HEAL).toContain("giveUp");
  });

  it("is wired as the navigation fallback for FAILED navigations only", () => {
    const cfg = readFileSync(resolve(ROOT, "vite.config.ts"), "utf8");
    // navigateFallback answers every navigation from the precache; that is what left a rebuilt
    // tab reloading into a stale shell. The fallback must hang off a NetworkOnly navigate route.
    expect(cfg).toContain("navigateFallback: null");
    expect(cfg).toContain('precacheFallback: { fallbackURL: "/offline-heal.html" }');
    expect(cfg).toMatch(/request\.mode === "navigate"/);
  });

  it("stays out of the globIgnores that keep index.html unprecached", () => {
    const cfg = readFileSync(resolve(ROOT, "vite.config.ts"), "utf8");
    const ignores = /globIgnores: \[([\s\S]*?)\]/.exec(cfg)?.[1] ?? "";
    // A fallback that is not in the precache is not a fallback at all.
    expect(ignores).toContain("**/index.html");
    expect(ignores).not.toContain("offline-heal");
  });
});
