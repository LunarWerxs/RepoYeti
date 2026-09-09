<script setup lang="ts">
// What the two unattended loops (auto-commit, sync-check) actually did (src/automation-run.ts,
// src/http/routes/automation.ts): a live progress line + Stop while one is running, then recent
// rounds newest-first with a tap-to-expand per-repository breakdown. The incident ledger in
// AutoCommitSection answers "what is WRONG right now"; this answers "what HAPPENED", including
// the rounds where nothing did. Loaded on first open, same lazy pattern as every other
// history-shaped Settings section (AutoCommitSection's incidents, OperationalErrorsSection).
import { computed, reactive, ref, watch } from "vue";
import type { Component } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Ban, Check, ChevronRight, CircleAlert, Loader2, Unplug } from "@lucide/vue";
import { useStore } from "../../store";
import { ApiError } from "../../api";
import { fromNow } from "@/lib/util";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeVariants } from "@/components/ui/badge";
import type { AutomationRun, AutomationRunKind, AutomationRunOutcome, AutomationRunRepo } from "@/types";

const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void store.loadAutomationRuns();
  },
  { immediate: true },
);

const KINDS: readonly AutomationRunKind[] = ["auto_commit", "sync_check"];

function kindLabel(kind: AutomationRunKind): string {
  return kind === "auto_commit"
    ? t("settings.automationHistoryKindAutoCommit")
    : t("settings.automationHistoryKindSyncCheck");
}

// ── live round: only the loop(s) actually running right now get a progress line + Stop ────────
const runningKinds = computed(() => KINDS.filter((k) => store.automationActiveRounds[k].running));

function liveProgressText(kind: AutomationRunKind): string {
  const live = store.automationLiveRuns[kind];
  const done = live?.done ?? 0;
  const total = live?.total ?? 0;
  return live?.current
    ? t("settings.automationHistoryProgressCurrent", { name: live.current, done, total })
    : t("settings.automationHistoryProgressCounts", { done, total });
}

async function stop(kind: AutomationRunKind): Promise<void> {
  try {
    await store.cancelAutomationRound(kind);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("settings.automationHistoryStopFailed"));
  }
}

// ── recent runs, newest first ──────────────────────────────────────────────────────────────
const sortedRuns = computed(() => [...store.automationRuns].sort((a, b) => b.startedAt - a.startedAt));

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("settings.automationHistoryDurationSeconds", { n: s }, s);
  const m = Math.round(s / 60);
  if (m < 60) return t("settings.automationHistoryDurationMinutes", { n: m }, m);
  const h = Math.round(m / 60);
  return t("settings.automationHistoryDurationHours", { n: h }, h);
}

/** Null — never a negative or nonsense figure — while a run is still in flight, and permanently
 *  for an interrupted run (its endedAt never arrives; see AutomationRun.endedAt's doc comment). */
function durationLabel(run: AutomationRun): string | null {
  if (run.endedAt == null) return null;
  const ms = run.endedAt - run.startedAt;
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : null;
}

type OutcomeKey = "running" | AutomationRunOutcome;
function outcomeKey(outcome: AutomationRunOutcome | null): OutcomeKey {
  return outcome ?? "running";
}

const OUTCOME_VARIANTS: Record<OutcomeKey, BadgeVariants["variant"]> = {
  running: "info",
  completed: "success",
  cancelled: "outline",
  failed: "destructive",
  interrupted: "warning",
};
const OUTCOME_ICONS: Record<OutcomeKey, Component> = {
  running: Loader2,
  completed: Check,
  cancelled: Ban,
  failed: CircleAlert,
  interrupted: Unplug,
};
const OUTCOME_ICON_CLASS: Record<OutcomeKey, string> = {
  running: "animate-spin text-info",
  completed: "text-success",
  cancelled: "text-muted-foreground",
  failed: "text-destructive",
  interrupted: "text-warning",
};

function outcomeLabel(outcome: AutomationRunOutcome | null): string {
  const labels: Record<OutcomeKey, string> = {
    running: t("settings.automationHistoryOutcomeRunning"),
    completed: t("settings.automationHistoryOutcomeCompleted"),
    cancelled: t("settings.automationHistoryOutcomeCancelled"),
    failed: t("settings.automationHistoryOutcomeFailed"),
    interrupted: t("settings.automationHistoryOutcomeInterrupted"),
  };
  return labels[outcomeKey(outcome)];
}

function repoOutcomeLabel(outcome: AutomationRunRepo["outcome"]): string {
  const labels: Record<AutomationRunRepo["outcome"], string> = {
    committed: t("settings.automationHistoryRepoOutcomeCommitted"),
    synced: t("settings.automationHistoryRepoOutcomeSynced"),
    blocked: t("settings.automationHistoryRepoOutcomeBlocked"),
    error: t("settings.automationHistoryRepoOutcomeError"),
  };
  return labels[outcome];
}

/** Small text fragments from a repo row's free-form `detail`, mirroring the exact shapes
 *  auto-commit and sync-check write (src/auto-commit.ts, src/remote-sync.ts). Every field is
 *  narrowed with typeof before use — same defensiveness as the store's applyAutomationRunEvent —
 *  so a shape this build doesn't recognise is silently skipped rather than thrown. */
function repoDetailBits(repo: AutomationRunRepo): string[] {
  const d = repo.detail;
  if (!d) return [];
  const bits: string[] = [];
  if (typeof d.commits === "number") {
    bits.push(t("settings.automationHistoryDetailCommits", { n: d.commits }, d.commits));
  }
  if (d.pulled === true) bits.push(t("settings.automationHistoryDetailPulled"));
  if (d.pushed === true) bits.push(t("settings.automationHistoryDetailPushed"));
  if (d.degraded === true) bits.push(t("settings.automationHistoryDetailDegraded"));
  if (typeof d.reason === "string") bits.push(t("settings.automationHistoryDetailReason", { reason: d.reason }));
  if (typeof d.note === "string") bits.push(t("settings.automationHistoryDetailNote", { note: d.note }));
  return bits;
}

// ── per-run detail: lazy + cached by id, including a null "not kept anymore" result — never
//    re-fetched once settled ───────────────────────────────────────────────────────────────
const expandedRunId = ref<string | null>(null);
const detailCache = reactive<Record<string, { run: AutomationRun; repos: AutomationRunRepo[] } | null>>({});
const detailLoading = reactive<Record<string, boolean>>({});

async function toggleRun(id: string): Promise<void> {
  if (expandedRunId.value === id) {
    expandedRunId.value = null;
    return;
  }
  expandedRunId.value = id;
  if (id in detailCache) return;
  detailLoading[id] = true;
  try {
    detailCache[id] = await store.loadAutomationRunDetail(id);
  } finally {
    detailLoading[id] = false;
  }
}
</script>

<template>
  <SettingsGroup :label="$t('settings.automationHistoryTitle')" :description="$t('settings.automationHistoryHint')">
    <!-- live round(s): only a loop actually running right now gets a progress line + Stop -->
    <div v-if="runningKinds.length" class="flex flex-col gap-1.5 px-3.5 py-3">
      <div
        v-for="kind in runningKinds"
        :key="kind"
        class="flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/30 p-2.5"
      >
        <Loader2 :size="14" class="shrink-0 animate-spin text-info" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[12.5px] font-medium">{{ kindLabel(kind) }}</p>
          <p class="truncate text-[11.5px] text-muted-foreground">{{ liveProgressText(kind) }}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          class="shrink-0"
          :disabled="store.automationActiveRounds[kind].cancelling"
          @click="stop(kind)"
        >
          {{
            store.automationActiveRounds[kind].cancelling
              ? $t("settings.automationHistoryStopping")
              : $t("settings.automationHistoryStop")
          }}
        </Button>
      </div>
    </div>

    <!-- recent runs, newest first -->
    <div class="flex flex-col gap-2 px-3.5 py-3">
      <p v-if="!store.automationRunsReady" class="text-[12px] text-muted-foreground/70">
        {{ $t("settings.automationHistoryLoading") }}
      </p>
      <p v-else-if="!sortedRuns.length" class="text-[12px] text-muted-foreground/70">
        {{ $t("settings.automationHistoryEmpty") }}
      </p>
      <div v-else class="flex flex-col gap-1.5">
        <div v-for="run in sortedRuns" :key="run.id" class="overflow-hidden rounded-lg border border-border/60">
          <div
            role="button"
            tabindex="0"
            class="flex cursor-pointer items-start gap-2 p-2.5 transition-colors hover:bg-accent/40"
            :aria-expanded="expandedRunId === run.id"
            @click="toggleRun(run.id)"
            @keydown.enter="toggleRun(run.id)"
          >
            <ChevronRight
              :size="14"
              class="mt-0.5 shrink-0 text-muted-foreground transition-transform"
              :class="expandedRunId === run.id ? 'rotate-90' : ''"
            />
            <component
              :is="OUTCOME_ICONS[outcomeKey(run.outcome)]"
              :size="14"
              class="mt-0.5 shrink-0"
              :class="OUTCOME_ICON_CLASS[outcomeKey(run.outcome)]"
            />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <p class="text-[12.5px] font-medium">{{ kindLabel(run.kind) }}</p>
                <Badge :variant="OUTCOME_VARIANTS[outcomeKey(run.outcome)]" class="px-1.5 py-0 text-[10px]">
                  {{ outcomeLabel(run.outcome) }}
                </Badge>
              </div>
              <p class="text-[11.5px] text-muted-foreground">
                {{ fromNow(run.startedAt) }}<template v-if="durationLabel(run)"> · {{ durationLabel(run) }}</template>
                · {{ $t("settings.automationHistoryProgressCounts", { done: run.reposDone, total: run.reposTotal }) }}
              </p>
              <p v-if="run.outcome === 'failed' && run.error" class="mt-0.5 text-[11.5px] text-destructive">
                {{ run.error }}
              </p>
              <p v-else-if="run.outcome === 'interrupted'" class="mt-0.5 text-[11px] text-muted-foreground/80">
                {{ $t("settings.automationHistoryOutcomeInterruptedHint") }}
              </p>
            </div>
          </div>

          <ExpandTransition :open="expandedRunId === run.id">
            <div class="border-t border-border/60 bg-secondary/20 px-3.5 py-2.5">
              <p v-if="detailLoading[run.id]" class="text-[11.5px] text-muted-foreground">
                {{ $t("settings.automationHistoryLoading") }}
              </p>
              <p v-else-if="detailCache[run.id] === null" class="text-[11.5px] text-muted-foreground">
                {{ $t("settings.automationHistoryDetailUnavailable") }}
              </p>
              <div v-else-if="detailCache[run.id]" class="flex flex-col gap-1.5">
                <div
                  v-for="repo in detailCache[run.id]!.repos"
                  :key="repo.id"
                  class="rounded-md border border-border/40 p-2"
                >
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                      {{ repo.repoName }}
                    </span>
                    <Badge variant="outline" class="px-1.5 py-0 text-[10px]">
                      {{ repoOutcomeLabel(repo.outcome) }}
                    </Badge>
                    <span class="shrink-0 text-[11px] text-muted-foreground">{{ formatDuration(repo.durationMs) }}</span>
                  </div>
                  <div v-if="repoDetailBits(repo).length" class="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                    <span v-for="(bit, i) in repoDetailBits(repo)" :key="i" class="text-[11px] text-muted-foreground">
                      {{ bit }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </ExpandTransition>
        </div>
      </div>
    </div>
  </SettingsGroup>
</template>
