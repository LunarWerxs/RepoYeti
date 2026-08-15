<script setup lang="ts">
// "What would a pull do?" — the dialog behind the caret next to Pull.
//
// Everything shown here is read out of objects git already has locally (see
// src/read/incoming.ts): `git pull` is `fetch` + `merge`, and the fetch half is what downloads
// the commits. So this fetches, then describes, and nothing has touched the working tree by the
// time you're looking at it. The merge is simulated in the object store too, which is how the
// conflict warning can be honest BEFORE you pull rather than after you're mid-merge.
import { computed, ref, watch } from "vue";
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  Eye,
  FileQuestion,
  GitCommitHorizontal,
  Loader2,
} from "@lucide/vue";
import { useStore } from "../../store";
import { fromNow } from "@/lib/util";
import { buildChangeTree } from "@/lib/util";
import { provideTreeCollapse } from "@/lib/changes-tree";

import ChangesTree from "../ChangesTree.vue";
import { Button } from "@/components/ui/button";
import type { ButtonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChangedFile } from "../../types";

// `variant` is passed in rather than chosen here: this caret is the right half of a split button,
// and Pull switches to the accent variant when the repo is actually behind. Hardcoding one here
// left a grey caret welded to a green button. Taking it as a prop means the two cannot drift.
const props = defineProps<{
  repoId: string;
  disabled?: boolean;
  /** Disables Pull actions while leaving the caret and Preview option reachable. */
  pullDisabled?: boolean;
  /** Status alone proves a fast-forward cannot work, even before the preview request returns. */
  statusDiverged?: boolean;
  variant?: ButtonVariants["variant"];
}>();
const emit = defineEmits<{ pull: [] }>();
const store = useStore();

const open = ref(false);
const result = computed(() => store.incomingByRepo[props.repoId]);
const loading = computed(() => !!store.incomingLoading[props.repoId]);

// Re-fetch every time the dialog opens: a preview from five minutes ago is not a preview.
watch(open, (isOpen) => {
  if (isOpen) void store.loadIncoming(props.repoId);
});

const commits = computed(() => result.value?.commits ?? []);
const conflicts = computed(() => result.value?.conflicts ?? []);
const hasIncoming = computed(() => (result.value?.behind ?? commits.value.length) > 0);
const disposition = computed(() =>
  props.statusDiverged
    ? "blocked_non_fast_forward"
    : result.value?.pullDisposition ?? "unknown",
);
const isPullBlocked = computed(
  () =>
    disposition.value === "blocked_non_fast_forward" ||
    disposition.value === "blocked_would_overwrite",
);
const previewRefusesPull = computed(
  () =>
    !!result.value &&
    (!result.value.ok ||
      result.value.noUpstream ||
      result.value.relation === "no_upstream" ||
      result.value.relation === "unknown" ||
      result.value.pullDisposition === "unknown" ||
      (result.value.ok && !result.value.noUpstream && !result.value.snapshot)),
);
// The repeated menu Pull obeys the same fail-closed preview contract as the card's primary
// button and the dialog footer. In particular, a cached fetch error/unknown/no-upstream result
// must not leave this secondary entry point actionable.
const menuPullDisabled = computed(
  () => !!props.pullDisabled || isPullBlocked.value || previewRefusesPull.value || loading.value,
);
const canPull = computed(
  () =>
    !!result.value?.ok &&
    hasIncoming.value &&
    disposition.value === "ready_fast_forward" &&
    !loading.value &&
    !props.pullDisabled,
);

// Reuse the card's changed-files tree so this reads exactly like the source-control panel.
// IncomingFile → ChangedFile is a straight shape map; the tree only needs path/status/stat.
const incomingAsChanges = computed<ChangedFile[]>(() =>
  (result.value?.files ?? []).map((f) => ({
    path: f.path,
    status: f.status,
    staged: false,
    stat: f.binary
      ? undefined
      : { addedLines: f.addedLines, removedLines: f.removedLines, addedChars: 0, removedChars: 0 },
  })),
);
const tree = computed(() => buildChangeTree(incomingAsChanges.value));

// Scoped to a preview-only key so expanding folders here can't disturb the real source-control
// tree's persisted collapse state for this repo.
//
// NO selection is provided, deliberately, which is what stops the tree drawing per-file
// checkboxes. Ticking files here would promise a partial pull, and there is no such thing: a pull
// is fetch + merge of a BRANCH, so it advances the whole ref or nothing. (Copying individual paths
// out of the fetched ref is `git checkout <upstream> -- <path>`, which leaves the branch behind
// and dirties the tree — a different operation with different consequences, not a pull.) This
// dialog is a read-only look at what the one pull would bring.
provideTreeCollapse(`incoming:${props.repoId}`);

/** Pull, then close. The parent owns the actual action (and its toast). */
function pullNow(): void {
  if (!canPull.value) return;
  open.value = false;
  emit("pull");
}

function pullFromMenu(): void {
  if (!menuPullDisabled.value) emit("pull");
}
</script>

<template>
  <!-- The right half of a split button: same variant and same `size` as Pull, so it matches in
       both colour and height, with a hairline divider against Pull's right edge. Opening a menu
       rather than firing the dialog directly matches every other caret in the app (the commit
       split button, the branch switcher): a caret means "there are choices here".
       The joining classes live HERE, not on the <PullPreview> tag: this component's root is a
       renderless <DropdownMenu>, so a class passed in from the parent has no element to land on
       and is silently dropped — which is exactly how the left side ended up still rounded.
       `px-1` rather than the `px-1.5` its larger cousins use, because this button is h-6 to
       Commit's h-9; the same padding on a shorter button reads as a wide stub. -->
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        :variant="variant"
        size="sm"
        class="-ml-px rounded-l-none border-l border-l-black/15 px-1 dark:border-l-white/20"
        :disabled="disabled"
        :aria-label="$t('repo.preview.menuLabel')"
        :title="$t('repo.preview.menuLabel')"
      >
        <ChevronDown />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="max-w-48">
      <!-- The primary action is repeated here, as it is in the commit menu: having opened the
           menu, you should not have to close it again to do the obvious thing. -->
      <DropdownMenuItem
        data-testid="preview-menu-pull"
        :disabled="menuPullDisabled"
        @select="pullFromMenu"
      >
        <ArrowDownToLine :size="15" />
        <span>{{ $t("repo.actions.pull") }}</span>
      </DropdownMenuItem>
      <DropdownMenuItem @select="open = true">
        <Eye :size="15" />
        <span>{{ $t("repo.preview.title") }}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader class="min-w-0">
        <DialogTitle class="flex items-center gap-2">
          <ArrowDownToLine :size="16" class="shrink-0 text-muted-foreground" />
          {{ $t("repo.preview.title") }}
        </DialogTitle>
        <DialogDescription>
          <template v-if="loading">{{ $t("repo.preview.checking") }}</template>
          <template v-else-if="result && !result.ok">{{ result.message || $t("repo.preview.failed") }}</template>
          <template v-else-if="result?.relation === 'no_upstream' || result?.noUpstream">
            {{ $t("repo.preview.noUpstream") }}
          </template>
          <template v-else-if="!hasIncoming">{{ $t("repo.preview.upToDate") }}</template>
          <template v-else>
            {{ $t("repo.preview.summary", {
              commits: result!.behind,
              files: result!.stat.filesChanged,
              upstream: result!.upstream,
            }) }}
          </template>
        </DialogDescription>
      </DialogHeader>

      <div v-if="loading" class="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
        <Loader2 :size="15" class="animate-spin" />{{ $t("repo.preview.checking") }}
      </div>

      <template v-else-if="result?.ok && hasIncoming">
        <!-- Lead with the verdict for the command RepoYeti ACTUALLY runs (`pull --ff-only`).
             A clean hypothetical merge is secondary evidence and must never turn a diverged
             pull green or imply that the primary button can create a merge commit. -->
        <div
          v-if="disposition === 'blocked_non_fast_forward'"
          data-testid="preview-pull-disposition"
          class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive"
        >
          <AlertTriangle :size="15" class="mt-px shrink-0" />
          <div class="font-medium">{{ $t("repo.preview.blockedDiverged") }}</div>
        </div>
        <div
          v-else-if="disposition === 'blocked_would_overwrite'"
          data-testid="preview-pull-disposition"
          class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive"
        >
          <AlertTriangle :size="15" class="mt-px shrink-0" />
          <div class="font-medium">{{ $t("repo.preview.blockedWouldOverwrite") }}</div>
        </div>
        <div
          v-else-if="disposition === 'ready_fast_forward'"
          data-testid="preview-pull-disposition"
          class="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-[12.5px] text-success"
        >
          <CheckCircle2 :size="15" class="shrink-0" />
          {{ $t("repo.preview.cleanFastForward") }}
        </div>
        <div
          v-else
          data-testid="preview-pull-disposition"
          class="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-[12.5px] text-muted-foreground"
        >
          <FileQuestion :size="15" class="shrink-0" />
          {{ $t("repo.preview.pullCheckUnknown") }}
        </div>

        <!-- A merge-tree simulation is still useful for a developer who chooses to reconcile a
             divergence manually, but it is deliberately quieter and explicitly labeled as a
             MANUAL merge check. It never changes the fast-forward-only verdict above. -->
        <div
          v-if="result.relation === 'diverged' && conflicts.length"
          data-testid="preview-manual-merge"
          class="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive"
        >
          <AlertTriangle :size="15" class="mt-px shrink-0" />
          <div class="min-w-0">
            <div class="font-medium">
              {{ $t("repo.preview.manualMergeWillConflict", { count: conflicts.length }, conflicts.length) }}
            </div>
            <ul class="mono mt-1 space-y-0.5 text-[11.5px] opacity-90">
              <li v-for="p in conflicts.slice(0, 8)" :key="p" class="truncate">{{ p }}</li>
              <li v-if="conflicts.length > 8" class="opacity-70">
                {{ $t("repo.preview.moreConflicts", { count: conflicts.length - 8 }) }}
              </li>
            </ul>
          </div>
        </div>
        <div
          v-else-if="result.relation === 'diverged' && !result.conflictCheck"
          data-testid="preview-manual-merge"
          class="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-[12.5px] text-muted-foreground"
        >
          <FileQuestion :size="15" class="shrink-0" />
          {{ $t("repo.preview.manualMergeUnknown") }}
        </div>
        <div
          v-else-if="result.relation === 'diverged'"
          data-testid="preview-manual-merge"
          class="flex items-center gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-[12.5px] text-info"
        >
          <CheckCircle2 :size="15" class="shrink-0" />
          {{ $t("repo.preview.manualMergeClean") }}
        </div>

        <!-- incoming commits -->
        <div class="min-w-0">
          <div class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            <GitCommitHorizontal :size="13" />
            {{ $t("repo.preview.commitsHeading", { count: commits.length }, commits.length) }}
          </div>
          <div class="scroll-slim max-h-44 overflow-y-auto rounded-md border border-border">
            <div
              v-for="c in commits"
              :key="c.hash"
              class="flex items-center gap-2 border-b border-border px-2 py-1 text-[12px] last:border-b-0"
            >
              <span class="mono shrink-0 text-[11px] text-info/80">{{ c.shortHash }}</span>
              <span class="min-w-0 flex-1 truncate" :title="c.subject">{{ c.subject }}</span>
              <!-- a zero half is noise, not information — drop it rather than print "−0" -->
              <span
                v-if="c.stat && (c.stat.addedLines || c.stat.removedLines)"
                class="mono shrink-0 text-[10.5px]"
              >
                <span v-if="c.stat.addedLines" class="text-success">+{{ c.stat.addedLines }}</span>
                <span v-if="c.stat.removedLines" class="ml-1 text-destructive">−{{ c.stat.removedLines }}</span>
              </span>
              <span class="shrink-0 text-[10.5px] whitespace-nowrap text-muted-foreground">{{ fromNow(c.date) }}</span>
            </div>
          </div>
          <p v-if="result!.commitsTruncated" class="mt-1 text-[11px] text-muted-foreground">
            {{ $t("repo.preview.commitsTruncated") }}
          </p>
        </div>

        <!-- incoming files, in the same tree the source-control panel uses -->
        <div class="min-w-0">
          <div class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {{ $t("repo.preview.filesHeading", { count: result!.stat.filesChanged }, result!.stat.filesChanged) }}
            <span class="mono ml-auto normal-case">
              <span v-if="result!.stat.addedLines" class="text-success">+{{ result!.stat.addedLines }}</span>
              <span v-if="result!.stat.removedLines" class="ml-1 text-destructive">−{{ result!.stat.removedLines }}</span>
            </span>
          </div>
          <div class="scroll-slim max-h-56 overflow-y-auto rounded-md border border-border p-1">
            <!-- read-only: no discard/stage/open here, these files don't exist locally yet -->
            <ChangesTree :nodes="tree" :repo-id="repoId" :can-control="false" is-guest read-only />
          </div>
          <p v-if="result!.filesTruncated" class="mt-1 text-[11px] text-muted-foreground">
            {{ $t("repo.preview.filesTruncated") }}
          </p>
        </div>
      </template>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ $t("common.close") }}</Button>
        <Button
          data-testid="preview-pull-action"
          :disabled="!canPull"
          :variant="canPull ? 'default' : 'secondary'"
          @click="pullNow"
        >
          <ArrowDownToLine />
          <template v-if="isPullBlocked">{{ $t("repo.preview.pullBlocked") }}</template>
          <template v-else-if="disposition === 'unknown'">{{ $t("repo.preview.pullUnavailable") }}</template>
          <template v-else>{{ $t("repo.actions.pull") }}</template>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
