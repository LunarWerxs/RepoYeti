/**
 * PUT /api/settings used to apply each accepted field as an independent block that saved
 * config.json and broadcast `settings_changed` on its own — so a multi-field PUT serialised
 * config.json once PER FIELD and fanned out an overlapping burst of SSE events. health.ts now
 * applies every field exactly as before (same order, same runtime setters, same clamping) but
 * batches persistence: one saveConfig(cfg), one settings_changed broadcast, and at most one
 * refreshAllRepos() call for the whole request. These tests assert the batching without
 * re-testing the per-field application semantics already covered elsewhere.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import * as configModule from "../src/config.ts";
import * as service from "../src/service/index.ts";
import { addListener, removeListener } from "../src/bus.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

// putSettings's response body calls resolveLoreServersEnabled(cfg), which — when
// cfg.loreServersEnabled is absent — derives a default AND persists it via its own saveConfig()
// call (see health.ts), independent of anything this test file is about. Pre-setting the field
// avoids that unrelated side effect so the saveConfig/broadcast counts below measure only the
// batching this suite targets.
const noLoreDefaultCfg = (): RepoYetiConfig => ({ ...localCfg(), loreServersEnabled: true });

// Mirrors tests/timer-rounds.test.ts's capture() helper.
function capture(): { events: Array<{ event: string; payload: unknown }>; stop: () => void } {
  const events: Array<{ event: string; payload: unknown }> = [];
  const listener = (event: string, _data: string, payload: unknown): void =>
    void events.push({ event, payload });
  addListener(listener);
  return { events, stop: () => removeListener(listener) };
}

let saveSpy: ReturnType<typeof spyOn> | undefined;
let refreshSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  saveSpy?.mockRestore();
  saveSpy = undefined;
  refreshSpy?.mockRestore();
  refreshSpy = undefined;
});

test("a five-field PUT does exactly one saveConfig call and one settings_changed broadcast with every persisted value", async () => {
  const app = createApp(noLoreDefaultCfg());
  saveSpy = spyOn(configModule, "saveConfig");
  const cap = capture();
  try {
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        remoteEditing: false,
        changesChars: false,
        autoCommitIntervalSecs: 30, // clamps to 60
        updateNotify: false,
        mcpApprovalTimeoutSecs: 5, // clamps to 10
      }),
    });
    expect(put.status).toBe(200);
    expect(saveSpy.mock.calls.length).toBe(1);
    const settingsEvents = cap.events.filter((e) => e.event === "settings_changed");
    expect(settingsEvents.length).toBe(1);
    expect(settingsEvents[0]!.payload).toEqual({
      remoteEditing: false,
      changesChars: false,
      autoCommitIntervalSecs: 60,
      updateNotify: false,
      mcpApprovalTimeoutSecs: 10,
    });
  } finally {
    cap.stop();
  }
});

test("junk changesStatDisplay still 400s after a single save + broadcast that applied the other field", async () => {
  const cfg = noLoreDefaultCfg();
  const app = createApp(cfg);
  saveSpy = spyOn(configModule, "saveConfig");
  const cap = capture();
  try {
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changesStatDisplay: "pie-chart", remoteEditing: false }),
    });
    expect(put.status).toBe(400);
    expect(cfg.remoteEditing).toBe(false);
    expect(saveSpy.mock.calls.length).toBe(1);
    const settingsEvents = cap.events.filter((e) => e.event === "settings_changed");
    expect(settingsEvents.length).toBe(1);
    expect(settingsEvents[0]!.payload).toEqual({ remoteEditing: false });
  } finally {
    cap.stop();
  }
});

test("mcpAutoDeny:true puts both mcpAutoDeny and mcpAutoApprove in the one broadcast payload", async () => {
  // mcpAutoDeny defaults true unless explicitly false — must disable it here for
  // mcpAutoApprove:true to actually take effect at boot (see app.ts's mutual-exclusion priming).
  const app = createApp({ ...noLoreDefaultCfg(), mcpAutoDeny: false, mcpAutoApprove: true });
  saveSpy = spyOn(configModule, "saveConfig");
  const cap = capture();
  try {
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcpAutoDeny: true }),
    });
    expect(put.status).toBe(200);
    expect(saveSpy.mock.calls.length).toBe(1);
    const settingsEvents = cap.events.filter((e) => e.event === "settings_changed");
    expect(settingsEvents.length).toBe(1);
    expect(settingsEvents[0]!.payload).toEqual({ mcpAutoDeny: true, mcpAutoApprove: false });
  } finally {
    cap.stop();
  }
});

test("an empty body saves nothing and broadcasts nothing", async () => {
  const app = createApp(noLoreDefaultCfg());
  saveSpy = spyOn(configModule, "saveConfig");
  const cap = capture();
  try {
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(put.status).toBe(200);
    expect(saveSpy.mock.calls.length).toBe(0);
    expect(cap.events.filter((e) => e.event === "settings_changed").length).toBe(0);
  } finally {
    cap.stop();
  }
});

test("diffStats + remoteBrowse together call refreshAllRepos exactly once", async () => {
  const app = createApp(localCfg());
  refreshSpy = spyOn(service, "refreshAllRepos").mockImplementation(() => {});
  try {
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ diffStats: true, remoteBrowse: false }),
    });
    expect(put.status).toBe(200);
    expect(refreshSpy.mock.calls.length).toBe(1);
  } finally {
    /* restored in afterEach */
  }
});
