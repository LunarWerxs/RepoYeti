import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { clearInstanceInfo, readInstanceInfo, writeInstanceInfo } from "../src/instance.ts";
import { PORTABLE_WINDOW_SIZE } from "../src/http/routes/health.ts";

// Settings persistence + the runtime-pointer sync for "Portable window". POST /api/portable-window
// itself is NOT exercised here — it spawns a real detached browser process via the kit's
// openPortableWindow (src/portable-window.mjs), which has no dry-run seam, so a test that called it
// would pop a real window on any machine with Edge/Chrome installed.

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

test("GET /api/status defaults portableMode to false; PUT /api/settings flips it and echoes it back", async () => {
  const app = createApp(localCfg());

  const before = await (await app.request("/api/status")).json();
  expect(before.portableMode).toBe(false);

  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ portableMode: true }),
  });
  expect(put.status).toBe(200);
  expect((await put.json()).portableMode).toBe(true);

  const after = await (await app.request("/api/status")).json();
  expect(after.portableMode).toBe(true);
});

test("PUT /api/settings with portableMode updates the existing runtime pointer (read-merge-write)", async () => {
  clearInstanceInfo();
  writeInstanceInfo(7171); // simulate a daemon already having bound + written its pointer
  expect(readInstanceInfo()?.portableMode).toBeUndefined();

  const app = createApp(localCfg());
  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ portableMode: true }),
  });
  expect(put.status).toBe(200);

  expect(readInstanceInfo()?.portableMode).toBe(true);
  // Core fields (port/url/pid) survive the merge untouched.
  expect(readInstanceInfo()?.port).toBe(7171);

  clearInstanceInfo();
});

test("PUT /api/settings with portableMode is a no-op on the pointer when no daemon has written one yet", async () => {
  clearInstanceInfo();
  const app = createApp(localCfg());
  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ portableMode: true }),
  });
  expect(put.status).toBe(200);
  expect(readInstanceInfo()).toBeNull(); // updateInstanceInfo() no-ops when no pointer exists
});

test("the portable window's first-run size fits the measured dashboard layout", () => {
  // Measured against the real dashboard (see PORTABLE_WINDOW_SIZE in http/routes/health.ts):
  // the layout caps content at --container-max = 800px, so 800 + 15 scrollbar + ~16 frame =
  // 831 outer is the floor below which the design width gets cropped.
  expect(PORTABLE_WINDOW_SIZE.width).toBe(840);
  expect(PORTABLE_WINDOW_SIZE.height).toBe(760);
  // Guard the intent, not just the digits: it must render the full 800px container…
  expect(PORTABLE_WINDOW_SIZE.width).toBeGreaterThanOrEqual(831);
  // …without drifting back toward Chromium's whole-work-area default.
  expect(PORTABLE_WINDOW_SIZE.width).toBeLessThan(1200);
  expect(PORTABLE_WINDOW_SIZE.height).toBeLessThan(1100);
});
