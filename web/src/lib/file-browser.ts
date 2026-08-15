// Lazily-loaded working-tree state for the file panel's "All files" browse mode (RepoFileTree).
//
// Same provide/inject shape as @/lib/changes-tree, and for the same reason: RepoFileTree is a
// self-recursive component, so per-folder state can't live in one instance. The owner
// (RepoCardChanges) creates it via provideFileBrowser() and every node reads it through
// useFileBrowser().
//
// THE DIFFERENCE FROM changes-tree. The changed-files tree receives its whole nested tree up
// front, so its state is just "which folders are folded". This one owns the DATA too, because a
// full working tree is not something you can fetch up front: including ignored paths — which is
// the entire point of the mode — RepoYeti's own checkout is 200,000+ files. So a folder's
// children are fetched the first time it is opened, one directory per request (~1 ms server-side;
// see src/service/tree.ts), and folders nobody opens are never walked.
//
// Consequently folders start CLOSED here, the opposite of the changed-files tree. There, an
// expanded default shows you the handful of files you just edited; here it would mean fetching
// the entire repository one request at a time the moment the panel mounts.
import { inject, provide, reactive, type InjectionKey } from "vue";
import { api } from "@/api";
import type { RepoTreeEntry } from "@/types";

/** One directory's fetch state. Absent from the map = never requested. */
export interface DirState {
  entries: RepoTreeEntry[];
  loading: boolean;
  /** A human-readable failure (permission denied, vanished mid-browse), or null. */
  error: string | null;
  /** Set when the server capped an oversized directory (MAX_TREE_ENTRIES). */
  truncated?: boolean;
  /** Entry count before the cap — only meaningful with `truncated`. */
  total?: number;
}

export interface FileBrowserApi {
  /** repo-relative dir path ("" = root) → its fetch state. Reactive. */
  dirs: Map<string, DirState>;
  /** Currently-expanded folder paths. Reactive. Empty = everything collapsed. */
  open: Set<string>;
  isOpen: (path: string) => boolean;
  /** Expand ⇄ collapse one folder, fetching its children the first time it opens. */
  toggle: (path: string) => void;
  /** Fetch (or re-fetch) one directory. Safe to call repeatedly — concurrent calls collapse. */
  load: (path: string, force?: boolean) => Promise<void>;
  /** Expand the tree down to `path` and make sure every folder on the way is loaded. Backs
   *  "click a search result and land on it in the tree". */
  revealPath: (path: string, type: "dir" | "file") => Promise<void>;
  /** Drop every cached listing and fold everything back up (the panel's refresh). */
  reset: () => void;
  /** True while any directory request is in flight — drives the toolbar spinner. */
  busy: () => boolean;
}

const KEY: InjectionKey<FileBrowserApi> = Symbol("ry-file-browser");

function makeApi(repoId?: string): FileBrowserApi {
  const dirs = reactive(new Map<string, DirState>());
  const open = reactive(new Set<string>());

  async function load(path: string, force = false): Promise<void> {
    if (!repoId) return;
    const existing = dirs.get(path);
    // Already loaded, or already loading — don't stack a second request for the same folder.
    if (existing?.loading) return;
    if (existing && !force && !existing.error) return;
    dirs.set(path, {
      entries: existing?.entries ?? [],
      loading: true,
      error: null,
      truncated: existing?.truncated,
      total: existing?.total,
    });
    try {
      const res = await api.tree(repoId, path);
      dirs.set(path, {
        entries: res.entries ?? [],
        loading: false,
        error: null,
        truncated: res.truncated,
        total: res.total,
      });
    } catch (e) {
      dirs.set(path, {
        entries: [],
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const apiObj: FileBrowserApi = {
    dirs,
    open,
    isOpen: (p) => open.has(p),
    toggle: (p) => {
      if (open.has(p)) {
        open.delete(p);
        return;
      }
      open.add(p);
      void load(p); // first open fetches; later opens reuse the cached listing
    },
    load,
    revealPath: async (path, type) => {
      // Every ancestor, plus the target itself when it IS a folder. Loading a FILE path would
      // answer "not a directory" and park an error on a folder that is perfectly fine.
      const parts = path.split("/").filter(Boolean);
      const dirs = type === "dir" ? parts : parts.slice(0, -1);
      await load("");
      let acc = "";
      for (const part of dirs) {
        acc = acc ? `${acc}/${part}` : part;
        open.add(acc);
        await load(acc); // sequential: each level's listing is what makes the next one renderable
      }
    },
    reset: () => {
      dirs.clear();
      open.clear();
      void load("");
    },
    busy: () => {
      for (const d of dirs.values()) if (d.loading) return true;
      return false;
    },
  };
  return apiObj;
}

/** Owner side (RepoCardChanges): create the per-repo browse state for its subtree. */
export function provideFileBrowser(repoId: string): FileBrowserApi {
  const api = makeApi(repoId);
  provide(KEY, api);
  return api;
}

/** Node side (RepoFileTree): read the shared state (a private one if mounted standalone). */
export function useFileBrowser(): FileBrowserApi {
  return inject(KEY, () => makeApi(), true);
}
