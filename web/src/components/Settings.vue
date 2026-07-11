<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Settings as SettingsIcon } from "@lucide/vue";
import type { PushPanelSide } from "@/shell/usePushPanel";
import SettingsPanel from "@/shell/SettingsPanel.vue";
import SettingsTabs from "@/shell/SettingsTabs.vue";
import IdentitiesSection from "./settings/IdentitiesSection.vue";
import AccessSection from "./settings/AccessSection.vue";
import DiscoverySection from "./settings/DiscoverySection.vue";
import CloudSyncSection from "./settings/CloudSyncSection.vue";
import AppearanceSection from "./settings/AppearanceSection.vue";
import EditorSection from "./settings/EditorSection.vue";
import SyncHotkeysSection from "./settings/SyncHotkeysSection.vue";
import AutoCommitSection from "./settings/AutoCommitSection.vue";
import AgentSafetySection from "./settings/AgentSafetySection.vue";
import IdentityFirewallSection from "./settings/IdentityFirewallSection.vue";
import AiProvidersSection from "./settings/AiProvidersSection.vue";

const open = defineModel<boolean>("open", { required: true });
const props = withDefaults(defineProps<{ side?: PushPanelSide; rightOffsetPx?: number }>(), {
  side: "right",
  rightOffsetPx: 0,
});

const { t } = useI18n();

// The panel groups its sections into tabs so the everyday knobs (General) aren't
// buried under the power-user ones (firewall, agent rail, tunnel, AI providers).
type TabId = "general" | "identities" | "automation" | "access";
const tab = ref<TabId>("general");
const tabs = computed<{ id: TabId; label: string }[]>(() => [
  { id: "general", label: t("settings.tabs.general") },
  { id: "identities", label: t("settings.tabs.identities") },
  { id: "automation", label: t("settings.tabs.automation") },
  { id: "access", label: t("settings.tabs.access") },
]);
// Every open lands back on General — the tab most visits need.
watch(open, (isOpen) => {
  if (isOpen) tab.value = "general";
});
</script>

<template>
  <SettingsPanel
    v-model:open="open"
    :side="props.side"
    :right-offset-px="props.rightOffsetPx"
    :title="$t('settings.title')"
    :description="$t('settings.description')"
  >
    <template #title-icon>
      <SettingsIcon :size="17" class="text-muted-foreground" />
    </template>

    <div class="flex flex-col gap-4">
      <SettingsTabs v-model="tab" :tabs="tabs" />

      <!-- All sections stay MOUNTED (v-show, not v-if): several refresh their data from an
           `open` watcher that fires when the panel opens, which would never run for a section
           first mounted by a later tab click. -->

      <!-- General: appearance, folders to scan, editor, sync + hotkeys ──────── -->
      <div v-show="tab === 'general'" class="flex flex-col gap-4">
        <AppearanceSection />
        <DiscoverySection :open="open" />
        <EditorSection />
        <SyncHotkeysSection />
      </div>

      <!-- Identities: git identities, GitHub accounts, ⭐ Identity Firewall ──── -->
      <div v-show="tab === 'identities'" class="flex flex-col gap-4">
        <IdentitiesSection :open="open" />
        <IdentityFirewallSection :open="open" />
      </div>

      <!-- Automation: auto-commit, ⭐ Agent Safety Rail, AI providers ────────── -->
      <div v-show="tab === 'automation'" class="flex flex-col gap-4">
        <AutoCommitSection />
        <AgentSafetySection />
        <AiProvidersSection :open="open" />
      </div>

      <!-- Access: Connections account, remote access + tunnel, cloud sync ───── -->
      <div v-show="tab === 'access'" class="flex flex-col gap-4">
        <AccessSection :open="open" />
        <CloudSyncSection />
      </div>
    </div>
  </SettingsPanel>
</template>
