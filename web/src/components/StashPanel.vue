<script setup lang="ts">
// Per-repo stash controls (save / pop / drop), extracted from RepoCard. Reads the loaded stash
// list from the store (RepoCard triggers the load on expand) and runs the git ops itself, keyed by
// repoId. Multi-root: the "Stash" save button (only when there are uncommitted changes) + the
// stash-list dropdown (only when stashes exist) — both gated by the repo's stash capability.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, ChevronDown, CornerDownLeft, Trash2, Loader2 } from "@lucide/vue";
import { useStore } from "../store";
import { useRepoFeedback } from "@/lib/repo-feedback";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const props = defineProps<{ repoId: string; canStash: boolean; dirty: number }>();
const store = useStore();
const { t } = useI18n();
const { toastResult } = useRepoFeedback();

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
async function stashDrop(index: number): Promise<void> {
  if (gitBusy.value) return;
  toastResult(await store.stashDrop(props.repoId, index), t("repo.stash.dropped"));
}
</script>

<template>
  <Button
    v-if="canStash && dirty > 0"
    variant="outline"
    size="sm"
    :disabled="!!gitBusy"
    :title="$t('repo.stash.stashTooltip')"
    @click="stashSave"
  >
    <Loader2 v-if="gitBusy === 'stash'" class="animate-spin" />
    <Archive v-else />
    {{ $t("repo.stash.stash") }}
  </Button>
  <!-- existing stashes: pop / drop -->
  <DropdownMenu v-if="canStash && stashes.length">
    <DropdownMenuTrigger
      class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
      :title="$t('repo.stash.menuLabel')"
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
          :title="$t('repo.stash.popTooltip')"
          :aria-label="$t('repo.stash.pop')"
          @click="stashPop(s.index)"
        >
          <CornerDownLeft :size="14" />
        </button>
        <button
          type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition hover:bg-destructive/15 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          :disabled="!!gitBusy"
          :title="$t('repo.stash.dropTooltip')"
          :aria-label="$t('repo.stash.drop')"
          @click="stashDrop(s.index)"
        >
          <Trash2 :size="14" />
        </button>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
