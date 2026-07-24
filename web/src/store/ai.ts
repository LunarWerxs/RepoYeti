import { ref, computed } from "vue";
import { api } from "../api";
import type {
  ActionName,
  ActionResult,
  AiCatalogEntry,
  AiModel,
  AiProviderId,
  AiSettings,
  CommitPlanResponse,
  CommitStyle,
  DiffDetail,
  SmartCommitResult,
} from "../types";

/**
 * BYOK AI settings + commit-message/plan generation + smart-commit execution.
 * `busy` and `loadChanges` are shared with the repo-actions module (passed in) so a
 * smart commit shows the same per-button spinner and refreshes the same changed-file tree.
 */
export function useAi(
  busy: Record<string, ActionName | undefined>,
  loadChanges: (repoId: string) => Promise<void>,
  asResult: (e: unknown) => ActionResult,
) {
  // BYOK AI settings (redacted — never holds a key). `aiEnabled` gates the Generate button.
  // Style defaults to Conventional Commits; it's pickable from Settings → AI and from the
  // smart-commit plan header, and owners can still set it in ~/.repoyeti/config.json. The
  // daemon mirrors this default.
  const aiSettings = ref<AiSettings>({
    providers: {},
    defaultProvider: null,
    style: "conventional",
    diffDetail: "lean", // mirrors DEFAULT_DIFF_DETAIL (src/config.ts)
    yolo: false,
    commitEnabled: true,
  });
  const aiReady = ref(false);
  /** Guest-only readiness supplied by the sharer's daemon without disclosing provider details. */
  const remoteAiUsable = ref<boolean | null>(null);
  /** Provider catalog from GET /api/ai/catalog — safe display metadata, no secrets. */
  const aiCatalog = ref<AiCatalogEntry[]>([]);
  /** A usable provider is connected (a default provider with a model) — AI can actually run. */
  const aiUsable = computed(() => {
    if (remoteAiUsable.value !== null) return remoteAiUsable.value;
    const dp = aiSettings.value.defaultProvider;
    return !!(dp && aiSettings.value.providers[dp]?.model);
  });
  /** Whether the AI commit buttons are SHOWN. Default on, independent of whether a key exists —
   *  clicking with no usable provider nudges the owner to add one (see RepoCardCommit). */
  const aiCommitEnabled = computed(() => aiSettings.value.commitEnabled !== false);
  // Back-compat alias: `aiEnabled` historically meant "a usable provider is connected".
  const aiEnabled = aiUsable;

  // ── BYOK AI ───────────────────────────────────────────────────────────────────
  async function loadAiCatalog(): Promise<void> {
    try {
      aiCatalog.value = await api.ai.catalog();
    } catch {
      /* catalog is optional — Settings UI falls back gracefully to an empty list */
    }
  }
  async function loadAiSettings(): Promise<void> {
    try {
      remoteAiUsable.value = null;
      aiSettings.value = await api.ai.settings();
    } catch {
      /* leave defaults — AI is optional */
    } finally {
      aiReady.value = true;
    }
  }
  /** Load only the two AI capability bits a share-link guest needs. Provider/key metadata stays
   *  owner-only; generation itself is still performed by the sharer's daemon. */
  async function loadAiAvailability(): Promise<void> {
    try {
      const availability = await api.ai.availability();
      remoteAiUsable.value = availability.usable;
      aiSettings.value = {
        ...aiSettings.value,
        commitEnabled: availability.commitEnabled,
      };
    } catch {
      remoteAiUsable.value = false;
    } finally {
      aiReady.value = true;
    }
  }
  /** Validate + save a key; returns the models it unlocks. Throws ApiError on bad key. */
  async function connectProvider(provider: AiProviderId, apiKey: string): Promise<AiModel[]> {
    const r = await api.ai.connect(provider, apiKey);
    aiSettings.value = r.settings;
    return r.models;
  }
  async function listProviderModels(provider: AiProviderId): Promise<AiModel[]> {
    return (await api.ai.models(provider)).models;
  }
  async function selectModel(provider: AiProviderId, model: string | null): Promise<void> {
    aiSettings.value = await api.ai.setProvider(provider, { model });
  }
  async function setDefaultProvider(provider: AiProviderId): Promise<void> {
    aiSettings.value = await api.ai.setProvider(provider, { makeDefault: true });
  }
  /** Toggle smart-commit YOLO mode (optimistic; rolls back on failure). */
  async function setYolo(yolo: boolean): Promise<void> {
    const prev = aiSettings.value.yolo;
    aiSettings.value = { ...aiSettings.value, yolo };
    try {
      aiSettings.value = await api.ai.setYolo(yolo);
    } catch (e) {
      aiSettings.value = { ...aiSettings.value, yolo: prev }; // roll back
      throw e;
    }
  }
  /** Toggle whether the AI commit buttons are shown (optimistic; rolls back on failure). */
  async function setCommitEnabled(commitEnabled: boolean): Promise<void> {
    const prev = aiSettings.value.commitEnabled;
    aiSettings.value = { ...aiSettings.value, commitEnabled };
    try {
      aiSettings.value = await api.ai.setCommitEnabled(commitEnabled);
    } catch (e) {
      aiSettings.value = { ...aiSettings.value, commitEnabled: prev }; // roll back
      throw e;
    }
  }
  async function setStyle(style: CommitStyle): Promise<void> {
    const prev = aiSettings.value.style;
    aiSettings.value = { ...aiSettings.value, style };
    try {
      aiSettings.value = await api.ai.setStyle(style);
    } catch (e) {
      aiSettings.value = { ...aiSettings.value, style: prev }; // roll back
      throw e;
    }
  }
  /** Set the smart-commit diff-detail dial (optimistic; rolls back on failure). */
  async function setDiffDetail(diffDetail: DiffDetail): Promise<void> {
    const prev = aiSettings.value.diffDetail;
    aiSettings.value = { ...aiSettings.value, diffDetail };
    try {
      aiSettings.value = await api.ai.setDiffDetail(diffDetail);
    } catch (e) {
      aiSettings.value = { ...aiSettings.value, diffDetail: prev }; // roll back
      throw e;
    }
  }
  async function removeProvider(provider: AiProviderId): Promise<void> {
    aiSettings.value = await api.ai.removeProvider(provider);
  }
  /** Draft a commit message from the repo's diff (or just `paths`, for smart-commit per-group
   *  regenerate). Throws ApiError → caller toasts. */
  async function genCommitMessage(repoId: string, provider?: AiProviderId, paths?: string[]): Promise<string> {
    return (await api.ai.commitMessage(repoId, provider, paths)).message;
  }

  /** Propose a multi-commit plan from the repo's working tree (commits nothing). With `paths`,
   *  scope the plan to just the owner's checked selection; an empty/omitted selection plans the
   *  whole working tree (see api.ai.commitPlan). Throws ApiError (e.g. NO_AI_PROVIDER /
   *  NOTHING_TO_COMMIT) → the caller toasts. */
  async function genCommitPlan(repoId: string, provider?: AiProviderId, paths?: string[]): Promise<CommitPlanResponse> {
    return api.ai.commitPlan(repoId, provider, paths);
  }

  /** Execute an (owner-edited) commit plan. Sets the commit busy state, reloads the changed-
   *  file tree afterward (it shrank), and returns the structured result for the UI to render. */
  async function smartCommit(
    repoId: string,
    commits: Array<{ message: string; paths: string[] }>,
    sync = false,
  ): Promise<SmartCommitResult> {
    busy[repoId] = "commit";
    try {
      const r = await api.smartCommit(repoId, commits, sync);
      await loadChanges(repoId); // some/all files were just committed
      return r;
    } catch (e) {
      return { ...asResult(e), repoId };
    } finally {
      busy[repoId] = undefined;
    }
  }

  return {
    aiSettings,
    aiCatalog,
    aiReady,
    aiEnabled,
    aiUsable,
    aiCommitEnabled,
    loadAiSettings,
    loadAiAvailability,
    loadAiCatalog,
    connectProvider,
    listProviderModels,
    selectModel,
    setDefaultProvider,
    setYolo,
    setCommitEnabled,
    setStyle,
    setDiffDetail,
    removeProvider,
    genCommitMessage,
    genCommitPlan,
    smartCommit,
  };
}
