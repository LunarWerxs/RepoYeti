/**
 * Cloudflare Artifacts remotes: which repo token a git operation gets, and how the owner's
 * Cloudflare API token is kept (src/artifacts.ts, routes/artifacts.ts).
 *
 * Every case drives a real boundary: a real git repo whose remote is an Artifacts URL, the HTTP
 * route, and a stand-in for Cloudflare's token API at the fetch layer (the only thing faked). The
 * contracts are security and cost ones:
 *   - a fetch gets a READ token and a push a WRITE token. Measured live on 2026-10-05: Artifacts
 *     refuses a push made with a read token (403), so the scope is what keeps a fetch from writing;
 *   - the token is bound to the remote's own artifacts host, even when the repo carries a GitHub
 *     pin, and a lookalike host gets nothing;
 *   - an API answer that would add lines to git's credential protocol is refused;
 *   - a repo token is reused until near expiry (Artifacts bills per operation, and the background
 *     sync fetches every five minutes), and clearing the API token stops the very next operation;
 *   - the API token never comes back out of the daemon.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";
import { mkScratchDir } from "./helpers/scratch.ts";
import { createApp } from "../src/http/app.ts";
import { authForRepo, authForCloneUrl } from "../src/gh-account.ts";
import { forgetArtifactsCredentials } from "../src/artifacts.ts";
import { credentialConfigArgs } from "../src/git.ts";
import { classify } from "../src/git-actions/sync.ts";
import type { RepoView } from "../src/db.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HOST = `${ACCOUNT}.artifacts.cloudflare.net`;
const REMOTE = `https://${HOST}/git/team/app.git`;
const API_TOKEN = "cfut_test_0123456789abcdefghijkl";
const MINT_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/artifacts/namespaces/team/tokens`;

interface MintCall {
  url: string;
  authorization: string | null;
  body: { repo: string; scope: string; ttl: number };
}

let calls: MintCall[] = [];
/** What the stand-in Cloudflare API answers to the n-th mint (1-based). */
let answer: (n: number, scope: string) => Response;
const realFetch = globalThis.fetch;
const savedEnv = {
  mem: process.env.REPOYETI_KEYCHAIN_MEMORY,
  svc: process.env.REPOYETI_KEYCHAIN_SERVICE,
};

/** A token shaped like the live API's (art_v2_x_<40 hex>), expiring `ttlS` from now. */
const minted = (n: number, scope: string, ttlS = 3600): Response =>
  Response.json(
    {
      success: true,
      errors: [],
      messages: [],
      result: {
        id: `tok${n}`,
        plaintext: `art_v2_x_${n.toString(16).padStart(40, "0")}?expires=${Math.floor(Date.now() / 1000) + ttlS}`,
        scope,
        expires_at: new Date(Date.now() + ttlS * 1000).toISOString(),
      },
    },
    { status: 201 },
  );

beforeEach(() => {
  calls = [];
  answer = minted;
  process.env.REPOYETI_KEYCHAIN_MEMORY = "1";
  process.env.REPOYETI_KEYCHAIN_SERVICE = `repoyeti-artifacts-test-${process.pid}`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.cloudflare.com/")) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as MintCall["body"];
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization"), body });
    return answer(calls.length, body.scope);
  }) as typeof fetch;
  forgetArtifactsCredentials();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  forgetArtifactsCredentials();
  for (const [key, val] of [
    ["REPOYETI_KEYCHAIN_MEMORY", savedEnv.mem],
    ["REPOYETI_KEYCHAIN_SERVICE", savedEnv.svc],
  ] as const) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

const app = (): ReturnType<typeof createApp> =>
  createApp({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 } as RepoYetiConfig);

async function putToken(token: string): Promise<{ status: number; text: string }> {
  const res = await app().request("/api/artifacts", {
    method: "PUT",
    body: JSON.stringify({ token }),
    headers: { "content-type": "application/json" },
  });
  return { status: res.status, text: await res.text() };
}

/** A real repo whose origin is an Artifacts remote, pinned to a GitHub account on purpose. */
async function artifactsRepo(): Promise<RepoView> {
  const dir = join(mkScratchDir("ry-artifacts-"), "repo");
  await $`git init -q ${dir}`.quiet();
  await $`git -C ${dir} remote add origin ${REMOTE}`.quiet();
  return {
    id: "r1",
    name: "repo",
    absPath: dir,
    vcs: "git",
    syncAccountHost: "github.com",
    syncAccountLogin: "lunawerx",
  } as unknown as RepoView;
}

test("a fetch gets a read token and a push a write token, bound to the remote's own host", async () => {
  expect((await putToken(API_TOKEN)).status).toBe(200);
  const repo = await artifactsRepo();

  const read = await authForRepo(repo, "read");
  // The GitHub pin is not consulted: the credential belongs to the artifacts host, not github.com.
  expect(read?.host).toBe(HOST);
  expect(read?.token).toBe(`art_v2_x_${"1".padStart(40, "0")}`); // the secret, without ?expires=
  expect(calls[0]).toEqual({
    url: MINT_URL,
    authorization: `Bearer ${API_TOKEN}`,
    body: { repo: "app", scope: "read", ttl: 3600 },
  });
  // git consults the helper only for this host, so the token cannot be offered to any other.
  expect(credentialConfigArgs(read)[3]?.startsWith(`credential.https://${HOST}.helper=`)).toBe(true);

  const write = await authForRepo(repo, "write");
  expect(calls[1]?.body.scope).toBe("write");
  expect(write?.token).not.toBe(read?.token);

  // A clone reads, so it gets a read token too.
  forgetArtifactsCredentials();
  await authForCloneUrl(REMOTE);
  expect(calls[2]?.body.scope).toBe("read");
});

test("a lookalike host or a non-https remote never gets a token minted for it", async () => {
  await putToken(API_TOKEN);
  for (const url of [
    `https://${HOST}.evil.example/git/team/app.git`,
    `https://evil.example/${HOST}/git/team/app.git`,
    `http://${HOST}/git/team/app.git`,
    `https://${HOST}/git/team/app.git/extra`,
    `https://${HOST}/git/team/../app.git`,
  ]) {
    expect(await authForCloneUrl(url)).toBeNull();
  }
  expect(calls).toHaveLength(0);
});

test("a repo token is reused until ten minutes before expiry, and a push's token never serves a fetch", async () => {
  await putToken(API_TOKEN);
  const repo = await artifactsRepo();

  await authForRepo(repo, "write");
  await authForRepo(repo, "write");
  expect(calls).toHaveLength(1);
  // The fetch that follows a push gets its own read token, not the push-capable one.
  await authForRepo(repo, "read");
  expect(calls.map((c) => c.body.scope)).toEqual(["write", "read"]);

  // A token with five minutes left is too close to expiry for a slow push: mint a fresh one.
  forgetArtifactsCredentials();
  answer = (n, scope) => minted(n, scope, 300);
  await authForRepo(repo, "read");
  await authForRepo(repo, "read");
  expect(calls).toHaveLength(4);
});

test("an API answer that is not a plain token, or an API refusal, yields no credential", async () => {
  await putToken(API_TOKEN);
  const repo = await artifactsRepo();

  // A newline in the secret would let the answer write extra lines into git's credential protocol.
  answer = () =>
    Response.json({ success: true, result: { plaintext: "art_v2_x_abc\nusername=evil?expires=9999999999" } });
  expect(await authForRepo(repo, "read")).toBeNull();

  answer = () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
  expect(await authForRepo(repo, "read")).toBeNull();
});

test("clearing the token in Settings stops the next operation at once, cached repo token included", async () => {
  const saved = await putToken(API_TOKEN);
  expect(saved.text).not.toContain(API_TOKEN);
  expect(JSON.parse(saved.text)).toEqual({ ok: true, configured: true });
  const status = await app().request("/api/artifacts");
  expect(await status.text()).not.toContain(API_TOKEN);

  const repo = await artifactsRepo();
  expect(await authForRepo(repo, "read")).not.toBeNull();

  expect(JSON.parse((await putToken("")).text)).toEqual({ ok: true, configured: false });
  expect(await authForRepo(repo, "read")).toBeNull();
  expect(calls).toHaveLength(1); // nothing was minted after the clear, and the cached token was dropped
});

test("Artifacts auth failures are reported as Artifacts, not as a GitHub account or an SSH key", () => {
  // Both stderr lines are verbatim from a live Artifacts remote (2026-10-05).
  const noToken = classify(
    new Error(`fatal: could not read Username for 'https://${HOST}': terminal prompts disabled`),
  );
  expect(noToken.code).toBe("ARTIFACTS_NOT_AUTHORIZED");
  const refused = classify(
    new Error(
      `remote: Insufficient permissions\nfatal: unable to access '${REMOTE}/': The requested URL returned error: 403`,
    ),
  );
  expect(refused.code).toBe("ARTIFACTS_NOT_AUTHORIZED");
  // A diverged branch on an Artifacts remote is still a divergence, not an auth problem.
  expect(
    classify(new Error(`To ${REMOTE}\n ! [rejected] main -> main (non-fast-forward)`)).code,
  ).toBe("NON_FAST_FORWARD");
});
