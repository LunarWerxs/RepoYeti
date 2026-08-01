<script setup lang="ts">
// One conflict region under review: what git found, what the model proposed, and — the part
// that does the real work here — what the daemon MEASURED about that proposal.
//
// The layout is deliberate. `flags` render above the proposal, not below it, and they render
// whatever the model claimed about itself: a "high confidence" resolution that dropped a line
// both sides kept is exactly the failure this feature has to make visible, and burying the
// evidence under the code would be showing it in the place nobody looks. The model's own
// confidence is a chip; the audit is a callout.
//
// Accept is opt-in per region and starts OFF for every region, including clean ones. The parent
// offers a "select the clean ones" shortcut so that isn't tedious, but the default state of a
// merge nobody has looked at is "not accepted".
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Pencil } from "@lucide/vue";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConflictHunk, HunkResolution, ResolutionFlag } from "../../types";

const props = defineProps<{
  hunk: ConflictHunk;
  /** Absent when the model returned nothing usable for this region (see `rejectedReason`). */
  resolution?: HunkResolution;
  /** Why this region has no proposal, when it has none. */
  rejectedReason?: string;
}>();

/** Accepted state + the (possibly hand-edited) text, both owned by the parent so Apply can read
 *  every region at once. */
const accepted = defineModel<boolean>("accepted", { required: true });
const content = defineModel<string>("content", { required: true });

const { t } = useI18n();
const showSides = ref(false);
const editing = ref(false);

/** The audit findings, worst first — a dropped shared line outranks a stylistic observation. */
const FLAG_ORDER: ResolutionFlag[] = [
  "dropped-shared-lines",
  "emptied",
  "invented-lines",
  "much-shorter",
  "identical-to-ours",
  "identical-to-theirs",
];
const flags = computed(() =>
  [...(props.resolution?.flags ?? [])].sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b)),
);

/** Literal t() keys (never a computed `repo.resolve.flag.${f}`) so scripts/i18n-check.mjs can
 *  statically verify every key here exists — the same rule ChangesTree's conflictLabel follows. */
function flagLabel(flag: ResolutionFlag): string {
  switch (flag) {
    case "dropped-shared-lines":
      return t("repo.resolve.flag.droppedShared");
    case "emptied":
      return t("repo.resolve.flag.emptied");
    case "invented-lines":
      return t("repo.resolve.flag.invented");
    case "much-shorter":
      return t("repo.resolve.flag.muchShorter");
    case "identical-to-ours":
      return t("repo.resolve.flag.identicalOurs");
    default:
      return t("repo.resolve.flag.identicalTheirs");
  }
}

/** Whether a flag means "this is probably wrong" rather than "you should know this". Picking a
 *  side wholesale is a legitimate resolution; losing a line both sides kept is not. */
function flagIsSevere(flag: ResolutionFlag): boolean {
  return flag === "dropped-shared-lines" || flag === "emptied" || flag === "invented-lines";
}

const severe = computed(() => flags.value.some(flagIsSevere));
const confidence = computed(() => props.resolution?.confidence ?? "low");
/** The one-line verdict on the header row: an audit finding wins over the model's own claim. */
const needsAttention = computed(() => severe.value || confidence.value === "low");

const confidenceLabel = computed(() => {
  switch (confidence.value) {
    case "high":
      return t("repo.resolve.confidenceHigh");
    case "medium":
      return t("repo.resolve.confidenceMedium");
    default:
      return t("repo.resolve.confidenceLow");
  }
});

// A hand-edit is still the owner's to accept or not, but it should not silently inherit an
// "accepted" tick that referred to the model's text. Re-editing an accepted region un-accepts it.
watch(content, (next, prev) => {
  if (next !== prev && accepted.value && editing.value) accepted.value = false;
});

const lineCount = (text: string): number => (text ? text.replace(/\n$/, "").split("\n").length : 0);
</script>

<template>
  <div
    :class="
      cn(
        'rounded-lg ring-1 transition-colors',
        accepted
          ? 'bg-success/5 ring-success/40'
          : severe
            ? 'bg-destructive/5 ring-destructive/40'
            : needsAttention
              ? 'bg-warning/5 ring-warning/30'
              : 'bg-muted/30 ring-border',
      )
    "
  >
    <!-- header: which region, what the model claimed, accept toggle -->
    <div class="flex items-center gap-2 px-3 py-2">
      <span class="mono shrink-0 text-[11px] font-semibold text-muted-foreground">
        {{ $t("repo.resolve.regionLabel", { n: hunk.index, line: hunk.line + 1 }) }}
      </span>

      <span
        v-if="resolution"
        :class="
          cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            confidence === 'high'
              ? 'bg-success/15 text-success'
              : confidence === 'medium'
                ? 'bg-warning/15 text-warning'
                : 'bg-destructive/15 text-destructive',
          )
        "
      >
        {{ confidenceLabel }}
      </span>

      <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {{ resolution?.note || rejectedReason }}
      </span>

      <Tooltip>
        <TooltipTrigger as-child>
          <button
            v-if="resolution"
            type="button"
            role="checkbox"
            :aria-checked="accepted"
            :aria-label="$t('repo.resolve.acceptAria', { n: hunk.index })"
            :class="
              cn(
                'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                accepted
                  ? 'bg-success/15 text-success hover:bg-success/25'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )
            "
            @click="accepted = !accepted"
          >
            <Check :size="12" />
            {{ accepted ? $t("repo.resolve.accepted") : $t("repo.resolve.accept") }}
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ $t("repo.resolve.acceptHint") }}</TooltipContent>
      </Tooltip>
    </div>

    <!-- the mechanical audit: above the code, and independent of the model's own confidence -->
    <div v-if="flags.length" class="flex flex-col gap-1 px-3 pb-2">
      <div
        v-for="flag in flags"
        :key="flag"
        :class="
          cn(
            'flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px]/relaxed',
            flagIsSevere(flag) ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
          )
        "
      >
        <AlertTriangle :size="12" class="mt-0.5 shrink-0" />
        <span class="min-w-0">{{ flagLabel(flag) }}</span>
      </div>
      <!-- The actual dropped lines, because "it dropped a shared line" is a claim the owner
           should be able to check in place rather than take on faith. -->
      <pre
        v-if="resolution?.droppedLines?.length"
        class="mono max-h-24 overflow-auto rounded-md bg-destructive/5 px-2 py-1 text-[10px]/snug text-destructive"
      >{{ resolution.droppedLines.join("\n") }}</pre>
    </div>

    <!-- the proposal -->
    <div v-if="resolution" class="px-3 pb-2">
      <div class="mb-1 flex items-center gap-2">
        <span class="text-[11px] font-medium text-foreground">{{ $t("repo.resolve.proposed") }}</span>
        <span class="text-[10px] text-muted-foreground">
          {{ $t("repo.resolve.lineCount", { n: lineCount(content) }, lineCount(content)) }}
        </span>
        <button
          type="button"
          class="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          @click="editing = !editing"
        >
          <Pencil :size="11" />
          {{ editing ? $t("repo.resolve.editDone") : $t("repo.resolve.edit") }}
        </button>
      </div>
      <Textarea
        v-if="editing"
        v-model="content"
        rows="8"
        spellcheck="false"
        class="mono resize-y text-[11px]/snug"
        :aria-label="$t('repo.resolve.editAria', { n: hunk.index })"
      />
      <pre
        v-else
        class="mono max-h-64 overflow-auto rounded-md bg-background/60 px-2 py-1.5 text-[11px]/snug ring-1 ring-border"
      >{{ content || $t("repo.resolve.emptyResolution") }}</pre>
    </div>

    <!-- what git actually found, collapsed by default (progressive disclosure) -->
    <div class="px-3 pb-2">
      <button
        type="button"
        class="flex items-center gap-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        :aria-expanded="showSides"
        @click="showSides = !showSides"
      >
        <component :is="showSides ? ChevronDown : ChevronRight" :size="12" />
        {{ showSides ? $t("repo.resolve.hideSides") : $t("repo.resolve.showSides") }}
      </button>
      <div v-if="showSides" class="mt-1.5 grid gap-1.5">
        <div>
          <div class="mono mb-0.5 text-[10px] font-semibold text-muted-foreground">
            {{ $t("repo.resolve.ours", { label: hunk.oursLabel }) }}
          </div>
          <pre class="mono max-h-40 overflow-auto rounded-md bg-background/60 px-2 py-1 text-[11px]/snug ring-1 ring-border">{{ hunk.oursText || $t("repo.resolve.emptySide") }}</pre>
        </div>
        <div v-if="hunk.baseText !== undefined">
          <div class="mono mb-0.5 text-[10px] font-semibold text-muted-foreground">
            {{ $t("repo.resolve.base") }}
          </div>
          <pre class="mono max-h-40 overflow-auto rounded-md bg-background/60 px-2 py-1 text-[11px]/snug ring-1 ring-border">{{ hunk.baseText || $t("repo.resolve.emptySide") }}</pre>
        </div>
        <div>
          <div class="mono mb-0.5 text-[10px] font-semibold text-muted-foreground">
            {{ $t("repo.resolve.theirs", { label: hunk.theirsLabel }) }}
          </div>
          <pre class="mono max-h-40 overflow-auto rounded-md bg-background/60 px-2 py-1 text-[11px]/snug ring-1 ring-border">{{ hunk.theirsText || $t("repo.resolve.emptySide") }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
