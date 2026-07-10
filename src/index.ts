#!/usr/bin/env bun
/**
 * repoyeti bin entry — a thin shebang shim. All command logic lives in src/cli/
 * (main.ts dispatches; lifecycle.ts boots the daemon; git.ts/token.ts/mcp.ts drive
 * a running daemon). Kept at src/index.ts because that's the published `bin` target
 * and what the tray launcher invokes (`bun src/index.ts start`).
 */
import { main } from "./cli/main.ts";

// Last-resort crash handlers: an unhandled throw/rejection anywhere in the daemon logs what
// happened and exits non-zero instead of dying silently (or, for a rejection, limping on in an
// unknown state). A supervisor/launcher sees the exit and can restart.
process.on("uncaughtException", (err) => {
  console.error("[repoyeti] uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[repoyeti] unhandled rejection:", reason);
  process.exit(1);
});

await main(process.argv.slice(2));
