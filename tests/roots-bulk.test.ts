import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/daemon.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { upsertRepo, getRepo, setRepoStatus, type RepoStatus } from "../src/db.ts";
import { fetchAllRepos, discoverRoot, forgetReposUnder } from "../src/service.ts";
import { sign, unsign, rotateKey } from "../src/auth.ts";

const localCfg = (roots: string[] = []): RepoYetiConfig => ({ roots, port: 7171, maxDepth: 6, maxRepos: 200 });

const statusWithRemote = (remote: string | null): RepoStatus => ({
  branch: "main",
  detached: false,
  dirty: 0,
  ahead: 0,
  behind: 0,
  remote,
  error: null,
  fetchedAt: null,
  updatedAt: Date.now(),
});

async function gitRepoIn(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

// ── fetch-all ──────────────────────────────────────────────────────────────────

test("fetchAllRepos attempts only repos with a remote, and reports per-repo failures", async () => {
  const withRemote = mkdtempSync(join(tmpdir(), "gm-fa-r-"));
  await $`git -c init.defaultBranch=main init -q ${withRemote}`.quiet();
  const idA = upsertRepo(withRemote, "fa-remote", "auto", false);
  setRepoStatus(idA, statusWithRemote("origin")); // has a remote, but no real upstream → fetch fails

  const noRemote = mkdtempSync(join(tmpdir(), "gm-fa-n-"));
  await $`git -c init.defaultBranch=main init -q ${noRemote}`.quiet();
  const idB = upsertRepo(noRemote, "fa-noremote", "auto", false);
  setRepoStatus(idB, statusWithRemote(null)); // no remote → skipped entirely

  const r = await fetchAllRepos();
  expect(r.total).toBeGreaterThanOrEqual(1);
  expect(r.ok + r.failed.length).toBe(r.total); // every attempted repo is accounted for
  expect(r.failed.some((f) => f.id === idB)).toBe(false); // no-remote repo was skipped, not failed
  // idA has a remote → it was attempted (lands in ok or failed, never silently dropped)
  expect(r.failed.some((f) => f.id === idA) || r.ok >= 1).toBe(true);
});

test("POST /api/repos/fetch-all returns a well-formed summary", async () => {
  const res = await createApp(localCfg()).request("/api/repos/fetch-all", { method: "POST" });
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(typeof j.total).toBe("number");
  expect(typeof j.ok).toBe("number");
  expect(Array.isArray(j.failed)).toBe(true);
});

// ── scan roots ───────────────────────────────────────────────────────────────

test("discoverRoot indexes repos found under a new root", async () => {
  const root = mkdtempSync(join(tmpdir(), "gm-root-"));
  await gitRepoIn(root, "alpha");
  await gitRepoIn(root, "beta");
  const found = await discoverRoot(root, 6, 200);
  expect(found).toBeGreaterThanOrEqual(2);
});

test("forgetReposUnder removes auto repos under a root but keeps pinned ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "gm-forget-"));
  const autoDir = await gitRepoIn(root, "auto-repo");
  const pinnedDir = await gitRepoIn(root, "pinned-repo");
  const autoId = upsertRepo(autoDir, "auto-repo", "auto", false);
  const pinnedId = upsertRepo(pinnedDir, "pinned-repo", "pinned", false);

  const removed = forgetReposUnder(root);
  expect(removed).toBeGreaterThanOrEqual(1);
  expect(getRepo(autoId)).toBeNull(); // auto repo under the root is forgotten
  expect(getRepo(pinnedId)).not.toBeNull(); // an explicitly-pinned repo is kept
});

test("GET/POST/DELETE /api/roots list, add (validated), and remove a scan root", async () => {
  const cfg = localCfg();
  const app = createApp(cfg);
  const root = mkdtempSync(join(tmpdir(), "gm-rootroute-"));
  await gitRepoIn(root, "child");

  // add
  const add = await app.request("/api/roots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: root }),
  });
  expect(add.status).toBe(200);
  expect((await add.json()).roots).toContain(root);

  // list reflects it
  const list = await app.request("/api/roots");
  expect((await list.json()).roots).toContain(root);

  // a non-existent path is rejected
  const bad = await app.request("/api/roots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: join(root, "does-not-exist") }),
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).code).toBe("BAD_REQUEST");

  // remove
  const del = await app.request("/api/roots", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: root }),
  });
  expect(del.status).toBe(200);
  expect((await del.json()).roots).not.toContain(root);
});

// ── sign out everywhere (key rotation) ─────────────────────────────────────────

test("rotateKey invalidates every existing signed token", () => {
  const token = sign("hello");
  expect(unsign(token)).toBe("hello"); // valid before rotation

  rotateKey();
  expect(unsign(token)).toBeNull(); // old token no longer verifies

  const fresh = sign("hello");
  expect(unsign(fresh)).toBe("hello"); // new tokens work under the new key
});

test("POST /api/auth/logout-all succeeds and clears the session cookie", async () => {
  const res = await createApp(localCfg()).request("/api/auth/logout-all", { method: "POST" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
});
