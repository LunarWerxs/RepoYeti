// A real daemon on an ephemeral port with REPOYETI_BASE_URL pointed at it — the harness the CLI
// tests need, because src/cli/* is forbidden to import the service/read layers and can only be
// exercised the way a user runs it: over loopback HTTP against a running daemon.
//
// Local mode (no OIDC) leaves /api/* ungated, so the CLI client can talk to it directly.
import { createApp } from "../../src/http/app.ts";
import type { RepoYetiConfig } from "../../src/config.ts";

export const minimalConfig = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

/** Spin a daemon, point REPOYETI_BASE_URL at it, run `fn`, then tear down — restoring the env var
 *  no matter what, so a failing assertion can't leak the override into the rest of the suite. */
export async function withDaemon(
  fn: (origin: string) => Promise<void>,
  cfg: RepoYetiConfig = minimalConfig(),
): Promise<void> {
  const prev = process.env.REPOYETI_BASE_URL;
  const app = createApp(cfg);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const origin = `http://127.0.0.1:${server.port}`;
  process.env.REPOYETI_BASE_URL = origin;
  try {
    await fn(origin);
  } finally {
    server.stop(true);
    if (prev === undefined) delete process.env.REPOYETI_BASE_URL;
    else process.env.REPOYETI_BASE_URL = prev;
  }
}
