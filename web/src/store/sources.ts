import { ref, type Ref } from "vue";
import { api } from "../api";
import type { FetchAllResult, LoreServer, Repo } from "../types";

/**
 * Scan roots / registered Lore servers / bulk fetch / add-or-clone-repo / drag-reorder /
 * sign-out-everywhere. The five scan-progress refs are owned by the barrel (the `connect()`
 * SSE handler also writes them directly from `scan_*` events), so they're passed in here.
 */
export function useSources(
  repos: Ref<Repo[]>,
  scanning: Ref<boolean>,
  scanFound: Ref<number>,
  scanNew: Ref<number>,
  scanDone: Ref<boolean>,
  lastScanCancelled: Ref<boolean>,
) {
  // Scan roots (discovery directories) — lazily loaded when Settings opens.
  const roots = ref<string[]>([]);
  // Registered Lore servers — lazily loaded when Settings / Add-repo opens.
  const servers = ref<LoreServer[]>([]);
  // True while a bulk "fetch all" is running (drives the header button spinner).
  const fetchingAll = ref(false);

  // ── scan roots / bulk fetch / sign-out-everywhere ────────────────────────────
  async function loadRoots(): Promise<void> {
    roots.value = await api.roots();
  }
  /** Add a scan root; repos under it stream in live via the `repo_added` SSE event. */
  async function addScanRoot(path: string): Promise<void> {
    const r = await api.addRoot(path);
    roots.value = r.roots;
  }
  /** Remove a scan root; its auto-discovered repos disappear via `repo_removed`. */
  async function removeScanRoot(path: string): Promise<number> {
    const r = await api.removeRoot(path);
    roots.value = r.roots;
    return r.removed;
  }

  /** Start a scan — the whole machine by default, or a single folder via `{ path }`. Progress +
   *  results arrive over the scan_* SSE events; we flip `scanning` on optimistically so the modal
   *  reacts before the first frame. */
  async function startScan(opts?: { path?: string }): Promise<void> {
    scanning.value = true;
    scanDone.value = false;
    lastScanCancelled.value = false;
    scanFound.value = 0;
    scanNew.value = 0;
    try {
      await api.startScan(opts);
    } catch (e) {
      scanning.value = false; // the request itself failed — never entered the running state
      throw e;
    }
  }
  /** Stop the in-flight scan (the modal's X). The scan_cancelled SSE event settles the state. */
  async function cancelScan(): Promise<void> {
    await api.cancelScan();
  }
  // ── lore servers ─────────────────────────────────────────────────────────────
  async function loadServers(): Promise<void> {
    servers.value = await api.servers();
  }
  async function addServer(url: string, name?: string): Promise<LoreServer> {
    const r = await api.addServer(url, name);
    servers.value = r.servers;
    return r.server;
  }
  async function removeServer(id: string): Promise<void> {
    const r = await api.deleteServer(id);
    servers.value = r.servers;
  }
  /** Clone a repo from a registered Lore server into a folder under a scan root. */
  async function cloneFromServer(input: { url: string; parentPath: string; name?: string }): Promise<Repo> {
    const repo = await api.cloneFromServer(input);
    const idx = repos.value.findIndex((r) => r.id === repo.id);
    if (idx >= 0) repos.value[idx] = repo;
    else repos.value.push(repo);
    return repo;
  }

  /** Fetch every repo with a remote. Returns a summary the caller toasts. */
  async function fetchAll(): Promise<FetchAllResult> {
    fetchingAll.value = true;
    try {
      return await api.fetchAll();
    } finally {
      fetchingAll.value = false;
    }
  }
  async function shutdown(): Promise<void> {
    await api.shutdown();
  }
  /** Sign out on every device (rotates the daemon's signing key). */
  async function logoutAll(): Promise<void> {
    await api.logoutAll();
  }

  async function addRepo(mode: "register" | "create", path: string): Promise<Repo> {
    const repo = mode === "register" ? await api.registerRepo(path) : await api.createRepo(path);
    const idx = repos.value.findIndex((r) => r.id === repo.id);
    if (idx >= 0) repos.value[idx] = repo;
    else repos.value.push(repo);
    return repo;
  }

  /** Clone a remote into a folder under a scan root; the new repo also arrives via SSE. */
  async function cloneRepo(input: {
    url: string;
    parentPath: string;
    name?: string;
    identityId?: string | null;
  }): Promise<Repo> {
    const repo = await api.cloneRepo(input);
    const idx = repos.value.findIndex((r) => r.id === repo.id);
    if (idx >= 0) repos.value[idx] = repo;
    else repos.value.push(repo);
    return repo;
  }

  /**
   * Persist a drag-to-reorder. First reorder the local `repos` to match so a later
   * rebuild — triggered by any pin/star/hide toggle or live SSE patch — re-derives the
   * order the user just dragged into place, instead of snapping back to the server's
   * pre-drag sort_order. The API call is then best-effort. `orderedIds` is the full set
   * (the section lists plus the hidden tail), so every repo gets a position.
   */
  async function persistRepoOrder(orderedIds: string[]): Promise<void> {
    const pos = new Map(orderedIds.map((id, i) => [id, i]));
    repos.value = [...repos.value].sort(
      (a, b) =>
        (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    try {
      await api.reorderRepos(orderedIds);
    } catch {
      /* order is a nicety — never block the UI on it */
    }
  }

  return {
    roots,
    servers,
    fetchingAll,
    loadRoots,
    addScanRoot,
    removeScanRoot,
    startScan,
    cancelScan,
    loadServers,
    addServer,
    removeServer,
    cloneFromServer,
    fetchAll,
    shutdown,
    logoutAll,
    addRepo,
    cloneRepo,
    persistRepoOrder,
  };
}
