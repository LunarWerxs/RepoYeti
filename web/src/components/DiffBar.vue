<script setup lang="ts">
// A proportional added/removed change bar — the GitKraken-style alternative to a "+12 −3" pair.
//
// Shared by the History panel (commit-level totals, with a leading files-changed count) and the
// work-tree changed-files tree (per-file deltas, no files count). It was inline markup in
// LogPanel until the owner asked for the same option in the Changes view; a second copy of the
// scaling formula is exactly how the git-status colour map drifted before it was centralised.
//
// The bar's LENGTH is this row's churn against the largest churn in the same list (`max`), so
// bars are comparable down a column; its SPLIT is added vs removed. `max` is passed in rather
// than computed here because only the list owner can see every sibling row.
//
// Deliberately tooltip-FREE: it carries a native `title` and nothing else, so a caller decides
// whether the row can afford a real Tooltip instance. History wraps it in one; the changed-files
// tree does not, because that list runs to the daemon's MAX_CHANGED_FILES = 2000 rows and a
// Tooltip per row was measured as making the tree janky (the same reason those rows already use
// native `title` for every other hover).
import { Files } from "@lucide/vue";
import { barShare, barWidth, churn, compactN } from "@/lib/diffstat";

const props = withDefaults(
  defineProps<{
    added: number;
    removed: number;
    /** Largest churn among the sibling rows — the scale this bar is drawn against. */
    max: number;
    /** Commit-level only: the files-changed count rendered to the left of the bar. */
    files?: number | null;
    /** Exact figures for the hover title + accessible name (the bar itself abbreviates). */
    label?: string;
    /** Bar track width class. The History column is wider than a tree row's slot. */
    width?: string;
  }>(),
  { files: null, label: "", width: "w-16" },
);

const total = (): number => churn(props.added, props.removed);
</script>

<template>
  <span
    class="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    :aria-label="label || undefined"
    :title="label || undefined"
  >
    <span
      v-if="files !== null"
      class="inline-flex w-7 shrink-0 items-center justify-end gap-0.5 text-muted-foreground/75"
    >
      <Files :size="10" />{{ compactN(files) }}
    </span>
    <span class="flex h-2 shrink-0 overflow-hidden rounded-full bg-muted/55" :class="width">
      <!-- A zero-churn row (a merge commit, a mode-only change, a new empty file) still draws a
           stub, in neutral grey, so the column never has a silently empty cell. -->
      <span
        class="flex h-full min-w-px overflow-hidden rounded-full"
        :style="{ width: total() ? barWidth(total(), max) : '7%' }"
      >
        <span
          v-if="added"
          class="h-full bg-success/80"
          :style="{ width: barShare(added, removed, 'added') }"
        />
        <span
          v-if="removed"
          class="h-full bg-destructive/75"
          :style="{ width: barShare(added, removed, 'removed') }"
        />
        <span v-if="!total()" class="h-full w-full bg-muted-foreground/35" />
      </span>
    </span>
  </span>
</template>
