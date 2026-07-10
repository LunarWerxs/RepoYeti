/**
 * Git backend — a thin adapter over the existing, verified git plumbing.
 *
 * This file introduces NO new behavior: every method delegates straight to the functions
 * that have always driven repoyeti (status.ts, git-actions.ts, inspect.ts). Its only job is to
 * prove the VcsBackend contract is satisfiable by the real git code (a compile-time check)
 * and to give service.ts a single object to call once it stops importing git functions
 * directly. Because the signatures were designed to mirror these functions, the mapping is
 * 1:1.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readStatus, readChanges } from "../read/status.ts";
import {
  gitFetch,
  gitPullFfOnly,
  gitPush,
  gitCommitAll,
  gitCheckout,
  gitCreateBranch,
  gitDeleteBranch,
  gitStashSave,
  gitStashPop,
  gitStashDrop,
  fileDiffPatch,
  gitDiscardFile,
  collectCommitDiff,
  collectPathsDiff,
  gitCommitGroups,
  grepChangedContent,
} from "../git-actions.ts";
import { readBranches, readLog, readStashes, readCommit } from "../read/inspect.ts";
import type { VcsBackend, FilePatchResult } from "./types.ts";

export const gitBackend: VcsBackend = {
  kind: "git",
  marker: ".git",
  capabilities: { stash: true, fetch: true, multipleRemotes: true, fileModels: true },

  detect: (absPath) => existsSync(join(absPath, ".git")),

  readStatus,
  readChanges,

  fetch: gitFetch,
  pull: gitPullFfOnly,
  push: gitPush,
  commitAll: gitCommitAll,

  listBranches: readBranches,
  checkout: gitCheckout,
  createBranch: gitCreateBranch,
  deleteBranch: gitDeleteBranch,

  readLog,
  readCommit,

  readStashes,
  stashSave: gitStashSave,
  stashPop: gitStashPop,
  stashDrop: gitStashDrop,

  async filePatch(absPath, relPath): Promise<FilePatchResult> {
    try {
      const { patch, truncated } = await fileDiffPatch(absPath, relPath);
      return { ok: true, patch, truncated };
    } catch (e) {
      return { ok: false, patch: "", truncated: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
  discardFile: gitDiscardFile,

  collectAiDiff: (absPath, paths) =>
    paths?.length ? collectPathsDiff(absPath, paths) : collectCommitDiff(absPath),
  commitGroups: gitCommitGroups,
  searchContent: grepChangedContent,
};
