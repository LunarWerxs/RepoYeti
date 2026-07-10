import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { upsertRepo, setRepoStatus, type RepoStatus } from "../src/db.ts";
import { resolveBaseUrl, resolveRepo, get, ApiError } from "../src/cli/client.ts";
import { runGitVerb } from "../src/cli/git.ts";
import type { RepoView } from "../src/db.ts";
import { clearInstanceInfo } from "../src/instance.ts";

// Local mode (no OIDC) → /api/* is not gated, so the CLI client can hit the daemon directly.
const minimalConfig = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

/** Spin a real daemon on an ephemeral port, point REPOYETI_BASE_URL at it, run `fn`, then tear
 *  down — restoring the env var no matter what. */
async function withDaemon(fn: (origin: string) => Promise<void>): Promise<void> {
  const prev = process.env.REPOYETI_BASE_URL;
  const app = createApp(minimalConfig());
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

const status = (over: Partial<RepoStatus>): RepoStatus => ({
  branch: "main",
  detached: false,
  dirty: 0,
  ahead: 0,
  behind: 0,
  remote: null,
  error: null,
  fetchedAt: null,
  updatedAt: Date.now(),
  ...over,
});

test("resolveBaseUrl prefers REPOYETI_BASE_URL", async () => {
  await withDaemon(async (origin) => {
    expect(await resolveBaseUrl()).toBe(origin);
  });
});

test("client lists a seeded repo and resolveRepo finds it by name", async () => {
  const path = mkdtempSync(join(tmpdir(), "gm-cli-list-"));
  const id = upsertRepo(path, "cli-list-repo", "auto", false);
  await withDaemon(async () => {
    const { repos } = await get<{ repos: RepoView[] }>("/api/repos");
    expect(repos.some((r) => r.id === id)).toBe(true);

    const found = await resolveRepo("cli-list-repo");
    expect(found.id).toBe(id);

    // basename of the absolute path also resolves it.
    const byBase = await resolveRepo(path.split(/[/\\]/).pop()!);
    expect(byBase.id).toBe(id);
  });
});

test("resolveRepo throws an ApiError for an unknown repo", async () => {
  await withDaemon(async () => {
    let err: unknown;
    try {
      await resolveRepo("definitely-not-a-real-repo");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("NOT_FOUND");
  });
});

test("repos and drift verbs run against the live daemon", async () => {
  const aheadPath = mkdtempSync(join(tmpdir(), "gm-cli-ahead-"));
  const cleanPath = mkdtempSync(join(tmpdir(), "gm-cli-clean-"));
  const aheadId = upsertRepo(aheadPath, "cli-ahead", "auto", false);
  upsertRepo(cleanPath, "cli-clean", "auto", false);
  setRepoStatus(aheadId, status({ ahead: 2, behind: 1 }));

  await withDaemon(async () => {
    process.exitCode = 0;
    await runGitVerb("repos", []);
    expect(process.exitCode).toBe(0);

    // drift surfaces the ahead/behind repo without throwing.
    await runGitVerb("drift", []);
    expect(process.exitCode).toBe(0);

    // status <repo> resolves and prints the block.
    await runGitVerb("status", ["cli-ahead"]);
    expect(process.exitCode).toBe(0);
  });
});

test("a repo-scoped verb with no repo arg fails (exit 1) without throwing", async () => {
  await withDaemon(async () => {
    process.exitCode = 0;
    await runGitVerb("status", []); // missing <repo>
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

test("resolveBaseUrl gives the friendly error when no daemon is running", async () => {
  const prev = process.env.REPOYETI_BASE_URL;
  delete process.env.REPOYETI_BASE_URL;
  clearInstanceInfo(); // no live-instance pointer → findLiveInstance() returns null
  try {
    let err: unknown;
    try {
      await resolveBaseUrl();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("repoyeti start");
  } finally {
    if (prev !== undefined) process.env.REPOYETI_BASE_URL = prev;
  }
});
