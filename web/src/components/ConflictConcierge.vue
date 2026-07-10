<script setup lang="ts">
// Conflict Concierge — the persistent, state-driven triage card for repos that are CURRENTLY
// conflicted or mid-git-operation (merge/rebase/cherry-pick/revert). Unlike the transient
// `repo_auto_commit_blocked` toast (auto-commit-only, event-driven, gone after the SSE fires),
// this card is derived straight from live repo status (store.visibleAttentionRepos) so it
// survives reloads and disappears the instant the condition clears — no toast bookkeeping.
import { X, GitMerge, ChevronRight } from "@lucide/vue";
import { useStore } from "../store";
import { t } from "../i18n";
import type { Repo } from "../types";

const store = useStore();

/** Map the daemon's raw marker/flag to a short, translated reason label. Each branch calls
 *  t() with a literal key (never a dynamic one) so the i18n-check static scanner can verify
 *  every key here is real and used, same as everywhere else in the app. */
function reason(repo: Repo): string {
  if (repo.status?.conflicted) return t("triage.reasonConflict");
  switch (repo.status?.gitOperation) {
    case "MERGE_HEAD":
      return t("triage.reasonMergeHead");
    case "rebase-merge":
      return t("triage.reasonRebaseMerge");
    case "rebase-apply":
      return t("triage.reasonRebaseApply");
    case "CHERRY_PICK_HEAD":
      return t("triage.reasonCherryPick");
    case "REVERT_HEAD":
      return t("triage.reasonRevert");
    default:
      return t("triage.reasonGeneric");
  }
}

/** Click-through: scroll the repo's card into view and expand it so the owner can act. */
function goToRepo(repo: Repo): void {
  const el = document.getElementById(`repo-card-${repo.id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const trigger = el.querySelector<HTMLElement>('[role="button"]');
  if (trigger?.getAttribute("aria-expanded") === "false") trigger.click();
}
</script>

<template>
  <div
    v-if="store.visibleAttentionRepos.length"
    class="ring-warning/30 bg-warning/10 mb-2.5 flex flex-col gap-1.5 rounded-lg py-2.5 text-xs/relaxed ring-1"
  >
    <div class="flex items-center gap-1.5 px-3 text-[13px] font-semibold text-warning">
      <GitMerge :size="15" />
      <span>{{ $t("triage.title") }}</span>
      <span class="text-warning/70">
        {{
          store.visibleAttentionRepos.length === 1
            ? $t("triage.countOne")
            : $t("triage.countMany", { count: store.visibleAttentionRepos.length })
        }}
      </span>
    </div>
    <div class="flex flex-col gap-0.5 px-1.5">
      <div
        v-for="repo in store.visibleAttentionRepos"
        :key="repo.id"
        role="button"
        tabindex="0"
        class="group flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 outline-none transition-colors hover:bg-warning/10 focus-visible:ring-2 focus-visible:ring-ring/40"
        @click="goToRepo(repo)"
        @keydown.enter.prevent="goToRepo(repo)"
        @keydown.space.prevent="goToRepo(repo)"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-[13px] font-medium text-foreground">{{ repo.name }}</span>
            <span v-if="repo.status?.branch" class="mono shrink-0 truncate text-[11px] text-muted-foreground">
              {{ repo.status.branch }}
            </span>
          </div>
          <div class="truncate text-[11px] text-warning">{{ reason(repo) }}</div>
        </div>
        <ChevronRight :size="14" class="shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-warning/15 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          :aria-label="$t('triage.dismissAria', { name: repo.name })"
          :title="$t('triage.dismiss')"
          @click.stop="store.dismissAttention(repo.id)"
        >
          <X :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>
