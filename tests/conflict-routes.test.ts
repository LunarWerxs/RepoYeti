/**
 * HTTP surface of AI conflict resolution.
 *
 * The routes themselves are thin, so what is worth testing here is the SHAPE of the feature:
 * that reading is separate from proposing, that proposing is separate from writing, and that
 * each gate refuses before anything expensive or irreversible happens. The guest gate (this is
 * the one AI route that is owner-only) is exercised where the rest of the share-link adversarial
 * suite lives, in tests/share-gate.test.ts.
 */
import { test, expect } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

// Local mode (no OIDC) → /api/* isn't gated, so the routes are directly reachable.
const localCfg = (extra?: Partial<RepoYetiConfig>): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  ...extra,
});

const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function conflictedRepo(name: string): Promise<{ dir: string; id: string; file: string }> {
  const dir = mkScratchDir(`ry-croute-${name}-`);
  const file = "app.txt";
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config core.autocrlf false`.quiet();
  const commit = async (msg: string) => {
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} ${IDENT} commit -q -m ${msg}`.quiet();
  };
  await Bun.write(join(dir, file), "top\nbase\nbottom\n");
  await commit("base");
  await $`git -C ${dir} checkout -q -b feature`.quiet();
  await Bun.write(join(dir, file), "top\ntheirs\nbottom\n");
  await commit("theirs");
  await $`git -C ${dir} checkout -q main`.quiet();
  await Bun.write(join(dir, file), "top\nours\nbottom\n");
  await commit("ours");
  await $`git -C ${dir} ${IDENT} merge feature`.quiet().nothrow();
  return { dir, id: mustUpsertRepo(dir, `croute-${name}`, "auto", false), file };
}

test("GET /conflicts and /conflict read the merge without touching the repo", async () => {
  const { id, file, dir } = await conflictedRepo("read");
  const app = createApp(localCfg());
  const before = readFileSync(join(dir, file), "utf8");

  const list = await app.request(`/api/repos/${id}/conflicts`);
  expect(list.status).toBe(200);
  const listed = (await list.json()) as { files: Array<{ path: string; hunks: number }> };
  expect(listed.files.some((f) => f.path === file && f.hunks === 1)).toBe(true);

  const read = await app.request(`/api/repos/${id}/conflict?path=${encodeURIComponent(file)}`);
  expect(read.status).toBe(200);
  const body = (await read.json()) as { hash: string; hunks: unknown[]; parsed?: unknown };
  expect(body.hunks).toHaveLength(1);
  expect(body.hash).toBeTruthy();
  // `parsed` is the internal splice representation and must not go over the wire.
  expect(body.parsed).toBeUndefined();

  // Neither read wrote anything.
  expect(readFileSync(join(dir, file), "utf8")).toBe(before);
});

test("GET /conflict distinguishes 'no such file' from 'file with no conflict'", async () => {
  // Two different answers, and the difference matters to the UI: 404 means the path is wrong,
  // 409 means the path is fine and there is simply nothing here to resolve.
  const { id, dir } = await conflictedRepo("notconflict");
  const app = createApp(localCfg());
  await Bun.write(join(dir, "clean.txt"), "no conflict in here\n");

  const missing = await app.request(`/api/repos/${id}/conflict?path=${encodeURIComponent("nope.txt")}`);
  expect(missing.status).toBe(404);

  const clean = await app.request(`/api/repos/${id}/conflict?path=${encodeURIComponent("clean.txt")}`);
  expect(clean.status).toBe(409);
  expect((await clean.json()).code).toBe("NOT_CONFLICTED");
});

test("conflict-resolve refuses before any provider call when no AI provider is configured", async () => {
  const { id, file } = await conflictedRepo("noprovider");
  const res = await post(createApp(localCfg()), `/api/repos/${id}/conflict-resolve`, { path: file });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("NO_AI_PROVIDER");
});

test("conflict-resolve is refused outright when the owner turned the feature off", async () => {
  const { id, file } = await conflictedRepo("disabled");
  const app = createApp(
    localCfg({
      ai: {
        providers: { openai: { apiKey: "owner-key", model: "gpt-test" } },
        defaultProvider: "openai",
        conflictEnabled: false,
      },
    }),
  );
  const res = await post(app, `/api/repos/${id}/conflict-resolve`, { path: file });
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe("FORBIDDEN");
});

test("conflict-apply writes the accepted region and reports what is left", async () => {
  const { id, file, dir } = await conflictedRepo("apply");
  const app = createApp(localCfg());
  const read = await app.request(`/api/repos/${id}/conflict?path=${encodeURIComponent(file)}`);
  const { hash } = (await read.json()) as { hash: string };

  const res = await post(app, `/api/repos/${id}/conflict-apply`, {
    path: file,
    hash,
    accepted: [{ index: 1, content: "ours\ntheirs" }],
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, applied: 1, remaining: 0 });

  const onDisk = readFileSync(join(dir, file), "utf8");
  expect(onDisk).toBe("top\nours\ntheirs\nbottom\n");
  // Still unmerged — the route does not stage, so the merge is not "done".
  expect(await $`git -C ${dir} status --porcelain`.quiet().text()).toContain("UU");
});

test("conflict-apply 409s on a stale hash and leaves the file untouched", async () => {
  const { id, file, dir } = await conflictedRepo("stale");
  const app = createApp(localCfg());
  const before = readFileSync(join(dir, file), "utf8");

  const res = await post(app, `/api/repos/${id}/conflict-apply`, {
    path: file,
    hash: "0".repeat(32),
    accepted: [{ index: 1, content: "merged" }],
  });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("CONFLICT_STALE");
  expect(readFileSync(join(dir, file), "utf8")).toBe(before);
});

test("conflict-apply validates its body before it reaches the working tree", async () => {
  const { id, file } = await conflictedRepo("validate");
  const app = createApp(localCfg());

  const noAccepted = await post(app, `/api/repos/${id}/conflict-apply`, {
    path: file,
    hash: "0".repeat(32),
    accepted: [],
  });
  expect(noAccepted.status).toBe(400);

  const noHash = await post(app, `/api/repos/${id}/conflict-apply`, {
    path: file,
    accepted: [{ index: 1, content: "x" }],
  });
  expect(noHash.status).toBe(400);

  // A region index beyond the engine's own per-file cap can't correspond to anything real.
  const absurdIndex = await post(app, `/api/repos/${id}/conflict-apply`, {
    path: file,
    hash: "0".repeat(32),
    accepted: [{ index: 9_999, content: "x" }],
  });
  expect(absurdIndex.status).toBe(400);
});

test("conflict-apply refuses an oversized body before buffering or parsing it", async () => {
  // The schema alone would let 40 regions × 512 KB through as a ~250 MB request. The bodyLimit
  // middleware is what makes that a 413 at the door rather than memory the daemon has to hold.
  const { id, file } = await conflictedRepo("toobig");
  const res = await post(createApp(localCfg()), `/api/repos/${id}/conflict-apply`, {
    path: file,
    hash: "0".repeat(32),
    accepted: [{ index: 1, content: "x".repeat(2_200_000) }],
  });
  expect(res.status).toBe(413);
});

test("AI settings expose the conflict toggle and the model-tier the UI warns on", async () => {
  const app = createApp(
    localCfg({
      ai: {
        providers: { openai: { apiKey: "owner-key", model: "gpt-4o-mini" } },
        defaultProvider: "openai",
      },
    }),
  );
  const j = (await (await app.request("/api/ai/settings")).json()) as {
    conflictEnabled: boolean;
    modelTier: string | null;
  };
  // Defaults ON, and a `-mini` model is reported as a small tier so the UI can say so.
  expect(j.conflictEnabled).toBe(true);
  expect(j.modelTier).toBe("small");

  // A PUT must answer with the SAME shape the GET did, or the client's store loses the field.
  const put = await app.request("/api/ai/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conflictEnabled: false }),
  });
  const after = (await put.json()) as { conflictEnabled: boolean; modelTier: string | null };
  expect(after.conflictEnabled).toBe(false);
  expect(after.modelTier).toBe("small");
});
