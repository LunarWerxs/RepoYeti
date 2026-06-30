// Per-repo file selection for the source-control changed-files tree (ChangesTree) — drives the
// "Commit selected (N)" affordance (per-file staging via POST /api/repos/:id/commit-selected).
//
// Like collapse state (see @/lib/changes-tree), ChangesTree is *self-recursive*, so the set of
// selected files can't live in a single instance — it's created once by the owner (RepoCard) via
// provideTreeSelection() and read by every node in the recursion via useTreeSelection(). State is a
// reactive Set of selected *file* paths (folders are never selected directly; selecting a folder
// toggles its descendant files — RepoCard owns that fan-out since only it holds the full tree).
//
// Persisted to localStorage per repo (same pattern as collapse / changes-view height) so a partial
// selection survives a reload — or the live-update re-render that re-creates the card on every SSE
// status push. prune() drops paths that are no longer pending so a committed/refreshed file can't
// linger as a stale selection (the backend also guards this with PLAN_STALE).
import { computed, inject, provide, reactive, watch, type ComputedRef, type InjectionKey } from "vue";
import { useLocalStorage } from "@vueuse/core";

export interface TreeSelectionApi {
  /** File paths currently selected (reactive — drives the checkbox + the commit button). */
  selected: Set<string>;
  isSelected: (path: string) => boolean;
  /** Flip one file in ↔ out of the selection. */
  toggle: (path: string) => void;
  /** Add (select = true) or remove (false) many files at once — drives the folder/select-all toggles. */
  setMany: (paths: Iterable<string>, select: boolean) => void;
  /** Clear the whole selection (after a successful commit, or the "clear" affordance). */
  clear: () => void;
  /** Drop any selected path not in `valid` (e.g. it was just committed / is no longer pending). */
  prune: (valid: Iterable<string>) => void;
  /** Reactive selection size — the N in "Commit selected (N)". */
  count: ComputedRef<number>;
}

const KEY: InjectionKey<TreeSelectionApi> = Symbol("gm-tree-selection");

/** repoId → selected file paths. Absent / empty = nothing selected. */
const persisted = useLocalStorage<Record<string, string[]>>("repoyeti:changesSelected", {});

function makeApi(repoId?: string): TreeSelectionApi {
  const selected = reactive(new Set<string>(repoId ? (persisted.value[repoId] ?? []) : []));
  const api: TreeSelectionApi = {
    selected,
    isSelected: (p) => selected.has(p),
    toggle: (p) => void (selected.has(p) ? selected.delete(p) : selected.add(p)),
    setMany: (paths, select) => {
      for (const p of paths) {
        if (select) selected.add(p);
        else selected.delete(p);
      }
    },
    clear: () => selected.clear(),
    prune: (valid) => {
      const keep = new Set(valid);
      for (const p of [...selected]) if (!keep.has(p)) selected.delete(p);
    },
    count: computed(() => selected.size),
  };
  // Mirror every change back to localStorage; drop the key entirely when nothing is selected so the
  // store stays tidy (matches changes-tree's collapse persistence).
  if (repoId) {
    watch(
      () => [...selected],
      (paths) => {
        if (paths.length) persisted.value[repoId] = paths;
        else delete persisted.value[repoId];
      },
    );
  }
  return api;
}

/** Owner side (RepoCard): create the shared, persisted selection and expose it to the subtree. */
export function provideTreeSelection(repoId: string): TreeSelectionApi {
  const api = makeApi(repoId);
  provide(KEY, api);
  return api;
}

/** Node side (ChangesTree): read the shared selection (falls back to a private one if standalone). */
export function useTreeSelection(): TreeSelectionApi {
  return inject(KEY, () => makeApi(), true);
}
