import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { upsertRepo } from "../src/db.ts";

// Local mode (no OIDC) → /api/* is ungated, so routes are exercised directly.
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const J = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function repoWithId(): Promise<{ dir: string; id: string }> {
  const dir = mkdtempSync(join(tmpdir(), "gm-broute-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m init`.quiet();
  return { dir, id: upsertRepo(dir, "broute", "auto", false) };
}

test("GET /branches lists branches; unknown repo 404s", async () => {
  const { id } = await repoWithId();
  const app = createApp(localCfg());
  const res = await app.request(`/api/repos/${id}/branches`);
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.current).toBe("main");
  expect((await (await app.request("/api/repos/nope/branches")).json()).code).toBe("NOT_FOUND");
});

test("POST /branch creates (201), rejects duplicate (409) and invalid name (400)", async () => {
  const { id } = await repoWithId();
  const app = createApp(localCfg());

  const create = await app.request(`/api/repos/${id}/branch`, J({ name: "feature/x", switch: false }));
  expect(create.status).toBe(201);
  expect((await create.json()).ok).toBe(true);

  const dup = await app.request(`/api/repos/${id}/branch`, J({ name: "feature/x", switch: false }));
  expect(dup.status).toBe(409);
  expect((await dup.json()).code).toBe("BRANCH_EXISTS");

  const bad = await app.request(`/api/repos/${id}/branch`, J({ name: "bad name" }));
  expect(bad.status).toBe(400);
  expect((await bad.json()).code).toBe("INVALID_REF_NAME");
});

test("POST /checkout switches on a clean tree, 409s on a dirty one", async () => {
  const { dir, id } = await repoWithId();
  const app = createApp(localCfg());
  await app.request(`/api/repos/${id}/branch`, J({ name: "dev", switch: false }));

  const ok = await app.request(`/api/repos/${id}/checkout`, J({ branch: "dev" }));
  expect(ok.status).toBe(200);
  expect((await ok.json()).ok).toBe(true);

  writeFileSync(join(dir, "seed.txt"), "dirty\n");
  const dirty = await app.request(`/api/repos/${id}/checkout`, J({ branch: "main" }));
  expect(dirty.status).toBe(409);
  expect((await dirty.json()).code).toBe("DIRTY_WORKING_TREE");
});

test("DELETE /branch removes a merged branch and refuses a protected one", async () => {
  const { id } = await repoWithId();
  const app = createApp(localCfg());
  await app.request(`/api/repos/${id}/branch`, J({ name: "merged", switch: false }));

  const del = await app.request(`/api/repos/${id}/branch`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "merged" }),
  });
  expect(del.status).toBe(200);
  expect((await del.json()).ok).toBe(true);

  const prot = await app.request(`/api/repos/${id}/branch`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "main" }),
  });
  expect(prot.status).toBe(409);
  expect((await prot.json()).code).toBe("PROTECTED_BRANCH");
});

test("GET /log returns commits", async () => {
  const { id } = await repoWithId();
  const app = createApp(localCfg());
  const res = await app.request(`/api/repos/${id}/log?limit=10`);
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.commits.length).toBeGreaterThanOrEqual(1);
  expect(j.commits[0].subject).toBe("init");
});

test("stash save → list → pop round-trips over the routes", async () => {
  const { dir, id } = await repoWithId();
  const app = createApp(localCfg());
  writeFileSync(join(dir, "seed.txt"), "edited\n");

  const save = await app.request(`/api/repos/${id}/stash`, J({ message: "wip" }));
  expect(save.status).toBe(200);
  expect((await save.json()).ok).toBe(true);

  const list = await app.request(`/api/repos/${id}/stashes`);
  expect((await list.json()).stashes.length).toBe(1);

  const pop = await app.request(`/api/repos/${id}/stash/pop`, J({ index: 0 }));
  expect(pop.status).toBe(200);
  expect((await pop.json()).ok).toBe(true);
  expect((await (await app.request(`/api/repos/${id}/stashes`)).json()).stashes.length).toBe(0);
});

test("POST /discard restores a modified file; unknown repo 404s", async () => {
  const { dir, id } = await repoWithId();
  const app = createApp(localCfg());
  writeFileSync(join(dir, "seed.txt"), "garbage\n");

  const res = await app.request(`/api/repos/${id}/discard`, J({ path: "seed.txt" }));
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect((await Bun.file(join(dir, "seed.txt")).text()).replace(/\r/g, "")).toBe("seed\n");

  const missing = await app.request("/api/repos/nope/discard", J({ path: "x" }));
  expect(missing.status).toBe(404);
});
