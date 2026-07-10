<script setup lang="ts">
// Renders an added/removed delta as a green "+adds" / red "−dels" pair. Shared by the
// changed-files tree (both lines and chars) and the repo-card header (lines only, with the
// character breakdown carried in a surrounding tooltip). Numbers only — no translatable
// text — so it stays i18n-clean; labels live in the caller's tooltip/title. Tolerates a
// null/undefined stat (renders nothing) so callers can bind possibly-absent stats directly.
import type { DiffStat } from "@/types";
import { fmtCount } from "@/lib/diffstat";

withDefaults(defineProps<{ stat?: DiffStat | null; show?: "lines" | "chars" | "both" }>(), {
  stat: null,
  show: "both",
});
</script>

<template>
  <span
    v-if="stat"
    class="mono inline-flex shrink-0 items-center gap-1 text-[11px] leading-none tabular-nums"
  >
    <template v-if="show !== 'chars'">
      <span class="text-success">+{{ fmtCount(stat.addedLines) }}</span>
      <span class="text-destructive">−{{ fmtCount(stat.removedLines) }}</span>
    </template>
    <span v-if="show === 'both'" class="text-muted-foreground/40">·</span>
    <template v-if="show !== 'lines'">
      <span class="text-success/70">+{{ fmtCount(stat.addedChars) }}</span>
      <span class="text-destructive/70">−{{ fmtCount(stat.removedChars) }}</span>
    </template>
  </span>
</template>
