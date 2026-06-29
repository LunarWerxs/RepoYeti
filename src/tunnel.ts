/**
 * Zero-config remote access via a bundled `cloudflared` quick tunnel.
 *
 * Spawns `cloudflared tunnel --url http://127.0.0.1:<port>`, scrapes the
 * `*.trycloudflare.com` URL it prints, and hands it back. Tunnel failure is
 * NON-FATAL: the daemon keeps serving localhost. The URL rotates each run — that's
 * expected for a quick tunnel (the OAuth redirect shim handles it; see §7).
 *
 * SECURITY: a tunnel must never be exposed without app-layer auth. The caller
 * (index.ts) refuses to start one unless OIDC is configured. The quick tunnel is
 * bundled/installed cloudflared; Phase 5 pins a per-platform binary.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface TunnelHandle {
  stop(): void;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveCloudflaredExecutable(
  execPath = process.execPath,
  platform = process.platform,
): string {
  const exe = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const binDir = dirname(execPath);
  const candidates = [
    join(binDir, "vendor", exe),
    join(binDir, "vendor", "cloudflared", exe),
    join(binDir, "vendor", "cloudflared"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && isFile(candidate)) return candidate;
  }
  return exe;
}

export function startTunnel(
  port: number,
  onUrl: (url: string) => void,
  onError: (message: string) => void,
): TunnelHandle {
  let proc: ChildProcess;
  try {
    proc = spawn(
      resolveCloudflaredExecutable(),
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    onError(`could not launch cloudflared: ${err instanceof Error ? err.message : err}`);
    return { stop() {} };
  }

  let found = false;
  const scan = (buf: Buffer): void => {
    const m = URL_RE.exec(buf.toString());
    if (m && !found) {
      found = true;
      onUrl(m[0]);
    }
  };
  proc.stdout?.on("data", scan);
  proc.stderr?.on("data", scan);

  proc.on("error", (err) => onError(`cloudflared error: ${err.message}`));
  proc.on("exit", (code) => {
    if (!found) onError(`cloudflared exited (code ${code}) before yielding a URL`);
  });

  return {
    stop() {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
