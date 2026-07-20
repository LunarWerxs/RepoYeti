<script setup lang="ts">
// The action bar shown while the dashboard is in multi-select mode (see @/lib/repo-selection).
// Sticks to the bottom of the viewport so it stays reachable however far the list is scrolled,
// and offers the same per-repo actions the card's ⋮ menu does, applied across the selection:
// pin, star, hide, and remove-from-RepoYeti (confirm-gated, index-only — never deletes a folder).
//
// Bulk ops run SEQUENTIALLY, not via Promise.all: each one is a daemon write against the shared
// repo index, and firing 40 concurrent writes is how you get partial-apply races. The bar reports
// how many actually succeeded rather than assuming.
import { computed, onBeforeUnmount, onMounted, ref, watch, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";
import { EyeOff, Loader2, Pin, Star, Trash2, X } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import {
  bulkBarHeight,
  clearSelection,
  pruneSelection,
  selectAll,
  selectionCount,
  selectionIds,
  stopSelecting,
} from "@/lib/repo-selection";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { Repo } from "../types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const store = useStore();
const { t } = useI18n();

const busy = ref(false);
const removeOpen = ref(false);

// Publish our height so App.vue can lift the bottom-right toasts clear of this bar — otherwise a
// toast covers the right-hand buttons, Undo included. Observed rather than measured once: the bar
// wraps to a second row on narrow viewports, and an action can widen it mid-selection.
const barRef = useTemplateRef<HTMLElement>("bar");
let ro: ResizeObserver | null = null;
onMounted(() => {
  const el = barRef.value;
  if (!el) return;
  bulkBarHeight.value = el.offsetHeight;
  if (typeof ResizeObserver === "undefined") return;
  ro = new ResizeObserver(() => (bulkBarHeight.value = el.offsetHeight));
  ro.observe(el);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  bulkBarHeight.value = 0; // back to the plain bottom-right resting position
});

/**
 * Every repo the dashboard is currently SHOWING — the target of "select all".
 *
 * This has to honour the filter bar, not just the hidden flag: with a search/status/identity
 * filter on, AppShell renders `filteredRepos` (a subset), so sourcing this from `visibleRepos`
 * would tick repos that aren't on screen — and a following "Remove" would delete repos the
 * owner filtered away and never saw.
 */
const visibleIds = computed(() =>
  (store.filtersActive ? store.filteredRepos : store.visibleRepos).map((r) => r.id),
);
const allSelected = computed(
  () => visibleIds.value.length > 0 && selectionCount.value === visibleIds.value.length,
);

// A repo can vanish under us (bulk remove, rescan, another session) — don't keep its id ticked.
watch(
  () => store.repos.map((r) => r.id).join(","),
  () => pruneSelection(store.repos.map((r) => r.id)),
);

function toggleAll(): void {
  if (allSelected.value) clearSelection();
  else selectAll(visibleIds.value);
}

/** Success toast carrying an Undo, matching the per-repo toggles' convention. */
function undoableToast(message: string, revert: () => Promise<unknown>): void {
  toast.success(message, {
    action: {
      label: t("repo.undo"),
      onClick: () => {
        void revert();
      },
    },
  });
}

/** Run `op` over the selection one at a time; toast how many landed, with an optional Undo. */
async function runBulk(
  op: (id: string) => Promise<unknown>,
  done: (n: number) => string,
  revert?: () => Promise<unknown>,
): Promise<void> {
  if (busy.value || !selectionCount.value) return;
  busy.value = true;
  const ids = selectionIds.value;
  let ok = 0;
  try {
    for (const id of ids) {
      try {
        await op(id);
        ok += 1;
      } catch {
        /* keep going — one failure shouldn't strand the rest */
      }
    }
    if (ok === ids.length) {
      if (revert) undoableToast(done(ok), revert);
      else toast.success(done(ok));
    } else toast.warning(t("bulk.partial", { ok, failed: ids.length - ok }));
  } finally {
    busy.value = false;
  }
}

/**
 * Flip a boolean flag ON across the selection, with an Undo that restores each repo's OWN
 * previous value. That last part is why this snapshots first: a plain "set them all back to
 * false" would silently unpin repos that were already pinned before the bulk action.
 */
async function bulkFlag(
  read: (r: Repo) => boolean,
  write: (id: string, value: boolean) => Promise<unknown>,
  done: (n: number) => string,
): Promise<void> {
  const wasOff = selectionIds.value.filter((id) => {
    const repo = store.repos.find((r) => r.id === id);
    return repo ? !read(repo) : false;
  });
  await runBulk(
    (id) => write(id, true),
    done,
    async () => {
      for (const id of wasOff) {
        try {
          await write(id, false);
        } catch {
          /* best-effort restore */
        }
      }
    },
  );
}

async function bulkPin(): Promise<void> {
  await bulkFlag((r) => !!r.pinned, (id, v) => store.setPinned(id, v), (n) => t("bulk.pinned", { count: n }, n));
}
async function bulkStar(): Promise<void> {
  await bulkFlag((r) => !!r.starred, (id, v) => store.setStarred(id, v), (n) => t("bulk.starred", { count: n }, n));
}
async function bulkHide(): Promise<void> {
  await bulkFlag((r) => !!r.hidden, (id, v) => store.setHidden(id, v), (n) => t("bulk.hidden", { count: n }, n));
}

/**
 * Remove doesn't go through runBulk: undoing it needs the removed Repo OBJECTS (for their
 * absPath), which only exist as removeRepo's return value, and restoring is a genuine
 * re-index rather than flipping a flag back. Undo is offered whenever anything was removed,
 * including a partial run.
 */
async function bulkRemove(): Promise<void> {
  removeOpen.value = false;
  if (busy.value || !selectionCount.value) return;
  busy.value = true;
  const ids = selectionIds.value;
  const removed: Repo[] = [];
  try {
    for (const id of ids) {
      try {
        const r = await store.removeRepo(id);
        if (r) removed.push(r);
      } catch {
        /* keep going — one failure shouldn't strand the rest */
      }
    }
    const n = removed.length;
    // A genuine restore (drops the tombstone + re-indexes), not a re-add — a rescan would
    // otherwise refuse the path and the repo would vanish again. Same as the single-repo undo.
    const restoreAll = async (): Promise<void> => {
      for (const r of removed) {
        try {
          await store.restoreRemovedRepo(r.absPath);
        } catch {
          /* best-effort restore */
        }
      }
    };
    if (n === 0) toast.error(t("repo.toastRemoveFailed"));
    else if (n === ids.length) undoableToast(t("bulk.removed", { count: n }, n), restoreAll);
    else undoableToast(t("bulk.partial", { ok: n, failed: ids.length - n }), restoreAll);
  } finally {
    busy.value = false;
    // Every target is gone (or failed); either way the old ids are meaningless now.
    clearSelection();
  }
}
</script>

<template>
  <!-- Bottom-anchored so it's reachable at any scroll position. `safe-bottom` keeps it clear of
       the iOS home indicator, matching AppFooter.
       Two things stop the file viewer / settings drawer from burying it: it stays inside the
       un-pushed region via --content-inset-right (the same variable the dialogs re-centre on),
       and it sits one layer above the drawer's z-40. Modals (z-50) still win, which is right. -->
  <div
    class="safe-bottom pointer-events-none fixed bottom-0 left-0 z-[45] px-4 pb-4"
    :style="{ right: 'var(--content-inset-right, 0px)' }"
  >
    <div
      ref="bar"
      class="pointer-events-auto mx-auto flex max-w-(--container-max) flex-wrap items-center gap-2 rounded-xl border border-border bg-popover/95 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur"
    >
      <span class="text-[13px] font-medium">
        {{ $t("bulk.selected", { count: selectionCount }, selectionCount) }}
      </span>

      <Button variant="ghost" size="sm" class="h-7" :disabled="busy" @click="toggleAll">
        {{ allSelected ? $t("bulk.selectNone") : $t("bulk.selectAll") }}
      </Button>

      <span class="flex-1" />

      <Tooltip>
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <Button
              variant="secondary"
              size="sm"
              class="h-7"
              :disabled="busy || !selectionCount"
              @click="bulkPin"
            >
              <Loader2 v-if="busy" class="animate-spin" />
              <Pin v-else />
              <span class="hidden sm:inline">{{ $t("repo.pin") }}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ $t("bulk.pinTooltip") }}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <Button
              variant="secondary"
              size="sm"
              class="h-7"
              :disabled="busy || !selectionCount"
              @click="bulkStar"
            >
              <Star />
              <span class="hidden sm:inline">{{ $t("repo.star") }}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ $t("bulk.starTooltip") }}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <Button
              variant="secondary"
              size="sm"
              class="h-7"
              :disabled="busy || !selectionCount"
              @click="bulkHide"
            >
              <EyeOff />
              <span class="hidden sm:inline">{{ $t("repo.hide") }}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ $t("bulk.hideTooltip") }}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <Button
              variant="destructive"
              size="sm"
              class="h-7"
              :disabled="busy || !selectionCount"
              @click="removeOpen = true"
            >
              <Trash2 />
              <span class="hidden sm:inline">{{ $t("repo.remove.action") }}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ $t("bulk.removeTooltip") }}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="$t('bulk.exit')"
              :disabled="busy"
              @click="stopSelecting"
            >
              <X />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ $t("bulk.exit") }}</TooltipContent>
      </Tooltip>
    </div>
  </div>

  <!-- Removing many at once is the one bulk action worth a confirm: it's the only one that isn't
       a one-tap toggle back. Still index-only — no folder on disk is touched. -->
  <Dialog v-model:open="removeOpen">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t("bulk.removeTitle", { count: selectionCount }, selectionCount) }}</DialogTitle>
        <DialogDescription>{{ $t("repo.remove.description") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="removeOpen = false">{{ $t("common.cancel") }}</Button>
        <Button variant="destructive" @click="bulkRemove">{{ $t("repo.remove.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
