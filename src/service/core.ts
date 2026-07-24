/**
 * Orchestration core: per-repo status refresh and the action runner that every mutating
 * VCS action funnels through (so a user-triggered fetch/pull/push can never race the
 * watcher's status read on the same repo). After any action we re-read and broadcast
 * status so the phone sees the result over SSE without polling.
 */
import { enqueue } from "../opqueue.ts";
import { diffStatsEnabled } from "../read/diffstat.ts";
import { broadcast } from "../bus.ts";
import { getRepo, setRepoStatus, setRepoOrder } from "../db.ts";
import { resolveRepoIdentity, enforceIdentityPolicy } from "../identity.ts";
import { backendFor } from "../vcs/index.ts";
import { authForRepo } from "../gh-account.ts";
import type { GitHubAuth } from "../git.ts";
import type { VcsBackend } from "../vcs/types.ts";
import type { ActionResult } from "../git-actions.ts";
import type { Identity, RepoView } from "../db.ts";

/** Per-repo last-status signature (sans timestamp) so a no-op read doesn't emit. */
export const lastStatusSig = new Map<string, string>();

/** Read a repo's status behind its op-queue; persist + push over SSE only on change. */
export async function refreshRepo(id: string, absPath: string, markFetched = false): Promise<void> {
  const previous = getRepo(id)?.status;
  const backend = backendFor(getRepo(id)?.vcs ?? "git");
  const status = await enqueue(id, () => backend.readStatus(absPath, diffStatsEnabled()));
  if (markFetched) status.fetchedAt = Date.now();
  else status.fetchedAt = previous?.fetchedAt ?? null;
  const { updatedAt: _omit, ...sig } = status;
  const signature = JSON.stringify(sig);
  if (lastStatusSig.get(id) === signature) return;
  lastStatusSig.set(id, signature);
  setRepoStatus(id, status);
  broadcast("repo_state_changed", { id, status });
}

export interface ActionOutcome extends ActionResult {
  repoId: string;
}

type VcsAction = (
  backend: VcsBackend,
  absPath: string,
  identity: Identity | null,
  auth: GitHubAuth | null,
) => Promise<ActionResult>;
type VcsPrecondition = (
  backend: VcsBackend,
  absPath: string,
  identity: Identity | null,
  auth: GitHubAuth | null,
) => Promise<ActionResult | null>;

/**
 * The GitHub credential a repo's NETWORK op should run under, or null to leave it alone.
 *
 * This used to flip the machine's ACTIVE gh account before the op (and never put it back), which
 * was wrong in three ways worth remembering, because they are why it is done differently now:
 *
 *   - It never restored, so the last repo synced left its account active for every other tool on
 *     the machine — terminals, agents, editors — until something else flipped it.
 *   - It raced. netGate lets several network ops run at once and opqueue only serialises PER repo,
 *     so two repos with different accounts could interleave and op B would authenticate as A.
 *   - It only fired for an EXPLICIT pin, so the common case — a repo whose own git config already
 *     names its account — got nothing, and failed with "could not read Password" while the account
 *     it wanted sat right there in `gh auth status`.
 *
 * Resolving a token and injecting it into the single git child process fixes all three: no global
 * state is touched, concurrent ops can each use a different account, and the answer can come from
 * the repo itself rather than only from an explicit pin (see gh-account.ts).
 */
export async function accountAuthFor(repo: RepoView): Promise<GitHubAuth | null> {
  return authForRepo(repo).catch(() => null);
}

export async function runAction(
  repoId: string,
  action: VcsAction,
  markFetched = false,
  syncAccount = false,
  precondition?: VcsPrecondition,
): Promise<ActionOutcome> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found", repoId };
  if (repo.isSubmodule) {
    return { ok: false, code: "SUBMODULE_NOT_ACTIONABLE", message: "submodule worktree is not actionable", repoId };
  }
  // ⭐ Identity Firewall: block before any network/commit op if this repo violates a pinned
  // identity rule. Checked BEFORE any credential is resolved, so a blocked repo never causes a
  // token to be read for it at all.
  const violation = enforceIdentityPolicy(repo);
  if (violation) return { ...violation, repoId };
  const auth = syncAccount ? await accountAuthFor(repo) : null;
  const identity = resolveRepoIdentity(repo);
  const backend = backendFor(repo.vcs);
  const result = await enqueue(repoId, async () => {
    const blocked = await precondition?.(backend, repo.absPath, identity, auth);
    return blocked ?? action(backend, repo.absPath, identity, auth);
  });
  // Reflect the new reality (ahead/behind/dirty) to all clients.
  await refreshRepo(repoId, repo.absPath, markFetched && result.ok);
  return { ...result, repoId };
}

/**
 * Force a fresh status read (the phone's "pull to refresh"). Catches working-tree
 * edits the `.git`-only watcher intentionally doesn't see. Returns the latest view.
 */
export async function forceRefresh(repoId: string): Promise<RepoView | null> {
  const repo = getRepo(repoId);
  if (!repo) return null;
  await refreshRepo(repo.id, repo.absPath);
  return getRepo(repo.id);
}

/** Persist the user's drag-to-reorder of the repo list (order = repo ids top→bottom). */
export function reorderRepos(orderedIds: string[]): void {
  setRepoOrder(orderedIds);
}
