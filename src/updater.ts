import { resolve } from "node:path";
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
const engine = createUpdater({
  appRoot: resolve(import.meta.dir, ".."),
  serviceName: "repoyeti",
  appLabel: "RepoYeti",
  updateRepoEnvVar: "REPOYETI_UPDATE_REPO",
  installCmd: ["bun", "install"],
  buildCmd: ["bun", "run", "--cwd", "web", "build"],
});

export const checkForUpdate = engine.checkForUpdate as () => Promise<UpdateStatus>;
export const applyUpdate = engine.applyUpdate as () => Promise<UpdateApplyResult>;
