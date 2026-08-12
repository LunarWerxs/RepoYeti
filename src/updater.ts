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

export function cleanupStaleUpdateArtifacts(): void {
  if (isCompiledRelease()) cleanupReleaseArtifacts();
}
