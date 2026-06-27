/**
 * Read a repo's current state via the system git binary (simple-git).
 *
 * One `git status` call gives branch, ahead/behind, and the dirty file set; a
 * second cheap call resolves the remote URL. A 30s block timeout guards against
 * a hung child (e.g. an SSH key prompt). `behind` reflects the last fetch only —
 * we never fetch here, so a watch event never touches the network.
 */
import { gitFor } from "./git.ts";
import type { RepoStatus } from "./db.ts";

export async function readStatus(absPath: string): Promise<RepoStatus> {
  const updatedAt = Date.now();
  try {
    const git = gitFor(absPath);
    const status = await git.status();

    let remote: string | null = null;
    try {
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin") ?? remotes[0];
      remote = origin?.refs?.fetch || origin?.refs?.push || null;
    } catch {
      /* no remotes configured */
    }

    const detached = Boolean(status.detached) || status.current === "HEAD" || status.current === null;
    return {
      branch: status.current ?? null,
      detached,
      dirty: status.files.length,
      ahead: status.ahead ?? 0,
      behind: status.behind ?? 0,
      remote,
      error: null,
      fetchedAt: null,
      updatedAt,
    };
  } catch (err) {
    return {
      branch: null,
      detached: false,
      dirty: 0,
      ahead: 0,
      behind: 0,
      remote: null,
      error: err instanceof Error ? err.message : String(err),
      fetchedAt: null,
      updatedAt,
    };
  }
}
