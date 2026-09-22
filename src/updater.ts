import { resolve } from "node:path";
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
const gitEngine = createUpdater({
  appRoot: resolve(import.meta.dir, ".."),
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

export function checkForUpdate(): Promise<UpdateStatus> {
  return isCompiledRelease()
    ? (checkReleaseUpdate() as Promise<UpdateStatus>)
    : (gitEngine.checkForUpdate() as Promise<UpdateStatus>);
}

export function applyUpdate(): Promise<UpdateApplyResult> {
  return isCompiledRelease()
    ? (applyReleaseUpdate() as Promise<UpdateApplyResult>)
    : (gitEngine.applyUpdate() as Promise<UpdateApplyResult>);
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
