/**
 * Remote access via a bundled `cloudflared` tunnel — two flavours:
 *
 *  - QUICK (default, zero-config): `cloudflared tunnel --url http://127.0.0.1:<port>`, scrape the
 *    rotating `*.trycloudflare.com` URL it prints. Fine for a quick demo, but the URL rotates each
 *    run and trycloudflare is widely DNS-blocked (abuse), so phones on filtered networks can't reach
 *    it (the OAuth redirect shim absorbs the rotation; see §7).
 *  - NAMED (`startNamedTunnel`): `cloudflared tunnel run --token <token>` against the owner's own
 *    Cloudflare account → a STABLE host (e.g. app.repoyeti.com) that never rotates and resolves
 *    everywhere. There's no URL to scrape — the public-host→service mapping lives in the Cloudflare
 *    dashboard — so we report `https://<hostname>` once an edge connection registers.
 *
 * Tunnel failure is NON-FATAL: the daemon keeps serving localhost. SECURITY: a tunnel must never be
 * exposed without app-layer auth. The caller (index.ts / runtime.ts) refuses to start one unless
 * OIDC + an owner are configured.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
/** cloudflared logs one of these once an edge connection is live — a named tunnel's "ready" signal
 *  (it prints no public URL, since the hostname is configured in the Cloudflare dashboard). */
export const TUNNEL_READY_RE = /registered tunnel connection|connection [0-9a-f-]{6,} registered/i;

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

/**
 * Spawn cloudflared with `args`, watching the merged stdout/stderr stream. The first time `detect`
 * returns a URL from a chunk, fire `onUrl` (once). A launch failure or an exit before readiness
 * fires `onError`. Shared by the quick and named tunnels — they differ only in args + `detect`.
 */
function spawnCloudflared(
  args: string[],
  detect: (chunk: string) => string | null,
  onUrl: (url: string) => void,
  onError: (message: string) => void,
): TunnelHandle {
  let proc: ChildProcess;
  try {
    proc = spawn(resolveCloudflaredExecutable(), args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    onError(`could not launch cloudflared: ${err instanceof Error ? err.message : err}`);
    return { stop() {} };
  }

  let found = false;
  const scan = (buf: Buffer): void => {
    if (found) return;
    const url = detect(buf.toString());
    if (url) {
      found = true;
      onUrl(url);
    }
  };
  proc.stdout?.on("data", scan);
  proc.stderr?.on("data", scan);

  proc.on("error", (err) => onError(`cloudflared error: ${err.message}`));
  proc.on("exit", (code) => {
    if (!found) onError(`cloudflared exited (code ${code}) before the tunnel was ready`);
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

/** QUICK tunnel: scrape the rotating `*.trycloudflare.com` URL cloudflared prints. */
export function startTunnel(
  port: number,
  onUrl: (url: string) => void,
  onError: (message: string) => void,
): TunnelHandle {
  return spawnCloudflared(
    ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
    (chunk) => URL_RE.exec(chunk)?.[0] ?? null,
    onUrl,
    onError,
  );
}

/**
 * NAMED tunnel: `cloudflared tunnel run --token <token>`. cloudflared prints no public URL (the
 * hostname is configured in the Cloudflare dashboard), so we report `https://<hostname>` the moment
 * an edge connection registers. The CF tunnel's "public hostname" must point at this daemon's local
 * service (e.g. app.repoyeti.com → http://localhost:<port>).
 */
export function startNamedTunnel(
  token: string,
  hostname: string,
  onUrl: (url: string) => void,
  onError: (message: string) => void,
): TunnelHandle {
  const url = `https://${hostname}`;
  return spawnCloudflared(
    ["tunnel", "--no-autoupdate", "run", "--token", token],
    (chunk) => (TUNNEL_READY_RE.test(chunk) ? url : null),
    onUrl,
    onError,
  );
}
