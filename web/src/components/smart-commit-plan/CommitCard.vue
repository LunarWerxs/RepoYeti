<script setup lang="ts">
import {
  Sparkles,
  Loader2,
  ArrowUp,
  ArrowDown,
  Trash2,
  Plus,
  ChevronDown,
  MoreVertical,
  Combine,
  GitCommitHorizontal,
  GripVertical,
} from "@lucide/vue";
import type { DiffStat as DiffStatT } from "../../types";
import SmartCommitFileDiff from "../SmartCommitFileDiff.vue";
import SmartCommitCommitDiff from "../SmartCommitCommitDiff.vue";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

interface EditableGroup {
  key: string;
  subjectLine: string;
  body: string;
  showBody: boolean;
  files: string[];
}

defineProps<{
  group: EditableGroup;
  index: number;
  total: number;
  groups: EditableGroup[];
  repoId: string;
  statusByPath: Record<string, string>;
  statByPath: Record<string, DiffStatT>;
  openDiff: string | null;
  openAll: string | null;
  regenBusy: boolean;
}>();
const emit = defineEmits<{
  "toggle-diff": [path: string];
  "toggle-all": [];
  "move-up": [];
  "move-down": [];
  "merge-up": [];
  remove: [];
  regenerate: [];
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
  <div class="rounded-lg border border-border bg-card/40 p-3">
    <div class="flex items-center gap-1.5">
      <button
        type="button"
        class="sc-drag flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/50 outline-none transition-colors hover:bg-accent hover:text-muted-foreground active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring/40"
        :title="$t('repo.smartCommit.drag')"
        :aria-label="$t('repo.smartCommit.drag')"
      >
        <GripVertical :size="15" />
      </button>
      <Input
        v-model="group.subjectLine"
        :placeholder="$t('repo.smartCommit.subjectPlaceholder')"
        class="h-8 flex-1 font-mono text-[12.5px]"
      />
      <button
        type="button"
        :disabled="regenBusy"
        class="flex size-8 shrink-0 items-center justify-center rounded-md text-primary outline-none transition-colors hover:bg-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/40"
        :title="$t('repo.smartCommit.regen')"
        :aria-label="$t('repo.smartCommit.regen')"
        @click="emit('regenerate')"
      >
        <Loader2 v-if="regenBusy" :size="15" class="animate-spin" />
        <Sparkles v-else :size="15" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="size-8 shrink-0" :aria-label="$t('repo.smartCommit.cardMenu')">
            <MoreVertical :size="15" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-48">
          <DropdownMenuItem :disabled="index === 0" @select="emit('move-up')">
            <ArrowUp :size="15" /><span>{{ $t("repo.smartCommit.moveUp") }}</span>
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="index === total - 1" @select="emit('move-down')">
            <ArrowDown :size="15" /><span>{{ $t("repo.smartCommit.moveDown") }}</span>
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="index === 0" @select="emit('merge-up')">
            <Combine :size="15" /><span>{{ $t("repo.smartCommit.mergeUp") }}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="emit('remove')">
            <Trash2 :size="15" /><span>{{ $t("repo.smartCommit.removeCommit") }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- optional body -->
    <div class="mt-2 pl-6">
      <button
        v-if="!group.showBody"
        type="button"
        class="text-[11.5px] text-muted-foreground underline-offset-2 hover:underline"
        @click="group.showBody = true"
      >
        {{ $t("repo.smartCommit.bodyToggle") }}
      </button>
      <Textarea
        v-else
        v-model="group.body"
        :placeholder="$t('repo.smartCommit.bodyPlaceholder')"
        rows="2"
        class="max-h-28 min-h-9 resize-none text-[12.5px]"
      />
    </div>

    <!-- files: tap a chip to preview its diff; the ⋯ menu moves it to another commit -->
    <div class="mt-2 flex flex-wrap gap-1.5 pl-6">
      <div
        v-for="f in group.files"
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
            <DropdownMenuItem
              v-for="(other, oi) in groups"
              :key="other.key"
              :disabled="other.key === group.key"
              @select="emit('move-file', f, other.key)"
            >
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

    <!-- inline diff of the expanded file (single-open across the whole editor) -->
    <div v-if="openDiff && group.files.includes(openDiff)" class="mt-2 pl-6">
      <SmartCommitFileDiff
        :key="openDiff"
        :repo-id="repoId"
        :path="openDiff"
        :status="statusByPath[openDiff]"
      />
    </div>

    <!-- combined per-commit review: every file's diff stacked (companion to the
         single-file zoom above). Only meaningful with more than one file. -->
    <div v-if="group.files.length > 1" class="mt-2 pl-6">
      <button
        type="button"
        class="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        :aria-expanded="openAll === group.key"
        @click="emit('toggle-all')"
      >
        <ChevronDown :size="13" :class="cn('transition-transform', openAll === group.key && 'rotate-180')" />
        <span>{{ openAll === group.key ? $t("repo.smartCommit.hideAll") : $t("repo.smartCommit.reviewAll") }}</span>
      </button>
      <SmartCommitCommitDiff
        v-if="openAll === group.key"
        :key="group.files.join('|')"
        :repo-id="repoId"
        :files="group.files"
        :status-by-path="statusByPath"
        class="mt-2"
      />
    </div>
  </div>
</template>
