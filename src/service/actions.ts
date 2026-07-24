/**
 * Mutating VCS actions, each funnelled through `runAction` (core.ts) so it goes behind the
 * per-repo op-queue and re-broadcasts status afterward. Plus the bulk fetch-all helper.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getWatchableRepos } from "../db.ts";
import { enqueue } from "../opqueue.ts";
import { resolveRepoIdentity, enforceIdentityPolicy } from "../identity.ts";
import { backendFor } from "../vcs/index.ts";
import {
  gitRemoteSet,
  gitRemoteRemove,
  gitTagCreate,
  type ActionCode,
  type CommitGroupSpec,
  type CommitGroupResult,
} from "../git-actions.ts";
import type { ActionResult } from "../contract.ts";
import { runAction, refreshRepo, accountAuthFor, type ActionOutcome } from "./core.ts";
import { guardRepo } from "./guards.ts";
import { resolveRepoPath } from "./files.ts";
import { normalizeRelPath } from "../paths.ts";
import { collaborationFingerprint } from "../collaboration.ts";

export const fetchRepo = (id: string): Promise<ActionOutcome> => runAction(id, (b, p, idn, auth) => b.fetch(p, idn, auth), true, true);
export const pullRepo = (id: string): Promise<ActionOutcome> => runAction(id, (b, p, idn, auth) => b.pull(p, idn, auth), true, true);
export const pushRepo = (id: string): Promise<ActionOutcome> => runAction(id, (b, p, idn, auth) => b.push(p, idn, auth), false, true);
export const commitRepo = (
  id: string,
  message: string,
  amend = false,
): Promise<ActionOutcome> =>
  runAction(id, (b, p, idn) => b.commitAll(p, idn, message, amend));

/**
 * Commit only if the exact collaboration fingerprint observed by a remote peer is still current.
 * The comparison and staging/commit share one queue slot, closing the observation→commit race.
 */
export const commitRepoWithFingerprint = (
  id: string,
  message: string,
  expectedFingerprint: string,
): Promise<ActionOutcome> =>
  runAction(
    id,
    (b, p, idn) => b.commitAll(p, idn, message, false),
    false,
    false,
    async () => {
      const current = await collaborationFingerprint(id);
      if (!current.complete || current.fingerprint !== expectedFingerprint) {
        return {
          ok: false,
          code: "PLAN_STALE",
          message: "the working tree changed after the collaboration safety check; review it again before committing",
        };
      }
      return null;
    },
  );

// ── branch actions (switch / create / delete) ─────────────────────────────────────
export const checkoutRepo = (id: string, branch: string): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.checkout(p, branch));
export const createBranchRepo = (id: string, name: string, switchTo = true): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.createBranch(p, name, switchTo));
export const deleteBranchRepo = (id: string, name: string): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.deleteBranch(p, name));

// ── stash actions (save / pop / drop) ─────────────────────────────────────────────
export const stashSaveRepo = (id: string, message?: string): Promise<ActionOutcome> =>
  runAction(id, (b, p, idn) => b.stashSave(p, idn, message));
export const stashPopRepo = (id: string, index = 0): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.stashPop(p, index));
export const stashDropRepo = (id: string, index = 0): Promise<ActionOutcome> =>
  runAction(id, (b, p) => b.stashDrop(p, index));

// ── remote actions (set-url / remove origin) ──────────────────────────────────────
// Local `.git/config` edits (no network). runAction refreshes status after, so the card's
// remote URL + the cloud icon update over SSE immediately.
export const setRemoteRepo = (id: string, name: string, url: string): Promise<ActionOutcome> =>
  runAction(id, (_b, p) => gitRemoteSet(p, name, url));
export const removeRemoteRepo = (id: string, name: string): Promise<ActionOutcome> =>
  runAction(id, (_b, p) => gitRemoteRemove(p, name));

// ── tag creation (git-only; the route guards on repo.vcs) ──────────────────────────
export const createTagRepo = (
  id: string,
  name: string,
  message?: string,
  push = false,
): Promise<ActionOutcome> =>
  runAction(id, (_b, p, idn) => gitTagCreate(p, idn, name, message, push));

// ── bulk fetch-all ────────────────────────────────────────────────────────────────
export interface FetchAllResult {
  /** Repos that had a remote and were attempted. */
  total: number;
  /** How many fetched cleanly. */
  ok: number;
  /** Per-repo failures (so the UI can name them). */
  failed: Array<{ id: string; name: string; code: string }>;
}

/**
 * Fetch every repo that has a remote. Each goes through `fetchRepo` → the per-repo op-queue
 * and the network gate (`netGate`, default 4 concurrent), so firing them all at once stays
 * bounded — no new concurrency logic needed. Repos with no remote are skipped (not failures).
 */
export async function fetchAllRepos(): Promise<FetchAllResult> {
  const repos = getWatchableRepos().filter((r) => r.status?.remote);
  const results = await Promise.allSettled(repos.map((r) => fetchRepo(r.id)));
  const failed: FetchAllResult["failed"] = [];
  let ok = 0;
  results.forEach((res, i) => {
    if (res.status === "fulfilled" && res.value.ok) ok++;
    else {
      const code = res.status === "fulfilled" ? res.value.code : "ERROR";
      failed.push({ id: repos[i]!.id, name: repos[i]!.name, code });
    }
  });
  return { total: repos.length, ok, failed };
}

/** Result of discarding one file's working-tree changes (the changes-tree "Discard" action). */
export interface DiscardResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "DISCARD_FAILED" | "SUBMODULE_NOT_ACTIONABLE";
  message?: string;
  /** Repo-relative path that was discarded (normalised to forward slashes). */
  path?: string;
}

/**
 * Discard one changed file's working-tree changes — the inverse of the file editor.
 * Untrusted-path safe (confined to the repo exactly like readFileContent), behind the
 * per-repo op-queue, and DESTRUCTIVE — the UI gates it behind an explicit confirm.
 *
 * Three cases, all "restore this file to its committed/absent state":
 *  - tracked in HEAD (modified or deleted) → `git checkout HEAD -- <path>` restores it.
 *  - added/untracked (not in HEAD)         → remove the working file + unstage any add.
 * HEAD is never touched and no merge state is possible, so the safety invariant holds.
 */
export async function discardFile(repoId: string, relPath: string): Promise<DiscardResult> {
  const g = guardRepo<"SUBMODULE_NOT_ACTIONABLE">(repoId, "SUBMODULE_NOT_ACTIONABLE");
  if (g.fail) return g.fail;
  const repo = g.repo;
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  const backend = backendFor(repo.vcs);
  // Never reach into the VCS marker dir (.git / .lore) — restoring its internals is nonsense/unsafe.
  if (r.clean.split("/").includes(backend.marker)) {
    return { ok: false, code: "ERROR", message: `refusing to touch a ${backend.marker} directory` };
  }
  const result = await enqueue(repoId, () => backend.discardFile(repo.absPath, r.clean));
  // Refresh AFTER the queue slot releases (refreshRepo enqueues again → would deadlock if nested).
  if (result.ok) {
    await refreshRepo(repo.id, repo.absPath);
    return { ok: true, code: "OK", path: r.clean };
  }
  return { ok: false, code: result.code === "ERROR" ? "ERROR" : "DISCARD_FAILED", message: result.message };
}

/** Result of staging one file's working-tree change (the changes-tree "Stage" action). */
export interface StageResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "STAGE_FAILED" | "SUBMODULE_NOT_ACTIONABLE";
  message?: string;
  /** Repo-relative path that was staged (normalised to forward slashes). */
  path?: string;
}

/**
 * Stage ONE changed file's working-tree change into the index — a GitHub-Desktop-style per-file
 * "Stage" action, the non-destructive counterpart to discardFile. Untrusted-path safe (confined
 * to the repo exactly like discardFile), behind the per-repo op-queue. Purely additive to the
 * index; never commits and never touches HEAD, so it's safe even if the selection is stale (an
 * already-staged or since-reverted path is just a no-op `git add`/`lore stage`).
 */
export async function stageFile(repoId: string, relPath: string): Promise<StageResult> {
  const g = guardRepo<"SUBMODULE_NOT_ACTIONABLE">(repoId, "SUBMODULE_NOT_ACTIONABLE");
  if (g.fail) return g.fail;
  const repo = g.repo;
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  const backend = backendFor(repo.vcs);
  // Never reach into the VCS marker dir (.git / .lore) — staging its internals is nonsense/unsafe.
  if (r.clean.split("/").includes(backend.marker)) {
    return { ok: false, code: "ERROR", message: `refusing to touch a ${backend.marker} directory` };
  }
  const result = await enqueue(repoId, () => backend.stageFile(repo.absPath, r.clean));
  // Refresh AFTER the queue slot releases (refreshRepo enqueues again → would deadlock if nested).
  if (result.ok) {
    await refreshRepo(repo.id, repo.absPath);
    return { ok: true, code: "OK", path: r.clean };
  }
  return { ok: false, code: result.code === "ERROR" ? "ERROR" : "STAGE_FAILED", message: result.message };
}

/** Result of appending a path to the repo's .gitignore (the changes-tree "Add to .gitignore"). */
export interface GitignoreResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "SUBMODULE_NOT_ACTIONABLE" | "UNSUPPORTED";
  message?: string;
  /** The .gitignore pattern that was written (or found already present). */
  pattern?: string;
  /** True when the pattern was already ignored — a no-op, still reported as ok. */
  alreadyIgnored?: boolean;
}

/**
 * Append a repo-relative path to the repo's root .gitignore — the changes-tree "Add to .gitignore"
 * action. Untrusted-path safe (confined to the repo like discard/stage) and behind the per-repo
 * op-queue. Idempotent: if the exact pattern is already present it's a no-op. The pattern is
 * anchored to the repo root (leading slash) and written with forward slashes so it means exactly
 * this path on every platform. .gitignore only makes sense for git backends (Lore is refused).
 *
 * Note this only EDITS .gitignore — it does not `git rm --cached` an already-tracked file (git
 * ignores .gitignore for tracked paths). Untracked files vanish from the changes list on the
 * post-write refresh; a tracked file keeps showing until the owner also removes it from the index.
 */
export async function addToGitignore(repoId: string, relPath: string): Promise<GitignoreResult> {
  const g = guardRepo<"SUBMODULE_NOT_ACTIONABLE">(repoId, "SUBMODULE_NOT_ACTIONABLE");
  if (g.fail) return g.fail;
  const repo = g.repo;
  const backend = backendFor(repo.vcs);
  if (backend.marker !== ".git") {
    return { ok: false, code: "UNSUPPORTED", message: ".gitignore is only supported for git repositories" };
  }
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  // Never write a pattern that reaches into the VCS marker dir (.git).
  if (r.clean.split("/").includes(backend.marker)) {
    return { ok: false, code: "ERROR", message: `refusing to touch a ${backend.marker} directory` };
  }
  const pattern = `/${r.clean}`; // anchored to the repo root = this exact path, not a loose glob
  const gitignorePath = join(repo.absPath, ".gitignore");
  const result = await enqueue(repoId, async () => {
    try {
      const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
      const present = existing.split(/\r?\n/).some((l) => {
        const t = l.trim();
        return t === pattern || t === r.clean; // treat an anchored or bare prior entry as "already ignored"
      });
      if (present) return { ok: true as const, alreadyIgnored: true };
      // Guarantee a newline before our line (so we never glue onto a no-trailing-newline last line).
      const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      const next = `${existing}${sep}${pattern}\n`;
      // Atomic write (tmp + rename), same idiom as writeFileContent — a crash mid-write can't
      // leave a half-written .gitignore.
      const tmp = `${gitignorePath}.${randomUUID()}.tmp`;
      writeFileSync(tmp, next, "utf8");
      renameSync(tmp, gitignorePath);
      return { ok: true as const, alreadyIgnored: false };
    } catch (e) {
      return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
    }
  });
  if (!result.ok) return { ok: false, code: "ERROR", message: result.message };
  // Refresh AFTER the queue slot releases (refreshRepo enqueues again → would deadlock if nested).
  await refreshRepo(repo.id, repo.absPath);
  return { ok: true, code: "OK", pattern, alreadyIgnored: result.alreadyIgnored };
}

// ── smart commit (AI multi-commit splitter) ─────────────────────────────────────────

export interface SmartCommitOutcome {
  ok: boolean;
  code: ActionCode;
  message: string;
  repoId: string;
  /** Per-group outcome, in order (present once execution started). */
  committed?: CommitGroupResult[];
  /** Groups not attempted because an earlier one failed. */
  remaining?: number;
  /** True when a requested post-commit push succeeded. */
  synced?: boolean;
  /** The sync (pull/push) code/message when sync was requested and didn't fully succeed. */
  syncCode?: ActionCode;
  syncMessage?: string;
}

// ── shared path validation for the two staging entry points (smart-commit + commit-selected) ──
// Build a validation context from a fresh `readChanges`, then resolve each submitted path list
// against it: normalize slashes, reject paths no longer pending (PLAN_STALE), auto-add each
// rename's old path so the deletion lands with the addition, and enforce a duplicate policy. The
// `seen` set is threaded across calls (smart-commit accumulates it across groups) so the same file
// can't be assigned twice. Extracted so the two callers' rename/stale semantics can't drift apart.
interface PathValidationCtx {
  changedSet: Set<string>;
  renameFrom: Map<string, string>;
  seen: Set<string>;
}
function pathValidationCtx(fresh: Array<{ path: string; from?: string }>): PathValidationCtx {
  const changedSet = new Set(fresh.map((f) => f.path));
  const renameFrom = new Map<string, string>();
  for (const f of fresh) if (f.from) renameFrom.set(f.path, f.from);
  return { changedSet, renameFrom, seen: new Set<string>() };
}
type StagedPathsResult =
  | { ok: true; paths: string[] }
  | { ok: false; code: ActionCode; message: string };
function resolveStagedPaths(
  ctx: PathValidationCtx,
  rawPaths: string[],
  opts: { onDuplicate: "error" | "skip"; staleHint: string },
): StagedPathsResult {
  const paths: string[] = [];
  for (const raw of rawPaths) {
    const p = normalizeRelPath(raw);
    if (!ctx.changedSet.has(p)) {
      return { ok: false, code: "PLAN_STALE", message: `"${p}" is no longer a pending change — ${opts.staleHint}` };
    }
    if (ctx.seen.has(p)) {
      if (opts.onDuplicate === "error") {
        return { ok: false, code: "PLAN_PATHS_INVALID", message: `"${p}" is assigned to more than one commit` };
      }
      continue; // commit-selected: silently ignore an accidental duplicate selection
    }
    ctx.seen.add(p);
    paths.push(p);
    const from = ctx.renameFrom.get(p);
    if (from) paths.push(from); // stage the rename's old path with the new one
  }
  return { ok: true, paths };
}

/**
 * Execute an owner-edited commit plan: validate the submitted groups against the LIVE working
 * tree, then run the whole stage+commit sequence inside ONE op-queue slot (so nothing can
 * interleave), optionally syncing afterward, and refresh once the slot releases.
 *
 * Validation (against fresh `readChanges`):
 *  - every submitted path must currently be changed (a vanished/stale path → PLAN_STALE);
 *  - no path may appear in two groups (→ PLAN_PATHS_INVALID).
 * A rename's old path is auto-added to its group so the deletion lands with the addition.
 * Leaving some changed files unassigned is allowed — they simply stay in the working tree.
 */
export async function smartCommitRepo(
  repoId: string,
  commits: Array<{ message: string; paths: string[] }>,
  sync = false,
): Promise<SmartCommitOutcome> {
  const g = guardRepo<"SUBMODULE_NOT_ACTIONABLE", { repoId: string }>(repoId, "SUBMODULE_NOT_ACTIONABLE", { repoId });
  if (g.fail) return g.fail;
  const repo = g.repo;
  // ⭐ Identity Firewall: block before staging/committing anything if this repo violates a
  // pinned identity rule (mirrors runAction's preflight in service/core.ts).
  const violation = enforceIdentityPolicy(repo);
  if (violation) return { ...violation, repoId };
  if (commits.length === 0) return { ok: false, code: "EMPTY_PLAN", message: "no commits in the plan", repoId };
  const identity = resolveRepoIdentity(repo);
  const backend = backendFor(repo.vcs);

  const outcome = await enqueue(repoId, async (): Promise<Omit<SmartCommitOutcome, "repoId">> => {
    // Validate against the CURRENT tree (the plan may have been built minutes ago). A path in two
    // groups is an error here (each group is a distinct commit); see resolveStagedPaths.
    const fresh = await backend.readChanges(repo.absPath, false);
    const ctx = pathValidationCtx(fresh);
    const specs: CommitGroupSpec[] = [];
    for (const c of commits) {
      const r = resolveStagedPaths(ctx, c.paths, { onDuplicate: "error", staleHint: "re-plan" });
      if (!r.ok) return { ok: false, code: r.code, message: r.message };
      specs.push({ message: c.message, paths: r.paths });
    }

    const res = await backend.commitGroups(repo.absPath, identity, specs);
    const base: Omit<SmartCommitOutcome, "repoId"> = {
      ok: res.ok,
      code: res.code,
      message: res.message,
      committed: res.committed,
      remaining: res.remaining,
    };
    if (!res.ok || !sync) return base;

    // Resolve the GitHub credential this repo syncs as, for the network round-trip below. Injected
    // into each git child rather than switching the machine's active account (see core.ts
    // accountAuthFor); null when the repo needs nothing special.
    const auth = await accountAuthFor(repo);

    // Post-commit sync (mirrors the UI's "commit & sync"): pull --ff-only, THEN push, but only if
    // the pull actually succeeded. Pushing after a failed pull would publish the just-made local
    // commits without first confirming the branch is fast-forwarded to upstream (exactly the
    // NON_FAST_FORWARD race the pull-first order exists to avoid). The ff-only pull leaves any
    // leftover unassigned files untouched and succeeds unless the incoming update would overwrite
    // them; a genuine failure short-circuits and skips the push, so the commits stay safe locally.
    const pull = await backend.pull(repo.absPath, identity, auth);
    if (!pull.ok) return { ...base, synced: false, syncCode: pull.code, syncMessage: pull.message };
    const push = await backend.push(repo.absPath, identity, auth);
    if (push.ok) return { ...base, synced: true };
    return { ...base, synced: false, syncCode: push.code, syncMessage: push.message || pull.message };
  });

  // Refresh AFTER the slot releases (refreshRepo enqueues again → nesting would deadlock).
  await refreshRepo(repo.id, repo.absPath, outcome.ok && outcome.synced === true);
  return { ...outcome, repoId };
}

/**
 * Commit ONLY a selected subset of changed files in one ordinary commit — file-level staging for a
 * normal commit (Smart Commit already stages per-group internally; this exposes it for a single
 * commit). Stage exactly `paths` (a rename's old path auto-added so the deletion lands with the
 * addition), commit with `message`, and leave every other pending change in the working tree. Runs
 * in one op-queue slot so nothing interleaves; refreshes status afterward. A reuse of the same
 * `commitGroups` primitive Smart Commit drives, with a single group and no completeness requirement.
 */
export async function commitSelectedRepo(
  repoId: string,
  message: string,
  paths: string[],
): Promise<ActionResult & { repoId: string }> {
  const g = guardRepo<"SUBMODULE_NOT_ACTIONABLE", { repoId: string }>(repoId, "SUBMODULE_NOT_ACTIONABLE", { repoId });
  if (g.fail) return g.fail;
  const repo = g.repo;
  // ⭐ Identity Firewall: block before staging/committing anything if this repo violates a
  // pinned identity rule (mirrors runAction's preflight in service/core.ts).
  const violation = enforceIdentityPolicy(repo);
  if (violation) return { ...violation, repoId };
  const identity = resolveRepoIdentity(repo);
  const backend = backendFor(repo.vcs);

  const outcome = await enqueue(repoId, async (): Promise<ActionResult> => {
    // Validate the selection against the CURRENT tree (it may have shifted since the UI read it). A
    // duplicate selection is silently skipped here (single commit, no completeness requirement).
    const fresh = await backend.readChanges(repo.absPath, false);
    const ctx = pathValidationCtx(fresh);
    const r = resolveStagedPaths(ctx, paths, { onDuplicate: "skip", staleHint: "refresh and retry" });
    if (!r.ok) return { ok: false, code: r.code, message: r.message };
    const staged = r.paths;
    if (staged.length === 0) {
      return { ok: false, code: "NOTHING_TO_COMMIT", message: "select at least one changed file to commit" };
    }

    // Single group → surface its per-group result (commitGroups already maps git errors to codes).
    const res = await backend.commitGroups(repo.absPath, identity, [{ message, paths: staged }]);
    const only = res.committed[0];
    return only
      ? { ok: only.ok, code: only.code, message: only.message ?? res.message }
      : { ok: res.ok, code: res.code, message: res.message };
  });

  await refreshRepo(repo.id, repo.absPath);
  return { ...outcome, repoId };
}
