<script setup lang="ts">
// Advanced-tab section: the keyboard-shortcuts master switch + the accelerator reference list.
// Everything here is ON by default — this is where you turn it off, not where you discover it,
// which is why it lives under Advanced rather than taking a General slot.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { hotkeysEnabled, SHORTCUTS } from "@/lib/hotkeys";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Switch } from "@/components/ui/switch";

const { t } = useI18n();

// Human descriptions for the reference list, keyed by Shortcut.id.
// Static t() literals (re-run on locale change) so the i18n parity check sees them used.
const shortcutDesc = computed<Record<string, string>>(() => ({
  commit: t("settings.hotkeysList.commit"),
  viewerClose: t("settings.hotkeysList.viewerClose"),
  viewerSave: t("settings.hotkeysList.viewerSave"),
  treeResize: t("settings.hotkeysList.treeResize"),
  selectAll: t("settings.hotkeysList.selectAll"),
  selectClear: t("settings.hotkeysList.selectClear"),
}));
</script>

<template>
  <SettingsGroup :label="$t('settings.cardHotkeys')">
    <SettingsRow :label="$t('settings.hotkeysEnable')">
      <template #info><InfoHint :text="$t('settings.hotkeysEnableHint')" /></template>
      <template #control>
        <Switch v-model="hotkeysEnabled" :aria-label="$t('settings.hotkeysEnable')" />
      </template>
    </SettingsRow>

    <!-- The reference list only matters while shortcuts are on → HIDE it (not dim) while off. -->
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
