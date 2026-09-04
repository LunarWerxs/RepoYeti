/**
 * Orchestration core: per-repo status refresh and the action runner that every mutating
 * VCS action funnels through (so a user-triggered fetch/pull/push can never race the
 * watcher's status read on the same repo). After any action we re-read and broadcast
 * status so the phone sees the result over SSE without polling.
 */
import { enqueue } from "../opqueue.ts";
import { diffStatsEnabled } from "../read/diffstat.ts";
import { broadcast } from "../bus.ts";
import { getRepo, setRepoStatus, setRepoOrder, recordOperationalError } from "../db.ts";
import { resolveRepoIdentity, enforceIdentityPolicy } from "../identity.ts";
import { backendFor } from "../vcs/index.ts";
import { authForRepo } from "../gh-account.ts";
import type { GitHubAuth } from "../git.ts";
import type { VcsBackend } from "../vcs/types.ts";
import type { ActionResult } from "../git-actions.ts";
import type { Identity, RepoStatus, RepoView } from "../db.ts";

/** Per-repo last-status signature (sans timestamp) so a no-op read doesn't emit. */
export const lastStatusSig = new Map<string, string>();

/**
 * Read a repo's status behind its op-queue; persist + push over SSE only on change.
 *
 * A successful fetch changes remote refs but cannot change HEAD, the index, or working-tree
 * contents. Its caller can therefore reuse the previous diff aggregate instead of re-reading a
 * potentially enormous dirty tree just to update ahead/behind.
 */
export async function refreshRepo(
  id: string,
  absPath: string,
  markFetched = false,
  reuseDiff = false,
): Promise<RepoStatus> {
  const previous = getRepo(id)?.status;
  const backend = backendFor(getRepo(id)?.vcs ?? "git");
  const wantsDiff = diffStatsEnabled();
  const status = await enqueue(id, () => backend.readStatus(absPath, wantsDiff && !reuseDiff));
  if (reuseDiff && wantsDiff) status.diff = previous?.diff ?? null;
  if (markFetched) status.fetchedAt = Date.now();
  else status.fetchedAt = previous?.fetchedAt ?? null;
  const { updatedAt: _omit, ...sig } = status;
  const signature = JSON.stringify(sig);
  // The freshly READ status is returned either way. The signature check decides whether anyone
  // needs TELLING, which is a different question from what the caller that just mutated the repo
  // should hand back to the client that asked for the mutation.
  if (lastStatusSig.get(id) === signature) return status;
  lastStatusSig.set(id, signature);
  setRepoStatus(id, status);
  broadcast("repo_state_changed", { id, status });
  return status;
}

export interface ActionOutcome extends ActionResult {
  repoId: string;
  /**
   * The repo's status as of immediately after the action, for the client that requested it.
   *
   * The `repo_state_changed` broadcast still fans this out to every OTHER connected client, but
   * the initiator must not have to wait for its own SSE frame to see what it just did. That was
   * issue #17: a push left the button green until a manual Refresh, because Refresh was the one
   * action that patched status straight from its HTTP response and push relied on the broadcast
   * coming back around. The stream is best-effort by construction — it has no replay, and
   * http/routes/events.ts closes it outright when a slow client makes it drop frames — so an
   * action's own result is the only channel that can be relied on by the caller.
   *
   * Absent when the action never reached a refresh (unknown repo, submodule, identity block).
   */
  status?: RepoStatus | null;
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
  /**
   * A short, stable name for what this call site does ("fetch", "pull", "checkout", ...), never
   * shown to the user verbatim, only used to GROUP repeated failures (see
   * db.ts recordOperationalError / operationalErrorFingerprint). Every runAction call site in
   * service/actions.ts passes a distinct one; keep new call sites doing the same, or their
   * failures will silently merge into whichever existing op string they happen to reuse.
   */
  op: string,
  action: VcsAction,
  markFetched = false,
  syncAccount = false,
  precondition?: VcsPrecondition,
  reuseDiffAfter = false,
): Promise<ActionOutcome> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found", repoId };
  // Every early-exit below funnels through this before returning, so the grouped error history
  // (Settings → Error history, next to the live health/status route) covers every way this
  // function can fail, not just the ones that reach the git child process.
  const record = (result: ActionResult): void => {
    if (result.ok) return;
    recordOperationalError({ repoId, repoName: repo.name, op, code: result.code, message: result.message });
    // Owner-plane only: not in share/events.ts's allowlist, so a guest's SSE connection never
    // sees it. Settings' error-history panel listens for this to refetch, same idiom as
    // identity_rules_changed - the payload just needs to say something changed, not what.
    broadcast("operational_error_changed", { repoId, op, code: result.code });
  };
  if (repo.isSubmodule) {
    const result: ActionResult = {
      ok: false,
      code: "SUBMODULE_NOT_ACTIONABLE",
      message: "submodule worktree is not actionable",
    };
    record(result);
    return { ...result, repoId };
  }
  // ⭐ Identity Firewall: block before any network/commit op if this repo violates a pinned
  // identity rule. Checked BEFORE any credential is resolved, so a blocked repo never causes a
  // token to be read for it at all.
  const violation = enforceIdentityPolicy(repo);
  if (violation) {
    record(violation);
    return { ...violation, repoId };
  }
  const identity = resolveRepoIdentity(repo);
  const backend = backendFor(repo.vcs);
  const result = await enqueue(repoId, async () => {
    // Credential resolution belongs in the same per-repo queue slot as the operation. Otherwise
    // two rapid actions for one repo both walk branch/config/remotes and read a token in parallel
    // before either reaches the queue.
    const auth = syncAccount ? await accountAuthFor(repo) : null;
    const blocked = await precondition?.(backend, repo.absPath, identity, auth);
    return blocked ?? action(backend, repo.absPath, identity, auth);
  });
  record(result);
  // Reflect the new reality (ahead/behind/dirty) to all clients — and hand it back to this one.
  const status = await refreshRepo(
    repoId,
    repo.absPath,
    markFetched && result.ok,
    reuseDiffAfter && result.ok,
  );
  return { ...result, repoId, status };
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
