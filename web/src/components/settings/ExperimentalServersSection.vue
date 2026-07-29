<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import { Switch } from "@/components/ui/switch";
import LoreServersSection from "./LoreServersSection.vue";
import BuzzIntegrationSection from "./BuzzIntegrationSection.vue";

defineProps<{ open: boolean }>();

const store = useStore();
const { t } = useI18n();

async function onLoreEnabled(enabled: boolean): Promise<void> {
  try {
    await store.setLoreServersEnabled(enabled);
  } catch {
    toast.error(t("settings.loreServersEnableFailed"));
  }
}

async function onBuzzEnabled(enabled: boolean): Promise<void> {
  try {
    await store.setBuzzEnabled(enabled);
  } catch {
    toast.error(t("settings.buzzEnableFailed"));
  }
}
</script>

<template>
  <SettingsGroup :label="$t('settings.cardExperimentalServers')">
    <SettingsRow :label="$t('settings.loreServersEnable')">
      <template #control>
        <Switch
          :model-value="store.loreServersEnabled"
          :aria-label="$t('settings.loreServersEnable')"
          @update:model-value="(value: boolean) => onLoreEnabled(value)"
        />
      </template>
    </SettingsRow>
    <LoreServersSection :open="open" />

    <SettingsRow :label="$t('settings.buzzEnable')">
      <template #control>
        <Switch
          :model-value="store.buzzEnabled"
          :aria-label="$t('settings.buzzEnable')"
          @update:model-value="(value: boolean) => onBuzzEnabled(value)"
        />
      </template>
    </SettingsRow>
    <BuzzIntegrationSection :open="open" />
  </SettingsGroup>
</template>
