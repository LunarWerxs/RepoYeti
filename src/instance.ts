/**
 * Running-instance pointer — thin per-app adapter over the shared kit factory
 * (`createInstancePointer`, synced in as `./instance-pointer.mjs`). The only local
 * code is RepoYeti's config-dir resolution (which honours REPOYETI_HOME via
 * CONFIG_DIR) plus its service/host identity. The daemon records the port it
 * ACTUALLY bound in `<CONFIG_DIR>/runtime.json` so launchers and the /api/health
 * probe can find it and enforce single-instance. Best-effort throughout.
 */
import { CONFIG_DIR } from "./config.ts";
import { createInstancePointer, type InstanceInfo } from "./instance-pointer.mjs";

export type { InstanceInfo };

const pointer = createInstancePointer({
  configDir: CONFIG_DIR,
  serviceName: "repoyeti",
  host: "127.0.0.1",
});

export const instanceFilePath = pointer.instanceFilePath;
export const writeInstanceInfo = pointer.writeInstanceInfo;
export const readInstanceInfo = pointer.readInstanceInfo;
export const clearInstanceInfo = pointer.clearInstanceInfo;
export const findLiveInstance = pointer.findLiveInstance;
