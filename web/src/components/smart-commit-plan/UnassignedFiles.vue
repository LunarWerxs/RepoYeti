<script setup lang="ts">
import { CornerUpLeft, MoreVertical, Plus, ChevronDown, GitCommitHorizontal } from "@lucide/vue";
import type { DiffStat as DiffStatT } from "../../types";
import SmartCommitFileDiff from "../SmartCommitFileDiff.vue";
import DiffStat from "../DiffStat.vue";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";

interface EditableGroup {
  key: string;
  subjectLine: string;
  body: string;
  showBody: boolean;
  files: string[];
}

defineProps<{
  leftovers: string[];
  groups: EditableGroup[];
  repoId: string;
  statusByPath: Record<string, string>;
  statByPath: Record<string, DiffStatT>;
  openDiff: string | null;
}>();
const emit = defineEmits<{
  "toggle-diff": [path: string];
  "move-file": [path: string, target: string];
}>();

function statusVariant(letter: string | undefined): "success" | "warning" | "destructive" | "info" | "secondary" {
  switch (letter) {
    case "A":
    case "U":
      return "success";
    case "D":
      return "destructive";
    case "R":
      return "info";
    case "M":
    case "C":
      return "warning";
    default:
      return "secondary";
  }
}
</script>

<template>
  <!-- unassigned (blocks commit) -->
  <div class="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
    <div class="mb-1 flex items-center gap-2 text-[12.5px] font-medium text-warning">
      <CornerUpLeft :size="15" />
      <span>{{ $t("repo.smartCommit.unassigned") }}</span>
    </div>
    <p class="mb-2 text-[11.5px] text-muted-foreground">{{ $t("repo.smartCommit.unassignedHint") }}</p>
    <div class="flex flex-wrap gap-1.5">
      <div
        v-for="f in leftovers"
        :key="f"
        class="flex max-w-full items-stretch overflow-hidden rounded-md border border-border bg-secondary/40 text-[11.5px]"
      >
        <button
          type="button"
          class="flex min-w-0 items-center gap-1.5 px-2 py-1 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
          :aria-expanded="openDiff === f"
          :title="$t('repo.smartCommit.viewDiff')"
          @click="emit('toggle-diff', f)"
        >
          <Badge :variant="statusVariant(statusByPath[f])" class="px-1 py-0 text-[9px] leading-none">{{ statusByPath[f] ?? "·" }}</Badge>
          <span class="truncate">{{ f }}</span>
          <DiffStat v-if="statByPath[f]" :stat="statByPath[f]" show="lines" class="shrink-0" />
          <ChevronDown :size="12" :class="cn('shrink-0 text-muted-foreground transition-transform', openDiff === f && 'rotate-180')" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              class="flex shrink-0 items-center border-l border-border/60 px-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              :title="$t('repo.smartCommit.fileMenu')"
              :aria-label="$t('repo.smartCommit.fileMenu')"
            >
              <MoreVertical :size="13" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="max-h-72 w-60 overflow-y-auto">
            <DropdownMenuLabel>{{ $t("repo.smartCommit.moveTo") }}</DropdownMenuLabel>
            <DropdownMenuItem v-for="(other, oi) in groups" :key="other.key" @select="emit('move-file', f, other.key)">
              <GitCommitHorizontal :size="14" />
              <span class="truncate">{{ oi + 1 }}. {{ other.subjectLine || $t("repo.smartCommit.newCommit") }}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="emit('move-file', f, 'new')">
              <Plus :size="14" /><span>{{ $t("repo.smartCommit.newCommit") }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <!-- inline diff of an expanded unassigned file (shares the single-open slot) -->
    <div v-if="openDiff && leftovers.includes(openDiff)" class="mt-2">
      <SmartCommitFileDiff
        :key="openDiff"
        :repo-id="repoId"
        :path="openDiff"
        :status="statusByPath[openDiff]"
      />
    </div>
  </div>
</template>
