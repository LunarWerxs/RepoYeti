/**
 * Dev launcher. Refuses to start a second GitMob (one instance at a time), then runs
 * the daemon under Bun's file watcher. GITMOB_DEV=1 exempts the watched daemon's
 * reloads from the single-instance guard — a `--watch` reload restarts the SAME
 * logical instance and must be free to rebind its port. See src/index.ts.
 *
 * Uses process.execPath (the real bun binary) rather than "bun", which on Windows
 * may be a .cmd shim that CreateProcess can't spawn directly.
 */
import { spawn } from "node:child_process";
import { findLiveInstance } from "../src/instance.ts";

const running = await findLiveInstance();
if (running) {
  console.log(
    `\n[gitmob] already running → ${running.url}\n[gitmob] stop it before running dev (one instance at a time).\n`,
  );
  process.exit(0);
}

process.env.GITMOB_DEV = "1";
const child = spawn(process.execPath, ["--watch", "src/index.ts", "start"], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(`[gitmob] failed to start dev daemon: ${err.message}`);
  process.exit(1);
});
