<script setup lang="ts">
// ⭐ Agent Safety Rail settings: the MCP mutating-call approval gate on/off, plus two independent,
// toggle-gated auto-resolution timers — auto-DENY (on by default; the historic behavior) and
// auto-APPROVE (off by default; opt-in, since auto-approving a mutating agent call defeats the
// point of the gate). Each timer's duration dropdown is revealed only when its toggle is on. When
// both are on, whichever duration elapses first wins (see src/approvals.ts). The pending-approval
// CARDS live in AgentApprovalCard.vue; this section only controls the gate + timers.
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

// Shared timeout presets (seconds): 30s … 10 min. The daemon floor is 10s, ceiling 1h. Reused by
// both the auto-deny and the auto-approve duration pickers.
const TIMEOUT_CHOICES = [30, 60, 120, 300, 600];
const timeoutLabel = (secs: number): string =>
  secs < 60 ? t("settings.intervalSeconds", { n: secs }, secs) : t("settings.intervalMinutes", { n: secs / 60 }, secs / 60);

const on = computed(() => store.mcpApprovalGate);

const denyChoice = computed<string>({
  get: () => String(store.mcpApprovalTimeoutSecs),
  set: (v: string) => void onDenyTimeout(Number(v)),
});
const approveChoice = computed<string>({
  get: () => String(store.mcpAutoApproveTimeoutSecs),
  set: (v: string) => void onApproveTimeout(Number(v)),
});

async function onGate(enabled: boolean): Promise<void> {
  try {
    await store.setMcpApprovalGate(enabled);
  } catch {
    toast.error(t("settings.mcpApprovalGateFailed"));
  }
}
async function onAutoDeny(enabled: boolean): Promise<void> {
  try {
    await store.setMcpAutoDeny(enabled);
  } catch {
    toast.error(t("settings.mcpApprovalGateFailed"));
  }
}
async function onAutoApprove(enabled: boolean): Promise<void> {
  try {
    await store.setMcpAutoApprove(enabled);
  } catch {
    toast.error(t("settings.mcpApprovalGateFailed"));
  }
}
async function onDenyTimeout(secs: number): Promise<void> {
  try {
    await store.setMcpApprovalTimeoutSecs(secs);
  } catch {
    toast.error(t("settings.mcpApprovalGateFailed"));
  }
}
async function onApproveTimeout(secs: number): Promise<void> {
  try {
    await store.setMcpAutoApproveTimeoutSecs(secs);
  } catch {
    toast.error(t("settings.mcpApprovalGateFailed"));
  }
}
</script>

<template>
  <SettingsGroup :label="$t('settings.cardMcpApprovalGate')" :description="$t('settings.mcpApprovalGateDescription')">
    <SettingsRow :label="$t('settings.mcpApprovalGate')">
      <template #info><InfoHint :text="$t('settings.mcpApprovalGateHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.mcpApprovalGate"
          :aria-label="$t('settings.mcpApprovalGate')"
          @update:model-value="(v: boolean) => onGate(v)"
        />
      </template>
    </SettingsRow>

    <!-- The two auto-resolution timers only matter while the gate is on → HIDE them while it's off. -->
    <ExpandTransition :open="on">
      <div class="flex flex-col">
        <!-- Auto-deny (toggle → reveals its duration only when on) -->
        <SettingsRow :label="$t('settings.mcpAutoDeny')">
          <template #info><InfoHint :text="$t('settings.mcpAutoDenyHint')" /></template>
          <template #control>
            <Switch
              :model-value="store.mcpAutoDeny"
              :aria-label="$t('settings.mcpAutoDeny')"
              @update:model-value="(v: boolean) => onAutoDeny(v)"
            />
          </template>
        </SettingsRow>
        <ExpandTransition :open="store.mcpAutoDeny">
          <div class="flex flex-col gap-1.5 px-3.5 pb-3">
            <span class="text-xs text-muted-foreground">{{ $t("settings.mcpAutoDenyAfter") }}</span>
            <Select v-model="denyChoice">
              <SelectTrigger class="w-full" :aria-label="$t('settings.mcpAutoDenyAfter')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="s in TIMEOUT_CHOICES" :key="s" :value="String(s)">
                  {{ timeoutLabel(s) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </ExpandTransition>

        <!-- Auto-approve (opt-in; toggle → reveals its duration only when on) -->
        <SettingsRow :label="$t('settings.mcpAutoApprove')">
          <template #info><InfoHint :text="$t('settings.mcpAutoApproveHint')" /></template>
          <template #control>
            <Switch
              :model-value="store.mcpAutoApprove"
              :aria-label="$t('settings.mcpAutoApprove')"
              @update:model-value="(v: boolean) => onAutoApprove(v)"
            />
          </template>
        </SettingsRow>
        <ExpandTransition :open="store.mcpAutoApprove">
          <div class="flex flex-col gap-1.5 px-3.5 pb-3">
            <span class="text-xs text-muted-foreground">{{ $t("settings.mcpAutoApproveAfter") }}</span>
            <Select v-model="approveChoice">
              <SelectTrigger class="w-full" :aria-label="$t('settings.mcpAutoApproveAfter')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="s in TIMEOUT_CHOICES" :key="s" :value="String(s)">
                  {{ timeoutLabel(s) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </ExpandTransition>
      </div>
    </ExpandTransition>
  </SettingsGroup>
</template>
