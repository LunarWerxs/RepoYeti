<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { hotkeysEnabled, powerShortcuts, SHORTCUTS } from "@/lib/hotkeys";
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

// Human descriptions for the Keyboard-shortcuts reference list, keyed by Shortcut.id.
// Static t() literals (re-run on locale change) so the i18n parity check sees them used.
const shortcutDesc = computed<Record<string, string>>(() => ({
  commit: t("settings.hotkeysList.commit"),
  viewerClose: t("settings.hotkeysList.viewerClose"),
  viewerSave: t("settings.hotkeysList.viewerSave"),
  treeResize: t("settings.hotkeysList.treeResize"),
}));

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
// Silent auto-update + restart of the app (opt-in; see src/auto-update.ts).
async function onAutoUpdate(enabled: boolean): Promise<void> {
  try {
    await store.setAutoUpdate(enabled);
  } catch {
    toast.error(t("settings.autoUpdateFailed"));
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
  <!-- App updates ─────────────────────────────────────────────────── -->
  <SettingsGroup :label="$t('settings.cardUpdates')">
    <SettingsRow :label="$t('settings.autoUpdate')" :description="$t('settings.autoUpdateHint')">
      <template #control>
        <Switch
          :model-value="store.autoUpdate"
          :aria-label="$t('settings.autoUpdate')"
          @update:model-value="(v: boolean) => onAutoUpdate(v)"
        />
      </template>
    </SettingsRow>
  </SettingsGroup>

  <!-- Background sync ─────────────────────────────────────────────── -->
  <SettingsGroup :label="$t('settings.cardSync')">
    <p class="px-3.5 py-2.5 text-[12px] leading-snug text-muted-foreground">
      {{ $t("settings.syncDescription") }}
    </p>
    <SettingsRow :label="$t('settings.syncCheck')" :description="$t('settings.syncCheckHint')">
      <template #control>
        <Switch
          :model-value="store.syncCheckEnabled"
          :aria-label="$t('settings.syncCheck')"
          @update:model-value="(v: boolean) => onSyncCheck(v)"
        />
      </template>
    </SettingsRow>
    <!-- keep in sync (auto fast-forward) — only acts as part of the check → gate on it -->
    <SettingsRow
      :label="$t('settings.keepInSync')"
      :description="$t('settings.keepInSyncHint')"
      :class="['transition-opacity', store.syncCheckEnabled ? '' : 'pointer-events-none opacity-50']"
    >
      <template #control>
        <Switch
          :model-value="store.keepInSync"
          :disabled="!store.syncCheckEnabled"
          :aria-label="$t('settings.keepInSync')"
          @update:model-value="(v: boolean) => onKeepInSync(v)"
        />
      </template>
    </SettingsRow>
    <!-- cadence — moot while the check is off → dim + disable it -->
    <div
      class="flex flex-col gap-1.5 px-3.5 py-3 transition-opacity"
      :class="store.syncCheckEnabled ? '' : 'pointer-events-none opacity-50'"
    >
      <span class="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {{ $t("settings.syncInterval") }}
        <InfoHint :text="$t('settings.syncIntervalHint')" />
      </span>
      <Select v-model="syncIntervalChoice" :disabled="!store.syncCheckEnabled">
        <SelectTrigger class="w-full" :aria-label="$t('settings.syncInterval')"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="s in SYNC_INTERVAL_CHOICES" :key="s" :value="String(s)">
            {{ syncIntervalLabel(s) }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
    <!-- desktop notifications (per-browser; rides the OS Notification permission) -->
    <SettingsRow
      :label="$t('settings.desktopNotify')"
      :description="$t('settings.desktopNotifyHint')"
      :class="['transition-opacity', store.notifyPermission === 'unsupported' ? 'pointer-events-none opacity-50' : '']"
    >
      <template #control>
        <Switch
          :model-value="store.desktopNotify"
          :disabled="store.notifyPermission === 'unsupported'"
          :aria-label="$t('settings.desktopNotify')"
          @update:model-value="(v: boolean) => onDesktopNotify(v)"
        />
      </template>
    </SettingsRow>
    <p v-if="store.notifyPermission === 'denied'" class="px-3.5 pb-3 text-[11px] text-warning">
      {{ $t("settings.desktopNotifyBlocked") }}
    </p>
  </SettingsGroup>

  <!-- Keyboard shortcuts ───────────────────────────────────────── -->
  <SettingsGroup :label="$t('settings.cardHotkeys')">
    <SettingsRow :label="$t('settings.hotkeysEnable')" :description="$t('settings.hotkeysEnableHint')">
      <template #control>
        <Switch v-model="hotkeysEnabled" :aria-label="$t('settings.hotkeysEnable')" />
      </template>
    </SettingsRow>

    <SettingsRow
      :label="$t('settings.hotkeysPower')"
      :description="$t('settings.hotkeysPowerHint')"
      :class="['transition-opacity', hotkeysEnabled ? '' : 'pointer-events-none opacity-50']"
    >
      <template #control>
        <Switch
          v-model="powerShortcuts"
          :disabled="!hotkeysEnabled"
          :aria-label="$t('settings.hotkeysPower')"
        />
      </template>
    </SettingsRow>

    <div class="flex flex-col gap-2 px-3.5 py-3">
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
  </SettingsGroup>
</template>
