<script setup lang="ts">
import { reactive, ref, computed, watch } from "vue";
import { useColorMode } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import {
  Sparkles,
  Check,
  Link2,
  Trash2,
  RefreshCw,
  X,
  ChevronDown,
  Palette,
  Cloud,
  Keyboard,
  Settings as SettingsIcon,
  FolderSearch,
  Plus,
  LogOut,
  Loader2,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { ApiError } from "../api";
import { useLockedSheetSide } from "@/lib/use-locked-sheet-side";
import { changesViewSize } from "@/lib/changes-view";
import { hotkeysEnabled, powerShortcuts, SHORTCUTS } from "@/lib/hotkeys";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import IdentityManager from "./IdentityManager.vue";
import type { AiCatalogEntry, AiModel, AiProviderId } from "../types";

const open = defineModel<boolean>("open", { required: true });
const store = useStore();
const { t } = useI18n();

// Shared light/dark/system theme — writes to the same store App.vue reads. §3.
const theme = useColorMode({ initialValue: "dark" });

const side = useLockedSheetSide(open);

// Human descriptions for the Keyboard-shortcuts reference list, keyed by Shortcut.id.
// Static t() literals (re-run on locale change) so the i18n parity check sees them used.
const shortcutDesc = computed<Record<string, string>>(() => ({
  commit: t("settings.hotkeysList.commit"),
  viewerClose: t("settings.hotkeysList.viewerClose"),
  viewerSave: t("settings.hotkeysList.viewerSave"),
  treeResize: t("settings.hotkeysList.treeResize"),
}));

// ── access mode (local ↔ remote) ──────────────────────────────────────────────
const isRemote = computed(() => store.mode === "remote");
const switchingMode = ref(false);
async function setAccessMode(toRemote: boolean): Promise<void> {
  switchingMode.value = true;
  try {
    await store.setMode(toRemote ? "remote" : "local");
  } catch (e) {
    if (e instanceof ApiError && e.code === "NEEDS_OWNER") {
      toast.message(t("remote.needsOwner"));
      window.location.href = "/oauth/login"; // claim ownership, then re-toggle
      return;
    }
    toast.error(t("remote.modeFailed"));
  } finally {
    switchingMode.value = false;
  }
}

// ── sign out everywhere (rotates the daemon signing key) ──────────────────────
const confirmSignOutAll = ref(false);
async function signOutAll(): Promise<void> {
  if (!confirmSignOutAll.value) {
    confirmSignOutAll.value = true; // inline two-step confirm
    return;
  }
  confirmSignOutAll.value = false;
  try {
    await store.logoutAll();
    toast.success(t("settings.signOutAllDone"));
    // The current device's cookie is now void too — reload so the auth gate re-evaluates.
    window.location.reload();
  } catch {
    toast.error(t("settings.signOutAllFailed"));
  }
}

// ── scan roots (discovery folders) ─────────────────────────────────────────────
const newRoot = ref("");
const addingRoot = ref(false);
const confirmRemoveRoot = ref<string | null>(null);
// Load the current roots whenever the sheet opens.
watch(open, (isOpen) => {
  if (isOpen) void store.loadRoots();
});
async function addRoot(): Promise<void> {
  const path = newRoot.value.trim();
  if (!path || addingRoot.value) return;
  addingRoot.value = true;
  try {
    await store.addScanRoot(path);
    toast.success(t("settings.rootsAdded", { path }));
    newRoot.value = "";
  } catch {
    toast.error(t("settings.rootsAddFailed"));
  } finally {
    addingRoot.value = false;
  }
}
async function removeRoot(path: string): Promise<void> {
  if (confirmRemoveRoot.value !== path) {
    confirmRemoveRoot.value = path; // first click arms the confirm
    return;
  }
  confirmRemoveRoot.value = null;
  try {
    const removed = await store.removeScanRoot(path);
    toast.success(t("settings.rootsRemoved", { count: removed }, removed));
  } catch {
    toast.error(t("settings.rootsRemoveFailed"));
  }
}

// Toggle the per-file/per-repo diff statistics (server setting; rolls back + toasts on fail).
async function onDiffStats(enabled: boolean): Promise<void> {
  try {
    await store.setDiffStats(enabled);
  } catch {
    toast.error(t("settings.diffStatsFailed"));
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

// Large-file Diff threshold (server setting). Preset sizes are powers of two so the labels
// read as real KB/MB (512 KB = 524288 = the server default). <Select> is string-valued, so
// map via String(bytes).
const DIFF_PATCH_OPTIONS = [
  { bytes: 256 * 1024, label: "256 KB" },
  { bytes: 512 * 1024, label: "512 KB" },
  { bytes: 1024 * 1024, label: "1 MB" },
  { bytes: 2 * 1024 * 1024, label: "2 MB" },
];
const diffPatchChoice = computed<string>({
  get: () => String(store.diffPatchBytes),
  set: (v: string) => void onDiffPatchBytes(Number(v)),
});
async function onDiffPatchBytes(bytes: number): Promise<void> {
  try {
    await store.setDiffPatchBytes(bytes);
  } catch {
    toast.error(t("settings.diffPatchThresholdFailed"));
  }
}

// "Always side-by-side" is the user-facing inverse of the server's compact-patch flag:
// ON → never use the compact patch (diffPatchEnabled = false).
async function onAlwaysSideBySide(always: boolean): Promise<void> {
  try {
    await store.setDiffPatchEnabled(!always);
  } catch {
    toast.error(t("settings.diffPatchAlwaysFailed"));
  }
}

// ── background remote-sync check ─────────────────────────────────────────────────
// Cadence presets (seconds). 30 is the server's floor; 600 (10 min) a relaxed ceiling.
const SYNC_INTERVAL_CHOICES = [30, 60, 120, 300, 600];
const syncIntervalLabel = (secs: number): string =>
  secs < 60
    ? t("settings.intervalSeconds", { n: secs }, secs)
    : t("settings.intervalMinutes", { n: secs / 60 }, secs / 60);
// <Select> is string-valued; map through String(secs) like the diff-threshold picker.
const syncIntervalChoice = computed<string>({
  get: () => String(store.syncIntervalSecs),
  set: (v: string) => void onSyncInterval(Number(v)),
});
async function onSyncCheck(enabled: boolean): Promise<void> {
  try {
    await store.setSyncCheck(enabled);
  } catch {
    toast.error(t("settings.syncCheckFailed"));
  }
}
async function onSyncInterval(secs: number): Promise<void> {
  try {
    await store.setSyncInterval(secs);
  } catch {
    toast.error(t("settings.syncIntervalFailed"));
  }
}
async function onKeepInSync(enabled: boolean): Promise<void> {
  try {
    await store.setKeepInSync(enabled);
  } catch {
    toast.error(t("settings.keepInSyncFailed"));
  }
}
// Desktop notifications are per-browser: turning them ON requests the Notification permission
// (this runs from the switch's click — a real user gesture, as browsers require).
async function onDesktopNotify(on: boolean): Promise<void> {
  if (!on) {
    store.disableDesktopNotify();
    return;
  }
  const perm = await store.enableDesktopNotify();
  if (perm !== "granted") toast.error(t("settings.desktopNotifyBlocked"));
}

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
  open,
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

</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent :side="side" class="gap-0 p-0">
      <SheetHeader class="border-b border-border/60">
        <SheetTitle class="flex items-center gap-2">
          <SettingsIcon :size="17" class="text-muted-foreground" /> {{ $t("settings.title") }}
        </SheetTitle>
        <SheetDescription>
          {{ $t("settings.description") }}
        </SheetDescription>
      </SheetHeader>

      <div class="scroll-slim flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <!-- Identities ─────────────────────────────────────────────────── -->
        <IdentityManager />

        <!-- Access (local ↔ remote) ───────────────────────────────────── -->
        <Card class="gap-3 border-border bg-secondary/20 py-4 shadow-none">
          <CardHeader class="gap-1 px-4">
            <CardTitle class="flex items-center gap-2 text-[13px]">
              <Cloud :size="15" class="text-muted-foreground" /> {{ $t("settings.cardAccess") }}
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-4 px-4">
            <label class="flex cursor-pointer items-center justify-between gap-3">
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.accessMode") }}</span>
                <span class="text-[12px] text-muted-foreground">
                  {{ isRemote ? $t("remote.modeOnHint") : $t("remote.modeOffHint") }}
                </span>
              </span>
              <Switch
                :model-value="isRemote"
                :disabled="switchingMode"
                :aria-label="$t('settings.accessMode')"
                @update:model-value="(v: boolean) => setAccessMode(v)"
              />
            </label>
            <!-- sign out everywhere (rotates the signing key → invalidates all devices) -->
            <div v-if="store.authEnforced" class="flex items-center justify-between gap-3">
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.signOutAll") }}</span>
                <span class="text-[12px] text-muted-foreground">{{ $t("settings.signOutAllHint") }}</span>
              </span>
              <Button
                :variant="confirmSignOutAll ? 'destructive' : 'outline'"
                size="sm"
                class="shrink-0"
                @click="signOutAll"
                @blur="confirmSignOutAll = false"
              >
                <LogOut />
                {{ confirmSignOutAll ? $t("settings.signOutAllConfirm") : $t("settings.signOutAll") }}
              </Button>
            </div>
          </CardContent>
        </Card>

        <!-- Scan folders (discovery roots) ───────────────────────────────── -->
        <Card class="gap-3 border-border bg-secondary/20 py-4 shadow-none">
          <CardHeader class="gap-1 px-4">
            <CardTitle class="flex items-center gap-2 text-[13px]">
              <FolderSearch :size="15" class="text-muted-foreground" /> {{ $t("settings.cardRoots") }}
            </CardTitle>
            <CardDescription class="text-[12px]">{{ $t("settings.rootsHint") }}</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-2.5 px-4">
            <p v-if="!store.roots.length" class="text-[12.5px] text-muted-foreground">
              {{ $t("settings.rootsEmpty") }}
            </p>
            <div
              v-for="r in store.roots"
              :key="r"
              class="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2.5 py-1.5"
            >
              <code class="mono min-w-0 flex-1 truncate text-[12px]" :title="r">{{ r }}</code>
              <Button
                :variant="confirmRemoveRoot === r ? 'destructive' : 'ghost'"
                size="sm"
                class="shrink-0"
                :aria-label="$t('settings.rootsRemove')"
                @click="removeRoot(r)"
                @blur="confirmRemoveRoot = null"
              >
                <Trash2 />
                <span v-if="confirmRemoveRoot === r">{{ $t("settings.rootsRemove") }}</span>
              </Button>
            </div>
            <form class="flex items-center gap-2 pt-0.5" @submit.prevent="addRoot">
              <Input
                v-model="newRoot"
                class="mono min-w-0 flex-1 text-[12.5px]"
                :placeholder="$t('settings.rootsPlaceholder')"
                :aria-label="$t('settings.rootsAdd')"
              />
              <Button type="submit" size="sm" class="shrink-0" :disabled="!newRoot.trim() || addingRoot">
                <Loader2 v-if="addingRoot" class="animate-spin" />
                <Plus v-else />
                {{ $t("settings.rootsAdd") }}
              </Button>
            </form>
          </CardContent>
        </Card>

        <!-- Appearance ───────────────────────────────────────────────── -->
        <Card class="gap-3 border-border bg-secondary/20 py-4 shadow-none">
          <CardHeader class="gap-1 px-4">
            <CardTitle class="flex items-center gap-2 text-[13px]">
              <Palette :size="15" class="text-muted-foreground" /> {{ $t("settings.cardAppearance") }}
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-4 px-4">
            <div class="flex flex-col gap-1.5">
              <span class="text-[12px] text-muted-foreground">{{ $t("settings.theme") }}</span>
              <Select v-model="theme">
                <SelectTrigger class="w-full" :aria-label="$t('settings.theme')"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">{{ $t("settings.themeLight") }}</SelectItem>
                  <SelectItem value="dark">{{ $t("settings.themeDark") }}</SelectItem>
                  <SelectItem value="auto">{{ $t("settings.themeSystem") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="text-[12px] text-muted-foreground">{{ $t("settings.changesHeight") }}</span>
              <Select v-model="changesViewSize">
                <SelectTrigger class="w-full" :aria-label="$t('settings.changesHeight')"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">{{ $t("settings.heightSmall") }}</SelectItem>
                  <SelectItem value="medium">{{ $t("settings.heightMedium") }}</SelectItem>
                  <SelectItem value="tall">{{ $t("settings.heightTall") }}</SelectItem>
                </SelectContent>
              </Select>
              <span class="text-[11px] text-muted-foreground/70">
                {{ $t("settings.changesHeightHint") }}
              </span>
            </div>
            <label class="flex cursor-pointer items-center justify-between gap-3">
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.diffStats") }}</span>
                <span class="text-[12px] text-muted-foreground">{{ $t("settings.diffStatsHint") }}</span>
              </span>
              <Switch
                :model-value="store.diffStatsEnabled"
                :aria-label="$t('settings.diffStats')"
                @update:model-value="(v: boolean) => onDiffStats(v)"
              />
            </label>
            <label class="flex cursor-pointer items-center justify-between gap-3">
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.diffPatchAlways") }}</span>
                <span class="text-[12px] text-muted-foreground">{{ $t("settings.diffPatchAlwaysHint") }}</span>
              </span>
              <Switch
                :model-value="!store.diffPatchEnabled"
                :aria-label="$t('settings.diffPatchAlways')"
                @update:model-value="(v: boolean) => onAlwaysSideBySide(v)"
              />
            </label>
            <!-- Threshold is moot when always-side-by-side is on → dim + disable it. -->
            <div
              class="flex flex-col gap-1.5 transition-opacity"
              :class="store.diffPatchEnabled ? '' : 'pointer-events-none opacity-50'"
            >
              <span class="text-[12px] text-muted-foreground">{{ $t("settings.diffPatchThreshold") }}</span>
              <Select v-model="diffPatchChoice" :disabled="!store.diffPatchEnabled">
                <SelectTrigger class="w-full" :aria-label="$t('settings.diffPatchThreshold')"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="o in DIFF_PATCH_OPTIONS" :key="o.bytes" :value="String(o.bytes)">
                    {{ o.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <span class="text-[11px] text-muted-foreground/70">
                {{ $t("settings.diffPatchThresholdHint") }}
              </span>
            </div>
          </CardContent>
        </Card>

        <!-- Background sync ─────────────────────────────────────────────── -->
        <Card class="gap-3 border-border bg-secondary/20 py-4 shadow-none">
          <CardHeader class="gap-1 px-4">
            <CardTitle class="flex items-center gap-2 text-[13px]">
              <RefreshCw :size="15" class="text-muted-foreground" /> {{ $t("settings.cardSync") }}
            </CardTitle>
            <CardDescription class="text-[12px]">{{ $t("settings.syncDescription") }}</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-4 px-4">
            <label class="flex cursor-pointer items-center justify-between gap-3">
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.syncCheck") }}</span>
                <span class="text-[12px] text-muted-foreground">{{ $t("settings.syncCheckHint") }}</span>
              </span>
              <Switch
                :model-value="store.syncCheckEnabled"
                :aria-label="$t('settings.syncCheck')"
                @update:model-value="(v: boolean) => onSyncCheck(v)"
              />
            </label>
            <!-- keep in sync (auto fast-forward) — only acts as part of the check → gate on it -->
            <label
              class="flex items-center justify-between gap-3 transition-opacity"
              :class="store.syncCheckEnabled ? 'cursor-pointer' : 'pointer-events-none opacity-50'"
            >
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.keepInSync") }}</span>
                <span class="text-[12px] text-muted-foreground">{{ $t("settings.keepInSyncHint") }}</span>
              </span>
              <Switch
                :model-value="store.keepInSync"
                :disabled="!store.syncCheckEnabled"
                :aria-label="$t('settings.keepInSync')"
                @update:model-value="(v: boolean) => onKeepInSync(v)"
              />
            </label>
            <!-- cadence — moot while the check is off → dim + disable it -->
            <div
              class="flex flex-col gap-1.5 transition-opacity"
              :class="store.syncCheckEnabled ? '' : 'pointer-events-none opacity-50'"
            >
              <span class="text-[12px] text-muted-foreground">{{ $t("settings.syncInterval") }}</span>
              <Select v-model="syncIntervalChoice" :disabled="!store.syncCheckEnabled">
                <SelectTrigger class="w-full" :aria-label="$t('settings.syncInterval')"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="s in SYNC_INTERVAL_CHOICES" :key="s" :value="String(s)">
                    {{ syncIntervalLabel(s) }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <span class="text-[11px] text-muted-foreground/70">{{ $t("settings.syncIntervalHint") }}</span>
            </div>
            <!-- desktop notifications (per-browser; rides the OS Notification permission) -->
            <label
              class="flex items-center justify-between gap-3 transition-opacity"
              :class="store.notifyPermission === 'unsupported' ? 'pointer-events-none opacity-50' : 'cursor-pointer'"
            >
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.desktopNotify") }}</span>
                <span class="text-[12px] text-muted-foreground">{{ $t("settings.desktopNotifyHint") }}</span>
              </span>
              <Switch
                :model-value="store.desktopNotify"
                :disabled="store.notifyPermission === 'unsupported'"
                :aria-label="$t('settings.desktopNotify')"
                @update:model-value="(v: boolean) => onDesktopNotify(v)"
              />
            </label>
            <p v-if="store.notifyPermission === 'denied'" class="text-[11px] text-warning">
              {{ $t("settings.desktopNotifyBlocked") }}
            </p>
          </CardContent>
        </Card>

        <!-- Keyboard shortcuts ───────────────────────────────────────── -->
        <Card class="gap-3 border-border bg-secondary/20 py-4 shadow-none">
          <CardHeader class="gap-1 px-4">
            <CardTitle class="flex items-center gap-2 text-[13px]">
              <Keyboard :size="15" class="text-muted-foreground" /> {{ $t("settings.cardHotkeys") }}
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-4 px-4">
            <label class="flex cursor-pointer items-center justify-between gap-3">
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.hotkeysEnable") }}</span>
                <span class="text-[12px] text-muted-foreground">{{ $t("settings.hotkeysEnableHint") }}</span>
              </span>
              <Switch v-model="hotkeysEnabled" :aria-label="$t('settings.hotkeysEnable')" />
            </label>

            <label
              class="flex items-center justify-between gap-3 transition-opacity"
              :class="hotkeysEnabled ? 'cursor-pointer' : 'pointer-events-none opacity-50'"
            >
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.hotkeysPower") }}</span>
                <span class="text-[12px] text-muted-foreground">{{ $t("settings.hotkeysPowerHint") }}</span>
              </span>
              <Switch
                v-model="powerShortcuts"
                :disabled="!hotkeysEnabled"
                :aria-label="$t('settings.hotkeysPower')"
              />
            </label>

            <div class="flex flex-col gap-2">
              <span class="text-[12px] text-muted-foreground">{{ $t("settings.hotkeysListLabel") }}</span>
              <ul class="flex flex-col gap-1.5">
                <li
                  v-for="s in SHORTCUTS"
                  :key="s.id"
                  class="flex items-center justify-between gap-3 transition-opacity"
                  :class="(s.power ? hotkeysEnabled && powerShortcuts : hotkeysEnabled) ? '' : 'opacity-40'"
                >
                  <span class="text-[12.5px] text-foreground">{{ shortcutDesc[s.id] }}</span>
                  <span class="flex shrink-0 items-center gap-1">
                    <kbd
                      v-for="k in s.keys"
                      :key="k"
                      class="mono rounded border border-border bg-secondary px-1.5 py-0.5 text-[10.5px] leading-none text-muted-foreground"
                    >{{ k }}</kbd>
                  </span>
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>

        <!-- AI commit messages ──────────────────────────────────────── -->
        <Card class="gap-4 border-border bg-secondary/20 py-4 shadow-none">
          <CardHeader class="gap-1.5 px-4">
            <CardTitle class="flex items-center gap-2 text-[13px]">
              <Sparkles :size="15" class="text-violet-300" /> {{ $t("settings.cardAi") }}
            </CardTitle>
            <CardDescription class="text-[12px] leading-relaxed">
              {{ $t("settings.aiDescription") }}
            </CardDescription>
          </CardHeader>

          <CardContent class="flex flex-col gap-4 px-4">
            <!-- Providers -->
            <div class="flex flex-col gap-1.5">
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
                        class="border-violet-500/30 bg-violet-500/15 px-1.5 py-0 text-[10px] font-medium text-violet-700 dark:text-violet-300"
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

            <!-- Smart-commit YOLO mode -->
            <label class="flex cursor-pointer items-center justify-between gap-3">
              <span class="flex flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.aiYolo") }}</span>
                <span class="text-[12px] text-muted-foreground">{{ $t("settings.aiYoloHint") }}</span>
              </span>
              <Switch
                :model-value="settings.yolo"
                :aria-label="$t('settings.aiYolo')"
                @update:model-value="(v: boolean) => onYolo(v)"
              />
            </label>
          </CardContent>
        </Card>
      </div>
    </SheetContent>
  </Sheet>
</template>
