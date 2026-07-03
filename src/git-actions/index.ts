/**
 * Safe remote git actions — fetch / pull / push — with the non-negotiable guards:
 *  - The daemon NEVER leaves a repo half-merged. Pull is fast-forward-only and is
 *    refused outright on a dirty tree or detached HEAD ("resolve at your desk").
 *  - Push is never `--force`. A non-fast-forward push is reported, not forced.
 *  - Every failure maps to a stable, first-class error code the UI can render.
 *
 * Auth + author identity are injected per operation (`-c core.sshCommand` + `-c user.*`)
 * via git.ts — global/repo config is never mutated.
 *
 * This module is split by concern across sibling files (barrel pattern):
 *  - ./sync.ts   — fetch / pull / push / clone + the shared error classifier
 *  - ./commit.ts — whole-tree commit (+ amend), the smart-commit group executor, discard
 *  - ./diff.ts   — bounded diff/status/grep collection for the AI + file-viewer + search
 *  - ./refs.ts   — remotes, tags, branches, stash
 * This file re-exports the complete public surface so existing
 * `from "./git-actions.ts"` / `from "./git-actions/index.ts"` imports keep working.
 */
// The result envelope + code now live in contract.ts (the contract layer) so the VCS
// abstraction can depend on them without importing this git module. Re-exported here for
// back-compat — service.ts and the vcs backends still import them from git-actions.ts.
export type {
  ActionResult,
  ActionCode,
  CommitGroupSpec,
  CommitGroupResult,
  CommitGroupsResult,
} from "../contract.ts";

export { gitFetch, gitPullFfOnly, gitPush, gitClone } from "./sync.ts";
export { gitCommitAll, gitCommitGroups, gitDiscardFile } from "./commit.ts";
export {
  collectCommitDiff,
  collectPathsDiff,
  isNoisyPath,
  collectCommitPlanInput,
  fileDiffPatch,
  grepChangedContent,
} from "./diff.ts";
export {
  gitRemoteSet,
  gitRemoteRemove,
  gitTagCreate,
  isValidBranchName,
  gitCheckout,
  gitCreateBranch,
  gitDeleteBranch,
  gitStashSave,
  gitStashPop,
  gitStashDrop,
} from "./refs.ts";
