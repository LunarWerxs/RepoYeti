<script setup lang="ts">
// ⭐ Agent Safety Rail settings: the MCP mutating-call approval gate on/off + its auto-deny
// timeout. Mirrors AutoCommitSection.vue's shape (master switch + a dependent control dimmed
// while off). The pending-approval CARDS themselves live in AgentApprovalCard.vue on the
// dashboard — this section only controls whether the gate runs at all.
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

// Auto-deny timeout presets (seconds): 30s … 10 min. The daemon floor is 10s, ceiling 1h.
const TIMEOUT_CHOICES = [30, 60, 120, 300, 600];
const timeoutLabel = (secs: number): string =>
  secs < 60 ? t("settings.intervalSeconds", { n: secs }, secs) : t("settings.intervalMinutes", { n: secs / 60 }, secs / 60);

const timeoutChoice = computed<string>({
  get: () => String(store.mcpApprovalTimeoutSecs),
  set: (v: string) => void onTimeout(Number(v)),
});

async function onToggle(enabled: boolean): Promise<void> {
  try {
    await store.setMcpApprovalGate(enabled);
  } catch {
    toast.error(t("settings.mcpApprovalGateFailed"));
  }
}
async function onTimeout(secs: number): Promise<void> {
  try {
    await store.setMcpApprovalTimeoutSecs(secs);
  } catch {
    toast.error(t("settings.mcpApprovalGateFailed"));
  }
}

const on = computed(() => store.mcpApprovalGate);
</script>

<template>
  <SettingsGroup :label="$t('settings.cardMcpApprovalGate')">
    <p class="px-3.5 py-2.5 text-[12px] leading-snug text-muted-foreground">
      {{ $t("settings.mcpApprovalGateDescription") }}
    </p>
    <SettingsRow :label="$t('settings.mcpApprovalGate')" :description="$t('settings.mcpApprovalGateHint')">
      <template #control>
        <Switch
          :model-value="store.mcpApprovalGate"
          :aria-label="$t('settings.mcpApprovalGate')"
          @update:model-value="(v: boolean) => onToggle(v)"
        />
      </template>
    </SettingsRow>

    <div
      class="flex flex-col gap-1.5 px-3.5 py-3 transition-opacity"
      :class="on ? '' : 'pointer-events-none opacity-50'"
    >
      <span class="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {{ $t("settings.mcpApprovalTimeout") }}
        <InfoHint :text="$t('settings.mcpApprovalTimeoutHint')" />
      </span>
      <Select v-model="timeoutChoice" :disabled="!on">
        <SelectTrigger class="w-full" :aria-label="$t('settings.mcpApprovalTimeout')"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="s in TIMEOUT_CHOICES" :key="s" :value="String(s)">
            {{ timeoutLabel(s) }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  </SettingsGroup>
</template>
