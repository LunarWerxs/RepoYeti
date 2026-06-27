import { defineStore } from "pinia";
import { ref, reactive, computed, watch } from "vue";
import { useEventSource } from "@vueuse/core";
import { api, ApiError } from "./api";
import type { ActionName, ActionResult, Identity, Repo } from "./types";

export const useStore = defineStore("gitmob", () => {
  const repos = ref<Repo[]>([]);
  const identities = ref<Identity[]>([]);
  const loading = ref(true);
  const connected = ref(false);

  // auth
  const authReady = ref(false);
  const authEnforced = ref(false);
  const authenticated = ref(true);
  const owner = ref<string | null>(null);
  /** repoId → the action currently in flight (drives per-button loading state). */
  const busy = reactive<Record<string, ActionName | undefined>>({});

  const identityById = computed<Record<string, Identity>>(() =>
    Object.fromEntries(identities.value.map((i) => [i.id, i])),
  );

  async function loadAuth(): Promise<void> {
    try {
      const s = await api.authStatus();
      authEnforced.value = s.authEnforced;
      authenticated.value = s.authenticated;
      owner.value = s.owner;
    } catch {
      // status endpoint unreachable — treat as open so we still try to load
      authEnforced.value = false;
      authenticated.value = true;
    } finally {
      authReady.value = true;
    }
  }
  async function logout(): Promise<void> {
    await api.logout();
    location.reload();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [r, i] = await Promise.all([api.listRepos(), api.listIdentities()]);
      repos.value = r;
      identities.value = i;
    } finally {
      loading.value = false;
    }
  }

  function patchRepo(id: string, patch: Partial<Repo>): void {
    const r = repos.value.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }

  // ── live updates (SSE) ──────────────────────────────────────────────────────
  function connect(): void {
    const { status, event, data } = useEventSource(
      "/api/events",
      ["hello", "ping", "repo_state_changed", "repo_identity_changed"],
      { autoReconnect: { retries: -1, delay: 2500 } },
    );
    watch(status, (s) => (connected.value = s === "OPEN"));
    watch(data, (raw) => {
      if (!raw || !event.value) return;
      try {
        const payload = JSON.parse(raw);
        if (event.value === "repo_state_changed") patchRepo(payload.id, { status: payload.status });
        else if (event.value === "repo_identity_changed")
          patchRepo(payload.id, { identityId: payload.identityId });
      } catch {
        /* ignore malformed frame */
      }
    });
  }

  // ── actions ─────────────────────────────────────────────────────────────────
  // (commit is separate — it needs a message — see `commit()` below)
  async function doAction(
    repoId: string,
    name: "fetch" | "pull" | "push" | "refresh",
  ): Promise<ActionResult> {
    busy[repoId] = name;
    try {
      if (name === "refresh") {
        const repo = await api.refresh(repoId);
        patchRepo(repoId, { status: repo.status });
        return { ok: true, code: "OK", message: "refreshed" };
      }
      return await api[name](repoId);
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
    } finally {
      busy[repoId] = undefined;
    }
  }

  async function commit(repoId: string, message: string): Promise<ActionResult> {
    busy[repoId] = "commit";
    try {
      return await api.commit(repoId, message);
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
    } finally {
      busy[repoId] = undefined;
    }
  }

  async function assignIdentity(repoId: string, identityId: string | null): Promise<void> {
    patchRepo(repoId, { identityId }); // optimistic
    await api.assignIdentity(repoId, identityId);
  }

  async function addRepo(mode: "register" | "create", path: string): Promise<Repo> {
    const repo = mode === "register" ? await api.registerRepo(path) : await api.createRepo(path);
    const idx = repos.value.findIndex((r) => r.id === repo.id);
    if (idx >= 0) repos.value[idx] = repo;
    else repos.value.push(repo);
    return repo;
  }

  // ── identity CRUD ───────────────────────────────────────────────────────────
  async function reloadIdentities(): Promise<void> {
    identities.value = await api.listIdentities();
  }
  async function createIdentity(input: Omit<Identity, "id">): Promise<void> {
    await api.createIdentity(input);
    await reloadIdentities();
  }
  async function updateIdentity(id: string, patch: Partial<Omit<Identity, "id">>): Promise<void> {
    await api.updateIdentity(id, patch);
    await reloadIdentities();
  }
  async function removeIdentity(id: string): Promise<void> {
    await api.deleteIdentity(id);
    await Promise.all([reloadIdentities(), api.listRepos().then((r) => (repos.value = r))]);
  }

  return {
    repos,
    identities,
    loading,
    connected,
    busy,
    authReady,
    authEnforced,
    authenticated,
    owner,
    identityById,
    loadAuth,
    logout,
    loadAll,
    connect,
    doAction,
    commit,
    assignIdentity,
    addRepo,
    createIdentity,
    updateIdentity,
    removeIdentity,
  };
});
