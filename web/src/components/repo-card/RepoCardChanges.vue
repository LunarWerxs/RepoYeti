<script setup lang="ts">
// Repo working-state strip (path + remote presence, branch switcher, error line) and the
// changed-files tree (search/filter, collapse-all, drag-to-resize, per-file discard), extracted
// from RepoCard. Self-contained like BranchPanel/StashPanel/LogPanel: reads/derives from `repo`
// and the store, and runs its own git ops (discard) keyed by repo.id.
import { computed, ref, useTemplateRef, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, ChevronsDownUp, ChevronsUpDown, Cloud, CloudOff, FileSearch, GripHorizontal, List, ListTree, Loader2, Search, X } from "@lucide/vue";
import { useStore } from "../../store";
import { api } from "../../api";
import { buildChangeTree } from "@/lib/util";
import { provideTreeCollapse } from "@/lib/changes-tree";
import { cn } from "@/lib/utils";
import { useRepoFeedback } from "@/lib/repo-feedback";
import {
  changesTreeStyle,
  setChangesOverride,
  clearChangesOverride,
  hasChangesOverride,
  changesDisplayMode,
  setChangesDisplayMode,
  MIN_CHANGES_PX,
  MAX_CHANGES_PX,
} from "@/lib/changes-view";
import { shortcutsActive } from "@/lib/hotkeys";
import { useGripDrag } from "@/lib/grip-drag";
import { useTooltipConfig } from "@/lib/tooltip-config";
import ChangesTree from "../ChangesTree.vue";
import BranchPanel from "../BranchPanel.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { Repo, TreeNode } from "../../types";

const props = defineProps<{ repo: Repo }>();
const store = useStore();
const { t } = useI18n();
const { toastResult } = useRepoFeedback();

const st = computed(() => props.repo.status);
const hasRemote = computed(() => !!st.value?.remote);

// The toolbar's icon-only buttons are Tooltip-labelled; when the app-wide "show tooltips"
// switch is off, reka suppresses those, so a native :title takes over as the only visible
// label (the same gated-title pattern as RepoCardHeader's dropdown triggers).
const { enabled: tooltipsEnabled } = useTooltipConfig();

// ── collapse + changed-files tree ─────────────────────────────────────────────
const changeTree = computed(() => buildChangeTree(store.changesByRepo[props.repo.id] ?? []));

// Per-folder collapse state, shared with the recursive ChangesTree via provide/inject
// (persisted per repo — see @/lib/changes-tree).
const treeCollapse = provideTreeCollapse(props.repo.id);

function collectDirPaths(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "dir") {
      acc.push(n.path);
      if (n.children) collectDirPaths(n.children, acc);
    }
  }
  return acc;
}
const dirPaths = computed(() => collectDirPaths(changeTree.value));
// True once every folder is collapsed → the button flips to "expand all".
const allCollapsed = computed(
  () => dirPaths.value.length > 0 && dirPaths.value.every((p) => treeCollapse.collapsed.has(p)),
);
function toggleCollapseAll(): void {
  if (allCollapsed.value) treeCollapse.expandAll();
  else treeCollapse.collapseAll(dirPaths.value);
}

// ── tree ⇄ list view (per-repo, persisted; see @/lib/changes-view) ────────────
// Some people prefer a flat list of full paths over the nested folder tree. The toggle in the
// toolbar flips this per card; "tree" is the default so nothing changes for existing cards.
const displayMode = computed(() => changesDisplayMode(props.repo.id));
const isList = computed(() => displayMode.value === "list");
function toggleDisplayMode(): void {
  setChangesDisplayMode(props.repo.id, isList.value ? "tree" : "list");
}

// List view = every file leaf of the (already search-filtered) tree, flattened and sorted by
// full path. Reuses ChangesTree in `flat` mode, so selection / discard / open / diff-stats /
// keyboard nav all work identically — only folders and indentation drop away.
function flattenLeaves(nodes: TreeNode[], acc: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    if (n.type === "file") acc.push(n);
    else if (n.children) flattenLeaves(n.children, acc);
  }
  return acc;
}

// ── changed-files search ──────────────────────────────────────────────────────
// Filename filtering is instant + local. The "Search content" toggle additionally greps
// inside the changed files via the daemon — debounced, cancellable, and only at ≥3 chars.
// Lifted to RepoCard (v-model) rather than a plain local ref: RepoCardChanges lives inside
// <CollapsibleContent>, which unmounts its content on collapse (reka-ui's default
// unmountOnHide), so state owned here would otherwise reset every time the card is
// collapsed/re-expanded — RepoCard's own scope doesn't unmount, so it survives there.
const treeQuery = defineModel<string>("treeQuery", { required: true });
const searching = computed(() => treeQuery.value.trim().length > 0);

const contentMode = defineModel<boolean>("contentMode", { required: true });
const contentMatches = ref<Set<string>>(new Set());
const contentLoading = ref(false);
// Server-owned threshold (from /api/status) so the UI gate can't drift from the daemon's.
const minContentChars = computed(() => store.contentSearchMin);
let searchAbort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function runContentSearch(): void {
  const ctrl = new AbortController();
  searchAbort = ctrl;
  // Safety net: never let a hung/slow daemon strand the spinner. boundedGit already kills
  // its git child at 30s; this is the independent client-side cap on the whole round-trip.
  const killTimer = setTimeout(() => ctrl.abort(), 10_000);
  api
    .searchContent(props.repo.id, treeQuery.value.trim(), ctrl.signal)
    .then((paths) => {
      if (!ctrl.signal.aborted) contentMatches.value = new Set(paths);
    })
    .catch(() => {
      if (!ctrl.signal.aborted) contentMatches.value = new Set();
    })
    .finally(() => {
      clearTimeout(killTimer);
      if (searchAbort === ctrl) {
        contentLoading.value = false;
        searchAbort = null;
      }
    });
}

// Each keystroke (or toggle) cancels any in-flight request and drops stale matches, then
// re-arms the debounce. Below the threshold (or with content mode off) we don't hit git.
watch([treeQuery, contentMode], () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchAbort?.abort();
  searchAbort = null;
  contentMatches.value = new Set();
  if (!contentMode.value || treeQuery.value.trim().length < minContentChars.value) {
    contentLoading.value = false;
    return;
  }
  contentLoading.value = true; // show the spinner immediately, even during the debounce
  searchTimer = setTimeout(runContentSearch, 180);
});

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  searchAbort?.abort();
});

// A file is kept when its path matches the query, or — in content mode at ≥3 chars — when
// its content matched. A folder is kept when its own name matches (then it shows all its
// contents) or it has a kept descendant. The tree is force-expanded while searching.
function filterTreeBy(nodes: TreeNode[], keep: (n: TreeNode) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === "dir") {
      if (keep(n)) {
        out.push(n); // folder itself matches → show it with all its contents
      } else {
        const kids = n.children ? filterTreeBy(n.children, keep) : [];
        if (kids.length) out.push({ ...n, children: kids });
      }
    } else if (keep(n)) {
      out.push(n);
    }
  }
  return out;
}
const filteredTree = computed(() => {
  const q = treeQuery.value.trim().toLowerCase();
  if (!q) return changeTree.value;
  const useContent = contentMode.value && q.length >= minContentChars.value;
  const matches = contentMatches.value;
  return filterTreeBy(
    changeTree.value,
    (n) => n.path.toLowerCase().includes(q) || (useContent && n.type === "file" && matches.has(n.path)),
  );
});
// The flat file list for list view — leaves of the filtered tree, sorted by full path.
const flatFiles = computed(() =>
  flattenLeaves(filteredTree.value).sort((a, b) => a.path.localeCompare(b.path)),
);

// ── drag-to-resize the changed-files tree ─────────────────────────────────────
// The grip below the tree pins an explicit height (persisted per repo); double-click
// it (or press Delete) to fall back to the global Settings preset. See @/lib/changes-view.
const treeScroll = useTemplateRef<HTMLElement>("treeScroll");
// Live px while a drag is in flight; persisted once on release so we don't thrash
// localStorage (the deep useLocalStorage watcher serialises on every mutation).
const dragHeight = ref<number | null>(null);
const treeStyle = computed(() =>
  dragHeight.value != null ? { height: `${dragHeight.value}px` } : changesTreeStyle(props.repo.id),
);
const resized = computed(() => hasChangesOverride(props.repo.id));
const clampPx = (px: number): number =>
  Math.min(MAX_CHANGES_PX, Math.max(MIN_CHANGES_PX, Math.round(px)));
let dragStartY = 0;
let dragStartH = 0;

// All the release/stuck-drag handling (button filtering, capture loss, swallowed pointerup,
// blur, unmount) lives in useGripDrag — see @/lib/grip-drag.
const onGripDown = useGripDrag({
  onStart: (e) => {
    if (!treeScroll.value) return false;
    dragStartY = e.clientY;
    dragStartH = treeScroll.value.clientHeight;
  },
  onMove: (e) => {
    dragHeight.value = clampPx(dragStartH + (e.clientY - dragStartY));
  },
  onEnd: () => {
    if (dragHeight.value != null) {
      setChangesOverride(props.repo.id, dragHeight.value); // commit the final height
      dragHeight.value = null;
    }
  },
});
function resetTreeHeight(): void {
  dragHeight.value = null;
  clearChangesOverride(props.repo.id);
}
// Keyboard: ↑/↓ nudge the height in 24px steps from the current rendered size.
function nudgeHeight(delta: number): void {
  const base = treeScroll.value?.clientHeight;
  if (base) setChangesOverride(props.repo.id, base + delta);
}

// The changed-files grip's keyboard resize (↑/↓/Del) only fires when shortcuts are on.
function gripKey(action: () => void): void {
  if (shortcutsActive()) action();
}

// ── discard one file's working-tree changes (confirm-gated) ───────────────────
const discardTarget = ref<string | null>(null);
const discardOpen = computed({
  get: () => discardTarget.value !== null,
  set: (v: boolean) => {
    if (!v) discardTarget.value = null;
  },
});
function askDiscard(path: string): void {
  discardTarget.value = path;
}
async function confirmDiscard(): Promise<void> {
  const path = discardTarget.value;
  discardTarget.value = null;
  if (!path) return;
  // Serialize with the other per-repo git ops (matches BranchPanel/StashPanel): a rapid second
  // discard while one is still in flight would otherwise fire two concurrent discardFile ops.
  if (store.gitOpBusy[props.repo.id]) return;
  toastResult(await store.discardFile(props.repo.id, path), t("repo.discard.discarded"));
}

// ── drag-to-move: a file row dropped on a folder row moves it there (bubbled from ChangesTree) ──
async function onMove(payload: { from: string; toDir: string }): Promise<void> {
  // Serialize with the other per-repo git ops (matches discard): don't fire a move while one is
  // already in flight for this repo.
  if (store.gitOpBusy[props.repo.id]) return;
  toastResult(await store.moveFile(props.repo.id, payload.from, payload.toDir), t("repo.changes.moved"));
}
</script>

<template>
  <!-- path (location) + remote-presence cloud, kept on one line -->
  <div class="flex items-center gap-2">
    <div
      class="mono min-w-0 flex-1 truncate text-left text-[11.5px] text-muted-foreground"
      dir="rtl"
      :title="repo.absPath"
    >
      {{ repo.absPath }}
    </div>
    <Tooltip>
      <TooltipTrigger as-child>
        <span :class="cn('inline-flex shrink-0', hasRemote ? 'text-info/80' : 'text-muted-foreground/50')">
          <Cloud v-if="hasRemote" :size="16" />
          <CloudOff v-else :size="16" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{{ hasRemote ? st?.remote : $t("repo.badge.noRemote") }}</TooltipContent>
    </Tooltip>
  </div>

  <!-- branch switcher + inline create form — see BranchPanel.vue -->
  <BranchPanel
    v-if="!st?.error"
    :repo-id="repo.id"
    :branch="st?.branch ?? null"
    :detached="st?.detached ?? false"
  />

  <!-- error line -->
  <div
    v-if="st?.error"
    class="flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-2 text-[12.5px] text-destructive"
  >
    <AlertTriangle :size="14" class="shrink-0" />
    <span class="min-w-0 break-words">{{ st.error }}</span>
  </div>

  <!-- changed-files tree (height from Settings preset; drag the grip to resize) -->
  <ExpandTransition :open="!!(st && st.dirty > 0)">
  <div
    class="overflow-hidden rounded-md border border-border bg-background/40"
  >
    <!-- tree toolbar: filter the changed files + collapse-all ⇄ expand-all -->
    <div class="flex items-center gap-1.5 border-b border-border/40 px-1.5 py-1">
      <div class="relative min-w-0 flex-1">
        <Search
          class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          v-model="treeQuery"
          type="text"
          :placeholder="$t('repo.changes.searchPlaceholder')"
          :aria-label="$t('repo.changes.searchPlaceholder')"
          class="h-6 w-full rounded bg-transparent pr-14 pl-7 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:bg-accent/30 focus-visible:ring-1 focus-visible:ring-ring/40"
        />
        <!-- right cluster: clear (only with a query) + the "search inside files" toggle -->
        <div class="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
          <Tooltip v-if="treeQuery">
            <TooltipTrigger as-child>
              <button
                type="button"
                :aria-label="$t('repo.changes.searchClear')"
                :title="tooltipsEnabled ? undefined : $t('repo.changes.searchClear')"
                class="flex size-6 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                @click="treeQuery = ''"
              >
                <X :size="12" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ $t("repo.changes.searchClear") }}</TooltipContent>
          </Tooltip>
          <!-- greps inside the changed files (fires at ≥ min chars); highlighted while on,
               spinner while a search is in flight. Tooltip replaces the old text label. -->
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                type="button"
                role="checkbox"
                :aria-checked="contentMode"
                :aria-label="$t('repo.changes.searchContent')"
                :title="tooltipsEnabled ? undefined : $t('repo.changes.searchContent')"
                class="flex size-6 items-center justify-center rounded outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
                :class="contentMode ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
                @click="contentMode = !contentMode"
              >
                <Loader2 v-if="contentLoading" :size="13" class="animate-spin" />
                <FileSearch v-else :size="13" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ $t("repo.changes.searchContent") }}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <!-- tree ⇄ list view toggle (per-repo, persisted). Shows the icon of the mode you'd switch TO. -->
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            role="switch"
            :aria-checked="isList"
            class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            :aria-label="isList ? $t('repo.changes.viewAsTree') : $t('repo.changes.viewAsList')"
            :title="tooltipsEnabled ? undefined : (isList ? $t('repo.changes.viewAsTree') : $t('repo.changes.viewAsList'))"
            @click="toggleDisplayMode"
          >
            <component :is="isList ? ListTree : List" :size="14" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ isList ? $t("repo.changes.viewAsTree") : $t("repo.changes.viewAsList") }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="dirPaths.length && !searching && !isList">
        <TooltipTrigger as-child>
          <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            :aria-label="allCollapsed ? $t('repo.changes.expandAll') : $t('repo.changes.collapseAll')"
            :title="tooltipsEnabled ? undefined : (allCollapsed ? $t('repo.changes.expandAll') : $t('repo.changes.collapseAll'))"
            @click="toggleCollapseAll"
          >
            <component :is="allCollapsed ? ChevronsUpDown : ChevronsDownUp" :size="14" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ allCollapsed ? $t("repo.changes.expandAll") : $t("repo.changes.collapseAll") }}</TooltipContent>
      </Tooltip>
    </div>
    <div ref="treeScroll" class="scroll-slim overflow-y-auto p-1" :style="treeStyle">
      <!-- Spinner only before the FIRST load: changesLoading also flips on every background
           refresh, and swapping the whole (possibly huge) tree for a spinner and back would
           unmount/remount thousands of rows on each refresh. Once data exists, the old tree
           stays up and patches in place when the new list lands. -->
      <div
        v-if="store.changesLoading[repo.id] && !store.changesByRepo[repo.id]"
        class="flex items-center gap-2 px-2.5 py-2 text-[12.5px] text-muted-foreground"
      >
        <Loader2 :size="14" class="animate-spin" /> {{ $t("repo.changes.loading") }}
      </div>
      <div
        v-else-if="searching && !filteredTree.length && !contentLoading"
        class="px-2.5 py-2 text-[12px] text-muted-foreground"
      >
        {{ $t("repo.changes.searchNoMatch") }}
      </div>
      <ChangesTree
        v-else
        :nodes="isList ? flatFiles : filteredTree"
        :repo-id="repo.id"
        :flat="isList"
        :force-expand="searching && !isList"
        @discard="askDiscard"
        @move="onMove"
      />
      <!-- Server capped an oversized changed-file list (MAX_CHANGED_FILES) — say so. -->
      <div
        v-if="store.changesMeta[repo.id]?.truncated"
        class="px-2.5 py-1.5 text-[11.5px] text-warning/80"
      >
        {{
          $t("repo.changes.truncated", {
            shown: store.changesByRepo[repo.id]?.length ?? 0,
            total: store.changesMeta[repo.id]?.total,
          })
        }}
      </div>
    </div>
    <!-- resize grip: drag (or ↑/↓) to set an explicit height; double-click / Delete to reset -->
    <button
      type="button"
      :aria-label="resized ? $t('repo.changes.gripAriaResized') : $t('repo.changes.gripAria')"
      :title="resized ? $t('repo.changes.gripTitleResized') : $t('repo.changes.gripTitle')"
      class="group/grip flex h-5 w-full cursor-ns-resize touch-none items-center justify-center border-t border-border/40 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/40"
      @pointerdown="onGripDown"
      @dblclick="resetTreeHeight"
      @keydown.up.prevent="gripKey(() => nudgeHeight(-24))"
      @keydown.down.prevent="gripKey(() => nudgeHeight(24))"
      @keydown.delete.prevent="gripKey(resetTreeHeight)"
      @keydown.backspace.prevent="gripKey(resetTreeHeight)"
    >
      <GripHorizontal
        :size="14"
        :class="
          cn(
            'text-muted-foreground/40 transition-colors group-hover/grip:text-muted-foreground',
            resized && 'text-primary/50',
          )
        "
      />
    </button>
  </div>
  </ExpandTransition>

  <!-- confirm before discarding a file's working-tree changes (destructive) -->
  <Dialog v-model:open="discardOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.discard.title") }}</DialogTitle>
        <DialogDescription>{{ $t("repo.discard.body", { file: discardTarget ?? "" }) }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button variant="secondary" @click="discardOpen = false">{{ $t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDiscard">{{ $t("repo.discard.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
