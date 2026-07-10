// Per-repo collapse state for the source-control changed-files tree (ChangesTree).
//
// ChangesTree is a *self-recursive* component, so the collapsed-folder state can't live in
// a single instance — it's created once by the owner (RepoCard) via provideTreeCollapse()
// and read by every node in the recursion via useTreeCollapse(). State is a reactive Set of
// collapsed *directory* paths; a folder is expanded unless its path is in the set, so a
// freshly-built tree starts fully expanded (matching the previous always-open behaviour).
//
// The set is persisted to localStorage per repo (client-side preference, same pattern as the
// drag-to-resize height in @/lib/changes-view) so folds survive a reload — or a live-update
// re-render that re-creates the card.
import { inject, provide, reactive, watch, type InjectionKey } from "vue";
import { useLocalStorage } from "@vueuse/core";

export interface TreeCollapseApi {
  /** Directory paths that are currently collapsed (reactive — drives row rendering). */
  collapsed: Set<string>;
  isCollapsed: (path: string) => boolean;
  /** Flip one folder open ↔ closed. */
  toggle: (path: string) => void;
  /** Collapse every folder so only the root-level rows remain visible. */
  collapseAll: (dirPaths: Iterable<string>) => void;
  expandAll: () => void;
}

const KEY: InjectionKey<TreeCollapseApi> = Symbol("gm-tree-collapse");

/** repoId → collapsed folder paths. Absent / empty = fully expanded. */
const persisted = useLocalStorage<Record<string, string[]>>("repoyeti:changesCollapsed", {});

function makeApi(repoId?: string): TreeCollapseApi {
  const collapsed = reactive(new Set<string>(repoId ? (persisted.value[repoId] ?? []) : []));
  const api: TreeCollapseApi = {
    collapsed,
    isCollapsed: (p) => collapsed.has(p),
    toggle: (p) => void (collapsed.has(p) ? collapsed.delete(p) : collapsed.add(p)),
    collapseAll: (paths) => {
      collapsed.clear();
      for (const p of paths) collapsed.add(p);
    },
    expandAll: () => collapsed.clear(),
  };
  // Mirror every change back to localStorage; drop the key entirely when nothing is folded
  // so the store stays tidy (matches clearChangesOverride in @/lib/changes-view).
  if (repoId) {
    watch(
      () => [...collapsed],
      (paths) => {
        if (paths.length) persisted.value[repoId] = paths;
        else delete persisted.value[repoId];
      },
    );
  }
  return api;
}

/** Owner side (RepoCard): create the shared, persisted state and expose it to the subtree. */
export function provideTreeCollapse(repoId: string): TreeCollapseApi {
  const api = makeApi(repoId);
  provide(KEY, api);
  return api;
}

/** Node side (ChangesTree): read the shared state (falls back to a private one if standalone). */
export function useTreeCollapse(): TreeCollapseApi {
  return inject(KEY, () => makeApi(), true);
}
