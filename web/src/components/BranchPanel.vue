<script setup lang="ts">
// Per-repo branch switcher (switch / create / delete), extracted from RepoCard. Reads the loaded
// branch list from the store (RepoCard triggers the initial load on expand) and runs the git ops
// itself, keyed by repoId. `branch`/`detached` come in as props (the status fallback for the pill).
// Rendered only when the repo has no error (the parent gates with v-if). Multi-root: the switcher
// pill + the inline create-branch form.
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { GitBranch, ChevronDown, Loader2, Trash2, Plus } from "@lucide/vue";
import { useStore } from "../store";
import { cn } from "@/lib/utils";
import { useRepoFeedback } from "@/lib/repo-feedback";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const props = defineProps<{ repoId: string; branch: string | null; detached: boolean }>();
const store = useStore();
const { t } = useI18n();
const { toastResult } = useRepoFeedback();

const branchList = computed(() => store.branchesByRepo[props.repoId]);
const otherBranches = computed(() => (branchList.value?.branches ?? []).filter((b) => !b.current));
const gitBusy = computed(() => store.gitOpBusy[props.repoId]);
const currentBranch = computed(() => branchList.value?.current ?? props.branch ?? null);
const newBranch = ref("");
const creatingBranch = ref(false);

async function switchTo(branch: string): Promise<void> {
  if (gitBusy.value) return;
  toastResult(await store.switchBranch(props.repoId, branch), t("repo.branches.switched"));
}
async function createBranch(): Promise<void> {
  const name = newBranch.value.trim();
  if (!name || gitBusy.value) return;
  const r = await store.createBranch(props.repoId, name, true);
  toastResult(r, t("repo.branches.created"));
  if (r.ok) {
    newBranch.value = "";
    creatingBranch.value = false;
  }
}
async function removeBranch(name: string): Promise<void> {
  if (gitBusy.value) return;
  toastResult(await store.deleteBranch(props.repoId, name), t("repo.branches.deleted"));
}
</script>

<template>
  <!-- branch switcher: current branch + dropdown to switch / delete, ＋ to create -->
  <div class="flex items-center gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger
        class="mono flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-[12px] text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
        :title="$t('repo.branches.manageTooltip')"
        :aria-label="$t('repo.branches.manageTooltip')"
        :disabled="gitBusy === 'checkout' || gitBusy === 'branch'"
      >
        <Loader2
          v-if="gitBusy === 'checkout' || gitBusy === 'branch'"
          :size="13"
          class="shrink-0 animate-spin"
        />
        <GitBranch v-else :size="13" :class="cn('shrink-0', detached && 'text-warning')" />
        <span class="truncate">{{ detached ? "detached" : (currentBranch ?? "—") }}</span>
        <ChevronDown :size="13" class="shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64">
        <DropdownMenuLabel>{{ $t("repo.branches.switchLabel") }}</DropdownMenuLabel>
        <div v-if="!branchList" class="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
          <Loader2 :size="13" class="animate-spin" />{{ $t("repo.branches.loading") }}
        </div>
        <div v-else-if="!otherBranches.length" class="px-2 py-1.5 text-[12px] text-muted-foreground">
          {{ $t("repo.branches.none") }}
        </div>
        <div
          v-for="b in otherBranches"
          :key="b.name"
          class="group/br flex items-center gap-1.5 rounded-sm px-1.5 py-1 hover:bg-accent/60"
        >
          <button
            type="button"
            class="mono flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12.5px] outline-none"
            @click="switchTo(b.name)"
          >
            <GitBranch :size="13" class="shrink-0 opacity-70" />
            <span class="truncate">{{ b.name }}</span>
            <span v-if="b.ahead || b.behind" class="mono shrink-0 text-[10.5px] text-muted-foreground">
              <span v-if="b.ahead">↑{{ b.ahead }}</span><span v-if="b.behind"> ↓{{ b.behind }}</span>
            </span>
          </button>
          <button
            type="button"
            class="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 pointer-coarse:opacity-100 outline-none transition group-hover/br:opacity-100 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40"
            :title="$t('repo.branches.deleteTooltip')"
            :aria-label="$t('repo.branches.deleteTooltip')"
            @click="removeBranch(b.name)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
    <button
      type="button"
      class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      :title="$t('repo.branches.createTooltip')"
      :aria-label="$t('repo.branches.create')"
      @click="creatingBranch = !creatingBranch"
    >
      <Plus :size="15" />
    </button>
  </div>
  <!-- inline create-branch form (toggled by ＋) -->
  <form v-if="creatingBranch" class="flex items-center gap-2" @submit.prevent="createBranch">
    <input
      v-model="newBranch"
      type="text"
      :placeholder="$t('repo.branches.newPlaceholder')"
      :aria-label="$t('repo.branches.create')"
      class="mono h-8 min-w-0 flex-1 rounded-md border border-border bg-background/60 px-2.5 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    />
    <Button type="submit" size="sm" :disabled="!newBranch.trim() || !!gitBusy">
      <Loader2 v-if="gitBusy === 'branch'" class="animate-spin" />
      <Plus v-else />
      {{ $t("repo.branches.create") }}
    </Button>
  </form>
</template>
