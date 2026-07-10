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
  const detectedIdentitiesLoading = ref(false);
  const detectedIdentitiesReady = ref(false);

  const identityById = computed<Record<string, Identity>>(() =>
    Object.fromEntries(identities.value.map((i) => [i.id, i])),
  );

  // ── identity CRUD ───────────────────────────────────────────────────────────
  async function reloadIdentities(): Promise<void> {
    identities.value = await api.listIdentities();
  }
  async function loadDetectedIdentities(): Promise<void> {
    if (detectedIdentitiesLoading.value) return;
    detectedIdentitiesLoading.value = true;
    try {
      detectedIdentities.value = await api.detectedIdentities();
      detectedIdentitiesReady.value = true;
    } catch {
      detectedIdentities.value = [];
      detectedIdentitiesReady.value = true;
    } finally {
      detectedIdentitiesLoading.value = false;
    }
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
    detectedIdentitiesLoading,
    detectedIdentitiesReady,
    identityById,
    createIdentity,
    updateIdentity,
    removeIdentity,
    loadDetectedIdentities,
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
