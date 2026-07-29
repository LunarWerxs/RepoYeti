<script setup lang="ts">
// Renders an added/removed delta as a green "+adds" / red "−dels" pair. Shared by the
// changed-files tree (both lines and chars) and the repo-card header (lines only, with the
// character breakdown carried in a surrounding tooltip). Numbers only — no translatable
// text — so it stays i18n-clean; labels live in the caller's tooltip/title. Tolerates a
// null/undefined stat (renders nothing) so callers can bind possibly-absent stats directly.
//
// In "both" mode the two pairs used to be told apart only by a `·` and a slightly lower
// opacity, which made "+12 −3 · +410 −96" read as one run of four unrelated numbers. Each pair
// now carries a tiny leading glyph instead: ≡ for lines, A for characters.
import { computed } from "vue";
import { AlignLeft, Type } from "@lucide/vue";
import type { DiffStat } from "@/types";
import { fmtCount } from "@/lib/diffstat";

const props = withDefaults(
  defineProps<{ stat?: DiffStat | null; show?: "lines" | "chars" | "both" }>(),
  { stat: null, show: "both" },
);

// A zero half carries no information the other half doesn't already give, and down a long file
// list the "−0"s stack into a column that reads like a column of errors. Character counts are
// intra-line, so appending to a file genuinely removes nothing and lands on exactly that case.
// Each empty half is dropped, and a pair whose halves are both empty disappears entirely — the
// full figures still ride in the caller's hover title, so nothing becomes unreachable.
const showLines = computed(
  () => props.show !== "chars" && !!props.stat && (props.stat.addedLines > 0 || props.stat.removedLines > 0),
);
const showChars = computed(
  () => props.show !== "lines" && !!props.stat && (props.stat.addedChars > 0 || props.stat.removedChars > 0),
);
// The glyphs exist to tell the two pairs apart, so they only earn their space when both render.
const showGlyphs = computed(() => showLines.value && showChars.value);
</script>

<template>
  <span
    v-if="showLines || showChars"
    class="mono inline-flex shrink-0 items-center gap-1 text-[11px] leading-none tabular-nums"
  >
    <template v-if="showLines">
      <AlignLeft v-if="showGlyphs" :size="9" class="shrink-0 text-muted-foreground/50" />
      <span v-if="stat!.addedLines" class="text-success">+{{ fmtCount(stat!.addedLines) }}</span>
      <span v-if="stat!.removedLines" class="text-destructive">−{{ fmtCount(stat!.removedLines) }}</span>
    </template>
    <template v-if="showChars">
      <Type v-if="showGlyphs" :size="9" class="ml-0.5 shrink-0 text-muted-foreground/50" />
      <span v-if="stat!.addedChars" class="text-success/70">+{{ fmtCount(stat!.addedChars) }}</span>
      <span v-if="stat!.removedChars" class="text-destructive/70">−{{ fmtCount(stat!.removedChars) }}</span>
    </template>
  </span>
</template>
