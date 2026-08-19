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

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
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

/**
 * The Connections Studio app-ping proxy (APP_PING_URL, see src/app-ping.ts): relays GitHub's
 * releases/latest JSON for LunarWerxs/RepoYeti verbatim — identical shape to
 * api.github.com/repos/${REPO}/releases/latest, so every field this file reads is unchanged — and
 * logs one anonymous install-count row per hit (random install id + running version + coarse OS;
 * never an IP or hostname; opt out with REPOYETI_NO_PING=1). This IS the update check: nothing
 * here makes an extra network call for the ping, it just carries a couple of extra headers/query
 * params on the request the app already made. Release *binaries* still download straight from
 * GitHub via the asset URLs the payload carries (trustedAssetUrl below still pins github.com).
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
  return (await fallback.json()) as Release;
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
  if (response?.ok) return (await response.json()) as Release;
  return await githubFallbackRelease(common, primaryError, response?.status);
}

let cached: { status: UpdateStatus; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export async function checkForUpdate(options: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  try {
    const release = await latestRelease();
    const remoteVersion = release.tag_name?.replace(/^v/, "") ?? "";
    const available = !!remoteVersion && isNewer(remoteVersion, VERSION);
    const asset = available ? assetForPlatform(release.assets ?? []) : null;
    const status = baseStatus({
      remoteCommit: release.tag_name ?? null,
      updateAvailable: available,
      canApply: available && !!asset,
      reason:
        available && !asset
          ? `v${remoteVersion} is available, but its ${releaseTarget()} archive is missing.`
          : null,
    });
    cached = { status, at: Date.now() };
    return status;
  } catch (error) {
    return baseStatus({
      ok: false,
      reason: `couldn't check for updates (${error instanceof Error ? error.message : String(error)}).`,
    });
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? "null"}`)),
    );
  });
}

async function extract(archive: string, destination: string): Promise<void> {
  if (process.platform === "win32") {
    await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
    ]);
  } else {
    await run("tar", ["-xzf", archive, "-C", destination]);
  }
}

/** The release asset holding the per-file SHA-256 manifest (produced by .github/workflows/release.yml). */
const CHECKSUM_ASSET = "SHA256SUMS.txt";

/**
 * The SHA-256 the release publishes for `assetName`, or null if the manifest doesn't cover it.
 *
 * `SHA256SUMS.txt` is `sha256sum` output — "<64 hex>  <name>", two spaces — built in the release
 * workflow across every uploaded artifact. It has always been attached to the release; nothing
 * ever read it.
 */
async function publishedChecksum(assets: ReleaseAsset[], assetName: string): Promise<string | null> {
  const manifest = assets.find((a) => a.name === CHECKSUM_ASSET);
  if (!manifest) return null;
  const response = await fetch(manifest.browser_download_url, {
    headers: { accept: "text/plain", "user-agent": `${SERVICE}/${VERSION}` },
    redirect: "follow",
  });
  if (!response.ok) return null;
  for (const line of (await response.text()).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && basename(m[2]!) === assetName) return m[1]!.toLowerCase();
  }
  return null;
}

/** SHA-256 of a file on disk, lowercase hex. */
async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return hasher.digest("hex").toLowerCase();
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

export async function applyUpdate(): Promise<UpdateApplyResult> {
  const status = await checkForUpdate({ fresh: true });
  if (!status.ok) return failure(status.reason ?? "update check failed");
  if (!status.updateAvailable) return failure("already up to date");
  const remoteVersion = (status.remoteCommit ?? "").replace(/^v/, "");

  let assets: ReleaseAsset[] = [];
  let asset: ReleaseAsset | null = null;
  try {
    assets = (await latestRelease()).assets ?? [];
    asset = assetForPlatform(assets);
  } catch {}
  if (!asset) return failure(`no ${releaseTarget()} archive is attached to v${remoteVersion}`);

  const executable = process.execPath;
  const installDir = dirname(executable);
  const staging = join(installDir, ".update-staging");
  const oldExecutable = join(installDir, `${basename(executable)}.old-${status.checkedAt}`);
  const bundledName = process.platform === "win32" ? "repoyeti.exe" : "repoyeti";
  const output: string[] = [];
  let movedAside = false;
  let parkedPath: string | null = null;

  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const archive = join(staging, asset.name);
    output.push(`downloading ${asset.name} (${Math.round(asset.size / 1048576)} MB)`);
    const response = await fetch(asset.browser_download_url, {
      headers: { accept: "application/octet-stream", "user-agent": `${SERVICE}/${VERSION}` },
      redirect: "follow",
    });
    if (!response.ok) return failure(`download failed (HTTP ${response.status})`);
    await Bun.write(archive, response);

    // Verify the archive against the release's published SHA-256 BEFORE unpacking it, and fail
    // closed if there is nothing to verify against.
    //
    // Until now the only check on a downloaded binary was verifyVersion() below — running it and
    // seeing whether it printed the expected version string. Anything that prints that string
    // passes, so the check tells you the file is the right VERSION and nothing at all about
    // whether it is the right FILE. This code then renames it over the running executable, which
    // makes "whatever was served at browser_download_url" arbitrary code execution on every
    // installation with auto-update enabled.
    //
    // Fail-closed is deliberate. A missing manifest means we cannot tell a good archive from a
    // bad one, and "install it anyway" is the exact behavior being removed. Every release the
    // current workflow builds attaches SHA256SUMS.txt, so the only thing this refuses is an
    // update we have no way to trust.
    const expectedHash = await publishedChecksum(assets, asset.name);
    if (!expectedHash) {
      return failure(`v${remoteVersion} publishes no ${CHECKSUM_ASSET}, so the download cannot be verified`);
    }
    const actualHash = await sha256File(archive);
    if (actualHash !== expectedHash) {
      return failure(`the downloaded ${asset.name} does not match the checksum published for v${remoteVersion}`);
    }
    output.push(`verified sha256 ${actualHash.slice(0, 12)}…`);

    await extract(archive, staging);

    const candidate = join(staging, bundledName);
    if (!existsSync(candidate)) return failure(`the update archive has no ${bundledName}`);
    if (!(await verifyVersion(candidate, remoteVersion))) {
      return failure("the downloaded executable failed its version self-check");
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
    const parked = join(installDir, `.${basename(executable)}.new-${status.checkedAt}`);
    rmSync(parked, { force: true });
    moveInto(candidate, parked);
    parkedPath = parked;
    renameSync(executable, oldExecutable);
    movedAside = true;
    renameSync(parked, executable);
    parkedPath = null;
    if (process.platform !== "win32") {
      try {
        await run("chmod", ["+x", executable]);
      } catch {}
    }
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
    if (movedAside && existsSync(oldExecutable)) {
      try {
        rmSync(executable, { force: true });
        renameSync(oldExecutable, executable);
      } catch {}
    }
    // A parked binary that never got renamed into place is dead weight sitting in the install
    // directory; drop it rather than leave a mystery file beside the executable.
    if (parkedPath) {
      try {
        rmSync(parkedPath, { force: true });
      } catch {}
    }
    return failure(`update failed: ${error instanceof Error ? error.message : String(error)}`);
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
