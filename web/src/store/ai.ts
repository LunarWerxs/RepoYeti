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
  // Style is hardcoded to Conventional Commits (no UI picker); owners can still override
  // it in ~/.repoyeti/config.json. The daemon mirrors this default.
  const aiSettings = ref<AiSettings>({ providers: {}, defaultProvider: null, style: "conventional", yolo: false });
  const aiReady = ref(false);
  /** Provider catalog from GET /api/ai/catalog — safe display metadata, no secrets. */
  const aiCatalog = ref<AiCatalogEntry[]>([]);
  const aiEnabled = computed(() => {
    const dp = aiSettings.value.defaultProvider;
    return !!(dp && aiSettings.value.providers[dp]?.model);
  });

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
      aiSettings.value = await api.ai.settings();
    } catch {
      /* leave defaults — AI is optional */
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
  async function removeProvider(provider: AiProviderId): Promise<void> {
    aiSettings.value = await api.ai.removeProvider(provider);
  }
  /** Draft a commit message from the repo's diff (or just `paths`, for smart-commit per-group
   *  regenerate). Throws ApiError → caller toasts. */
  async function genCommitMessage(repoId: string, provider?: AiProviderId, paths?: string[]): Promise<string> {
    return (await api.ai.commitMessage(repoId, provider, paths)).message;
  }

  /** Propose a multi-commit plan from the repo's working tree (commits nothing). Throws
   *  ApiError (e.g. NO_AI_PROVIDER / NOTHING_TO_COMMIT) → the caller toasts. */
  async function genCommitPlan(repoId: string, provider?: AiProviderId): Promise<CommitPlanResponse> {
    return api.ai.commitPlan(repoId, provider);
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
    loadAiSettings,
    loadAiCatalog,
    connectProvider,
    listProviderModels,
    selectModel,
    setDefaultProvider,
    setYolo,
    setStyle,
    removeProvider,
    genCommitMessage,
    genCommitPlan,
    smartCommit,
  };
}
