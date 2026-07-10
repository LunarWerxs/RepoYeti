// Shared per-repo action feedback, extracted from RepoCard so the panel children
// (BranchPanel / StashPanel / LogPanel) translate error codes and toast results identically
// without each duplicating the 17-entry error map. Call from a component's setup() — it uses
// useI18n() and so must run in a setup/composable context.
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";

export interface ActionLike {
  ok: boolean;
  code: string;
  message?: string;
}

export function useRepoFeedback(): {
  /** Translate a first-class error code into one calm, actionable sentence ("" if unknown). */
  friendly: (code: string) => string;
  /** Toast a git ActionResult: the resolved success message, or the friendly error. */
  toastResult: (r: ActionLike, successMsg: string) => void;
} {
  const { t } = useI18n();

  // Translate first-class error codes into one calm, actionable sentence.
  function friendly(code: string): string {
    const map: Record<string, string> = {
      DIRTY_WORKING_TREE: t("repo.err.dirtyWorkingTree"),
      NON_FAST_FORWARD: t("repo.err.nonFastForward"),
      DETACHED_HEAD: t("repo.err.detachedHead"),
      NO_UPSTREAM: t("repo.err.noUpstream"),
      NO_REMOTE: t("repo.err.noRemote"),
      NOTHING_TO_COMMIT: t("repo.err.nothingToCommit"),
      SSH_AUTH_FAILED: t("repo.err.sshAuthFailed"),
      SSH_PASSPHRASE_REQUIRED: t("repo.err.sshPassphraseRequired"),
      BRANCH_EXISTS: t("repo.err.branchExists"),
      INVALID_REF_NAME: t("repo.err.invalidRefName"),
      UNMERGED_BRANCH: t("repo.err.unmergedBranch"),
      CANNOT_DELETE_CURRENT: t("repo.err.cannotDeleteCurrent"),
      PROTECTED_BRANCH: t("repo.err.protectedBranch"),
      NOTHING_TO_STASH: t("repo.err.nothingToStash"),
      STASH_CONFLICT: t("repo.err.stashConflict"),
      STASH_EMPTY: t("repo.err.stashEmpty"),
      DISCARD_FAILED: t("repo.err.discardFailed"),
    };
    return map[code] ?? "";
  }

  // Takes the already-resolved success message (not a key) so the i18n checker sees each
  // t("…") referenced statically at the call site.
  function toastResult(r: ActionLike, successMsg: string): void {
    if (r.ok) toast.success(r.message || successMsg);
    else toast.error(friendly(r.code) || r.message || t("repo.actions.failed", { action: "git" }));
  }

  return { friendly, toastResult };
}
