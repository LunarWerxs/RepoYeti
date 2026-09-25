import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoYetiConfig } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";
import { isSecretFileName, windowsPathAlias } from "../src/paths.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

useSuiteTimeout();

// The route-level allow/deny check in src/http/routes/files.ts (fileAccessRefused). Pins the two
// refusals the service layer's confinement cannot make: a Windows alias spelling that names a
// file no later guard inspects, and a secret-shaped name travelling over remote access.
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const REMOTE = { "x-forwarded-for": "203.0.113.7" };

test("windowsPathAlias refuses short names, streams and trailing dots on win32 only", () => {
  // Each of these reaches a file the spelled-path guards never see (`GIT~1` and `.git.` are `.git`).
  for (const p of ["GIT~1/config", "PROGRA~1/x.txt", "src/ABCDEF~12.TS", "notes.txt:hidden", ".git./config", "src/a.ts./b"]) {
    expect(windowsPathAlias(p, "win32")).not.toBeNull();
    expect(windowsPathAlias(p, "linux")).toBeNull();
  }
  for (const p of ["src/app.ts", "docs/v1.2/readme.md", "a~b.txt", "backup~draft.md", ".env", ""]) {
    expect(windowsPathAlias(p, "win32")).toBeNull();
  }
});

test("isSecretFileName matches env files and private keys by their last segment", () => {
  for (const p of [".env", "config/.env.local", ".ENV.production", "certs/server.pem", "tls.key", "id_ed25519", ".git-credentials"]) {
    expect(isSecretFileName(p)).toBe(true);
  }
  for (const p of [".env.example", "id_ed25519.pub", ".env/lib/site.py", "src/env.ts", "keys.ts"]) {
    expect(isSecretFileName(p)).toBe(false);
  }
});

test("GET/PUT /file refuse a secret over remote access and serve it on loopback", async () => {
  const dir = mkScratchDir("gm-access-");
  writeFileSync(join(dir, ".env"), "TOKEN=local-only\n");
  writeFileSync(join(dir, ".env.example"), "TOKEN=\n");
  const id = mustUpsertRepo(dir, "access-guard", "auto", false);
  const app = createApp(localCfg());

  const remote = await app.request(`/api/repos/${id}/file?path=.env`, { headers: REMOTE });
  expect(remote.status).toBe(403);
  expect((await remote.json()).code).toBe("FORBIDDEN");

  const put = await app.request(`/api/repos/${id}/file?path=.env`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...REMOTE },
    body: JSON.stringify({ content: "TOKEN=overwritten\n" }),
  });
  expect(put.status).toBe(403);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe("TOKEN=local-only\n");

  // The shareable template still travels, and the owner at the desk still reads the real file.
  expect((await app.request(`/api/repos/${id}/file?path=.env.example`, { headers: REMOTE })).status).toBe(200);
  const local = await app.request(`/api/repos/${id}/file?path=.env`);
  expect(local.status).toBe(200);
  expect((await local.json()).content).toBe("TOKEN=local-only\n");
});
