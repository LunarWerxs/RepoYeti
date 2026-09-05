<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Check, CircleAlert } from "@lucide/vue";
import { useStore } from "../../store";
import { ApiError } from "../../api";
import { fromNow } from "@/lib/util";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const props = defineProps<{ open?: boolean }>();
const store = useStore();
const { t } = useI18n();

// Interval-mode cadence presets (seconds): 5 min … 6 h. The daemon floor is 60s, ceiling 24h.
const INTERVAL_CHOICES = [300, 900, 1800, 3600, 7200, 21600];
const intervalLabel = (secs: number): string =>
  secs < 3600
    ? t("settings.intervalMinutes", { n: secs / 60 }, secs / 60)
    : t("settings.intervalHours", { n: secs / 3600 }, secs / 3600);

// <Select> is string-valued; map through String(secs) like the sync-check picker.
const intervalChoice = computed<string>({
  get: () => String(store.autoCommitIntervalSecs),
  set: (v: string) => void onInterval(Number(v)),
});
const modeChoice = computed<"interval" | "daily">({
  get: () => store.autoCommitMode,
  set: (v) => void onMode(v),
});
const aiFallbackChoice = computed<"skip" | "basic">({
  get: () => store.autoCommitAiFallback,
  set: (v) => void onAiFallback(v),
});

async function onToggle(enabled: boolean): Promise<void> {
  try {
    await store.setAutoCommit(enabled);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onMode(mode: "interval" | "daily"): Promise<void> {
  try {
    await store.setAutoCommitMode(mode);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onInterval(secs: number): Promise<void> {
  try {
    await store.setAutoCommitInterval(secs);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onAt(at: string): Promise<void> {
  if (!at) return;
  try {
    await store.setAutoCommitAt(at);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onPull(enabled: boolean): Promise<void> {
  try {
    await store.setAutoCommitPull(enabled);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onAiFallback(mode: "skip" | "basic"): Promise<void> {
  try {
    await store.setAutoCommitAiFallback(mode);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}
async function onPush(enabled: boolean): Promise<void> {
  try {
    await store.setAutoCommitPush(enabled);
  } catch {
    toast.error(t("settings.autoCommitFailed"));
  }
}

// Everything below the master switch is moot while auto-commit is off → collapse it away
// entirely (ExpandTransition) rather than just dim/disable it.
const on = computed(() => store.autoCommit);

// The master switch only ARMS the feature — repos are opted in one-by-one from each card's ⋯
// menu. Surface how many are opted in right here so "I flipped it on, why is nothing happening?"
// answers itself (the answer is almost always "no repo is opted in yet").
const optedInCount = computed(() => store.repos.filter((r) => r.autoCommit).length);

// ── incident ledger: repos the unattended timer skipped, or only partially synced ──────
// (src/http/routes/auto-commit-incidents.ts). Loaded when the Settings sheet opens, same
// on-open refresh pattern as IdentityFirewallSection.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void store.loadAutoCommitIncidents();
  },
  { immediate: true },
);
const unackedIncidents = computed(() => store.autoCommitIncidents.filter((i) => i.ackedAt == null));
const ackedIncidents = computed(() => store.autoCommitIncidents.filter((i) => i.ackedAt != null));

async function ack(id: string): Promise<void> {
  try {
    await store.ackAutoCommitIncident(id);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("settings.autoCommitIncidentAckFailed"));
  }
}
</script>

<template>
  <SettingsGroup :label="$t('settings.cardAutoCommit')" :description="$t('settings.autoCommitDescription')">
    <!-- master enable -->
    <SettingsRow :label="$t('settings.autoCommit')">
      <template #info><InfoHint :text="$t('settings.autoCommitHint')" /></template>
      <template #control>
        <Switch
          :model-value="store.autoCommit"
          :aria-label="$t('settings.autoCommit')"
          @update:model-value="(v: boolean) => onToggle(v)"
        />
      </template>
    </SettingsRow>

    <!-- everything below the master switch is moot while auto-commit is off → collapse it away
         entirely (rather than just dim/disable) via the kit's ExpandTransition. -->
    <ExpandTransition :open="on">
      <div class="flex flex-col">
        <!-- two-step reminder: the switch above is armed, but nothing runs until repos are
             opted in per-card. Show the current opt-in count (or a nudge when it's zero). -->
        <p
          :class="[
            'px-3.5 pt-3 text-[12px] leading-relaxed',
            optedInCount === 0 ? 'text-warning' : 'text-muted-foreground',
          ]"
        >
          {{
            optedInCount === 0
              ? $t("settings.autoCommitNoReposYet")
              : $t("settings.autoCommitReposOptedIn", { n: optedInCount }, optedInCount)
          }}
        </p>

        <!-- schedule mode: every N vs daily at a set time -->
        <div class="flex flex-col gap-1.5 px-3.5 py-3">
          <span class="text-[12px] text-muted-foreground">{{ $t("settings.autoCommitSchedule") }}</span>
          <Select v-model="modeChoice">
            <SelectTrigger class="w-full" :aria-label="$t('settings.autoCommitSchedule')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="interval">{{ $t("settings.autoCommitModeInterval") }}</SelectItem>
              <SelectItem value="daily">{{ $t("settings.autoCommitModeDaily") }}</SelectItem>
            </SelectContent>
          </Select>

          <!-- interval mode → cadence preset -->
          <template v-if="store.autoCommitMode === 'interval'">
            <Select v-model="intervalChoice">
              <SelectTrigger class="w-full" :aria-label="$t('settings.autoCommitEvery')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="s in INTERVAL_CHOICES" :key="s" :value="String(s)">
                  {{ intervalLabel(s) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </template>

          <!-- daily mode → wall-clock time -->
          <template v-else>
            <input
              type="time"
              :value="store.autoCommitAt"
              :aria-label="$t('settings.autoCommitAt')"
              class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              @change="onAt(($event.target as HTMLInputElement).value)"
            />
          </template>
        </div>

        <!-- pull before pushing -->
        <SettingsRow :label="$t('settings.autoCommitPull')">
          <template #info><InfoHint :text="$t('settings.autoCommitPullHint')" /></template>
          <template #control>
            <Switch
              :model-value="store.autoCommitPull"
              :aria-label="$t('settings.autoCommitPull')"
              @update:model-value="(v: boolean) => onPull(v)"
            />
          </template>
        </SettingsRow>

        <!-- push after committing -->
        <SettingsRow :label="$t('settings.autoCommitPush')">
          <template #info><InfoHint :text="$t('settings.autoCommitPushHint')" /></template>
          <template #control>
            <Switch
              :model-value="store.autoCommitPush"
              :aria-label="$t('settings.autoCommitPush')"
              @update:model-value="(v: boolean) => onPush(v)"
            />
          </template>
        </SettingsRow>

        <!-- what an unattended run does when a CONFIGURED AI provider fails -->
        <div class="flex flex-col gap-1.5 px-3.5 py-3">
          <span class="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            {{ $t("settings.autoCommitAiFallback") }}
            <InfoHint :text="$t('settings.autoCommitAiFallbackHint')" />
          </span>
          <Select v-model="aiFallbackChoice">
            <SelectTrigger class="w-full" :aria-label="$t('settings.autoCommitAiFallback')">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">{{ $t("settings.autoCommitAiFallbackSkip") }}</SelectItem>
              <SelectItem value="basic">{{ $t("settings.autoCommitAiFallbackBasic") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </ExpandTransition>

    <!-- Incident ledger: a repo the unattended timer skipped, or only partially synced, while
         nobody was watching the dashboard (src/http/routes/auto-commit-incidents.ts). Shown
         whenever there's history, independent of whether auto-commit is on right now: the
         owner may have turned it off precisely BECAUSE of one of these. -->
    <div v-if="store.autoCommitIncidents.length" class="flex flex-col gap-2 px-3.5 py-3">
      <div class="flex items-center gap-1.5">
        <span class="text-[12px] text-muted-foreground">{{ $t("settings.autoCommitIncidents") }}</span>
        <Badge v-if="unackedIncidents.length" variant="warning" class="px-1.5 py-0 text-[10px]">
          {{ unackedIncidents.length }}
        </Badge>
        <InfoHint :text="$t('settings.autoCommitIncidentsHint')" />
      </div>

      <div class="flex flex-col gap-1.5">
        <div
          v-for="incident in unackedIncidents"
          :key="incident.id"
          class="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5"
        >
          <CircleAlert :size="14" class="mt-0.5 shrink-0 text-warning" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-[12.5px] font-medium">{{ incident.repoName }}</p>
            <p class="text-[11.5px] text-muted-foreground">{{ incident.reason }} · {{ fromNow(incident.at) }}</p>
          </div>
          <Button size="sm" variant="outline" class="shrink-0" @click="ack(incident.id)">
            <Check />
            {{ $t("settings.autoCommitIncidentAck") }}
          </Button>
        </div>

        <!-- already-reviewed history, collapsed visually behind lower emphasis -->
        <div
          v-for="incident in ackedIncidents.slice(0, 5)"
          :key="incident.id"
          class="flex items-start gap-2 rounded-lg border border-border/60 bg-secondary/30 p-2.5 opacity-70"
        >
          <Check :size="14" class="mt-0.5 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-[12.5px] font-medium">{{ incident.repoName }}</p>
            <p class="text-[11.5px] text-muted-foreground">{{ incident.reason }} · {{ fromNow(incident.at) }}</p>
          </div>
        </div>
      </div>
    </div>
  </SettingsGroup>
</template>
