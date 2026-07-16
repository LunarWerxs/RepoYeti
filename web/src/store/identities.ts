import { ref, computed, type Ref } from "vue";
import { api } from "../api";
import type { AccountsSnapshot, DetectedIdentity, GhAccount, Identity, IdentityRule, Repo } from "../types";

/**
 * Saved commit identities (CRUD + auto-detected candidates) and the machine-wide GitHub
 * (gh) account switcher. Grouped together because removing an identity also refreshes the
 * accounts snapshot (the server cascades any account→identity link that pointed at it).
 */
export function useIdentities(repos: Ref<Repo[]>) {
  const identities = ref<Identity[]>([]);
  const detectedIdentities = ref<DetectedIdentity[]>([]);
  // Suggestions the owner dismissed but that are STILL detected — shown (collapsed) for review +
  // per-item restore. (A dismissed id that's no longer detected simply doesn't appear here.)
  const dismissedDetectedIdentities = ref<DetectedIdentity[]>([]);
  const detectedIdentitiesLoading = ref(false);
  const detectedIdentitiesReady = ref(false);

  const identityById = computed<Record<string, Identity>>(() =>
    Object.fromEntries(identities.value.map((i) => [i.id, i])),
  );

  // ── is the identity feature worth showing at all? ────────────────────────────
  //
  // A commit identity only earns screen space when you actually commit as more than one person
  // (work vs. personal). With a single git identity — the overwhelmingly common case — every
  // identity control is a decision the owner can't get wrong and therefore shouldn't be asked:
  // pure noise on every repo card and a whole Settings tab for a feature doing nothing.
  //
  // So the UI hides itself until there's evidence it's needed, and comes back on its own the
  // moment there is. `identityUiForced` is the manual escape hatch (Settings → "I use more than
  // one git identity"), which also solves the chicken-and-egg: you can't add a 2nd identity
  // through a UI that's hidden because you only have 1.
  const identityUiForced = ref(localStorage.getItem("repoyeti.showIdentities") === "1");
  function setIdentityUiForced(on: boolean): void {
    identityUiForced.value = on;
    if (on) localStorage.setItem("repoyeti.showIdentities", "1");
    else localStorage.removeItem("repoyeti.showIdentities");
  }
  const identitiesRelevant = computed(
    () =>
      identityUiForced.value ||
      identities.value.length >= 2 || // juggling two authors — the case the feature exists for
      identityRules.value.length > 0 || // a Firewall rule is pinned → the owner opted in
      repos.value.some((r) => r.identityId), // some repo already commits as a chosen identity
  );

  // ── identity CRUD ───────────────────────────────────────────────────────────
  async function reloadIdentities(): Promise<void> {
    identities.value = await api.listIdentities();
  }
  async function loadDetectedIdentities(): Promise<void> {
    if (detectedIdentitiesLoading.value) return;
    detectedIdentitiesLoading.value = true;
    try {
      const r = await api.detectedIdentities();
      detectedIdentities.value = r.detected;
      dismissedDetectedIdentities.value = r.dismissed;
      detectedIdentitiesReady.value = true;
    } catch {
      detectedIdentities.value = [];
      detectedIdentitiesReady.value = true;
    } finally {
      detectedIdentitiesLoading.value = false;
    }
  }
  /** Dismiss a detected suggestion so it stops re-appearing; optimistic (moves it to the dismissed
   *  list, which the UI shows collapsed for review/restore). */
  async function dismissDetectedIdentity(id: string): Promise<void> {
    const item = detectedIdentities.value.find((d) => d.id === id);
    detectedIdentities.value = detectedIdentities.value.filter((d) => d.id !== id);
    if (item && !dismissedDetectedIdentities.value.some((d) => d.id === id)) {
      dismissedDetectedIdentities.value = [item, ...dismissedDetectedIdentities.value];
    }
    try {
      await api.dismissDetectedIdentity(id);
    } catch {
      await loadDetectedIdentities(); // roll back to the server's truth
    }
  }
  /** Un-dismiss ONE suggestion (the Undo action + per-item restore); optimistic. */
  async function restoreDetectedIdentity(id: string): Promise<void> {
    const item = dismissedDetectedIdentities.value.find((d) => d.id === id);
    dismissedDetectedIdentities.value = dismissedDetectedIdentities.value.filter((d) => d.id !== id);
    if (item && !detectedIdentities.value.some((d) => d.id === id)) {
      detectedIdentities.value = [...detectedIdentities.value, item];
    }
    try {
      await api.restoreDetectedIdentity(id);
    } catch {
      await loadDetectedIdentities();
    }
  }
  /** Un-dismiss every previously-hidden suggestion, then reload. */
  async function restoreDetectedIdentities(): Promise<void> {
    await api.restoreDetectedIdentities();
    await loadDetectedIdentities();
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
    // Also refresh accounts: the server cascade clears any account→identity link that pointed at
    // this identity, so re-reading drops the now-stale link from the switcher's dropdowns.
    await Promise.all([
      reloadIdentities(),
      api.listRepos().then((r) => (repos.value = r)),
      loadAccounts(),
    ]);
  }

  // ── ⭐ Identity Firewall — rules pinning a required identity to a repo-path glob ──────
  const identityRules = ref<IdentityRule[]>([]);
  const identityRulesReady = ref(false);
  async function loadIdentityRules(): Promise<void> {
    try {
      identityRules.value = await api.identityRules();
    } catch {
      identityRules.value = [];
    } finally {
      identityRulesReady.value = true;
    }
  }
  /** Replace the full rule list. Throws ApiError (NOT_FOUND) → the caller toasts; adopts the
   *  server's persisted list on success. */
  async function setIdentityRules(rules: IdentityRule[]): Promise<void> {
    identityRules.value = await api.setIdentityRules(rules);
  }

  // ── GitHub (gh) accounts — the machine-wide active-account switcher ────────────
  // `ghAvailable` is false when the `gh` CLI isn't installed/reachable (the UI then shows a hint).
  // Loaded on boot (loadAll) so the header switcher shows the active account, and refreshed when
  // Settings opens. Switching flips the active auth account — see AccountSwitcher.vue / AppHeader.vue.
  const ghAvailable = ref(false);
  const ghAccounts = ref<GhAccount[]>([]);
  /** Global git author in effect (display-only; switching auth does NOT change this). */
  const gitCommitIdentity = ref<{ name: string; email: string }>({ name: "", email: "" });
  const accountsReady = ref(false);
  const accountsLoading = ref(false);
  /** The login currently being switched to (drives per-row + header spinners); null when idle. */
  const switchingAccount = ref<string | null>(null);
  const activeAccount = computed(() => ghAccounts.value.find((a) => a.active) ?? null);

  function applyAccountsSnapshot(s: AccountsSnapshot): void {
    ghAvailable.value = s.ghAvailable;
    ghAccounts.value = s.accounts ?? [];
    gitCommitIdentity.value = s.commitIdentity ?? { name: "", email: "" };
    accountsReady.value = true;
  }
  /** Load the machine's gh accounts + active one. Best-effort: never throws (drives an empty state). */
  async function loadAccounts(): Promise<void> {
    if (accountsLoading.value) return;
    accountsLoading.value = true;
    try {
      applyAccountsSnapshot(await api.accounts());
    } catch {
      ghAvailable.value = false;
      ghAccounts.value = [];
      accountsReady.value = true;
    } finally {
      accountsLoading.value = false;
    }
  }
  /** Switch the machine's active GitHub account (host defaults to github.com). Throws ApiError →
   *  the caller toasts; on success the snapshot (incl. the new active account) is applied. */
  async function switchAccount(login: string, host?: string): Promise<void> {
    switchingAccount.value = login;
    try {
      applyAccountsSnapshot(await api.switchAccount(login, host));
    } finally {
      switchingAccount.value = null;
    }
  }
  /** Link (or unlink, with null) a GitHub account to a saved commit identity (applied on switch).
   *  Throws ApiError → the caller toasts. */
  async function setAccountIdentity(login: string, identityId: string | null, host?: string): Promise<void> {
    applyAccountsSnapshot(await api.setAccountIdentity(login, identityId, host));
  }

  return {
    identities,
    detectedIdentities,
    dismissedDetectedIdentities,
    detectedIdentitiesLoading,
    detectedIdentitiesReady,
    identityById,
    identitiesRelevant,
    identityUiForced,
    setIdentityUiForced,
    createIdentity,
    updateIdentity,
    removeIdentity,
    loadDetectedIdentities,
    dismissDetectedIdentity,
    restoreDetectedIdentity,
    restoreDetectedIdentities,
    identityRules,
    identityRulesReady,
    loadIdentityRules,
    setIdentityRules,
    ghAvailable,
    ghAccounts,
    gitCommitIdentity,
    accountsReady,
    accountsLoading,
    switchingAccount,
    activeAccount,
    loadAccounts,
    switchAccount,
    setAccountIdentity,
  };
}
