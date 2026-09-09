import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyUpdate,
  assetForPlatform,
  checkForUpdate,
  fetchThroughTrustedRedirects,
  isNewer,
  releaseTarget,
  runBounded,
  trustedAssetUrl,
  trustedRedirectTarget,
} from "../src/github-updater.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// runBounded and the extraction step spawn real processes.
useSuiteTimeout();

const direct = {
  name: "repoyeti-windows-x64.exe",
  browser_download_url: "https://example.test/direct",
  size: 100,
};
const archive = {
  name: "repoyeti-windows-x64.zip",
  browser_download_url: "https://example.test/archive",
  size: 40,
};

test("compiled updater selects the Windows archive regardless of direct-exe upload order", () => {
  expect(assetForPlatform([direct, archive], "win32", "x64")).toEqual(archive);
  expect(assetForPlatform([archive, direct], "win32", "x64")).toEqual(archive);
});

test("compiled updater uses the public release target names", () => {
  expect(releaseTarget("win32", "x64")).toBe("windows-x64");
  expect(releaseTarget("darwin", "arm64")).toBe("macos-arm64");
  expect(releaseTarget("linux", "x64")).toBe("linux-x64");
});

test("release versions compare as numeric semver triples", () => {
  expect(isNewer("v0.14.1", "0.14.0")).toBe(true);
  expect(isNewer("0.14.0", "0.14.0")).toBe(false);
  expect(isNewer("0.13.9", "0.14.0")).toBe(false);
});

/**
 * The update check must survive its primary endpoint going away.
 *
 * This is the YTSort failure (2026-08) in a different shape: an artifact shipped with a single
 * baked-in update URL, that URL later stops resolving, and every install polls a dead link
 * forever with nothing surfaced to the user or the maintainer. One hardcoded endpoint and no
 * second opinion is that bug waiting to happen, so a Studio failure must fall through to
 * GitHub's own releases API — the one URL that survives an owner or repo rename.
 */
test("a failing Studio proxy falls back to GitHub instead of stranding the install", async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.includes("studio.connections.icu")) {
      return new Response("gone", { status: 503 });
    }
    return new Response(JSON.stringify({ tag_name: "v999.0.0", assets: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const status = await checkForUpdate({ fresh: true });
    expect(seen.some((u) => u.includes("studio.connections.icu"))).toBe(true);
    expect(seen.some((u) => u.includes("api.github.com"))).toBe(true);
    expect(status.updateAvailable).toBe(true);
    expect(status.remoteCommit).toBe("v999.0.0");
  } finally {
    globalThis.fetch = real;
  }
});

test("both endpoints down reports the primary failure, not the backstop's", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("primary is unreachable");
  }) as unknown as typeof fetch;
  try {
    const status = await checkForUpdate({ fresh: true });
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("primary is unreachable");
  } finally {
    globalThis.fetch = real;
  }
});

// ── the trust boundary (1.0 audit, item 3), transfer bounds (item 6), single discovery (item 19) ──
//
// The metadata source (the Studio proxy) is not the byte source. Before these tests existed the
// proxy's JSON named the archive URL and the manifest URL, both were fetched from wherever they
// pointed with redirects followed, and an archive matching a manifest from the same place counted
// as verified — so a wrong or compromised proxy answer was a binary renamed over the running
// executable. Everything below drives applyUpdate() through a fake fetch (the same seam the
// fallback tests above use) with a scratch "install dir", so nothing real is downloaded or swapped.

const TAG = "v999.0.0";
const BASE = `https://github.com/LunarWerxs/RepoYeti/releases/download/${TAG}`;
const ZIP = "repoyeti-windows-x64.zip";
const zipBytes = new TextEncoder().encode("PK: not a real archive, but bytes are bytes and hashes are hashes");
const zipSha = new Bun.CryptoHasher("sha256").update(zipBytes).digest("hex");
const manifestBytes = new TextEncoder().encode(`${zipSha}  ${ZIP}\n`);

interface ReleaseOverrides {
  zipUrl?: string;
  zipSize?: number;
  manifestUrl?: string;
  manifest?: boolean;
}
function release(o: ReleaseOverrides = {}) {
  const assets = [{ name: ZIP, browser_download_url: o.zipUrl ?? `${BASE}/${ZIP}`, size: o.zipSize ?? zipBytes.byteLength }];
  if (o.manifest !== false) {
    assets.push({
      name: "SHA256SUMS.txt",
      browser_download_url: o.manifestUrl ?? `${BASE}/SHA256SUMS.txt`,
      size: manifestBytes.byteLength,
    });
  }
  return { tag_name: TAG, assets };
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const bytes = (b: Uint8Array<ArrayBuffer>) => new Response(b, { status: 200 });
const isMetadata = (url: string) => url.includes("studio.connections.icu") || url.includes("api.github.com");

/** Install a fake fetch for the duration of `fn`, recording every URL requested. */
async function withFetch(
  handler: (url: string) => Response | Promise<Response>,
  fn: (seen: string[]) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    return handler(url);
  }) as typeof fetch;
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

/** A scratch install dir + short deadlines. `platform: "win32"` picks the .zip asset on every host;
 *  extraction (never reached by the refusals below) would run powershell. */
function applyOpts() {
  const dir = mkScratchDir("gm-updater-");
  return {
    executable: join(dir, "repoyeti.exe"),
    platform: "win32" as const,
    arch: "x64",
    downloadTimeoutMs: 3_000,
    manifestTimeoutMs: 3_000,
    extractTimeoutMs: 15_000,
  };
}

test("trustedAssetUrl binds owner, repository, tag and asset name, and nothing else passes", () => {
  expect(trustedAssetUrl(`${BASE}/${ZIP}`, TAG, ZIP)).toBe(true);
  // GitHub's URLs are case-insensitive for owner/repo; the tag and asset name are exact.
  expect(trustedAssetUrl(`https://github.com/lunarwerxs/repoyeti/releases/download/${TAG}/${ZIP}`, TAG, ZIP)).toBe(true);
  for (const bad of [
    `http://github.com/LunarWerxs/RepoYeti/releases/download/${TAG}/${ZIP}`, // not https
    `https://github.com/Someone/RepoYeti/releases/download/${TAG}/${ZIP}`, // another owner
    `https://github.com/LunarWerxs/Other/releases/download/${TAG}/${ZIP}`, // another repo
    `https://github.com/LunarWerxs/RepoYeti/releases/download/v0.1.0/${ZIP}`, // another tag
    `https://github.com/LunarWerxs/RepoYeti/releases/download/${TAG}/evil.zip`, // another asset
    `https://github.com.evil.example/LunarWerxs/RepoYeti/releases/download/${TAG}/${ZIP}`,
    `https://evil.example/github.com/LunarWerxs/RepoYeti/releases/download/${TAG}/${ZIP}`,
    `https://user:pw@github.com/LunarWerxs/RepoYeti/releases/download/${TAG}/${ZIP}`,
    `${BASE}/${ZIP}?x=1`,
    `${BASE}/${ZIP}#frag`,
    `${BASE}/${ZIP}/extra`,
    `${BASE}/..%2F${ZIP}`,
    "not a url",
  ]) {
    expect(trustedAssetUrl(bad, TAG, ZIP)).toBe(false);
  }
});

test("trustedRedirectTarget admits github.com and GitHub's asset CDN hosts only", () => {
  expect(trustedRedirectTarget("https://objects.githubusercontent.com/github-production-release-asset/x")).toBe(true);
  expect(trustedRedirectTarget("https://release-assets.githubusercontent.com/x")).toBe(true);
  expect(trustedRedirectTarget(`${BASE}/${ZIP}`)).toBe(true);
  for (const bad of [
    "https://evil.example/x",
    "http://objects.githubusercontent.com/x", // not https
    "https://githubusercontent.com.evil.example/x",
    "https://evilgithubusercontent.com/x", // suffix match must be on a dot boundary
    "https://user:pw@objects.githubusercontent.com/x",
    "nope",
  ]) {
    expect(trustedRedirectTarget(bad)).toBe(false);
  }
});

test("redirects are followed by hand: an off-GitHub hop is refused (real fetch, local server)", async () => {
  // This one deliberately uses the REAL fetch against a local server, to prove the runtime's
  // `redirect: "manual"` returns the 3xx rather than following it. Had it followed, the failure
  // would be a DNS error for evil.example, not the refusal asserted here.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(null, { status: 302, headers: { location: "https://evil.example/repoyeti.zip" } }),
  });
  try {
    const controller = new AbortController();
    await expect(
      fetchThroughTrustedRedirects(
        `http://127.0.0.1:${server.port}/asset`,
        { headers: {}, signal: controller.signal },
        "download",
      ),
    ).rejects.toThrow(/refused a redirect off GitHub \(evil\.example\)/);
  } finally {
    server.stop(true);
  }
});

test("applyUpdate refuses an archive whose URL is not the pinned release location, without fetching it", async () => {
  const foreign = "https://cdn.evil.example/repoyeti-windows-x64.zip";
  await withFetch(
    (url) => {
      if (isMetadata(url)) return json(release({ zipUrl: foreign }));
      if (url.endsWith("/SHA256SUMS.txt")) return bytes(manifestBytes);
      return new Response("must not be fetched", { status: 200 });
    },
    async (seen) => {
      const opts = applyOpts();
      const r = await applyUpdate(opts);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("not the LunarWerxs/RepoYeti release asset");
      expect(seen.some((u) => u.startsWith(foreign))).toBe(false);
      expect(existsSync(join(dirname(opts.executable), ".update-staging"))).toBe(false);
    },
  );
});

test("the checksum manifest is pinned too, and read BEFORE the archive is ever requested", async () => {
  await withFetch(
    (url) => (isMetadata(url) ? json(release({ manifestUrl: "https://cdn.evil.example/SHA256SUMS.txt" })) : bytes(zipBytes)),
    async (seen) => {
      const r = await applyUpdate(applyOpts());
      expect(r.ok).toBe(false);
      expect(r.message).toContain("refusing to read SHA256SUMS.txt");
      expect(seen.some((u) => u.endsWith(`/${ZIP}`))).toBe(false);
    },
  );
  await withFetch(
    (url) => (isMetadata(url) ? json(release({ manifest: false })) : bytes(zipBytes)),
    async (seen) => {
      const r = await applyUpdate(applyOpts());
      expect(r.ok).toBe(false);
      expect(r.message).toContain("publishes no SHA256SUMS.txt");
      expect(seen.some((u) => u.endsWith(`/${ZIP}`))).toBe(false);
    },
  );
});

test("a redirect off GitHub during the archive download is refused; one onto GitHub's CDN is followed", async () => {
  const cdn = "https://objects.githubusercontent.com/github-production-release-asset/abc";
  await withFetch(
    (url) => {
      if (isMetadata(url)) return json(release());
      if (url.endsWith("/SHA256SUMS.txt")) return bytes(manifestBytes);
      if (url === `${BASE}/${ZIP}`) {
        return new Response(null, { status: 302, headers: { location: "https://cdn.evil.example/x.zip" } });
      }
      return new Response("must not be fetched", { status: 200 });
    },
    async (seen) => {
      const r = await applyUpdate(applyOpts());
      expect(r.ok).toBe(false);
      expect(r.message).toContain("refused a redirect off GitHub (cdn.evil.example)");
      expect(seen.some((u) => u.includes("cdn.evil.example"))).toBe(false);
    },
  );
  await withFetch(
    (url) => {
      if (isMetadata(url)) return json(release());
      if (url.endsWith("/SHA256SUMS.txt")) return bytes(manifestBytes);
      if (url === `${BASE}/${ZIP}`) return new Response(null, { status: 302, headers: { location: cdn } });
      if (url === cdn) return bytes(zipBytes);
      return new Response("?", { status: 404 });
    },
    async (seen) => {
      const r = await applyUpdate(applyOpts());
      expect(seen).toContain(cdn);
      // Download + checksum passed; the bytes are not a real archive, so the failure is the
      // EXTRACTION step, which only runs after verification. That prefix is the proof.
      expect(r.ok).toBe(false);
      // "update failed: …" is the extraction step (powershell exiting non-zero here, ENOENT on a
      // host without it); "has no repoyeti.exe" is the post-extraction check. Either is past
      // verification, which is the property under test.
      expect(r.message).toMatch(/^update failed: |^the update archive has no repoyeti\.exe$/);
    },
  );
});

test("the byte count is bound to what the release lists: longer, shorter, or a different declared length is refused", async () => {
  const cases: Array<{ body: Uint8Array<ArrayBuffer>; size?: number; expect: RegExp }> = [
    { body: new Uint8Array(zipBytes.byteLength + 1), expect: /received more than|the server reports/ },
    { body: zipBytes.slice(0, 5), expect: /transfer ended after|the server reports/ },
  ];
  for (const c of cases) {
    await withFetch(
      (url) => {
        if (isMetadata(url)) return json(release({ zipSize: c.size }));
        if (url.endsWith("/SHA256SUMS.txt")) return bytes(manifestBytes);
        return bytes(c.body);
      },
      async () => {
        const opts = applyOpts();
        const r = await applyUpdate(opts);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(c.expect);
        expect(existsSync(join(dirname(opts.executable), ".update-staging"))).toBe(false);
      },
    );
  }
});

test("an archive that does not match the published checksum is refused after the stream is hashed", async () => {
  const other = new Uint8Array(zipBytes.byteLength).fill(0x41);
  await withFetch(
    (url) => {
      if (isMetadata(url)) return json(release());
      if (url.endsWith("/SHA256SUMS.txt")) return bytes(manifestBytes);
      return bytes(other);
    },
    async () => {
      const r = await applyUpdate(applyOpts());
      expect(r.ok).toBe(false);
      expect(r.message).toContain("does not match the checksum published");
    },
  );
});

test("a body that sends headers and never finishes is cut off by the deadline, not held forever", async () => {
  // This used to hold the global `applying` state indefinitely (auto-update.ts), deferring every
  // later update and refusing the dashboard's restart.
  await withFetch(
    (url) => {
      if (isMetadata(url)) return json(release({ zipSize: 1_000 }));
      if (url.endsWith("/SHA256SUMS.txt")) return bytes(manifestBytes);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(10)); // and then nothing, ever
          },
        }),
        { status: 200 },
      );
    },
    async () => {
      const started = Date.now();
      const r = await applyUpdate({ ...applyOpts(), downloadTimeoutMs: 400 });
      expect(r.ok).toBe(false);
      expect(r.message).toContain("timed out");
      expect(Date.now() - started).toBeLessThan(10_000);
    },
  );
});

test("apply stages from the release record the check returned: one metadata request, not two", async () => {
  // A second discovery would see a release published in between and verify its archive against
  // the first release's version — the audit's item 19. Here the second answer is deliberately a
  // different release with no assets; if it were consulted the apply would fail on "no archive".
  let metadataCalls = 0;
  await withFetch(
    (url) => {
      if (isMetadata(url)) {
        metadataCalls++;
        return json(metadataCalls === 1 ? release() : { tag_name: "v999.0.1", assets: [] });
      }
      if (url.endsWith("/SHA256SUMS.txt")) return bytes(manifestBytes);
      if (url === `${BASE}/${ZIP}`) return bytes(zipBytes);
      return new Response("?", { status: 404 });
    },
    async (seen) => {
      const r = await applyUpdate(applyOpts());
      expect(metadataCalls).toBe(1);
      expect(seen).toContain(`${BASE}/${ZIP}`);
      expect(r.ok).toBe(false);
      // "update failed: …" is the extraction step (powershell exiting non-zero here, ENOENT on a
      // host without it); "has no repoyeti.exe" is the post-extraction check. Either is past
      // verification, which is the property under test.
      expect(r.message).toMatch(/^update failed: |^the update archive has no repoyeti\.exe$/); // past verification, into extraction
    },
  );
});

test("malformed release metadata is refused rather than interpolated into a download URL", async () => {
  await withFetch(
    () => json({ tag_name: "../../evil", assets: [] }),
    async () => {
      const status = await checkForUpdate({ fresh: true });
      expect(status.ok).toBe(false);
      expect(status.reason).toContain("malformed");
    },
  );
});

test("runBounded kills a child that overruns its deadline", async () => {
  const started = Date.now();
  await expect(runBounded(process.execPath, ["-e", "await Bun.sleep(30000)"], 400)).rejects.toThrow(
    /did not finish within/,
  );
  expect(Date.now() - started).toBeLessThan(10_000);
});
