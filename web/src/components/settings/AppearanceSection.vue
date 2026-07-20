<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { changesViewSize } from "@/lib/changes-view";
import { historyFilesView } from "@/lib/history-view";
import { useTheme } from "@/lib/theme";
import { useTooltipConfig } from "@/lib/tooltip-config";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const store = useStore();
const { t } = useI18n();

// Shared kit light/dark/system theme — writes to the same store App.vue reads.
const { mode: theme } = useTheme();

// Kit-wide tooltip kill-switch (localStorage, like theme). The root TooltipProvider reads
// this flag; InfoHints opt out and stay on (see kit lib/tooltip-config.ts + InfoHint.vue).
const { enabled: tooltipsEnabled } = useTooltipConfig();

// Toggle the per-file/per-repo diff statistics (server setting; rolls back + toasts on fail).
async function onDiffStats(enabled: boolean): Promise<void> {
  try {
    await store.setDiffStats(enabled);
  } catch {
    toast.error(t("settings.diffStatsFailed"));
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

// Toggle "Portable window" (server setting). Turning it ON also opens one right away, so the
// owner sees the effect immediately instead of only on the next launch.
async function onPortableMode(enabled: boolean): Promise<void> {
  try {
    await store.setPortableMode(enabled);
  } catch {
    toast.error(t("settings.portableWindowFailed"));
    return;
  }
  if (!enabled) return;
  // The setting is already persisted; the immediate open is best-effort on top of it,
  // so a transport failure here (daemon mid-restart, expired session) must surface a
  // toast too, not become an unhandled rejection.
  try {
    const r = await store.openPortableWindow();
    if (r.ok) toast.success(t("settings.portableWindowOpened"));
    else toast.error(t("settings.portableWindowNoBrowser"));
  } catch {
    toast.error(t("settings.portableWindowFailed"));
  }
}

// Toggle "Hide tray icon" (server setting; rolls back + toasts on fail).
async function onHideTrayIcon(enabled: boolean): Promise<void> {
  try {
    await store.setHideTrayIcon(enabled);
  } catch {
    toast.error(t("settings.hideTrayIconFailed"));
  }
}
</script>

<template>
  <!-- Appearance ───────────────────────────────────────────────── -->
  <SettingsGroup :label="$t('settings.cardAppearance')">
    <SettingsRow :label="$t('settings.theme')">
      <template #control>
        <Select v-model="theme">
          <SelectTrigger class="w-full max-w-36" :aria-label="$t('settings.theme')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="light">{{ $t("settings.themeLight") }}</SelectItem>
            <SelectItem value="dark">{{ $t("settings.themeDark") }}</SelectItem>
            <SelectItem value="system">{{ $t("settings.themeSystem") }}</SelectItem>
          </SelectContent>
        </Select>
      </template>
    </SettingsRow>
    <SettingsRow :label="$t('settings.showTooltips')">
      <template #info><InfoHint :text="$t('settings.showTooltipsHint')" /></template>
      <template #control>
        <Switch v-model="tooltipsEnabled" :aria-label="$t('settings.showTooltips')" />
      </template>
    </SettingsRow>
    <!-- History detail: changed files as a nested folder tree (default) or a flat path list.
         Client-side view preference (localStorage) — see @/lib/history-view. -->
    <SettingsRow :label="$t('settings.historyFilesTree')">
      <template #info><InfoHint :text="$t('settings.historyFilesTreeHint')" /></template>
      <template #control>
        <Switch
          :model-value="historyFilesView === 'tree'"
          :aria-label="$t('settings.historyFilesTree')"
          @update:model-value="(v: boolean) => (historyFilesView = v ? 'tree' : 'list')"
        />
      </template>
    </SettingsRow>
    <SettingsRow :label="$t('settings.portableWindow')">
      <template #info><InfoHint :text="$t('settings.portableWindowHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.portableMode"
          :aria-label="$t('settings.portableWindow')"
          @update:model-value="(v: boolean) => onPortableMode(v)"
        />
      </template>
    </SettingsRow>
    <SettingsRow :label="$t('settings.hideTrayIcon')">
      <template #info><InfoHint :text="$t('settings.hideTrayIconHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.hideTrayIcon"
          :aria-label="$t('settings.hideTrayIcon')"
          @update:model-value="(v: boolean) => onHideTrayIcon(v)"
        />
      </template>
    </SettingsRow>
    <SettingsRow :label="$t('settings.changesHeight')">
      <template #info><InfoHint :text="$t('settings.changesHeightHint')" /></template>
      <template #control>
        <Select v-model="changesViewSize">
          <SelectTrigger class="w-full max-w-36" :aria-label="$t('settings.changesHeight')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="small">{{ $t("settings.heightSmall") }}</SelectItem>
            <SelectItem value="medium">{{ $t("settings.heightMedium") }}</SelectItem>
            <SelectItem value="tall">{{ $t("settings.heightTall") }}</SelectItem>
          </SelectContent>
        </Select>
      </template>
    </SettingsRow>
    <!-- Diff display rows live in this same group — they're every bit "how things look",
         and a separate two-row "Diffs" header was one lone-header section too many. -->
    <SettingsRow :label="$t('settings.diffStats')">
      <template #info><InfoHint :text="$t('settings.diffStatsHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.diffStatsEnabled"
          :aria-label="$t('settings.diffStats')"
          @update:model-value="(v: boolean) => onDiffStats(v)"
        />
      </template>
    </SettingsRow>
    <SettingsRow :label="$t('settings.diffPatchAlways')">
      <template #info><InfoHint :text="$t('settings.diffPatchAlwaysHint')" /></template>
      <template #control>
        <Switch
          :model-value="!store.diffPatchEnabled"
          :aria-label="$t('settings.diffPatchAlways')"
          @update:model-value="(v: boolean) => onAlwaysSideBySide(v)"
        />
      </template>
    </SettingsRow>
    <!-- Threshold is moot when always-side-by-side is on → HIDE it (not dim). Laid out as a
         standard row (label left, control right) like every other setting, rather than the
         stacked label-above-a-full-width-select it used to be. -->
    <ExpandTransition :open="store.diffPatchEnabled">
      <SettingsRow :label="$t('settings.diffPatchThreshold')">
        <template #info><InfoHint :text="$t('settings.diffPatchThresholdHint')" /></template>
        <template #control>
          <Select v-model="diffPatchChoice">
            <SelectTrigger class="w-full max-w-36" :aria-label="$t('settings.diffPatchThreshold')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="o in DIFF_PATCH_OPTIONS" :key="o.bytes" :value="String(o.bytes)">
                {{ o.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </template>
      </SettingsRow>
    </ExpandTransition>
  </SettingsGroup>
</template>

