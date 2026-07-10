/**
 * Bring-your-own-key AI: provider adapters + commit-message drafting + Smart-Commit planning.
 *
 * Implementation now lives in ./ai/ (split by concern: adapters / commit-message / commit-plan —
 * see that folder's index.ts for the breakdown). This file is kept as a thin re-export shim so
 * every existing `from "./ai.ts"` / `from "../ai.ts"` / `from "../src/ai.ts"` import (this repo
 * uses explicit `.ts`-suffixed specifiers under `moduleResolution: "bundler"`, which does NOT
 * fall back from a flat-file specifier to a same-named folder's index.ts) keeps resolving unchanged.
 */
export * from "./ai/index.ts";
