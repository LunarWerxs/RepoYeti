<script setup lang="ts">
// Per-repo stash controls (save / pop / drop), extracted from RepoCard. Reads the loaded stash
// list from the store (RepoCard triggers the load on expand) and runs the git ops itself, keyed by
// repoId. Multi-root: the "Stash" save button (only when there are uncommitted changes) + the
// stash-list dropdown (only when stashes exist) — both gated by the repo's stash capability.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, ChevronDown, CornerDownLeft, Trash2, Loader2 } from "@lucide/vue";
import { useStore } from "../store";
import { useRepoFeedback } from "@/lib/repo-feedback";
import { useTooltipConfig } from "@/lib/tooltip-config";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

const props = defineProps<{ repoId: string; canStash: boolean; dirty: number }>();
const store = useStore();
const { t } = useI18n();
const { toastResult } = useRepoFeedback();
const { enabled: tooltipsEnabled } = useTooltipConfig();

const stashes = computed(() => store.stashesByRepo[props.repoId]?.stashes ?? []);
const gitBusy = computed(() => store.gitOpBusy[props.repoId]);

async function stashSave(): Promise<void> {
  if (gitBusy.value) return;
  toastResult(await store.stashSave(props.repoId), t("repo.stash.saved"));
}
async function stashPop(index: number): Promise<void> {
  if (gitBusy.value) return;
  toastResult(await store.stashPop(props.repoId, index), t("repo.stash.popped"));
}

// ── drop a stash (confirm-gated: `git stash drop` is unrecoverable, and the Drop button sits
//    right beside Pop at the same size, so a mis-tap on a phone must not be able to fire it
//    directly — see the discard/delete-file confirms in RepoCardChanges.vue, same shape). ──
const dropTarget = ref<{ index: number; message: string } | null>(null);
const dropOpen = computed({
  get: () => dropTarget.value !== null,
  set: (v: boolean) => {
    if (!v) dropTarget.value = null;
  },
});
function askDrop(index: number, message: string): void {
  dropTarget.value = { index, message };
}
async function confirmDrop(): Promise<void> {
  const target = dropTarget.value;
  dropTarget.value = null;
  if (!target || gitBusy.value) return;
  toastResult(await store.stashDrop(props.repoId, target.index), t("repo.stash.dropped"));
}
</script>

<template>
  <Tooltip v-if="canStash && dirty > 0">
    <TooltipTrigger as-child>
      <span class="inline-flex">
        <Button
          variant="outline"
          size="sm"
          :disabled="!!gitBusy"
          @click="stashSave"
        >
          <Loader2 v-if="gitBusy === 'stash'" class="animate-spin" />
          <Archive v-else />
          {{ $t("repo.stash.stash") }}
        </Button>
      </span>
    </TooltipTrigger>
    <TooltipContent>{{ $t("repo.stash.stashTooltip") }}</TooltipContent>
  </Tooltip>
  <!-- existing stashes: pop / drop -->
  <DropdownMenu v-if="canStash && stashes.length">
    <DropdownMenuTrigger
      class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
      :title="tooltipsEnabled ? $t('repo.stash.menuLabel') : undefined"
      :aria-label="$t('repo.stash.menuLabel')"
    >
      <Archive :size="15" />
      <span>{{ stashes.length }}</span>
      <ChevronDown :size="14" class="opacity-60" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-72">
      <DropdownMenuLabel>{{ $t("repo.stash.menuLabel") }}</DropdownMenuLabel>
      <div
        v-for="s in stashes"
        :key="s.index"
        class="flex items-center gap-1.5 rounded-sm px-1.5 py-1 hover:bg-accent/50"
      >
        <span class="min-w-0 flex-1 truncate text-[12px]" :title="s.message">{{ s.message }}</span>
        <button
          type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          :disabled="!!gitBusy"
          :title="tooltipsEnabled ? $t('repo.stash.popTooltip') : undefined"
          :aria-label="$t('repo.stash.pop')"
          @click="stashPop(s.index)"
        >
          <CornerDownLeft :size="14" />
        </button>
        <button
          type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition hover:bg-destructive/15 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          :disabled="!!gitBusy"
          :title="tooltipsEnabled ? $t('repo.stash.dropTooltip') : undefined"
          :aria-label="$t('repo.stash.drop')"
          @click="askDrop(s.index, s.message)"
        >
          <Trash2 :size="14" />
        </button>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>

  <!-- confirm before dropping a stash (destructive, unrecoverable — names the stash message) -->
  <Dialog v-model:open="dropOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.stash.dropTitle") }}</DialogTitle>
        <DialogDescription>{{ $t("repo.stash.dropBody", { message: dropTarget?.message ?? "" }) }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button variant="secondary" @click="dropOpen = false">{{ $t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDrop">{{ $t("repo.stash.dropConfirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
