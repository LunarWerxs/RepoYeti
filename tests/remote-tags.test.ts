import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { gitRemoteSet, gitRemoteRemove, gitTagCreate } from "../src/git-actions.ts";
import { readTags } from "../src/read/inspect.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const J = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function repo(): Promise<string> {
  const dir = mkScratchDir("gm-rt-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "f.txt"), "x\n");
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q -m init`.quiet();
  return dir;
}

// ── remote add / set-url / remove (git-actions) ──────────────────────────────────

test("gitRemoteSet adds origin, updates it, and gitRemoteRemove drops it", async () => {
  const dir = await repo();
  expect((await gitRemoteSet(dir, "origin", "https://example.com/a.git")).ok).toBe(true);
  expect((await $`git -C ${dir} remote get-url origin`.text()).trim()).toBe("https://example.com/a.git");

  // second call updates the URL (set-url path)
  expect((await gitRemoteSet(dir, "origin", "git@github.com:org/b.git")).ok).toBe(true);
  expect((await $`git -C ${dir} remote get-url origin`.text()).trim()).toBe("git@github.com:org/b.git");

  expect((await gitRemoteRemove(dir, "origin")).ok).toBe(true);
  expect((await gitRemoteRemove(dir, "origin")).code).toBe("NO_REMOTE"); // already gone
});

// ── tags (read-only) ─────────────────────────────────────────────────────────────

test("readTags lists tags newest-first; empty when there are none", async () => {
  const dir = await repo();
  expect((await readTags(dir)).tags.length).toBe(0);

  await $`git -C ${dir} tag v1.0.0`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q --allow-empty -m next`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io tag -a v1.1.0 -m "release 1.1"`.quiet();

  const tags = await readTags(dir);
  expect(tags.ok).toBe(true);
  expect(tags.tags.map((t) => t.name).sort()).toEqual(["v1.0.0", "v1.1.0"]);
  // newest-first: each entry's creatordate is ≥ the next (robust when two tags tie within a clock-second)
  for (let i = 1; i < tags.tags.length; i++) {
    expect(tags.tags[i - 1]!.date >= tags.tags[i]!.date).toBe(true);
  }
});

// ── HTTP routes ──────────────────────────────────────────────────────────────────

test("POST/DELETE /api/repos/:id/remote validate the URL and update config", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "rt-route", "auto", false);
  const app = createApp(localCfg());

  const bad = await app.request(`/api/repos/${id}/remote`, J("POST", { url: "not a url" }));
  expect(bad.status).toBe(400);
  expect((await bad.json()).code).toBe("BAD_REQUEST");

  const ok = await app.request(`/api/repos/${id}/remote`, J("POST", { url: "https://example.com/x.git" }));
  expect(ok.status).toBe(200);
  expect((await ok.json()).ok).toBe(true);
  expect((await $`git -C ${dir} remote get-url origin`.text()).trim()).toBe("https://example.com/x.git");

  const del = await app.request(`/api/repos/${id}/remote`, J("DELETE", {}));
  expect(del.status).toBe(200);
});

test("GET /api/repos/:id/tags returns tags; unknown repo 404s", async () => {
  const dir = await repo();
  await $`git -C ${dir} tag v2.0.0`.quiet();
  const id = mustUpsertRepo(dir, "rt-tags", "auto", false);
  const app = createApp(localCfg());

  const res = await app.request(`/api/repos/${id}/tags`);
  expect(res.status).toBe(200);
  expect((await res.json()).tags.map((t: { name: string }) => t.name)).toContain("v2.0.0");

  expect((await app.request("/api/repos/nope/tags")).status).toBe(404);
});

// ── tag creation ──────────────────────────────────────────────────────────────────

test("gitTagCreate makes lightweight + annotated tags, rejects duplicates and bad names", async () => {
  const dir = await repo();
  expect((await gitTagCreate(dir, null, "v1.0.0")).ok).toBe(true); // lightweight
  expect((await gitTagCreate(dir, null, "v1.1.0", "release 1.1")).ok).toBe(true); // annotated
  expect((await gitTagCreate(dir, null, "v1.0.0")).code).toBe("EXISTS"); // duplicate
  expect((await gitTagCreate(dir, null, "bad tag")).code).toBe("INVALID_REF_NAME");
  expect((await readTags(dir)).tags.map((t) => t.name).sort()).toEqual(["v1.0.0", "v1.1.0"]);
});

test("POST /api/repos/:id/tag creates a tag (201) and validates the name", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "tag-route", "auto", false);
  const app = createApp(localCfg());

  const ok = await app.request(`/api/repos/${id}/tag`, J("POST", { name: "v3.0.0", message: "three" }));
  expect(ok.status).toBe(201);
  expect((await ok.json()).ok).toBe(true);
  expect((await readTags(dir)).tags.map((t) => t.name)).toContain("v3.0.0");

  const bad = await app.request(`/api/repos/${id}/tag`, J("POST", { name: "no good" }));
  expect(bad.status).toBe(400);
});
