/**
 * Running-instance pointer. The daemon may bind a different port than requested
 * (the preferred one was busy — see `listen()` in index.ts), so it records the
 * port it ACTUALLY bound in ~/.gitmob/runtime.json. The launcher reads this to
 * open the browser at the right URL and to detect an already-running instance via
 * /api/health, and the Vite dev proxy can follow it too. Best-effort throughout:
 * a write/read failure never blocks the daemon. Honours GITMOB_HOME (so tests and
 * relocated state point the pointer at the same dir as the rest of the config).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "./config.ts";

const RUNTIME_FILE = join(CONFIG_DIR, "runtime.json");

export interface InstanceInfo {
  port: number;
  url: string;
  pid: number;
  startedAt: number;
}

/** Absolute path of the runtime pointer (exported so other tools can locate it). */
export function instanceFilePath(): string {
  return RUNTIME_FILE;
}

/** Record the port the daemon actually bound, so launchers can find this instance. */
export function writeInstanceInfo(port: number): void {
  try {
    ensureConfigDir();
    const info: InstanceInfo = {
      port,
      url: `http://127.0.0.1:${port}`,
      pid: process.pid,
      startedAt: Date.now(),
    };
    // 0600: it carries the daemon's port + pid (mirrors how config.json is written).
    writeFileSync(RUNTIME_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort — the launcher falls back to the default port */
  }
}

/** Read the recorded instance pointer, or null if missing/unreadable. */
export function readInstanceInfo(): InstanceInfo | null {
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, "utf8")) as InstanceInfo;
  } catch {
    return null;
  }
}

/** Remove the pointer (on a clean shutdown). Stale files are tolerated by readers. */
export function clearInstanceInfo(): void {
  try {
    rmSync(RUNTIME_FILE, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve a LIVE GitMob instance from the pointer, or null. Reads runtime.json and
 * probes `${url}/api/health` (which is auth-exempt) so a stale pointer — the daemon
 * crashed, or the port was recycled by some other app — reads as "nothing running":
 * only a real, answering GitMob daemon counts. Used to enforce single-instance.
 */
export async function findLiveInstance(timeoutMs = 1000): Promise<InstanceInfo | null> {
  const info = readInstanceInfo();
  if (!info?.url) return null;
  try {
    const res = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; service?: string };
    return body?.ok && body.service === "gitmob" ? info : null;
  } catch {
    return null; // unreachable / not GitMob / timed out → treat as not running
  }
}
