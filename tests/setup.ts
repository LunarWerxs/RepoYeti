// Runs before any test module imports src/* — points all daemon state at a throwaway
// dir so tests never read or write the real ~/.repoyeti.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REPOYETI_HOME = mkdtempSync(join(tmpdir(), "repoyeti-test-home-"));
process.env.GIT_TERMINAL_PROMPT = "0";
