<script setup lang="ts">
import { reactive, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Link2, Trash2, RefreshCw, X, ChevronDown } from "@lucide/vue";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AiCatalogEntry, AiModel, AiProviderId, CommitStyle } from "../../types";

/** Whether the parent Settings sheet is open — drives the model-list prefetch below. */
const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

/** Provider catalogue from the daemon — single source of truth, no hardcoding needed. */
const PROVIDERS = computed<AiCatalogEntry[]>(() => store.aiCatalog);

interface Row {
  open: boolean;
  keyInput: string;
  connecting: boolean;
  loadingModels: boolean;
  confirmRemove: boolean;
  /** Built-in provider only: reveal the "bring your own key" input instead of the built-in note. */
  useOwnKey: boolean;
  models: AiModel[];
}
const blank = (): Row => ({
  open: false,
  keyInput: "",
  connecting: false,
  loadingModels: false,
  confirmRemove: false,
  useOwnKey: false,
  models: [],
});
const rows = reactive<Record<string, Row>>({});
/** Lazily initialise a row the first time it's needed (handles dynamic catalog). */
function rowFor(id: AiProviderId): Row {
  if (!rows[id]) rows[id] = blank();
  return rows[id]!;
}

const settings = computed(() => store.aiSettings);
const isConfigured = (id: AiProviderId): boolean => !!settings.value.providers[id];
// Y5: the YOLO/style rows below act on AI-generated commit messages, moot with zero
// providers connected, so collapse them away entirely rather than show dead controls.
const anyProviderConfigured = computed(() => Object.keys(settings.value.providers).length > 0);
/** Groq served by the free built-in key (owner hasn't pasted their own key for it). */
const isBuiltin = (id: AiProviderId): boolean => settings.value.providers[id]?.builtin === true;
const savedModel = (id: AiProviderId): string | null => settings.value.providers[id]?.model ?? null;
const nameOf = (id: AiProviderId): string => PROVIDERS.value.find((p) => p.id === id)?.label ?? id;

function modelOptions(id: AiProviderId): { label: string; value: string }[] {
  const opts = rowFor(id).models.map((m) => ({ label: m.label || m.id, value: m.id }));
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
      // The built-in provider shows no model picker, so it needs no model list.
      if (isConfigured(p.id) && !isBuiltin(p.id) && rowFor(p.id).models.length === 0) {
        void refreshModels(p.id);
      }
    }
  },
  { immediate: true },
);

async function connect(id: AiProviderId): Promise<void> {
  const row = rowFor(id);
  const key = row.keyInput.trim();
  if (!key) return;
  row.connecting = true;
  try {
    const models = await store.connectProvider(id, key);
    row.models = models;
    row.keyInput = "";
    row.useOwnKey = false; // now owner-keyed → show the normal model picker
    toast.success(t("settings.toastConnected", { name: nameOf(id), count: models.length }, models.length));
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
    row.models = await store.listProviderModels(id);
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
</script>

<template>
  <!-- AI commit messages ──────────────────────────────────────── -->
  <SettingsGroup :label="$t('settings.cardAi')" :description="$t('settings.aiDescription')">
    <!-- Providers -->
    <div class="flex flex-col gap-1.5 px-3.5 py-3">
      <span class="text-[12px] text-muted-foreground">{{ $t("settings.providers") }}</span>
      <div v-auto-animate class="flex flex-col gap-2">
        <Collapsible
          v-for="p in PROVIDERS"
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
                v-if="isBuiltin(p.id)"
                variant="info"
                class="px-1.5 py-0 text-[10px]"
              >
                {{ $t("settings.badgeBuiltin") }}
              </Badge>
              <Badge
                v-else-if="isConfigured(p.id)"
                variant="success"
                class="gap-1 px-1.5 py-0 text-[10px]"
              >
                <Check :size="10" /> {{ $t("settings.badgeActive") }}
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
              <!-- tier + provider link -->
              <div class="flex items-center justify-between gap-2">
                <Badge
                  v-if="p.free"
                  variant="success"
                  class="px-1.5 py-0 text-[10px]"
                >
                  {{ $t("settings.badgeFreeTier") }}
                </Badge>
                <a
                  :href="`https://${p.url}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="mono ml-auto text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >{{ p.url }}</a>
              </div>

              <!-- built-in free key (Groq, zero setup) → use as-is or switch to your own key -->
              <div v-if="isBuiltin(p.id) && !rowFor(p.id).useOwnKey" class="flex flex-col gap-2.5">
                <div class="text-[12px] text-muted-foreground">
                  {{ $t("settings.builtinKeyNote") }}
                  <span class="mono text-foreground">{{ savedModel(p.id) }}</span>
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
                  <Button
                    variant="ghost"
                    size="sm"
                    class="ml-auto text-muted-foreground"
                    @click="rowFor(p.id).useOwnKey = true"
                  >
                    <Link2 />
                    {{ $t("settings.btnUseOwnKey") }}
                  </Button>
                </div>
              </div>

              <!-- not configured (or "use your own key" on the built-in) → paste a key and connect -->
              <div
                v-else-if="!isConfigured(p.id) || (isBuiltin(p.id) && rowFor(p.id).useOwnKey)"
                class="flex items-center gap-2"
              >
                <Input
                  v-model="rowFor(p.id).keyInput"
                  type="password"
                  class="flex-1"
                  :aria-label="`${p.label} API key`"
                  :placeholder="p.keyPlaceholder"
                  @keyup.enter="connect(p.id)"
                />
                <Button
                  size="sm"
                  :disabled="!rowFor(p.id).keyInput.trim() || rowFor(p.id).connecting"
                  @click="connect(p.id)"
                >
                  <Link2 />
                  {{ $t("settings.btnConnect") }}
                </Button>
                <Button
                  v-if="isBuiltin(p.id) && rowFor(p.id).useOwnKey"
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="$t('common.cancel')"
                  @click="rowFor(p.id).useOwnKey = false; rowFor(p.id).keyInput = ''"
                >
                  <X />
                </Button>
              </div>

              <!-- owner-configured → choose a model, set default, or remove -->
              <template v-else>
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
              <SelectTrigger class="w-44" :aria-label="$t('settings.aiStyle')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conventional">{{ $t("settings.aiStyleConventional") }}</SelectItem>
                <SelectItem value="concise">{{ $t("settings.aiStyleConcise") }}</SelectItem>
                <SelectItem value="detailed">{{ $t("settings.aiStyleDetailed") }}</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </SettingsRow>
      </div>
    </ExpandTransition>
  </SettingsGroup>
</template>
