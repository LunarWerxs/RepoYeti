/**
 * Orchestration layer between the HTTP routes / watcher and the git plumbing.
 *
 * Everything that touches a repo goes through the per-repo operation queue, so a
 * user-triggered fetch/pull/push can never race the watcher's status read (or each
 * other) on the same repo. After any action we re-read and broadcast status, so the
 * phone sees the result over SSE without polling.
 *
 * This barrel re-exports the focused modules under `src/service/` so external importers
 * keep a single import surface (`./service/index.ts`):
 *   - core        → refresh/runAction/forceRefresh/reorder + ActionOutcome
 *   - watch       → live fs watching, coalesced refresh, refreshAllRepos, watcherHealth
 *   - actions     → mutating VCS actions, fetch-all, discardFile, smartCommitRepo
 *   - repo-mgmt   → discover/forget/register/clone/create
 *   - scan        → on-demand "Scan for projects" (cancellable rescan of all roots)
 *   - reads       → branches/log/commit/stashes/tags/changes/search + AI diff collectors
 *   - files       → file-viewer read/write/diff + diff-patch runtime settings
 *   - editors     → "Open with…" external-editor catalog / detection / launch
 *   - guards      → shared repo-precondition guard
 */
export * from "./core.ts";
export * from "./watch.ts";
export * from "./actions.ts";
export * from "./repo-mgmt.ts";
export * from "./scan.ts";
export * from "./reads.ts";
export * from "./files.ts";
export * from "./editors.ts";
export * from "./guards.ts";
