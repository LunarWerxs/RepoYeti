<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
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

// Interval-mode cadence presets (seconds): 5 min … 6 h. The daemon floor is 60s, ceiling 24h.
const INTERVAL_CHOICES = [300, 900, 1800, 3600, 7200, 21600];
const intervalLabel = (secs: number): string =>
  secs < 3600
    ? t("settings.intervalMinutes", { n: secs / 60 }, secs / 60)
    : t("settings.intervalHours", { n: secs / 3600 }, secs / 3600);

// <Select> is string-valued; map through String(secs) like the sync-check picker.
const intervalChoice = computed<string>({
  get: () => String(store.autoCommitIntervalSecs),
  set: (v: string) => void onInterval(Number(v)),
});
const modeChoice = computed<"interval" | "daily">({
  get: () => store.autoCommitMode,
  set: (v) => void onMode(v),
});

async function onToggle(enabled: boolean): Promise<void> {
  try {
    await store.setAutoCommit(enabled);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onMode(mode: "interval" | "daily"): Promise<void> {
  try {
    await store.setAutoCommitMode(mode);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onInterval(secs: number): Promise<void> {
  try {
    await store.setAutoCommitInterval(secs);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onAt(at: string): Promise<void> {
  if (!at) return;
  try {
    await store.setAutoCommitAt(at);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onPull(enabled: boolean): Promise<void> {
  try {
    await store.setAutoCommitPull(enabled);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onPush(enabled: boolean): Promise<void> {
  try {
    await store.setAutoCommitPush(enabled);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}

// Everything below the master switch is moot while auto-commit is off → dim + disable it.
const on = computed(() => store.autoCommit);
</script>

<template>
  <SettingsGroup :label="$t('settings.cardAutoCommit')" :description="$t('settings.autoCommitDescription')">
    <!-- master enable -->
    <SettingsRow :label="$t('settings.autoCommit')">
      <template #info><InfoHint :text="$t('settings.autoCommitHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.autoCommit"
          :aria-label="$t('settings.autoCommit')"
          @update:model-value="(v: boolean) => onToggle(v)"
        />
      </template>
    </SettingsRow>

    <!-- schedule mode: every N vs daily at a set time -->
    <div
      class="flex flex-col gap-1.5 px-3.5 py-3 transition-opacity"
      :class="on ? '' : 'pointer-events-none opacity-50'"
    >
      <span class="text-[12px] text-muted-foreground">{{ $t("settings.autoCommitSchedule") }}</span>
      <Select v-model="modeChoice" :disabled="!on">
        <SelectTrigger class="w-full" :aria-label="$t('settings.autoCommitSchedule')"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="interval">{{ $t("settings.autoCommitModeInterval") }}</SelectItem>
          <SelectItem value="daily">{{ $t("settings.autoCommitModeDaily") }}</SelectItem>
        </SelectContent>
      </Select>

      <!-- interval mode → cadence preset -->
      <template v-if="store.autoCommitMode === 'interval'">
        <Select v-model="intervalChoice" :disabled="!on">
          <SelectTrigger class="w-full" :aria-label="$t('settings.autoCommitEvery')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="s in INTERVAL_CHOICES" :key="s" :value="String(s)">
              {{ intervalLabel(s) }}
            </SelectItem>
          </SelectContent>
        </Select>
      </template>

      <!-- daily mode → wall-clock time -->
      <template v-else>
        <input
          type="time"
          :value="store.autoCommitAt"
          :disabled="!on"
          :aria-label="$t('settings.autoCommitAt')"
          class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          @change="onAt(($event.target as HTMLInputElement).value)"
        />
      </template>
    </div>

    <!-- pull before pushing -->
    <SettingsRow
      :label="$t('settings.autoCommitPull')"
      :class="['transition-opacity', on ? '' : 'pointer-events-none opacity-50']"
    >
      <template #info><InfoHint :text="$t('settings.autoCommitPullHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.autoCommitPull"
          :disabled="!on"
          :aria-label="$t('settings.autoCommitPull')"
          @update:model-value="(v: boolean) => onPull(v)"
        />
      </template>
    </SettingsRow>

    <!-- push after committing -->
    <SettingsRow
      :label="$t('settings.autoCommitPush')"
      :class="['transition-opacity', on ? '' : 'pointer-events-none opacity-50']"
    >
      <template #info><InfoHint :text="$t('settings.autoCommitPushHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.autoCommitPush"
          :disabled="!on"
          :aria-label="$t('settings.autoCommitPush')"
          @update:model-value="(v: boolean) => onPush(v)"
        />
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
