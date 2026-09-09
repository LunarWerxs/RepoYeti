/** Compiled-distribution updater. It intentionally consumes archives, never the direct .exe. */
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildPingRequest, ensureInstallId, pingDisabled, recordPingResult } from "./app-ping.ts";
import { VERSION, loadConfig } from "./config.ts";
import { readResponseTextLimited } from "./process-output.ts";
import type { UpdateApplyResult, UpdateStatus } from "./updater.ts";

const SERVICE = "repoyeti";
const REPO = "LunarWerxs/RepoYeti";
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
/**
 * Resilience fallback for the update check, used only when the Studio proxy fails (see
 * latestRelease). GitHub's own releases/latest is the right backstop precisely because it is
 * the one URL here that cannot be orphaned by a rename: GitHub redirects both owner and repo
 * renames, so this keeps resolving even if either changes.
 *
 * Why this exists (YTSort, 2026-08): a shipped artifact whose only update URL later stopped
 * resolving left every install silently polling a dead link for six months. Neither the users
 * nor the maintainer got any signal. A single hardcoded update endpoint with no second opinion
 * is that same failure waiting to happen, so this file no longer has one.
 */
const GITHUB_LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * THE TRUST BOUNDARY (1.0 audit, item 3).
 *
 * Release METADATA comes from the Connections Studio proxy (see latestRelease), with GitHub's own
 * API as the fallback. Release BYTES must not: the updater renames what it downloads over the
 * running executable, so "whatever the metadata pointed at" is arbitrary code execution on every
 * installation with auto-update enabled. Until this existed, the proxy's JSON supplied both the
 * archive URL and the checksum-manifest URL, both were fetched from wherever they pointed with
 * redirects followed blindly, and a manifest that agreed with the archive was taken as proof. A
 * checksum from the same untrusted source proves the transfer was intact, not who published it.
 *
 * So the byte sources are pinned to the repository instead of trusted from the metadata:
 *   - an asset is downloaded ONLY from `https://github.com/<REPO>/releases/download/<tag>/<name>`,
 *     with `<tag>` the release's own tag and `<name>` the asset the updater is looking for. Owner,
 *     repository, tag and asset name are all bound; a proxy that lies about the URL is refused
 *     before a single byte is fetched (trustedAssetUrl);
 *   - redirects are followed by hand, and each hop must land on github.com or a
 *     `*.githubusercontent.com` CDN host (trustedRedirectTarget). GitHub serves release assets by
 *     redirecting there; nothing else is a legitimate destination;
 *   - the byte count is bound to the size the release lists, and to an absolute ceiling, and the
 *     SHA-256 is computed over the stream as it lands, so the archive is never held in memory;
 *   - the manifest is fetched FIRST, under the same pinning, and a release with no verifiable
 *     checksum for the asset is refused before the large download starts;
 *   - the release record discovered by the version check is the one staged from (item 19): the
 *     old code checked "latest" for the version and then fetched "latest" again for the assets, so
 *     a release published between the two calls was verified against the wrong tag.
 *
 * What this does NOT claim: it is not a signature over the release. The publisher identity it
 * establishes is "GitHub served this for LunarWerxs/RepoYeti under this tag", which is the trust
 * the release workflow already rests on. A compromise of the repository's own release pipeline
 * is out of scope here.
 *
 * Every transfer and the extractor are bounded in time as well as bytes (item 6): a body that
 * sends headers and never finishes used to hold the global `applying` state forever, deferring
 * later updates and refusing a dashboard restart.
 */
const RELEASE_HOST = "github.com";
const ASSET_CDN_SUFFIX = ".githubusercontent.com";
const MAX_REDIRECTS = 5;
/** Ceilings that no legitimate release approaches: the archives are ~100 MB, the manifest < 1 KB. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
/** A releases/latest document is a few KB; one megabyte is absurd and therefore the ceiling. */
const MAX_METADATA_BYTES = 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const MANIFEST_TIMEOUT_MS = 30_000;
export const EXTRACT_TIMEOUT_MS = 5 * 60_000;
/** `v1.2.3`, `1.2.3`, with an optional pre-release/build suffix. Anything else is not a release
 *  this updater will build a download URL for. */
const TAG_SHAPE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  return `${os}-${arch}`;
}

export function assetForPlatform(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseAsset | null {
  const extension = platform === "win32" ? ".zip" : ".tar.gz";
  const expected = `repoyeti-${releaseTarget(platform, arch)}${extension}`;
  return assets.find((asset) => asset.name === expected) ?? null;
}

function numericVersion(value: string): number[] {
  return value
    .replace(/^v/, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewer(remote: string, local: string): boolean {
  const a = numericVersion(remote);
  const b = numericVersion(local);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function baseStatus(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    ok: true,
    service: SERVICE,
    currentVersion: VERSION,
    currentCommit: null,
    remoteCommit: null,
    branch: null,
    upstream: null,
    remote: RELEASES_PAGE,
    dirty: false,
    updateAvailable: false,
    canApply: false,
    checkedAt: Date.now(),
    reason: null,
    ...overrides,
  };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── trust boundary: pure decisions, exported for tests ─────────────────────────────────────────

/**
 * Is `url` exactly the GitHub release-asset URL for `assetName` on `tag` of THIS repository?
 * `https://github.com/<owner>/<repo>/releases/download/<tag>/<name>` and nothing else: https only,
 * no credentials, no query, no fragment, exactly six path segments, owner/repo compared
 * case-insensitively (GitHub's URLs are), tag and name byte-for-byte.
 */
export function trustedAssetUrl(url: string, tag: string, assetName: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.host !== RELEASE_HOST) return false;
  if (u.username || u.password || u.search || u.hash) return false;
  const parts = u.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 6) return false;
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return false;
  }
  const [owner, repo] = REPO.split("/") as [string, string];
  return (
    decoded[0]!.toLowerCase() === owner.toLowerCase() &&
    decoded[1]!.toLowerCase() === repo.toLowerCase() &&
    decoded[2] === "releases" &&
    decoded[3] === "download" &&
    decoded[4] === tag &&
    decoded[5] === assetName
  );
}

/** May a redirect from an asset download land on `url`? github.com itself, or one of GitHub's
 *  `*.githubusercontent.com` asset hosts, over https, with no credentials. */
export function trustedRedirectTarget(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    return u.host === RELEASE_HOST || u.hostname.endsWith(ASSET_CDN_SUFFIX);
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

/**
 * `fetch` that follows redirects itself, admitting only trusted hops. `redirect: "follow"` would
 * happily land on any host the previous hop named, which is exactly the door a lying metadata
 * source needs; `"manual"` returns the 3xx so each Location can be judged before it is fetched.
 * The initial URL is the caller's responsibility (trustedAssetUrl); this checks every hop after it.
 */
export async function fetchThroughTrustedRedirects(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
  label: string,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new Error(`${label}: redirect without a Location header`);
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new Error(`${label}: redirect to an unparseable location`);
    }
    if (!trustedRedirectTarget(next)) {
      throw new Error(`${label}: refused a redirect off GitHub (${hostOf(next)})`);
    }
    current = next;
  }
  throw new Error(`${label}: too many redirects`);
}

/** A cancellable deadline. Own timer rather than AbortSignal.timeout so it can be cleared the
 *  moment the work is done and never fires into a finished transfer. */
function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Drain a response body through `sink`, bound to the byte count the release lists and to `cap`,
 * and to the deadline. Rejects a body that is longer, shorter, or declares a different length
 * up front. The deadline is raced against every read, because a stalled stream never resolves a
 * read on its own and an aborted fetch is not guaranteed to reject a reader that is already waiting.
 */
async function drainBounded(
  response: Response,
  expectedBytes: number,
  cap: number,
  signal: AbortSignal,
  label: string,
  sink: (chunk: Uint8Array) => void,
): Promise<number> {
  if (!response.body) throw new Error(`${label}: empty response body`);
  if (expectedBytes > cap) throw new Error(`${label}: ${expectedBytes} bytes exceeds the ${cap}-byte ceiling`);
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared !== expectedBytes) {
    throw new Error(`${label}: the server reports ${declared} bytes but the release lists ${expectedBytes}`);
  }
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error(`${label}: aborted`));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => undefined); // the race below is its consumer; a late abort must not be "unhandled"
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value?.byteLength) continue;
      bytes += value.byteLength;
      if (bytes > expectedBytes) {
        throw new Error(`${label}: received more than the ${expectedBytes} bytes the release lists`);
      }
      sink(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  if (bytes !== expectedBytes) throw new Error(`${label}: transfer ended after ${bytes} of ${expectedBytes} bytes`);
  return bytes;
}

// ── metadata discovery ──────────────────────────────────────────────────────────────────────────

/**
 * Shape-check a release record from EITHER metadata source before anything trusts a field of it.
 * A malformed tag would otherwise be interpolated into a download URL; an asset with no size
 * could not be bound. Assets missing any field are dropped rather than failing the whole check,
 * so an unrelated malformed upload cannot block updates.
 */
/** Bounded JSON read of a metadata response (item 14's ceiling applied to the update check). */
async function readMetadata(response: Response): Promise<unknown> {
  const { text, truncated } = await readResponseTextLimited(response, MAX_METADATA_BYTES);
  if (truncated) throw new Error(`release metadata exceeded ${MAX_METADATA_BYTES} bytes`);
  return JSON.parse(text) as unknown;
}

function parseRelease(raw: unknown): Release {
  const r = raw as { tag_name?: unknown; assets?: unknown } | null;
  if (!r || typeof r.tag_name !== "string" || !TAG_SHAPE.test(r.tag_name)) {
    throw new Error("release metadata is malformed (tag)");
  }
  const assets: ReleaseAsset[] = [];
  for (const a of Array.isArray(r.assets) ? r.assets : []) {
    const x = a as { name?: unknown; browser_download_url?: unknown; size?: unknown } | null;
    if (
      x &&
      typeof x.name === "string" &&
      typeof x.browser_download_url === "string" &&
      typeof x.size === "number" &&
      Number.isFinite(x.size) &&
      x.size >= 0
    ) {
      assets.push({ name: x.name, browser_download_url: x.browser_download_url, size: x.size });
    }
  }
  return { tag_name: r.tag_name, assets };
}

/**
 * The Connections Studio app-ping proxy (APP_PING_URL, see src/app-ping.ts): relays GitHub's
 * releases/latest JSON for LunarWerxs/RepoYeti verbatim — identical shape to
 * api.github.com/repos/${REPO}/releases/latest, so every field this file reads is unchanged — and
 * logs one anonymous install-count row per hit (random install id + running version + coarse OS;
 * never an IP or hostname; opt out with REPOYETI_NO_PING=1). This IS the update check: nothing
 * here makes an extra network call for the ping, it just carries a couple of extra headers/query
 * params on the request the app already made. Release *binaries* never come from the proxy: the
 * asset URLs it relays are only honoured when they name the pinned GitHub release location (see
 * the trust-boundary note at the top).
 */
/**
 * Ask GitHub directly after the Studio proxy failed. Carries no install id and no version/os
 * telemetry — this is a plain unauthenticated read, so it stays within GitHub's anonymous rate
 * limit and reveals nothing the primary request would not have.
 *
 * If this fails too, the ORIGINAL failure is what gets reported: the primary endpoint is the
 * one an operator needs to hear about, and surfacing "GitHub said 403" would send them chasing
 * the backstop instead of the thing that actually broke.
 */
async function githubFallbackRelease(
  common: Record<string, string>,
  primaryError: unknown,
  primaryStatus: number | undefined,
): Promise<Release> {
  let fallback: Response;
  try {
    fallback = await fetch(GITHUB_LATEST_API, {
      headers: common,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw primaryError ?? error;
  }
  if (!fallback.ok) {
    if (primaryError) throw primaryError;
    throw new Error(
      `release check returned HTTP ${primaryStatus} (GitHub fallback: HTTP ${fallback.status})`,
    );
  }
  return parseRelease(await readMetadata(fallback));
}

async function latestRelease(): Promise<Release> {
  const disabled = pingDisabled();
  const cfg = loadConfig();
  if (!disabled) ensureInstallId(cfg);
  const { url, headers } = buildPingRequest(cfg);
  const common = { accept: "application/vnd.github+json", "user-agent": `${SERVICE}/${VERSION}` };
  let response: Response | null = null;
  let primaryError: unknown = null;
  try {
    response = await fetch(url, {
      headers: { ...common, ...headers },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    primaryError = error;
  }
  // Ping bookkeeping tracks the PRIMARY attempt only: a fallback that succeeds says nothing
  // about whether Studio received the install-count row, and marking it reported would burn
  // this install's one-time `new=1` on a request Studio never saw.
  if (!disabled) recordPingResult(cfg, !!response?.ok);
  if (response?.ok) return parseRelease(await readMetadata(response));
  return await githubFallbackRelease(common, primaryError, response?.status);
}

let cached: { status: UpdateStatus; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

/**
 * One metadata request, one answer for both the status and the release record. `applyUpdate`
 * stages from the SAME record the version decision was made on (item 19): asking "latest" twice
 * meant a release published between the two calls was downloaded and then verified against the
 * previous tag's version and refused.
 */
async function discover(): Promise<{ status: UpdateStatus; release: Release | null }> {
  try {
    const release = await latestRelease();
    const remoteVersion = release.tag_name.replace(/^v/, "");
    const available = isNewer(remoteVersion, VERSION);
    const asset = available ? assetForPlatform(release.assets) : null;
    const status = baseStatus({
      remoteCommit: release.tag_name,
      updateAvailable: available,
      canApply: available && !!asset,
      reason:
        available && !asset
          ? `v${remoteVersion} is available, but its ${releaseTarget()} archive is missing.`
          : null,
    });
    cached = { status, at: Date.now() };
    return { status, release };
  } catch (error) {
    return {
      status: baseStatus({ ok: false, reason: `couldn't check for updates (${describe(error)}).` }),
      release: null,
    };
  }
}

export async function checkForUpdate(options: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  return (await discover()).status;
}

// ── staging: download, verify, extract ──────────────────────────────────────────────────────────

/** Run a command to completion within `timeoutMs`; a child that overruns is killed and reported
 *  as a failure rather than left holding the update in `applying` forever. */
export function runBounded(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} did not finish within ${Math.round(timeoutMs / 1000)} s`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code ?? "null"}`));
    });
  });
}

async function extract(
  archive: string,
  destination: string,
  platform: NodeJS.Platform,
  timeoutMs: number,
): Promise<void> {
  if (platform === "win32") {
    await runBounded(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        // `$ErrorActionPreference = 'Stop'`: a cmdlet error is otherwise NON-terminating and
        // PowerShell exits 0, so a corrupt archive "extracted" successfully and the only signal
        // was the later "archive has no repoyeti.exe". Make the failure the failure.
        `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
      ],
      timeoutMs,
    );
  } else {
    await runBounded("tar", ["-xzf", archive, "-C", destination], timeoutMs);
  }
}

/** The release asset holding the per-file SHA-256 manifest (produced by .github/workflows/release.yml). */
const CHECKSUM_ASSET = "SHA256SUMS.txt";

interface StagingOptions {
  downloadTimeoutMs: number;
  manifestTimeoutMs: number;
  extractTimeoutMs: number;
  platform: NodeJS.Platform;
}

type ChecksumLookup = { ok: true; hash: string } | { ok: false; message: string };

/**
 * The SHA-256 the release publishes for `assetName`, read from the pinned manifest location.
 *
 * `SHA256SUMS.txt` is `sha256sum` output — "<64 hex>  <name>", two spaces — built in the release
 * workflow across every uploaded artifact. Fetched BEFORE the archive: a release that cannot be
 * verified is refused without downloading it. Fail-closed throughout: a missing manifest, a
 * manifest that does not list the asset, an oversized or off-GitHub manifest all mean there is
 * nothing to trust the archive against, and "install it anyway" is the behaviour being removed.
 */
async function publishedChecksum(release: Release, assetName: string, opts: StagingOptions): Promise<ChecksumLookup> {
  const manifest = release.assets.find((a) => a.name === CHECKSUM_ASSET);
  if (!manifest) {
    return { ok: false, message: `${release.tag_name} publishes no ${CHECKSUM_ASSET}, so the download cannot be verified` };
  }
  if (!trustedAssetUrl(manifest.browser_download_url, release.tag_name, CHECKSUM_ASSET)) {
    return {
      ok: false,
      message: `refusing to read ${CHECKSUM_ASSET}: its URL is not the ${REPO} release asset for ${release.tag_name}`,
    };
  }
  const label = `download ${CHECKSUM_ASSET}`;
  const dl = deadline(opts.manifestTimeoutMs);
  try {
    const response = await fetchThroughTrustedRedirects(
      manifest.browser_download_url,
      { headers: { accept: "text/plain", "user-agent": `${SERVICE}/${VERSION}` }, signal: dl.signal },
      label,
    );
    if (!response.ok) return { ok: false, message: `${label} failed (HTTP ${response.status})` };
    const chunks: Uint8Array[] = [];
    await drainBounded(response, manifest.size, MAX_MANIFEST_BYTES, dl.signal, label, (c) => chunks.push(c));
    const text = Buffer.concat(chunks).toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
      if (m && basename(m[2]!) === assetName) return { ok: true, hash: m[1]!.toLowerCase() };
    }
    return { ok: false, message: `${CHECKSUM_ASSET} for ${release.tag_name} does not list ${assetName}` };
  } catch (e) {
    return { ok: false, message: `${label}: ${describe(dl.signal.aborted ? dl.signal.reason : e)}` };
  } finally {
    dl.clear();
  }
}

function verifyVersion(executable: string, expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(executable, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 15_000);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.trim().replace(/^v/, "") === expected.replace(/^v/, ""));
    });
  });
}

function moveInto(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch {
    cpSync(source, destination);
    rmSync(source, { force: true });
  }
}

function failure(message: string): UpdateApplyResult {
  return {
    ok: false,
    message,
    restartRequired: false,
    status: baseStatus({ ok: false, reason: message }),
    output: [],
  };
}

type AssetDownloadResult =
  | { ok: true; archive: string; actualHash: string }
  | { ok: false; message: string };

/**
 * Download one release asset into `staging` from its PINNED location and verify it against
 * `expectedHash` as it streams in. The hash is computed over the bytes as they land and the file
 * is never read back whole; the byte count is bound to what the release lists; the transfer has a
 * deadline. A failure leaves nothing behind in `staging`.
 *
 * Until the checksum existed, the only check on a downloaded binary was verifyVersion() — running
 * it and seeing whether it printed the expected version string. Anything that prints that string
 * passes, so the check told you the file was the right VERSION and nothing at all about whether it
 * was the right FILE. The caller then renames it over the running executable. The checksum fixed
 * the FILE question; the pinning above fixes WHOSE file.
 */
export async function downloadAssetVerified(
  release: Release,
  asset: ReleaseAsset,
  staging: string,
  expectedHash: string,
  opts: Pick<StagingOptions, "downloadTimeoutMs">,
): Promise<AssetDownloadResult> {
  const label = `download ${asset.name}`;
  if (!trustedAssetUrl(asset.browser_download_url, release.tag_name, asset.name)) {
    return {
      ok: false,
      message: `refusing to download ${asset.name}: its URL is not the ${REPO} release asset for ${release.tag_name}`,
    };
  }
  if (!(asset.size > 0)) return { ok: false, message: `release metadata lists no size for ${asset.name}` };
  const archive = join(staging, asset.name);
  const dl = deadline(opts.downloadTimeoutMs);
  try {
    const response = await fetchThroughTrustedRedirects(
      asset.browser_download_url,
      { headers: { accept: "application/octet-stream", "user-agent": `${SERVICE}/${VERSION}` }, signal: dl.signal },
      label,
    );
    if (!response.ok) return { ok: false, message: `${label} failed (HTTP ${response.status})` };
    const hasher = new Bun.CryptoHasher("sha256");
    const sink = Bun.file(archive).writer();
    try {
      await drainBounded(response, asset.size, MAX_ARCHIVE_BYTES, dl.signal, label, (chunk) => {
        hasher.update(chunk);
        sink.write(chunk);
      });
    } finally {
      await sink.end();
    }
    const actualHash = hasher.digest("hex").toLowerCase();
    if (actualHash !== expectedHash) {
      rmSync(archive, { force: true });
      return {
        ok: false,
        message: `the downloaded ${asset.name} does not match the checksum published for ${release.tag_name}`,
      };
    }
    return { ok: true, archive, actualHash };
  } catch (e) {
    rmSync(archive, { force: true });
    return { ok: false, message: `${label}: ${describe(dl.signal.aborted ? dl.signal.reason : e)}` };
  } finally {
    dl.clear();
  }
}

// Verify (manifest first), download, and extract the update archive into `staging`. Returns the
// candidate executable's path once its checksum and version self-check both pass.
async function stageUpdateCandidate(
  release: Release,
  asset: ReleaseAsset,
  staging: string,
  remoteVersion: string,
  bundledName: string,
  opts: StagingOptions,
): Promise<{ ok: true; candidate: string; output: string[] } | { ok: false; message: string }> {
  const output: string[] = [];
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const checksum = await publishedChecksum(release, asset.name, opts);
  if (!checksum.ok) return { ok: false, message: checksum.message };
  output.push(`downloading ${asset.name} (${Math.round(asset.size / 1048576)} MB)`);
  const downloaded = await downloadAssetVerified(release, asset, staging, checksum.hash, opts);
  if (!downloaded.ok) return { ok: false, message: downloaded.message };
  const { archive, actualHash } = downloaded;
  output.push(`verified sha256 ${actualHash.slice(0, 12)}…`);

  await extract(archive, staging, opts.platform, opts.extractTimeoutMs);

  const candidate = join(staging, bundledName);
  if (!existsSync(candidate)) return { ok: false, message: `the update archive has no ${bundledName}` };
  if (!(await verifyVersion(candidate, remoteVersion))) {
    return { ok: false, message: "the downloaded executable failed its version self-check" };
  }
  return { ok: true, candidate, output };
}

// Progress markers for the binary swap below, visible to the catch block in `applyUpdate` so a
// failure partway through the dance can be rolled back from wherever it actually got to.
interface SwapProgress {
  movedAside: boolean;
  parkedPath: string | null;
}

// Park the new binary in the INSTALL directory first, then do the two renames back to back.
//
// The swap has to be move-aside-then-move-in (Windows will rename a running .exe but never
// overwrite one), so there is unavoidably an instant with nothing at `executable`. What was
// avoidable was its LENGTH: `moveInto` falls back to a full `cpSync` when source and
// destination are on different volumes, and the staging dir is a subdirectory of the install
// dir but the extracted candidate need not share its volume in every deployment. That put a
// whole file copy inside the window. Parking first makes both steps same-directory metadata
// operations with no I/O between them, which is as narrow as this can be made — and it
// matters because the tray's Quit is a `taskkill /T /F` that can land at any moment.
async function swapInUpdatedExecutable(
  candidate: string,
  installDir: string,
  executable: string,
  oldExecutable: string,
  checkedAt: number,
  platform: NodeJS.Platform,
  progress: SwapProgress,
): Promise<void> {
  const parked = join(installDir, `.${basename(executable)}.new-${checkedAt}`);
  rmSync(parked, { force: true });
  moveInto(candidate, parked);
  progress.parkedPath = parked;
  renameSync(executable, oldExecutable);
  progress.movedAside = true;
  renameSync(parked, executable);
  progress.parkedPath = null;
  if (platform !== "win32") {
    try {
      await runBounded("chmod", ["+x", executable], 30_000);
    } catch {}
  }
}

// Undo whatever the swap got through before it threw: restore the old binary if it was already
// moved aside, and drop a parked binary that never made it into place.
function rollbackFailedSwap(progress: SwapProgress, executable: string, oldExecutable: string): void {
  if (progress.movedAside && existsSync(oldExecutable)) {
    try {
      rmSync(executable, { force: true });
      renameSync(oldExecutable, executable);
    } catch {}
  }
  // A parked binary that never got renamed into place is dead weight sitting in the install
  // directory; drop it rather than leave a mystery file beside the executable.
  if (progress.parkedPath) {
    try {
      rmSync(progress.parkedPath, { force: true });
    } catch {}
  }
}

/** Seams for tests. Production callers pass nothing: the running executable, this platform, the
 *  default deadlines. */
export interface ApplyUpdateOptions {
  executable?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  downloadTimeoutMs?: number;
  manifestTimeoutMs?: number;
  extractTimeoutMs?: number;
}

export async function applyUpdate(options: ApplyUpdateOptions = {}): Promise<UpdateApplyResult> {
  // ONE discovery: the record the version decision is made on is the record staged from.
  const { status, release } = await discover();
  if (!status.ok || !release) return failure(status.reason ?? "update check failed");
  if (!status.updateAvailable) return failure("already up to date");
  const remoteVersion = release.tag_name.replace(/^v/, "");
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = assetForPlatform(release.assets, platform, arch);
  if (!asset) return failure(`no ${releaseTarget(platform, arch)} archive is attached to ${release.tag_name}`);

  const executable = options.executable ?? process.execPath;
  const installDir = dirname(executable);
  const staging = join(installDir, ".update-staging");
  const oldExecutable = join(installDir, `${basename(executable)}.old-${status.checkedAt}`);
  const bundledName = platform === "win32" ? "repoyeti.exe" : "repoyeti";
  const progress: SwapProgress = { movedAside: false, parkedPath: null };
  const stagingOptions: StagingOptions = {
    downloadTimeoutMs: options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    manifestTimeoutMs: options.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS,
    extractTimeoutMs: options.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS,
    platform,
  };

  try {
    const staged = await stageUpdateCandidate(release, asset, staging, remoteVersion, bundledName, stagingOptions);
    if (!staged.ok) {
      rmSync(staging, { recursive: true, force: true });
      return failure(staged.message);
    }
    const { candidate, output } = staged;

    await swapInUpdatedExecutable(candidate, installDir, executable, oldExecutable, status.checkedAt, platform, progress);

    rmSync(staging, { recursive: true, force: true });
    cached = null;
    output.push(`installed v${remoteVersion}`);
    return {
      ok: true,
      message: `Updated to v${remoteVersion}. Restarting…`,
      restartRequired: true,
      status: baseStatus({ currentVersion: remoteVersion }),
      output,
    };
  } catch (error) {
    rollbackFailedSwap(progress, executable, oldExecutable);
    rmSync(staging, { recursive: true, force: true });
    return failure(`update failed: ${describe(error)}`);
  }
}

export function cleanupStaleUpdateArtifacts(): void {
  try {
    const installDir = dirname(process.execPath);
    const executableName = basename(process.execPath);
    rmSync(join(installDir, ".update-staging"), { recursive: true, force: true });
    for (const name of readdirSync(installDir)) {
      // `<exe>.old-*` is the previous binary; `.<exe>.new-*` is a candidate that was parked for
      // the swap and never renamed in (a kill between the two renames). Both are stale once this
      // process is running from the canonical name again.
      if (name.startsWith(`${executableName}.old-`) || name.startsWith(`.${executableName}.new-`)) {
        rmSync(join(installDir, name), { force: true });
      }
    }
  } catch {}
}
