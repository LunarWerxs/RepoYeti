import { ref } from "vue";
import { api } from "../api";
import type { OperationalErrorView } from "../types";

/**
 * Grouped operational-error history (src/http/routes/errors.ts): "what has gone wrong, and how
 * often" for failed mutating git actions, grouped by (repo, op, code). Owner-only, loaded on
 * demand when its Settings section opens rather than on every boot, same reasoning as the
 * auto-commit incident ledger next to it.
 */
export function useOperationalErrors() {
  const errors = ref<OperationalErrorView[]>([]);
  const errorsReady = ref(false);
  const errorsLoading = ref(false);

  async function loadOperationalErrors(): Promise<void> {
    if (errorsLoading.value) return;
    errorsLoading.value = true;
    try {
      errors.value = await api.errors.list();
    } catch {
      errors.value = [];
    } finally {
      errorsReady.value = true;
      errorsLoading.value = false;
    }
  }

  /** Toggle a group's mute flag; optimistic, rolls back on failure. Throws ApiError (NOT_FOUND)
   *  past the rollback so the caller can toast. */
  async function setOperationalErrorMuted(fingerprint: string, muted: boolean): Promise<void> {
    const prev = errors.value;
    errors.value = prev.map((e) => (e.fingerprint === fingerprint ? { ...e, muted } : e));
    try {
      await api.errors.setMuted(fingerprint, muted);
    } catch (e) {
      errors.value = prev;
      throw e;
    }
  }

  /** Dismiss one group outright; optimistic (removed from the list immediately), rolls back on
   *  failure. Throws ApiError (NOT_FOUND) past the rollback so the caller can toast. */
  async function dismissOperationalError(fingerprint: string): Promise<void> {
    const prev = errors.value;
    errors.value = prev.filter((e) => e.fingerprint !== fingerprint);
    try {
      await api.errors.dismiss(fingerprint);
    } catch (e) {
      errors.value = prev;
      throw e;
    }
  }

  return {
    errors,
    errorsReady,
    errorsLoading,
    loadOperationalErrors,
    setOperationalErrorMuted,
    dismissOperationalError,
  };
}
