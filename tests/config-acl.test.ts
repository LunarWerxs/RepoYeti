/**
 * config.json is never secret-free on Windows's terms: even with a confirmed keychain its
 * projection keeps the relay signing key (RelayConfig explains why the pair cannot be split), and
 * the per-file ACL is gated to keychain-less hosts because it shells out to icacls on every save.
 * The config DIRECTORY is therefore restricted once per process with inheritable grants, so every
 * file created in it is owner-only from birth without paying a subprocess per settings toggle.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, loadConfig, resetConfigDirRestrictionForTests, saveConfig } from "../src/config.ts";
import { aiKeyName, keychainConfirmed, setSecret, setSecretStoreForTests } from "../src/secrets.ts";
import * as fsPerms from "../src/fs-perms.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// The helpers are spied, never run; the timeout travels with the file so a stray real call cannot hang.
useSuiteTimeout();

const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const snapshotConfig = (): string | null => (existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null);
function restoreConfig(saved: string | null): void {
  if (saved !== null) writeFileSync(CONFIG_PATH, saved);
  else rmSync(CONFIG_PATH, { force: true });
}

const spies: Array<ReturnType<typeof spyOn>> = [];
let restoreStore: (() => void) | undefined;
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  restoreStore?.();
  restoreStore = undefined;
});

test("saveConfig restricts the config directory once per process, not once per save", () => {
  const dirSpy = spyOn(fsPerms, "restrictDirToCurrentUser").mockImplementation(() => {});
  spies.push(dirSpy);
  resetConfigDirRestrictionForTests();
  const saved = snapshotConfig();
  try {
    saveConfig(loadConfig());
    saveConfig(loadConfig());
    saveConfig(loadConfig());
    expect(dirSpy).toHaveBeenCalledTimes(1);
    expect(dirSpy.mock.calls[0]?.[0]).toBe(CONFIG_DIR);
  } finally {
    restoreConfig(saved);
  }
});

test("a confirmed keychain keeps the relay key on disk and pays no per-save icacls for it", async () => {
  restoreStore = setSecretStoreForTests(null);
  expect(await setSecret(aiKeyName("groq"), "gsk_confirmed")).toBe(true);
  expect(keychainConfirmed()).toBe(true);
  const fileSpy = spyOn(fsPerms, "restrictToCurrentUser").mockImplementation(() => {});
  spies.push(fileSpy, spyOn(fsPerms, "restrictDirToCurrentUser").mockImplementation(() => {}));
  const saved = snapshotConfig();
  try {
    const cfg = loadConfig();
    cfg.relay = { identity: { id: "relay-id", publicKey: "relay-pub", privateKey: "relay-priv" } };
    saveConfig(cfg);
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(onDisk.relay.identity.privateKey).toBe("relay-priv"); // kept on purpose...
    expect(fileSpy).not.toHaveBeenCalled(); // ...and protected by the directory, not per save
  } finally {
    restoreConfig(saved);
  }
});
