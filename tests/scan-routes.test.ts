import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { getRepos } from "../src/db.ts";
import { rescanFolder, cancelScan, isScanning } from "../src/service/index.ts";

const localCfg = (roots: string[] = []): RepoYetiConfig => ({ roots, port: 7171, maxDepth: 6, maxRepos: 200 });

async function gitRepoIn(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

/** Spin until the module-level single-flight scan settles, so one test can't leak `active` into the next. */
async function waitIdle(): Promise<void> {
  for (let i = 0; i < 200 && isScanning(); i++) await new Promise((r) => setTimeout(r, 10));
}

test("rescanFolder finds repos under a folder and counts only genuinely-new ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "gm-scan-"));
  await gitRepoIn(root, "alpha");
  await gitRepoIn(root, "beta");

  // First scan: both repos are brand new → found and added both cover them.
  const first = await rescanFolder(root);
  expect(first.cancelled).toBe(false);
  expect(first.found).toBeGreaterThanOrEqual(2);
  expect(first.added).toBeGreaterThanOrEqual(2);

  // Re-scan the same folder: everything is already known → found again, but nothing "new".
  const second = await rescanFolder(root);
  expect(second.found).toBeGreaterThanOrEqual(2);
  expect(second.added).toBe(0);
});

test("POST /api/scan starts a scan and indexes the repos it finds", async () => {
  const root = mkdtempSync(join(tmpdir(), "gm-scanroute-"));
  const child = await gitRepoIn(root, "gamma");
  const app = createApp(localCfg([root]));

  const res = await app.request("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: root }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, running: true, scope: "folder" });

  await waitIdle(); // the route is fire-and-forget — let the background walk finish
  expect(getRepos().some((r) => r.absPath === child)).toBe(true);
});

test("POST /api/scan/cancel is a no-op (cancelled:false) when nothing is running", async () => {
  await waitIdle();
  const res = await createApp(localCfg()).request("/api/scan/cancel", { method: "POST" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, cancelled: false });
  expect(isScanning()).toBe(false);
});

test("cancelScan() returns false when idle", () => {
  expect(cancelScan()).toBe(false);
});

test("POST /api/repos/:id/account pins then clears a repo's GitHub sync account", async () => {
  const root = mkdtempSync(join(tmpdir(), "gm-acct-"));
  await gitRepoIn(root, "delta");
  const app = createApp(localCfg([root]));
  await rescanFolder(root); // await → fully indexed when it resolves
  const repo = getRepos().find((r) => r.name === "delta");
  expect(repo).toBeTruthy();
  // Fresh repos have no pinned account.
  expect(repo!.syncAccountLogin).toBe(null);

  // Pin an account (host defaults to github.com when omitted).
  const post = (body: unknown) =>
    app.request(`/api/repos/${repo!.id}/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let res = await post({ login: "octocat" });
  expect(res.status).toBe(200);
  let out = (await res.json()) as { repo: { syncAccountLogin: string | null; syncAccountHost: string | null } };
  expect(out.repo.syncAccountLogin).toBe("octocat");
  expect(out.repo.syncAccountHost).toBe("github.com");

  // Clear it (null login wipes both columns).
  res = await post({ login: null });
  out = (await res.json()) as { repo: { syncAccountLogin: string | null; syncAccountHost: string | null } };
  expect(out.repo.syncAccountLogin).toBe(null);
  expect(out.repo.syncAccountHost).toBe(null);
});
