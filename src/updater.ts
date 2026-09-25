import { resolve } from "node:path";
import { gitFor } from "./git.ts";
import {
  applyUpdate as applyReleaseUpdate,
  checkForUpdate as checkReleaseUpdate,
  cleanupStaleUpdateArtifacts as cleanupReleaseArtifacts,
} from "./github-updater.ts";
import { createUpdater } from "./updater-engine.mjs";

export interface UpdateStatus {
  ok: boolean;
  service: "repoyeti";
  currentVersion: string;
  currentCommit: string | null;
  remoteCommit: string | null;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  dirty: boolean;
  updateAvailable: boolean;
  canApply: boolean;
  checkedAt: number;
  reason: string | null;
  /** Source checkouts only (updater-engine.mjs): the remote branch an apply would pull. */
  remoteBranch?: string | null;
  /** Source checkouts only: a newer remote commit exists but HEAD is not its ancestor, so a
   *  fast-forward cannot apply it; `canApply` is false and `reason` explains. */
  diverged?: boolean;
  /** When the offered update was made, epoch ms: the remote commit's committer time on a source
   *  checkout, the release's `published_at` on a compiled build. Null or absent when unknown. The
   *  auto-update cooldown (src/auto-update.ts) reads it and treats unknown as too young. */
  remoteDate?: number | null;
}

/** Options an unattended apply passes (src/auto-update.ts). A manual apply passes none. */
export interface UpdateApplyOptions {
  /** Update cooldown: refuse to install anything made after this instant (epoch ms). The apply
   *  re-reads the remote, so this pins it to what the timer judged old enough rather than to
   *  whatever was published in the seconds since. */
  notNewerThan?: number;
}

export interface UpdateApplyResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
  status: UpdateStatus;
  output: string[];
}

// Thin per-app adapter over the shared kit updater engine (synced in as
// updater-engine.mjs). All the git / spawn / ls-remote / apply logic lives there;
// only RepoYeti's checkout root, update-remote env var, install/build commands, and
// service identity are local. The engine's UpdateStatus.service is `string`; it is
// narrowed back to the "repoyeti" literal here (the runtime value already is).
const APP_ROOT = resolve(import.meta.dir, "..");
const gitEngine = createUpdater({
  appRoot: APP_ROOT,
  serviceName: "repoyeti",
  appLabel: "RepoYeti",
  updateRepoEnvVar: "REPOYETI_UPDATE_REPO",
  // `bun install` at the root does NOT reach web/: there is no `workspaces` field in package.json,
  // so the dashboard is a separate package with its own lockfile. A plain root install therefore
  // left web/node_modules on the PREVIOUS commit's dependencies, and `buildCmd` below either built
  // the dashboard against stale deps or failed outright — which is how a source install could pull
  // new code and keep serving the old PWA (issue #16). Both installs run as one script so the
  // engine's rollback path, which re-runs installCmd for the previous commit, gets the fix too.
  installCmd: ["bun", "run", "install:all"],
  buildCmd: ["bun", "run", "--cwd", "web", "build"],
});

function isCompiledRelease(): boolean {
  return (
    (globalThis as { __REPOYETI_RELEASE_BUILD__?: boolean }).__REPOYETI_RELEASE_BUILD__ === true
  );
}

/**
 * The committer time of `sha` in epoch ms, or null. Read here rather than in the shared kit engine
 * because only RepoYeti's update cooldown needs it. The object is local by now: the engine's check
 * fetched the remote branch into FETCH_HEAD to prove the fast-forward before calling it an update.
 * Committer time is set by whoever made the commit, so a push that lies about its date can slip
 * the cooldown; a release's `published_at` is set by GitHub and cannot.
 */
async function commitTime(sha: string): Promise<number | null> {
  try {
    const secs = Number.parseInt((await gitFor(APP_ROOT).raw(["log", "-1", "--format=%ct", sha])).trim(), 10);
    return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
  } catch {
    return null;
  }
}

async function checkSourceUpdate(): Promise<UpdateStatus> {
  const status = (await gitEngine.checkForUpdate()) as UpdateStatus;
  if (status.updateAvailable && status.remoteCommit) status.remoteDate = await commitTime(status.remoteCommit);
  return status;
}

export function checkForUpdate(): Promise<UpdateStatus> {
  return isCompiledRelease() ? (checkReleaseUpdate() as Promise<UpdateStatus>) : checkSourceUpdate();
}

export async function applyUpdate(options: UpdateApplyOptions = {}): Promise<UpdateApplyResult> {
  if (isCompiledRelease()) {
    return (await applyReleaseUpdate({ notNewerThan: options.notNewerThan })) as UpdateApplyResult;
  }
  if (options.notNewerThan !== undefined) {
    // The engine pulls the remote tip as it finds it, so re-check the tip's age just before
    // handing over: a push since the timer's check has had no cooldown at all.
    const status = await checkSourceUpdate();
    if (status.updateAvailable && !(status.remoteDate != null && status.remoteDate <= options.notNewerThan)) {
      return {
        ok: false,
        message: "The newest remote commit is younger than the update cooldown.",
        restartRequired: false,
        status,
        output: [],
      };
    }
  }
  return (await gitEngine.applyUpdate()) as UpdateApplyResult;
}

/** Most characters of transcript a failure hands back. A build log can be long, and the failing
 *  step is the LAST entry, so the cap drops from the front. */
const TRANSCRIPT_MAX_CHARS = 64_000;

/**
 * The step transcript a failed apply carries. The kit engine attaches `output` to its rejection
 * (RepoYeti issue #24: it used to reach a caller only on success, so a failure reported one line and
 * lost the build output that explained it). The compiled-release path records no steps, so it has
 * none and this returns an empty list.
 */
export function failedUpdateTranscript(e: unknown): string[] {
  const output = (e as { output?: unknown } | null | undefined)?.output;
  if (!Array.isArray(output)) return [];
  const kept: string[] = [];
  let total = 0;
  for (let i = output.length - 1; i >= 0; i--) {
    const entry = output[i];
    if (typeof entry !== "string") continue;
    const clipped = entry.length > TRANSCRIPT_MAX_CHARS ? `…${entry.slice(-TRANSCRIPT_MAX_CHARS)}` : entry;
    if (kept.length && total + clipped.length > TRANSCRIPT_MAX_CHARS) break;
    kept.unshift(clipped);
    total += clipped.length;
  }
  return kept;
}

/** Log a failed update with its transcript, so an unattended failure, which has no toast at all,
 *  still leaves the whole reason in the daemon log. Returns the transcript for the caller. */
export function logUpdateFailure(e: unknown): string[] {
  const message = e instanceof Error ? e.message : String(e);
  const transcript = failedUpdateTranscript(e);
  const detail = transcript.length ? `\n${transcript.join("\n")}` : "";
  console.error(`[repoyeti] update failed: ${message}${detail}`);
  return transcript;
}

export function cleanupStaleUpdateArtifacts(): void {
  if (isCompiledRelease()) cleanupReleaseArtifacts();
}
