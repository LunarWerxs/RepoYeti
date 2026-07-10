<script setup lang="ts">
import { Settings as SettingsIcon } from "@lucide/vue";
import type { PushPanelSide } from "@/shell/usePushPanel";
import SettingsPanel from "@/shell/SettingsPanel.vue";
import IdentityAccessSection from "./settings/IdentityAccessSection.vue";
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
      <!-- Identities, connected account, and access mode ────────────────── -->
      <IdentityAccessSection :open="open" />

      <!-- ⭐ Identity Firewall: pin a required identity per repo-path glob ─── -->
      <IdentityFirewallSection :open="open" />

      <!-- Discovery: scan folders + lore servers ─────────────────────────── -->
      <DiscoverySection :open="open" />

      <!-- Opt-in cloud sync of theme/preferences via Connections ──────────── -->
      <CloudSyncSection />

      <!-- Appearance + diff display preferences ──────────────────────────── -->
      <AppearanceSection />

      <!-- "Open with…" default external editor ────────────────────────────── -->
      <EditorSection />

      <!-- Background sync + keyboard shortcuts ────────────────────────────── -->
      <SyncHotkeysSection />

      <!-- Auto-commit timer (opt-in per repo on each card) ────────────────── -->
      <AutoCommitSection />

      <!-- ⭐ Agent Safety Rail: MCP mutating-call approval gate + auto-deny timeout ── -->
      <AgentSafetySection />

      <!-- AI commit-message providers, YOLO mode, and style ───────────────── -->
      <AiProvidersSection :open="open" />
    </div>
  </SettingsPanel>
</template>
