import { test, expect } from "bun:test";
import { relayEffective, redactRelay, DEFAULT_RELAY_URL, type RepoYetiConfig } from "../src/config.ts";

// The stable address is the DEFAULT, not a feature you find: an untouched config is relay-ON at
// the hosted default. Only an explicit `enabled: false` — or a configured named tunnel, which IS
// a permanent address already — turns it off. These pin that truth table.

const base = (over: Partial<RepoYetiConfig> = {}): RepoYetiConfig =>
  ({ roots: [], port: 7171, ...over }) as RepoYetiConfig;

test("an untouched config is relay-ON at the hosted default", () => {
  const eff = relayEffective(base());
  expect(eff.enabled).toBe(true);
  expect(eff.url).toBe(DEFAULT_RELAY_URL);
  expect(redactRelay(base()).enabled).toBe(true);
});

test("an explicit opt-out stays off", () => {
  const cfg = base({ relay: { enabled: false } });
  expect(relayEffective(cfg).enabled).toBe(false);
  expect(redactRelay(cfg).enabled).toBe(false);
});

test("a named tunnel suppresses the default — a custom domain IS the stable address", () => {
  const cfg = base({ tunnel: { provider: "named", hostname: "app.example.com", token: "tok" } });
  expect(relayEffective(cfg).enabled).toBe(false);
});

test("a named tunnel always selects the custom-domain address, even with stale relay config", () => {
  const cfg = base({
    tunnel: { provider: "named", hostname: "app.example.com", token: "tok" },
    relay: { enabled: true },
  });
  expect(relayEffective(cfg).enabled).toBe(false);
});

test("a custom relay url rides along regardless of how enabled was decided", () => {
  const cfg = base({ relay: { url: "https://relay.example" } });
  const eff = relayEffective(cfg);
  expect(eff.enabled).toBe(true);
  expect(eff.url).toBe("https://relay.example");
});

test("the old hosted hostname migrates to app.repoyeti.com without changing self-hosted URLs", () => {
  expect(relayEffective(base({ relay: { enabled: true, url: "https://go.repoyeti.com" } })).url).toBe(
    DEFAULT_RELAY_URL,
  );
  expect(relayEffective(base({ relay: { enabled: true, url: "https://relay.example" } })).url).toBe(
    "https://relay.example",
  );
});
