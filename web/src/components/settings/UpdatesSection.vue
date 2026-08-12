<script setup lang="ts">
// General-tab section: app auto-update consents. (Keyboard shortcuts lived here briefly as one
// merged group; they're their own HotkeysSection under Advanced now — updates and accelerators
// never belonged under one header.)
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

const store = useStore();
const { t } = useI18n();

// The running DAEMON's version, straight off /api/status — the one thing you cannot read from a
// phone once auto-update is on (issue #15: no terminal, no /api/health). Deliberately not a
// build-time constant: this dashboard can outlive the daemon build that served it, and after a
// self-update + restart the reconnect refetches status, so the number follows the daemon.
const version = computed(() => store.serverVersion);
// The boot-time update check already ran (owner only, cached 5 min) and nothing displayed its
// result. Show it here, where someone is already asking "what am I on?".
const updateAvailable = computed(() => store.updateStatus?.updateAvailable === true);
// A MANUAL "Update" installs the new build but does not relaunch the daemon (only the opt-in
// scheduled apply does, see src/auto-update.ts) — and the status it returns already reports the
// NEW version with updateAvailable false. Left at that, the row would drop the badge and read
// "up to date" while the version still answering is the old one. Comparing the two keeps it
// honest until the restart lands.
const restartPending = computed(() => {
  const installed = store.updateStatus?.currentVersion;
  return !!installed && !!version.value && installed !== version.value;
});

// Two separate consents, deliberately two switches (see src/auto-update.ts):
//   · "Tell me about updates" (on by default) — announce one, install nothing.
//   · "Install them automatically" (opt-in) — apply + restart the daemon unattended.
async function onUpdateNotify(enabled: boolean): Promise<void> {
  try {
    await store.setUpdateNotify(enabled);
  } catch {
    toast.error(t("settings.updateNotifyFailed"));
  }
}
async function onAutoUpdate(enabled: boolean): Promise<void> {
  try {
    await store.setAutoUpdate(enabled);
  } catch {
    toast.error(t("settings.autoUpdateFailed"));
  }
}
</script>

<template>
  <SettingsGroup :label="$t('settings.cardUpdates')">
    <SettingsRow :label="$t('settings.version')">
      <template #info><InfoHint :text="$t('settings.versionHint')" /></template>
      <template #control>
        <!-- An UNATTENDED update runs with nobody at the terminal, which is the whole point of the
             setting — so the one surface that can report it is this row, on whatever device is
             looking. The daemon announces both phases over SSE (src/auto-update.ts); until now the
             dashboard subscribed to them and ignored them. "Restarting" also explains the
             disconnect that is about to follow, so it does not read as a failure. -->
        <Badge v-if="store.autoUpdateRestarting" variant="warning">
          {{ $t("settings.versionRestarting") }}
        </Badge>
        <Badge v-else-if="store.autoUpdateApplying" variant="info">
          {{ $t("settings.versionUpdating") }}
        </Badge>
        <Badge v-else-if="restartPending" variant="warning">
          {{ $t("settings.versionRestartPending") }}
        </Badge>
        <Badge v-else-if="updateAvailable" variant="info">
          {{ $t("settings.versionUpdateAvailable") }}
        </Badge>
        <span data-testid="running-version" class="font-mono tabular-nums text-foreground">
          {{ version || $t("settings.versionUnknown") }}
        </span>
      </template>
    </SettingsRow>
    <SettingsRow :label="$t('settings.updateNotify')">
      <template #info><InfoHint :text="$t('settings.updateNotifyHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.updateNotify"
          :aria-label="$t('settings.updateNotify')"
          @update:model-value="(v: boolean) => onUpdateNotify(v)"
        />
      </template>
    </SettingsRow>
    <SettingsRow :label="$t('settings.autoUpdate')">
      <template #info><InfoHint :text="$t('settings.autoUpdateHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.autoUpdate"
          :aria-label="$t('settings.autoUpdate')"
          @update:model-value="(v: boolean) => onAutoUpdate(v)"
        />
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
