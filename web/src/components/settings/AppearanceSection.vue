<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { changesViewSize } from "@/lib/changes-view";
import { defaultCommitAction } from "@/lib/commit-default";
import { useTheme } from "@/lib/theme";
import { useTooltipConfig } from "@/lib/tooltip-config";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
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
    <SettingsRow :label="$t('settings.defaultCommitAction')">
      <template #info><InfoHint :text="$t('settings.defaultCommitActionHint')" /></template>
      <template #control>
        <Select v-model="defaultCommitAction">
          <SelectTrigger class="w-full max-w-44" :aria-label="$t('settings.defaultCommitAction')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="commit">{{ $t("repo.commit.commit") }}</SelectItem>
            <SelectItem value="sync">{{ $t("repo.commit.commitSync") }}</SelectItem>
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
    <!-- The History panel's four display choices (activity graph, commit graph, change totals,
         changed files as tree/list) and the work tree's two now live in those panels' OWN
         toolbars — the sliders button beside each. They are not duplicated here on
         purpose: a switch nobody can find from the panel it changes is a switch nobody uses, and
         two homes for one preference is how they drift. This group keeps only what is genuinely
         app-wide. -->
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
    <!-- "Always side-by-side" moved to the file viewer's own ⋮ menu, and its "compact diff"
         notice now carries a one-click way out. It is the setting that decides what you are
         looking at, so it belongs on the thing it decides. The byte THRESHOLD stays in
         Advanced → Diffs: that one is a tuning number, not a view choice. -->
  </SettingsGroup>
</template>
