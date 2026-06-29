import { test, expect } from "bun:test";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, loadConfig, saveConfig, hydrateSecrets } from "../src/config.ts";
import { getSecret, setSecret, deleteSecret, aiKeyName } from "../src/secrets.ts";

const CONFIG_PATH = join(CONFIG_DIR, "config.json");
// An isolated keychain namespace so these tests never touch the user's real `repoyeti` entries.
const SVC = `repoyeti-test-${process.pid}`;

async function withService<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.REPOYETI_KEYCHAIN_SERVICE;
  process.env.REPOYETI_KEYCHAIN_SERVICE = SVC;
  try {
    return await fn(); // MUST await — else the env is restored before the async keychain ops run
  } finally {
    if (prev === undefined) delete process.env.REPOYETI_KEYCHAIN_SERVICE;
    else process.env.REPOYETI_KEYCHAIN_SERVICE = prev;
  }
}

function snapshotConfig(): string | null {
  return existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
}
function restoreConfig(saved: string | null): void {
  if (saved !== null) writeFileSync(CONFIG_PATH, saved);
  else rmSync(CONFIG_PATH, { force: true });
}

// Probe whether an OS secret service is actually reachable on this host. On a headless box
// with no libsecret it won't be, so the keychain-dependent tests skip rather than fail.
const HAVE_KEYCHAIN = await withService(async () => {
  const ok = await setSecret("__probe__", "x");
  if (ok) await deleteSecret("__probe__");
  return ok;
});

test.skipIf(!HAVE_KEYCHAIN)("secrets boundary set/get/delete roundtrip via the OS keychain", async () => {
  await withService(async () => {
    expect(await setSecret(aiKeyName("openai"), "sk-roundtrip")).toBe(true);
    expect(await getSecret(aiKeyName("openai"))).toBe("sk-roundtrip");
    await deleteSecret(aiKeyName("openai"));
    expect(await getSecret(aiKeyName("openai"))).toBeNull();
  });
});

test.skipIf(!HAVE_KEYCHAIN)(
  "hydrateSecrets migrates a legacy plaintext key into the keychain and strips config.json",
  async () => {
    const saved = snapshotConfig();
    await withService(async () => {
      // A legacy config.json that still carries the key in plaintext.
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          roots: [],
          port: 7171,
          maxDepth: 6,
          maxRepos: 200,
          ai: { providers: { openai: { apiKey: "sk-legacy-plaintext", model: "gpt-x" } }, defaultProvider: "openai" },
        }),
      );
      const cfg = loadConfig();
      expect(cfg.ai?.providers?.openai?.apiKey).toBe("sk-legacy-plaintext");

      await hydrateSecrets(cfg);

      // Key now lives in the keychain…
      expect(await getSecret(aiKeyName("openai"))).toBe("sk-legacy-plaintext");
      // …is gone from disk, but the non-secret model is kept…
      const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      expect(onDisk.ai.providers.openai.apiKey).toBeUndefined();
      expect(onDisk.ai.providers.openai.model).toBe("gpt-x");
      // …and is still usable in the running daemon's in-memory config.
      expect(cfg.ai?.providers?.openai?.apiKey).toBe("sk-legacy-plaintext");

      await deleteSecret(aiKeyName("openai"));
    });
    restoreConfig(saved);
  },
);

test("with the keychain disabled, saveConfig keeps the key in config.json (no silent key loss)", () => {
  const prevDisabled = process.env.REPOYETI_NO_KEYCHAIN;
  process.env.REPOYETI_NO_KEYCHAIN = "1";
  const saved = snapshotConfig();
  try {
    const cfg = loadConfig();
    cfg.ai = { providers: { openai: { apiKey: "sk-fallback", model: "m" } } };
    saveConfig(cfg);
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(onDisk.ai.providers.openai.apiKey).toBe("sk-fallback");
  } finally {
    if (prevDisabled === undefined) delete process.env.REPOYETI_NO_KEYCHAIN;
    else process.env.REPOYETI_NO_KEYCHAIN = prevDisabled;
    restoreConfig(saved);
  }
});
