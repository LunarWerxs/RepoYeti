import type { RepoYetiConfig } from "../config.ts";
/** Shared state handed to every route module's register(). */
export interface Deps {
  cfg: RepoYetiConfig;
  requestShutdown?: () => void;
}
