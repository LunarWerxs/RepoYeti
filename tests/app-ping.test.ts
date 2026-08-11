/**
 * Tests for src/app-ping.ts — the anonymous install/update-check ping to Connections Studio.
 *
 * Pure-function coverage only (no real network): osTag's platform mapping, pingDisabled's
 * env-gates, buildPingRequest's disabled/first-ping/repeat-ping shapes, and fireBootPing's
 * persisted 24h throttle. The actual fetch lives in src/github-updater.ts's latestRelease() and
 * is covered indirectly there (tests/github-updater.test.ts) — this file never hits the network.
 */
import { test, expect } from "bun:test";
import type { RepoYetiConfig } from "../src/config.ts";
import {
  buildPingRequest,
  ensureInstallId,
  fireBootPing,
  osTag,
  pingDisabled,
  recordPingResult,
  PING_INTERVAL_MS,
} from "../src/app-ping.ts";

const cfg = (overrides: Partial<RepoYetiConfig> = {}): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  ...overrides,
});

// ── osTag ──────────────────────────────────────────────────────────────────────────────────────

test("osTag maps Windows build numbers to a coarse win10/win11 tag", () => {
  expect(osTag("win32", "10.0.19045")).toBe("win10-19045");
  expect(osTag("win32", "10.0.22000")).toBe("win11-22000"); // the Windows 11 cutover build
  expect(osTag("win32", "10.0.26100")).toBe("win11-26100");
  expect(osTag("win32", "not-a-version")).toBe("windows"); // unparsable build -> bare fallback
});

test("osTag is a bare platform name off Windows, never a version or hostname", () => {
  expect(osTag("darwin", "23.1.0")).toBe("macos");
  expect(osTag("linux", "5.15.0")).toBe("linux");
});

// ── pingDisabled ───────────────────────────────────────────────────────────────────────────────

test("pingDisabled is false with a clean env", () => {
  expect(pingDisabled({})).toBe(false);
});

test("pingDisabled respects the opt-out env var", () => {
  expect(pingDisabled({ REPOYETI_NO_PING: "1" })).toBe(true);
  expect(pingDisabled({ REPOYETI_NO_PING: "0" })).toBe(false); // only "1" opts out
});

test("pingDisabled skips test/CI/dev runs", () => {
  expect(pingDisabled({ NODE_ENV: "test" })).toBe(true);
  expect(pingDisabled({ CI: "true" })).toBe(true);
  expect(pingDisabled({ REPOYETI_DEV: "1" })).toBe(true);
});

// ── buildPingRequest ───────────────────────────────────────────────────────────────────────────

test("a disabled ping is a bare URL with no query and no headers", () => {
  const req = buildPingRequest(cfg(), { REPOYETI_NO_PING: "1" });
  expect(req.url).toBe("https://studio.connections.icu/v1/app/repoyeti/latest");
  expect(req.headers).toEqual({});
});

test("an enabled ping with no install id yet carries v/os but no X-Install-Id or &new", () => {
  const req = buildPingRequest(cfg(), {});
  const url = new URL(req.url);
  expect(url.searchParams.get("v")).not.toBeNull();
  expect(url.searchParams.get("os")).not.toBeNull();
  expect(url.searchParams.has("new")).toBe(false);
  expect(req.headers["X-Install-Id"]).toBeUndefined();
});

test("the FIRST ping for an install carries the id and &new=1", () => {
  const c = cfg({ appPing: { installId: "abc-123" } });
  const req = buildPingRequest(c, {});
  expect(req.headers["X-Install-Id"]).toBe("abc-123");
  expect(new URL(req.url).searchParams.get("new")).toBe("1");
});

test("a REPEAT ping (already reported) carries the id but never &new again", () => {
  const c = cfg({ appPing: { installId: "abc-123", reported: true } });
  const req = buildPingRequest(c, {});
  expect(req.headers["X-Install-Id"]).toBe("abc-123");
  expect(new URL(req.url).searchParams.has("new")).toBe(false);
});

// ── ensureInstallId / recordPingResult (persistence only — no config.json I/O needed since these
//    only mutate the object passed in; config.ts's own saveConfig is exercised elsewhere) ───────

test("ensureInstallId mints exactly once and is stable across calls", () => {
  const c = cfg();
  const first = ensureInstallId(c);
  expect(typeof first).toBe("string");
  expect(first.length).toBeGreaterThan(0);
  const second = ensureInstallId(c);
  expect(second).toBe(first);
});

test("recordPingResult marks `reported` only on success, and never un-marks it", () => {
  const c = cfg({ appPing: { installId: "id-1" } });
  recordPingResult(c, false);
  expect(c.appPing?.reported).toBeFalsy();
  expect(typeof c.appPing?.lastPingAt).toBe("number");

  recordPingResult(c, true);
  expect(c.appPing?.reported).toBe(true);

  recordPingResult(c, false); // a later failure must not clear the flag
  expect(c.appPing?.reported).toBe(true);
});

// ── fireBootPing throttle ──────────────────────────────────────────────────────────────────────
// fireBootPing reads process.env directly (it can't be disabled via an injected env like the
// pure helpers above), so these run under REPOYETI_NO_PING to prove the gate short-circuits
// before the throttle/check logic — the one thing this suite CAN assert without a real network
// call or monkeypatching config.ts's module-level CONFIG_DIR.

test("fireBootPing never calls check() when pinging is disabled", () => {
  const previous = process.env.REPOYETI_NO_PING;
  process.env.REPOYETI_NO_PING = "1";
  try {
    let called = false;
    fireBootPing(() => {
      called = true;
      return Promise.resolve();
    });
    expect(called).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.REPOYETI_NO_PING;
    else process.env.REPOYETI_NO_PING = previous;
  }
});

test("PING_INTERVAL_MS is exactly 24h", () => {
  expect(PING_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
});
