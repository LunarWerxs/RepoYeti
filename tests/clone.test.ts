import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { cloneRepo } from "../src/service/index.ts";
import { getRepos } from "../src/db.ts";

const localCfg = (roots: string[] = []): RepoYetiConfig => ({ roots, port: 7171, maxDepth: 6, maxRepos: 200 });
const J = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function sourceRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-src-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "f.txt"), "hi\n");
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q -m init`.quiet();
  return dir;
}

/** A cross-platform file:// URL (file:///C:/x on Windows, file:///tmp/x on POSIX). */
function fileUrl(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return "file://" + (norm.startsWith("/") ? "" : "/") + norm;
}

test("cloneRepo clones a repo and indexes it", async () => {
  const src = await sourceRepo();
  const parent = mkdtempSync(join(tmpdir(), "gm-parent-"));
  const r = await cloneRepo(parent, "clonedX", src, null);
  expect(r.ok).toBe(true);
  expect(existsSync(join(parent, "clonedX", ".git"))).toBe(true);
  expect(getRepos().some((x) => x.absPath === resolve(join(parent, "clonedX")))).toBe(true);
});

test("POST /api/repos/clone rejects a non-URL", async () => {
  const parent = mkdtempSync(join(tmpdir(), "gm-clp-"));
  const res = await createApp(localCfg([parent])).request("/api/repos/clone", J({ url: "not a url", parentPath: parent }));
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("BAD_REQUEST");
});

test("POST /api/repos/clone rejects a destination outside the scan roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "gm-root-"));
  const outside = mkdtempSync(join(tmpdir(), "gm-outside-"));
  const res = await createApp(localCfg([root])).request(
    "/api/repos/clone",
    J({ url: "https://example.com/x/y.git", parentPath: outside }),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("BAD_REQUEST");
});

test("POST /api/repos/clone clones into a scan root, then 409s on a duplicate name", async () => {
  const src = await sourceRepo();
  const parent = mkdtempSync(join(tmpdir(), "gm-clparent-"));
  const app = createApp(localCfg([parent]));

  const ok = await app.request("/api/repos/clone", J({ url: fileUrl(src), parentPath: parent, name: "myclone" }));
  expect(ok.status).toBe(201);
  expect((await ok.json()).repo.name).toBe("myclone");
  expect(existsSync(join(parent, "myclone", ".git"))).toBe(true);

  const dup = await app.request("/api/repos/clone", J({ url: fileUrl(src), parentPath: parent, name: "myclone" }));
  expect(dup.status).toBe(409);
  expect((await dup.json()).code).toBe("EXISTS");
});
