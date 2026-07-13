/**
 * Tiny standalone probe spawned as a SEPARATE `bun` process by
 * tests/identity-hygiene.test.ts's runGuardProbe(). Imports src/config.ts fresh (its own process,
 * its own module cache) under whatever env the parent test set, calls ensureConfigDir(), and
 * prints exactly one line so the parent can assert on it. Not a *.test.ts file itself; it's not
 * meant to run under `bun test`, only spawned directly as `bun tests/helpers/guard-probe.ts`.
 */
import { ensureConfigDir } from "../../src/config.ts";

try {
  ensureConfigDir();
  console.log("NO_THROW");
} catch (e) {
  console.log(`THREW:${e instanceof Error ? e.message : String(e)}`);
}
