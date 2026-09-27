<script setup lang="ts">
// Background remote-sync check (periodic "is this repo behind its remote?" + optional auto
// fast-forward + the cadence picker + desktop-notification opt-in). Extracted out of
// SyncHotkeysSection into its own section so it can live in the Automation tab (it's an
// automation, alongside auto-commit) rather than under General → Updates. No behavior change —
// same store fields/setters, same rows, just relocated.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
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
</script>

<template>
  <SettingsGroup :label="$t('settings.cardSync')" :description="$t('settings.syncDescription')">
    <SettingsRow :label="$t('settings.syncCheck')">
      <template #info><InfoHint :text="$t('settings.syncCheckHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.syncCheckEnabled"
          :aria-label="$t('settings.syncCheck')"
          @update:model-value="(v: boolean) => onSyncCheck(v)"
        />
      </template>
    </SettingsRow>
    <!-- keep-in-sync + cadence only act as part of the check → HIDE (not dim) them while it's off -->
    <ExpandTransition :open="store.syncCheckEnabled">
      <div class="flex flex-col">
        <SettingsRow :label="$t('settings.keepInSync')">
          <template #info><InfoHint :text="$t('settings.keepInSyncHint')" /></template>
          <template #control>
            <Switch
              :model-value="store.keepInSync"
              :aria-label="$t('settings.keepInSync')"
              @update:model-value="(v: boolean) => onKeepInSync(v)"
            />
          </template>
        </SettingsRow>
        <div class="flex flex-col gap-1.5 px-3.5 py-3">
          <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
            {{ $t("settings.syncInterval") }}
            <InfoHint :text="$t('settings.syncIntervalHint')" />
          </span>
          <Select v-model="syncIntervalChoice">
            <SelectTrigger class="w-full" :aria-label="$t('settings.syncInterval')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="s in SYNC_INTERVAL_CHOICES" :key="s" :value="String(s)">
                {{ syncIntervalLabel(s) }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </ExpandTransition>
    <!-- desktop notifications (per-browser; rides the OS Notification permission). Hidden entirely
         where the browser has no Notification API (nothing to toggle). -->
    <SettingsRow v-if="store.notifyPermission !== 'unsupported'" :label="$t('settings.desktopNotify')">
      <template #info><InfoHint :text="$t('settings.desktopNotifyHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.desktopNotify"
          :aria-label="$t('settings.desktopNotify')"
          @update:model-value="(v: boolean) => onDesktopNotify(v)"
        />
      </template>
    </SettingsRow>
    <p v-if="store.notifyPermission === 'denied'" class="px-3.5 pb-3 text-2xs text-warning">
      {{ $t("settings.desktopNotifyBlocked") }}
    </p>
  </SettingsGroup>
</template>
