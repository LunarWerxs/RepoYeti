// Runs before any test module imports src/* — points all daemon state at a throwaway
// dir so tests never read or write the real ~/.gitmob.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GITMOB_HOME = mkdtempSync(join(tmpdir(), "gitmob-test-home-"));
process.env.GIT_TERMINAL_PROMPT = "0";
