/**
 * A view link reads what the owner changed, never what git ignores.
 *
 * `GET /api/repos/:id/file` and `GET /api/repos/:id/diff` are guest routes that read whatever path
 * they are given. The policy withholds the tree browser precisely because ignored paths are "where
 * `.env` files, local credentials and build output live" (src/share/policy.ts), yet `.env` needs no
 * browsing to find: a guest could simply ask for it. These pin the guard, and that it took nothing
 * the dashboard legitimately shows a guest.
 */
import { test, expect, beforeAll } from "bun:test";
import { $ } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import { sign } from "../src/auth.ts";
import { initDb, createShare, type Share } from "../src/db.ts";
import { hashToken, mintToken, GUEST_COOKIE } from "../src/share/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

useSuiteTimeout();

const cfg = (): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  mode: "remote",
  oauth: {
    issuer: "https://accounts.connectionsapi.com",
    clientId: "test-client",
    redirectUri: "https://example.com/cb",
    ownerSub: "owner-sub-123",
  },
});
const REMOTE = { "cf-connecting-ip": "203.0.113.7" };
const guestCookie = (share: Share): string =>
  `${GUEST_COOKIE}=${sign(JSON.stringify({ sid: share.id, exp: Date.now() + 3_600_000 }))}`;
const ownerCookie = (): string =>
  `gm_session=${sign(JSON.stringify({ sub: "owner-sub-123", email: "", exp: Date.now() + 60_000 }))}`;

let repoId = "";
let share: Share;

beforeAll(async () => {
  initDb();
  // A REAL git repo: a fixture that is not one would let git walk up into RepoYeti's own .git.
  const dir = mkScratchDir("share-ignored-read-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email seed@example.com`.quiet();
  writeFileSync(join(dir, ".gitignore"), ".env\n*.log\n");
  writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
  writeFileSync(join(dir, ".env"), "API_KEY=do-not-leak\n"); // ignored
  writeFileSync(join(dir, "notes.txt"), "a new file the guest can see in Changes\n"); // untracked, visible
  writeFileSync(join(dir, "app.ts"), "export const x = 2;\n"); // a tracked, changed file
  repoId = mustUpsertRepo(dir, "ignored-read", "pinned", false);
  share = createShare(hashToken(mintToken()), {
    label: "view link",
    perm: "view",
    scopeAll: false,
    repoIds: [repoId],
    expiresAt: null,
  });
});

async function asGuest(path: string): Promise<Response> {
  return createApp(cfg()).request(path, { headers: { ...REMOTE, cookie: guestCookie(share) } });
}

test("a guest cannot read an ignored file from the working tree, by /file or by /diff", async () => {
  for (const url of [
    `/api/repos/${repoId}/file?path=.env`,
    `/api/repos/${repoId}/file?path=.env&preview=pdf`,
    `/api/repos/${repoId}/diff?path=.env`,
  ]) {
    const res = await asGuest(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("do-not-leak");
  }
});

test("a guest still reads what the dashboard shows them: changed, untracked and committed files", async () => {
  const changed = await asGuest(`/api/repos/${repoId}/file?path=app.ts`);
  expect(changed.status).toBe(200);
  expect(((await changed.json()) as { content: string }).content).toContain("x = 2");
  expect((await asGuest(`/api/repos/${repoId}/file?path=notes.txt`)).status).toBe(200);
  expect((await asGuest(`/api/repos/${repoId}/diff?path=app.ts`)).status).toBe(200);
  // `.gitignore` itself is tracked, so no pattern hides it.
  expect((await asGuest(`/api/repos/${repoId}/file?path=.gitignore`)).status).toBe(200);
});

test("the owner is untouched: an ignored file is theirs to read", async () => {
  const res = await createApp(cfg()).request(`/api/repos/${repoId}/file?path=.env`, {
    headers: { ...REMOTE, cookie: ownerCookie() },
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { content: string }).content).toContain("do-not-leak");
});
