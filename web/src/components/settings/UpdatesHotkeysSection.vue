<script setup lang="ts">
// General-tab section: app auto-update + the keyboard-shortcuts reference. (Background sync used to
// live here too; it moved to its own BackgroundSyncSection under the Automation tab.)
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { hotkeysEnabled, SHORTCUTS } from "@/lib/hotkeys";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Switch } from "@/components/ui/switch";

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
  <!-- App updates + keyboard shortcuts, ONE group: both are two-row "how the app behaves"
       knobs, and each carrying its own header was exactly the sea-of-lone-headers the
       General tab consolidation removed. -->
  <SettingsGroup :label="$t('settings.cardUpdates')">
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
    <SettingsRow :label="$t('settings.hotkeysEnable')">
      <template #info><InfoHint :text="$t('settings.hotkeysEnableHint')" /></template>
      <template #control>
        <Switch v-model="hotkeysEnabled" :aria-label="$t('settings.hotkeysEnable')" />
      </template>
    </SettingsRow>

    <!-- The reference list only matters while shortcuts are on → HIDE it (not dim) while off.
         Every documented accelerator is a default now; the old "power user" opt-in tier is gone. -->
    <ExpandTransition :open="hotkeysEnabled">
      <div class="flex flex-col gap-2 px-3.5 py-3">
        <span class="text-[12px] text-muted-foreground">{{ $t("settings.hotkeysListLabel") }}</span>
        <ul class="flex flex-col gap-1.5">
          <li
            v-for="s in SHORTCUTS"
            :key="s.id"
            class="flex items-center justify-between gap-3"
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
    </ExpandTransition>
  </SettingsGroup>
</template>
