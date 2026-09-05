<script setup lang="ts">
import { reactive, computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Link2, Plus, Trash2, RefreshCw, X, ChevronDown, Save } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { ApiError } from "../../api";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OPENAI_COMPATIBLE_PRESETS,
  compatiblePresetForUrl,
  compatiblePresetUrl,
  displayCompatibleBaseUrl,
  isLoopbackCompatibleBaseUrl,
} from "@/lib/ai-compatible";
import type { AiCatalogEntry, AiModel, AiProviderId, CommitStyle, DiffDetail } from "../../types";

/** Whether the parent Settings sheet is open — drives the model-list prefetch below. */
const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

/** Provider catalogue from the daemon — single source of truth, no hardcoding needed. */
const PROVIDERS = computed<AiCatalogEntry[]>(() => store.aiCatalog);

interface Row {
  open: boolean;
  keyInput: string;
  baseUrlInput: string;
  modelInput: string;
  connecting: boolean;
  loadingModels: boolean;
  confirmRemove: boolean;
  models: AiModel[];
  discoveryAvailable: boolean | null;
}
const blank = (): Row => ({
  open: false,
  keyInput: "",
  baseUrlInput: "",
  modelInput: "",
  connecting: false,
  loadingModels: false,
  confirmRemove: false,
  models: [],
  discoveryAvailable: null,
});
const rows = reactive<Record<string, Row>>({});
/** Lazily initialise a row the first time it's needed (handles dynamic catalog). */
function rowFor(id: AiProviderId): Row {
  if (!rows[id]) rows[id] = blank();
  return rows[id]!;
}

const settings = computed(() => store.aiSettings);
const isConfigured = (id: AiProviderId): boolean => !!settings.value.providers[id];

// ── which providers actually get a row ────────────────────────────────────────
// Listing the whole catalogue meant permanently staring at providers you don't use. Now the
// list is only what you've CONNECTED, plus anything you've explicitly opened via "Add provider"
// this session (`adding`). A provider leaves `adding` once it's connected (it's in the
// configured list from then on) or when you dismiss its card.
const adding = ref<AiProviderId[]>([]);
/** The "Add provider" trigger — focus lands back here when an added card is dismissed. */
const addProviderBtn = useTemplateRef<{ $el?: HTMLElement }>("addProviderBtn");
const shownProviders = computed<AiCatalogEntry[]>(() =>
  PROVIDERS.value.filter((p) => isConfigured(p.id) || adding.value.includes(p.id)),
);
/** Catalogue entries not connected and not already staged for adding — the picker's contents. */
const addableProviders = computed<AiCatalogEntry[]>(() =>
  PROVIDERS.value.filter((p) => !isConfigured(p.id) && !adding.value.includes(p.id)),
);
function beginAdd(id: AiProviderId): void {
  if (!adding.value.includes(id)) adding.value.push(id);
  rowFor(id).open = true; // drop straight into the key form — that's the whole point of picking it
}
function cancelAdd(id: AiProviderId): void {
  adding.value = adding.value.filter((x) => x !== id);
  rows[id] = blank();
  // Dismissing drops the whole card out of `shownProviders`, unmounting the Cancel button the
  // user just pressed — without this, focus would fall to <body>. Hand it back to the picker,
  // which is where they'd want to go next anyway.
  void nextTick(() => addProviderBtn.value?.$el?.focus?.());
}
// Once a provider is connected it no longer needs its "adding" slot; keeping it there would
// leave a stray Cancel button on a live provider's card.
watch(
  () => Object.keys(settings.value.providers).join(","),
  () => {
    adding.value = adding.value.filter((id) => !isConfigured(id));
  },
);
// Y5: the YOLO/style rows below act on AI-generated commit messages, moot with zero
// providers connected, so collapse them away entirely rather than show dead controls.
const anyProviderConfigured = computed(() => Object.keys(settings.value.providers).length > 0);
const savedModel = (id: AiProviderId): string | null => settings.value.providers[id]?.model ?? null;
const savedBaseUrl = (id: AiProviderId): string =>
  displayCompatibleBaseUrl(settings.value.providers[id]?.baseUrl);
const nameOf = (id: AiProviderId): string => PROVIDERS.value.find((p) => p.id === id)?.label ?? id;
const isCompatible = (provider: AiCatalogEntry | AiProviderId): boolean =>
  typeof provider === "string"
    ? provider === "compatible"
    : provider.id === "compatible" || provider.customBaseUrl === true;
const compatibleDestination = (id: AiProviderId): string =>
  savedBaseUrl(id) || displayCompatibleBaseUrl(rowFor(id).baseUrlInput);
const compatibleKeyOptional = (id: AiProviderId): boolean =>
  isLoopbackCompatibleBaseUrl(rowFor(id).baseUrlInput);
const selectedCompatiblePreset = (id: AiProviderId): string =>
  compatiblePresetForUrl(rowFor(id).baseUrlInput);

function applyCompatiblePreset(id: AiProviderId, presetId: string): void {
  const url = compatiblePresetUrl(presetId);
  if (url) rowFor(id).baseUrlInput = url;
}

function canConnect(id: AiProviderId): boolean {
  const row = rowFor(id);
  if (!isCompatible(id)) return !!row.keyInput.trim();
  if (!row.baseUrlInput.trim() || !row.modelInput.trim()) return false;
  return !!row.keyInput.trim() || compatibleKeyOptional(id);
}

function modelOptions(id: AiProviderId): { label: string; value: string }[] {
  // Mark the provider's curated `recommended` model (config.ts AI_CATALOG) when the live list has
  // it — a suffix rather than a separate badge because shadcn's SelectItem wraps the whole slot in
  // SelectItemText (so the trigger mirrors it too, which is fine: the picked model reads as such).
  const rec = PROVIDERS.value.find((p) => p.id === id)?.recommended;
  const opts = rowFor(id).models.map((m) => {
    const label = m.label || m.id;
    return { label: m.id === rec ? `${label} · ${t("settings.recommended")}` : label, value: m.id };
  });
  const sel = savedModel(id);
  if (sel && !opts.some((o) => o.value === sel)) opts.unshift({ label: sel, value: sel });
  return opts;
}

// When the sheet opens, fetch model lists for already-connected providers.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    for (const p of PROVIDERS.value) {
      if (isConfigured(p.id) && rowFor(p.id).models.length === 0) {
        void refreshModels(p.id);
      }
      if (isConfigured(p.id)) void store.loadKeyPool(p.id);
    }
  },
  { immediate: true },
);

// ── per-provider key rotation pool (src/ai/credential-pool.ts) ─────────────────────
// GET never returns a raw key, so the pool's extras (every key besides the primary connected
// above) are edited as a whole replace-the-list on Save, same shape as the Identity Firewall's
// rule rows. `poolRows` seeds empty (there is nothing to prefill with): saving always replaces
// the daemon's current extras with exactly what's in the list below, which is why a fresh Save
// with an empty list is exactly "clear the backup keys".
const poolRows = reactive<Record<string, string[]>>({});
const poolSaving = reactive<Record<string, boolean>>({});
function rowsFor(id: AiProviderId): string[] {
  if (!poolRows[id]) poolRows[id] = [];
  return poolRows[id]!;
}
function poolSnapshot(id: AiProviderId) {
  return store.keyPools[id] ?? null;
}
const keyStatusVariant = (status: string): "success" | "warning" | "destructive" | "secondary" => {
  switch (status) {
    case "ok":
      return "success";
    case "cooldown":
      return "warning";
    case "dead":
      return "destructive";
    default:
      return "secondary";
  }
};
const keyStatusLabel = (status: string): string => {
  switch (status) {
    case "ok":
      return t("settings.aiKeyStatusOk");
    case "cooldown":
      return t("settings.aiKeyStatusCooldown");
    case "dead":
      return t("settings.aiKeyStatusDead");
    default:
      return t("settings.aiKeyStatusUntested");
  }
};
function addPoolRow(id: AiProviderId): void {
  rowsFor(id).push("");
}
function removePoolRow(id: AiProviderId, i: number): void {
  rowsFor(id).splice(i, 1);
}
async function savePoolRows(id: AiProviderId): Promise<void> {
  const keys = rowsFor(id)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  poolSaving[id] = true;
  try {
    await store.setKeyPool(id, keys);
    toast.success(t("settings.aiKeyPoolSaved"));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("settings.aiKeyPoolSaveFailed"));
  } finally {
    poolSaving[id] = false;
  }
}

async function connect(id: AiProviderId): Promise<void> {
  const row = rowFor(id);
  const key = row.keyInput.trim();
  if (!canConnect(id)) return;
  row.connecting = true;
  try {
    const result = await store.connectProvider(
      id,
      key,
      isCompatible(id)
        ? { baseUrl: row.baseUrlInput.trim(), model: row.modelInput.trim() }
        : {},
    );
    row.models = result.models;
    row.discoveryAvailable = result.discoveryAvailable;
    row.keyInput = "";
    row.baseUrlInput = "";
    row.modelInput = "";
    toast.success(
      t(
        "settings.toastConnected",
        { name: nameOf(id), count: result.models.length },
        result.models.length,
      ),
    );
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("settings.toastConnectFailed"));
  } finally {
    row.connecting = false;
  }
}

async function refreshModels(id: AiProviderId): Promise<void> {
  const row = rowFor(id);
  row.loadingModels = true;
  try {
    const result = await store.listProviderModels(id);
    row.models = result.models;
    row.discoveryAvailable = result.discoveryAvailable;
  } catch {
    /* keep whatever we had — refresh is best-effort */
  } finally {
    row.loadingModels = false;
  }
}

async function onModel(id: AiProviderId, model: string): Promise<void> {
  try {
    await store.selectModel(id, model || null);
  } catch {
    toast.error(t("settings.toastModelFailed"));
  }
}

async function makeDefault(id: AiProviderId): Promise<void> {
  try {
    await store.setDefaultProvider(id);
  } catch {
    toast.error(t("settings.toastDefaultFailed"));
  }
}

async function remove(id: AiProviderId): Promise<void> {
  try {
    await store.removeProvider(id);
    rows[id] = blank();
    toast.success(t("settings.toastRemoved", { name: nameOf(id) }));
  } catch {
    toast.error(t("settings.toastRemoveFailed"));
  }
}

// Toggle whether the AI commit buttons (Generate + Auto) show on repo cards at all.
async function onCommitEnabled(enabled: boolean): Promise<void> {
  try {
    await store.setCommitEnabled(enabled);
  } catch {
    toast.error(t("settings.aiCommitEnableFailed"));
  }
}

// Toggle whether "Resolve with AI" shows on conflicted files. There is deliberately no YOLO
// counterpart: this is the only AI feature here that writes SOURCE, so the review step between
// proposal and apply is the feature, not a setting.
async function onConflictEnabled(enabled: boolean): Promise<void> {
  try {
    await store.setConflictEnabled(enabled);
  } catch {
    toast.error(t("settings.aiConflictEnableFailed"));
  }
}

// Toggle smart-commit YOLO mode (commit the AI plan without the review editor).
async function onYolo(enabled: boolean): Promise<void> {
  try {
    await store.setYolo(enabled);
  } catch {
    toast.error(t("settings.aiYoloFailed"));
  }
}

// Set the AI commit-message style (conventional / concise / detailed).
async function onStyle(style: string): Promise<void> {
  try {
    await store.setStyle(style as CommitStyle);
  } catch {
    toast.error(t("settings.aiStyleFailed"));
  }
}

// Set how much of each file's diff the smart-commit planner reads (lean / balanced / thorough).
async function onDiffDetail(detail: string): Promise<void> {
  try {
    await store.setDiffDetail(detail as DiffDetail);
  } catch {
    toast.error(t("settings.aiDiffDetailFailed"));
  }
}
</script>

<template>
  <!-- AI commit messages ──────────────────────────────────────── -->
  <SettingsGroup :label="$t('settings.cardAi')" :description="$t('settings.aiDescription')">
    <!-- Master toggle: show the AI commit buttons at all (default on, even with no key). -->
    <SettingsRow :label="$t('settings.aiCommitEnable')">
      <template #info><InfoHint :text="$t('settings.aiCommitEnableHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.aiCommitEnabled"
          :aria-label="$t('settings.aiCommitEnable')"
          @update:model-value="(v: boolean) => onCommitEnabled(v)"
        />
      </template>
    </SettingsRow>

    <!-- Merge-conflict resolution (default on). Separate from the commit toggle because it is a
         different kind of risk: commit messages are prose the owner reads, this writes code. -->
    <SettingsRow :label="$t('settings.aiConflictEnabled')">
      <template #info><InfoHint :text="$t('settings.aiConflictEnabledHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.aiSettings.conflictEnabled"
          :aria-label="$t('settings.aiConflictEnabled')"
          @update:model-value="(v: boolean) => onConflictEnabled(v)"
        />
      </template>
    </SettingsRow>

    <!-- Providers — only the ones you've connected (plus any you're adding right now). -->
    <div class="flex flex-col gap-1.5 px-3.5 py-3">
      <span class="text-[12px] text-muted-foreground">{{ $t("settings.providers") }}</span>
      <p v-if="!shownProviders.length" class="text-[12px] text-muted-foreground/70">
        {{ $t("settings.providersEmpty") }}
      </p>
      <div v-auto-animate class="flex flex-col gap-2">
        <Collapsible
          v-for="p in shownProviders"
          :key="p.id"
          v-model:open="rowFor(p.id).open"
          class="overflow-hidden rounded-lg border border-border bg-secondary/45"
          @update:open="(o) => { if (!o) rowFor(p.id).confirmRemove = false }"
        >
          <CollapsibleTrigger
            class="group flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-secondary/40"
          >
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-[13px] font-semibold">{{ p.label }}</span>
              <Badge
                v-if="isConfigured(p.id)"
                variant="success"
                class="gap-1 px-1.5 py-0 text-[10px]"
              >
                <Check :size="10" /> {{ $t("settings.badgeActive") }}
              </Badge>
              <Badge
                v-else-if="p.suggested"
                variant="info"
                class="px-1.5 py-0 text-[10px]"
              >
                {{ $t("settings.badgeSuggested") }}
              </Badge>
              <Badge
                v-if="settings.defaultProvider === p.id"
                variant="primary"
                class="px-1.5 py-0 text-[10px]"
              >
                {{ $t("settings.badgeDefault") }}
              </Badge>
            </div>
            <ChevronDown
              :size="16"
              aria-hidden="true"
              class="pointer-events-none shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div class="flex flex-col gap-2.5 border-t border-border/60 px-3 py-3">
              <!-- tier + provider link. The "Free tier available" badge is a catalog fact about the
                   VENDOR (they offer a no-cost tier) — NOT a statement about the owner's key/plan —
                   so an InfoHint spells that out (owners kept reading it as "only free tier works"). -->
              <div v-if="p.free || p.url" class="flex items-center justify-between gap-2">
                <span v-if="p.free" class="flex items-center gap-1">
                  <Badge variant="success" class="px-1.5 py-0 text-[10px]">
                    {{ $t("settings.badgeFreeTier") }}
                  </Badge>
                  <InfoHint :text="$t('settings.freeTierHint')" />
                </span>
                <a
                  v-if="p.url"
                  :href="`https://${p.url}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="mono ml-auto text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >{{ p.url }}</a>
              </div>

              <!-- not configured → bring your own key. For the suggested provider (Groq), a short
                   nudge: it's free + fast and takes ~30s, so a fresh install has an obvious path. -->
              <div v-if="!isConfigured(p.id)" class="flex flex-col gap-2.5">
                <p v-if="p.suggested && p.url" class="text-[12px] text-muted-foreground">
                  {{ $t("settings.suggestedNudge") }}
                  <a
                    :href="`https://${p.url}`"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-primary underline-offset-2 hover:underline"
                  >{{ p.url }}</a>
                </p>

                <div
                  v-if="isCompatible(p)"
                  class="flex flex-col gap-2.5 rounded-md border border-border/70 bg-background/35 p-2.5"
                >
                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] font-medium text-muted-foreground">
                      {{ $t("settings.compatiblePreset") }}
                    </span>
                    <Select
                      :model-value="selectedCompatiblePreset(p.id)"
                      @update:model-value="(v) => typeof v === 'string' && applyCompatiblePreset(p.id, v)"
                    >
                      <SelectTrigger class="w-full" :aria-label="$t('settings.compatiblePreset')">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem
                          v-for="preset in OPENAI_COMPATIBLE_PRESETS"
                          :key="preset.id"
                          :value="preset.id"
                        >
                          {{ preset.label }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <p class="text-[11px] leading-relaxed text-muted-foreground">
                    {{ $t("settings.compatiblePresetHint") }}
                  </p>

                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] font-medium text-muted-foreground">
                      {{ $t("settings.compatibleBaseUrl") }}
                    </span>
                    <Input
                      v-model="rowFor(p.id).baseUrlInput"
                      type="url"
                      spellcheck="false"
                      autocomplete="url"
                      :aria-label="$t('settings.compatibleBaseUrl')"
                      :placeholder="$t('settings.compatibleBaseUrlPlaceholder')"
                      @keyup.enter="connect(p.id)"
                    />
                  </label>

                  <p
                    v-if="compatibleDestination(p.id)"
                    class="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
                  >
                    {{
                      $t("settings.compatibleDestinationDisclosure", {
                        url: compatibleDestination(p.id),
                      })
                    }}
                  </p>

                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] font-medium text-muted-foreground">
                      {{ $t("settings.compatibleManualModel") }}
                    </span>
                    <Input
                      v-model="rowFor(p.id).modelInput"
                      type="text"
                      spellcheck="false"
                      :aria-label="$t('settings.compatibleManualModel')"
                      :placeholder="$t('settings.compatibleManualModelPlaceholder')"
                      @keyup.enter="connect(p.id)"
                    />
                  </label>
                  <p class="text-[11px] leading-relaxed text-muted-foreground">
                    {{ $t("settings.compatibleManualModelHint") }}
                  </p>
                </div>

                <!-- Every provider ships selected diffs/prompts to it — a custom endpoint is not
                     more of a privacy step than Groq or Anthropic, so the same warning applies to
                     all of them, just naming the provider instead of a typed URL. -->
                <p
                  v-else
                  class="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {{ $t("settings.providerDestinationDisclosure", { name: p.label }) }}
                </p>

                <div class="flex items-center gap-2">
                  <Input
                    v-model="rowFor(p.id).keyInput"
                    type="password"
                    class="flex-1"
                    :aria-label="`${p.label} API key`"
                    :placeholder="
                      isCompatible(p) && compatibleKeyOptional(p.id)
                        ? $t('settings.compatibleApiKeyOptionalPlaceholder')
                        : p.keyPlaceholder
                    "
                    @keyup.enter="connect(p.id)"
                  />
                  <Button
                    size="sm"
                    :disabled="!canConnect(p.id) || rowFor(p.id).connecting"
                    @click="connect(p.id)"
                  >
                    <Link2 />
                    {{ $t("settings.btnConnect") }}
                  </Button>
                  <!-- only a provider you just added via the picker can be dismissed again;
                       a connected one is removed with the trash button instead -->
                  <Button
                    v-if="adding.includes(p.id)"
                    variant="ghost"
                    size="sm"
                    @click="cancelAdd(p.id)"
                  >
                    {{ $t("common.cancel") }}
                  </Button>
                </div>
                <p v-if="isCompatible(p)" class="text-[11px] leading-relaxed text-muted-foreground">
                  {{
                    compatibleKeyOptional(p.id)
                      ? $t("settings.compatibleApiKeyLoopbackHint")
                      : $t("settings.compatibleApiKeyRemoteHint")
                  }}
                </p>
              </div>

              <!-- owner-configured → choose a model, set default, or remove -->
              <template v-else>
                <div
                  v-if="isCompatible(p) && compatibleDestination(p.id)"
                  class="rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {{
                    $t("settings.compatibleSavedDestination", {
                      url: compatibleDestination(p.id),
                    })
                  }}
                </div>
                <div
                  v-else-if="!isCompatible(p)"
                  class="rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {{ $t("settings.providerSavedDestination", { name: p.label }) }}
                </div>

                <div class="flex items-center gap-2">
                  <Select
                    :model-value="savedModel(p.id) ?? undefined"
                    :disabled="rowFor(p.id).loadingModels"
                    @update:model-value="(v) => typeof v === 'string' && onModel(p.id, v)"
                  >
                    <SelectTrigger class="flex-1" :aria-label="`${p.label} model`">
                      <SelectValue :placeholder="$t('settings.selectModelPlaceholder')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="o in modelOptions(p.id)" :key="o.value" :value="o.value">
                        {{ o.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :aria-label="$t('settings.btnRefreshModels')"
                    :disabled="rowFor(p.id).loadingModels"
                    @click="refreshModels(p.id)"
                  >
                    <RefreshCw :class="rowFor(p.id).loadingModels && 'animate-spin'" />
                  </Button>
                </div>

                <p
                  v-if="isCompatible(p) && rowFor(p.id).discoveryAvailable === false"
                  class="text-[11px] leading-relaxed text-muted-foreground"
                >
                  {{ $t("settings.compatibleDiscoveryUnavailable") }}
                </p>

                <!-- Backup keys (rotation pool): never shows a full key, only its masked
                     fingerprint + health. See src/ai/credential-pool.ts. -->
                <div class="flex flex-col gap-2 rounded-md border border-border/70 bg-background/35 p-2.5">
                  <div class="flex items-center gap-1.5">
                    <span class="text-[11px] font-medium text-muted-foreground">
                      {{ $t("settings.aiKeyPoolTitle") }}
                    </span>
                    <InfoHint :text="$t('settings.aiKeyPoolHint')" />
                  </div>

                  <div v-if="poolSnapshot(p.id)" class="flex flex-wrap gap-1.5">
                    <span
                      v-for="entry in poolSnapshot(p.id)!.entries"
                      :key="entry.id"
                      class="inline-flex items-center gap-1 rounded-full border border-border/70 py-0.5 pl-2 pr-1 text-[10.5px] mono text-muted-foreground"
                    >
                      {{ entry.id }}
                      <Badge :variant="keyStatusVariant(entry.status)" class="px-1.5 py-0 text-[9.5px]">
                        {{ keyStatusLabel(entry.status) }}
                      </Badge>
                    </span>
                    <span v-if="!poolSnapshot(p.id)!.entries.length" class="text-[11px] text-muted-foreground/70">
                      {{ $t("settings.aiKeyPoolNoKeys") }}
                    </span>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <div v-for="(_k, i) in rowsFor(p.id)" :key="i" class="flex items-center gap-1.5">
                      <Input
                        v-model="rowsFor(p.id)[i]"
                        type="password"
                        class="flex-1 text-[12px]"
                        autocomplete="off"
                        spellcheck="false"
                        :aria-label="$t('settings.aiKeyPoolEntryLabel', { n: i + 1 })"
                        :placeholder="$t('settings.aiKeyPoolPlaceholder')"
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        class="shrink-0 text-muted-foreground hover:text-destructive"
                        :aria-label="$t('settings.aiKeyPoolRemove')"
                        @click="removePoolRow(p.id, i)"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <div class="flex items-center gap-2">
                      <Button variant="outline" size="sm" @click="addPoolRow(p.id)">
                        <Plus />
                        {{ $t("settings.aiKeyPoolAdd") }}
                      </Button>
                      <Button
                        size="sm"
                        class="ml-auto"
                        :disabled="poolSaving[p.id]"
                        @click="savePoolRows(p.id)"
                      >
                        <Save />
                        {{ $t("settings.aiKeyPoolSave") }}
                      </Button>
                    </div>
                    <p class="text-[11px] leading-relaxed text-muted-foreground">
                      {{ $t("settings.aiKeyPoolSaveHint") }}
                    </p>
                  </div>
                </div>

                <div class="flex items-center gap-2">
                  <Button
                    v-if="settings.defaultProvider !== p.id"
                    variant="secondary"
                    size="sm"
                    @click="makeDefault(p.id)"
                  >
                    {{ $t("settings.btnSetDefault") }}
                  </Button>

                  <div class="ml-auto flex items-center gap-2">
                    <template v-if="rowFor(p.id).confirmRemove">
                      <Button variant="destructive" size="sm" @click="remove(p.id)">
                        <Check />
                        {{ $t("settings.btnConfirmRemove") }}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        :aria-label="$t('common.cancel')"
                        @click="rowFor(p.id).confirmRemove = false"
                      >
                        <X />
                      </Button>
                    </template>
                    <Button
                      v-else
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:text-destructive"
                      :aria-label="$t('settings.btnRemoveKey')"
                      @click="rowFor(p.id).confirmRemove = true"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </template>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <!-- Add provider: a picker over everything in the catalogue you haven't connected. Picking
           one drops its card into the list above, already open on its key form. -->
      <DropdownMenu v-if="addableProviders.length">
        <DropdownMenuTrigger as-child>
          <Button ref="addProviderBtn" variant="secondary" size="sm" class="mt-0.5 self-start">
            <Plus />
            {{ $t("settings.addProvider") }}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="max-w-60">
          <DropdownMenuLabel>{{ $t("settings.addProviderLabel") }}</DropdownMenuLabel>
          <DropdownMenuItem v-for="p in addableProviders" :key="p.id" @select="beginAdd(p.id)">
            <span class="min-w-0 flex-1 truncate">{{ p.label }}</span>
            <Badge v-if="p.suggested" variant="info" class="shrink-0 px-1.5 py-0 text-[10px]">
              {{ $t("settings.badgeSuggested") }}
            </Badge>
            <Badge v-else-if="p.free" variant="success" class="shrink-0 px-1.5 py-0 text-[10px]">
              {{ $t("settings.badgeFreeTier") }}
            </Badge>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- Both rows below act on AI-generated commit messages, moot with no provider
         connected, so collapse them away entirely rather than show dead controls. -->
    <ExpandTransition :open="anyProviderConfigured">
      <div class="flex flex-col">
        <!-- Smart-commit YOLO mode -->
        <SettingsRow :label="$t('settings.aiYolo')">
          <template #info><InfoHint :text="$t('settings.aiYoloHint')" /></template>
          <template #control>
            <Switch
              :model-value="settings.yolo"
              :aria-label="$t('settings.aiYolo')"
              @update:model-value="(v: boolean) => onYolo(v)"
            />
          </template>
        </SettingsRow>

        <!-- AI commit-message style (themed Select; a native <select>'s popup ignores our theme
             entirely, rendering with the OS's own near-black dark-mode background). -->
        <SettingsRow :label="$t('settings.aiStyle')">
          <template #info><InfoHint :text="$t('settings.aiStyleHint')" /></template>
          <template #control>
            <Select :model-value="settings.style" @update:model-value="(v) => typeof v === 'string' && onStyle(v)">
              <SelectTrigger class="w-36" :aria-label="$t('settings.aiStyle')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conventional">{{ $t("settings.aiStyleConventional") }}</SelectItem>
                <SelectItem value="concise">{{ $t("settings.aiStyleConcise") }}</SelectItem>
                <SelectItem value="detailed">{{ $t("settings.aiStyleDetailed") }}</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </SettingsRow>

        <!-- The token-cost dial. Sits next to the style picker because together they're "what the
             AI reads" + "what it writes". -->
        <SettingsRow :label="$t('settings.aiDiffDetail')">
          <template #info><InfoHint :text="$t('settings.aiDiffDetailHint')" /></template>
          <template #control>
            <Select
              :model-value="settings.diffDetail"
              @update:model-value="(v) => typeof v === 'string' && onDiffDetail(v)"
            >
              <SelectTrigger class="w-36" :aria-label="$t('settings.aiDiffDetail')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="lean">{{ $t("settings.aiDiffDetailLean") }}</SelectItem>
                <SelectItem value="balanced">{{ $t("settings.aiDiffDetailBalanced") }}</SelectItem>
                <SelectItem value="thorough">{{ $t("settings.aiDiffDetailThorough") }}</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </SettingsRow>
      </div>
    </ExpandTransition>
  </SettingsGroup>
</template>
