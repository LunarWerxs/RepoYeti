<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Settings as SettingsIcon } from "@lucide/vue";
import { useStore } from "../store";
import type { PushPanelSide } from "@/shell/usePushPanel";
import SettingsPanel from "@/shell/SettingsPanel.vue";
import SettingsTabs from "@/shell/SettingsTabs.vue";

// Settings is part of the always-loaded shell, but its sections are not. Keep each panel behind a
// dynamic import so startup does not parse every account/AI/automation control, then mount only the
// active tab below. Sections that refresh from `open` use immediate watchers, so a tab first
// mounted after the sheet opens still loads current data.
const IdentitiesSection = defineAsyncComponent(() => import("./settings/IdentitiesSection.vue"));
const AccessSection = defineAsyncComponent(() => import("./settings/AccessSection.vue"));
const SharingSection = defineAsyncComponent(() => import("./settings/SharingSection.vue"));
const DiscoverySection = defineAsyncComponent(() => import("./settings/DiscoverySection.vue"));
const CloudSyncSection = defineAsyncComponent(() => import("./settings/CloudSyncSection.vue"));
const AppearanceSection = defineAsyncComponent(() => import("./settings/AppearanceSection.vue"));
const EditorSection = defineAsyncComponent(() => import("./settings/EditorSection.vue"));
const UpdatesSection = defineAsyncComponent(() => import("./settings/UpdatesSection.vue"));
const HotkeysSection = defineAsyncComponent(() => import("./settings/HotkeysSection.vue"));
const DiffTuningSection = defineAsyncComponent(() => import("./settings/DiffTuningSection.vue"));
const AutoCommitSection = defineAsyncComponent(() => import("./settings/AutoCommitSection.vue"));
const BackgroundSyncSection = defineAsyncComponent(() => import("./settings/BackgroundSyncSection.vue"));
const AgentSafetySection = defineAsyncComponent(() => import("./settings/AgentSafetySection.vue"));
const IdentityFirewallSection = defineAsyncComponent(() => import("./settings/IdentityFirewallSection.vue"));
const AiProvidersSection = defineAsyncComponent(() => import("./settings/AiProvidersSection.vue"));
const OperationalErrorsSection = defineAsyncComponent(
  () => import("./settings/OperationalErrorsSection.vue"),
);
const ExperimentalServersSection = defineAsyncComponent(
  () => import("./settings/ExperimentalServersSection.vue"),
);

const open = defineModel<boolean>("open", { required: true });
const props = withDefaults(
  defineProps<{ side?: PushPanelSide; rightOffsetPx?: number; targetTab?: string | null }>(),
  {
    side: "right",
    rightOffsetPx: 0,
    targetTab: null,
  },
);

const { t } = useI18n();
const store = useStore();

// The panel groups its sections into tabs so the everyday knobs (General) aren't
// buried under the power-user ones — which now live on their own Advanced tab (firewall,
// agent rail, experimental servers). Accounts and Access merged into one tab: GitHub accounts,
// git identities, the Connections account, remote access, and sharing are all "who am I
// and who gets in", and splitting them made each half look incomplete.
type TabId = "general" | "access" | "automation" | "advanced";
const tab = ref<TabId>("general");
// Preserve partially-filled controls while moving between tabs in one open session, but forget
// visited tabs on the next open. That keeps the old v-show state-preservation without eagerly
// mounting every section (or remounting every previously visited section on a later open).
const visitedTabs = ref<TabId[]>(["general"]);
const tabs = computed<{ id: TabId; label: string }[]>(() => [
  { id: "general", label: t("settings.tabs.general") },
  // Label kept to ONE short word — "Accounts & access" wrapped to two lines in the tab bar.
  { id: "access", label: t("settings.tabs.accounts") },
  { id: "automation", label: t("settings.tabs.automation") },
  { id: "advanced", label: t("settings.tabs.advanced") },
]);
const TAB_IDS: readonly TabId[] = ["general", "access", "automation", "advanced"];
const asTab = (v: string | null | undefined): TabId | null => {
  // Pre-merge deep links: `identities` was its own tab before it merged into Accounts & access.
  if (v === "identities") return "access";
  return v && (TAB_IDS as readonly string[]).includes(v) ? (v as TabId) : null;
};
watch(
  tab,
  (active) => {
    if (!visitedTabs.value.includes(active)) visitedTabs.value = [...visitedTabs.value, active];
  },
  { immediate: true },
);
// Each open lands on the deep-link target if one was requested (e.g. the AI-key notification →
// Automation), else back on General — the tab most visits need.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    const target = asTab(props.targetTab) ?? "general";
    visitedTabs.value = [target];
    tab.value = target;
  },
  // Also handles a Settings instance first mounted already open (component tests/embedders).
  { immediate: true },
);
// Handle a deep-link that arrives while the panel is ALREADY open (open didn't transition).
watch(
  () => props.targetTab,
  (t) => {
    const target = asTab(t);
    if (open.value && target) tab.value = target;
  },
);
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
      <!-- Pinned, not scrolled away with the content (the artifact in issue #20's screenshot).
           SettingsPanel's body is deliberately pulled up UNDERNEATH its glassy title bar
           (-mt-12/pt-15 in shell/Sidebar.vue) so rows shimmer through it as they scroll. That
           reads as intended for rows of settings; for the tab row it read as a bug — it slid up
           behind "Settings", then past it into the panel's clipped top edge, leaving two labels
           superimposed and the tabs sheared in half.
           -top-3 is not arbitrary: a sticky offset is measured from the scrollport's PADDING box,
           which pt-15 already puts 12px below the h-12 header, so -12px parks this flush on the
           header's bottom edge with no strip of scrolling content showing between them. The
           negative inline margin lets the background span the body's padding, so rows pass
           underneath rather than appearing beside it. Below the header's z-10, so if the two ever
           do meet, this still goes under the title rather than over it. -->
      <div class="bg-background sticky -top-3 z-[9] -mx-3.5 px-3.5 py-1.5">
        <SettingsTabs v-model="tab" :tabs="tabs" />
      </div>

      <!-- Lazy per open: only the active tab mounts initially. Tabs visited during this open stay
           mounted behind v-show so partially-filled forms survive tab switches; the visited set
           resets on the next open. Data-loading sections use immediate open-watchers. -->

      <!-- General: appearance, folders to scan, updates ────── -->
      <div
        v-if="visitedTabs.includes('general')"
        v-show="tab === 'general'"
        data-settings-tab="general"
        class="flex flex-col gap-4"
      >
        <AppearanceSection />
        <DiscoverySection :open="open" />
        <UpdatesSection />
      </div>

      <!-- Accounts & access: GitHub accounts, git identities, Connections account,
           remote access + tunnel, share links, cloud sync ──────────────────────── -->
      <div
        v-if="visitedTabs.includes('access')"
        v-show="tab === 'access'"
        data-settings-tab="access"
        class="flex flex-col gap-4"
      >
        <IdentitiesSection :open="open" />
        <AccessSection :open="open" />
        <SharingSection :open="open" />
        <CloudSyncSection />
      </div>

      <!-- Automation: auto-commit, background sync, AI providers ── -->
      <div
        v-if="visitedTabs.includes('automation')"
        v-show="tab === 'automation'"
        data-settings-tab="automation"
        class="flex flex-col gap-4"
      >
        <AutoCommitSection :open="open" />
        <BackgroundSyncSection />
        <AiProvidersSection :open="open" />
      </div>

      <!-- Advanced: power tuning (editor, shortcuts, diff threshold) + the sharp,
           rarely-touched tools — ⭐ Agent Safety Rail, ⭐ Identity Firewall, experimental servers ── -->
      <div
        v-if="visitedTabs.includes('advanced')"
        v-show="tab === 'advanced'"
        data-settings-tab="advanced"
        class="flex flex-col gap-4"
      >
        <EditorSection />
        <HotkeysSection />
        <DiffTuningSection />
        <AgentSafetySection />
        <!-- The Firewall pins a REQUIRED identity per path glob — meaningless (and unbuildable:
             every rule needs an identity to point at) until identities are in play at all. -->
        <IdentityFirewallSection v-if="store.identitiesRelevant" :open="open" />
        <OperationalErrorsSection :open="open" />
        <ExperimentalServersSection :open="open" />
      </div>
    </div>
  </SettingsPanel>
</template>
