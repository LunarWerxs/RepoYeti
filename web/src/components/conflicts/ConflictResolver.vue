<script setup lang="ts">
// "Resolve with AI" — the conflicted-file panel inside a repo card.
//
// The flow is three explicit steps and they are separate on purpose: LIST what git says is
// unmerged, PROPOSE a resolution for one file (the daemon writes nothing), then APPLY only the
// regions the owner ticked. Nothing here stages, so even a fully-applied file stays unmerged
// until the owner stages it themselves and `git commit` keeps refusing until they do.
//
// The model-tier banner is not decoration. Every other AI feature in this app produces a commit
// MESSAGE — prose whose worst case is embarrassing and which the owner reads before it lands.
// This one produces SOURCE, whose worst case is a plausible file that compiles and is quietly
// wrong. A small fast model is a fine trade for the former and a poor one for the latter, so the
// banner says which model is about to run and escalates when it looks like a small tier. It is
// advice, not a gate: the owner's key, the owner's repo, the owner's call.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, GitMerge, Loader2, Sparkles, X } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { ApiError } from "../../api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import ConflictHunkCard from "./ConflictHunkCard.vue";
import type {
  ConflictHunk,
  ConflictListEntry,
  ConflictUnsupported,
  HunkResolution,
  Repo,
} from "../../types";

const props = defineProps<{ repo: Repo }>();
const store = useStore();
const { t } = useI18n();

const files = ref<ConflictListEntry[]>([]);
const listing = ref(false);
const resolving = ref<string | null>(null);
const applying = ref(false);

/** The file currently under review, if any. Cleared on apply or dismiss. */
const active = ref<{
  path: string;
  hash: string;
  hunks: ConflictHunk[];
  resolutions: Map<number, HunkResolution>;
  rejected: Map<number, string>;
  model: string;
  windowed: boolean;
  hasBase: boolean;
} | null>(null);

/** Per-region owner state, keyed by hunk index: is it accepted, and with what text. */
const accepted = ref<Record<number, boolean>>({});
const contents = ref<Record<number, string>>({});

const conflicted = computed(() => !!props.repo.status?.conflicted);
const available = computed(() => store.aiConflictEnabled);
const modelTier = computed(() => store.aiSettings.modelTier);
const modelName = computed(() => {
  const dp = store.aiSettings.defaultProvider;
  return (dp && store.aiSettings.providers[dp]?.model) || "";
});

/** Literal t() keys so scripts/i18n-check.mjs can verify each one statically. */
function unsupportedLabel(reason: ConflictUnsupported): string {
  switch (reason) {
    case "no-markers":
      return t("repo.resolve.unsupported.noMarkers");
    case "binary":
      return t("repo.resolve.unsupported.binary");
    case "too-large":
      return t("repo.resolve.unsupported.tooLarge");
    case "too-many-hunks":
      return t("repo.resolve.unsupported.tooManyHunks");
    case "unparseable":
      return t("repo.resolve.unsupported.unparseable");
    default:
      return t("repo.resolve.unsupported.missing");
  }
}

function rejectedLabel(reason: string): string {
  switch (reason) {
    case "conflict-markers":
      return t("repo.resolve.rejected.markers");
    case "malformed":
      return t("repo.resolve.rejected.malformed");
    case "duplicate":
      return t("repo.resolve.rejected.duplicate");
    default:
      return t("repo.resolve.rejected.missing");
  }
}

async function refresh(): Promise<void> {
  if (!conflicted.value) {
    files.value = [];
    active.value = null;
    return;
  }
  listing.value = true;
  try {
    files.value = await store.listConflicts(props.repo.id);
  } catch {
    files.value = []; // a listing failure is not worth a toast — the triage card still shows
  } finally {
    listing.value = false;
  }
}

// State-driven, exactly like the Conflict Concierge card: the panel follows live repo status
// rather than an event, so it appears on reload and clears itself the moment the merge is done.
watch(() => [conflicted.value, props.repo.status?.gitOperation] as const, refresh, { immediate: true });

async function resolve(file: ConflictListEntry): Promise<void> {
  if (file.unsupported) return;
  resolving.value = file.path;
  try {
    const r = await store.resolveConflict(props.repo.id, file.path);
    active.value = {
      path: r.path,
      hash: r.hash,
      hunks: r.hunks,
      resolutions: new Map(r.resolutions.map((x) => [x.index, x])),
      rejected: new Map(r.rejected.map((x) => [x.index, x.reason])),
      model: r.model,
      windowed: r.windowed,
      hasBase: r.hasBase,
    };
    // Every region starts UNACCEPTED — including the clean ones. "Accept the clean ones" is one
    // click away below; defaulting them on would make the safe path the one you have to opt out
    // of, on the single feature in this app where nobody should be opted in by default.
    accepted.value = {};
    contents.value = Object.fromEntries(r.resolutions.map((x) => [x.index, x.content]));
  } catch (e) {
    toast.error(t("repo.resolve.failed"), {
      description: e instanceof ApiError ? e.message : String(e),
    });
  } finally {
    resolving.value = null;
  }
}

/** Regions the audit found nothing wrong with AND the model called high-confidence. */
const cleanIndices = computed(() => {
  if (!active.value) return [];
  return [...active.value.resolutions.values()]
    .filter((r) => r.flags.length === 0 && r.confidence === "high")
    .map((r) => r.index);
});

function acceptClean(): void {
  for (const i of cleanIndices.value) accepted.value[i] = true;
}

const acceptedCount = computed(() => Object.values(accepted.value).filter(Boolean).length);

async function apply(): Promise<void> {
  const a = active.value;
  if (!a || acceptedCount.value === 0) return;
  applying.value = true;
  try {
    const payload = Object.entries(accepted.value)
      .filter(([, on]) => on)
      .map(([index]) => ({ index: Number(index), content: contents.value[Number(index)] ?? "" }));
    const r = await store.applyConflict(props.repo.id, a.path, a.hash, payload);
    toast.success(
      r.remaining === 0
        ? t("repo.resolve.appliedAll", { path: r.path })
        : t("repo.resolve.appliedSome", { n: r.applied, remaining: r.remaining }),
      // Named because it is the escape hatch, and an owner who has just realised the merge is
      // wrong should not have to go looking for it. `-m` re-creates the conflict markers from
      // the index stages, discarding whatever was written over them.
      { description: t("repo.resolve.undoHint", { path: r.path }) },
    );
    active.value = null;
    await refresh();
  } catch (e) {
    toast.error(t("repo.resolve.applyFailed"), {
      description: e instanceof ApiError ? e.message : String(e),
    });
    // A stale hash means the file moved under us; re-list so the owner sees current state.
    if (e instanceof ApiError && e.code === "CONFLICT_STALE") {
      active.value = null;
      await refresh();
    }
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <div v-if="conflicted && files.length" class="mb-2 flex flex-col gap-2">
    <div class="flex items-center gap-1.5 text-[13px] font-semibold text-warning">
      <GitMerge :size="15" />
      <span>{{ $t("repo.resolve.title") }}</span>
      <span class="text-warning/70">
        {{ $t("repo.resolve.count", { n: files.length }, files.length) }}
      </span>
      <Loader2 v-if="listing" :size="12" class="animate-spin text-muted-foreground" />
    </div>

    <!-- The model-tier advisory. Always shown when the feature can run; louder for a small tier. -->
    <div
      v-if="available"
      :class="
        cn(
          'flex items-start gap-2 rounded-lg px-3 py-2 text-[11px]/relaxed ring-1',
          modelTier === 'small'
            ? 'bg-destructive/10 text-destructive ring-destructive/30'
            : 'bg-muted/50 text-muted-foreground ring-border',
        )
      "
    >
      <AlertTriangle :size="13" class="mt-0.5 shrink-0" />
      <div class="min-w-0">
        <p v-if="modelTier === 'small'" class="font-medium">
          {{ $t("repo.resolve.warnSmallModel", { model: modelName }) }}
        </p>
        <p v-else>{{ $t("repo.resolve.warnAnyModel", { model: modelName }) }}</p>
        <p class="mt-0.5 opacity-90">{{ $t("repo.resolve.warnReview") }}</p>
      </div>
    </div>

    <!-- file list -->
    <div v-if="!active" class="flex flex-col gap-1">
      <div
        v-for="f in files"
        :key="f.path"
        class="flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5"
      >
        <div class="min-w-0 flex-1">
          <div class="mono truncate text-[11px] text-foreground">{{ f.path }}</div>
          <div class="truncate text-[10px] text-muted-foreground">
            <span v-if="f.unsupported">{{ unsupportedLabel(f.unsupported) }}</span>
            <span v-else>{{ $t("repo.resolve.hunkCount", { n: f.hunks }, f.hunks) }}</span>
          </div>
        </div>
        <Button
          v-if="available && !f.unsupported"
          variant="outline"
          size="sm"
          :disabled="resolving !== null"
          @click="resolve(f)"
        >
          <Loader2 v-if="resolving === f.path" :size="12" class="animate-spin" />
          <Sparkles v-else :size="12" />
          {{ $t("repo.resolve.resolveButton") }}
        </Button>
      </div>
    </div>

    <!-- review: one card per region -->
    <div v-else class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class="mono min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          {{ active.path }}
        </span>
        <span class="shrink-0 text-[10px] text-muted-foreground">{{ active.model }}</span>
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          :aria-label="$t('repo.resolve.dismissAria')"
          @click="active = null"
        >
          <X :size="13" />
        </button>
      </div>

      <!-- Said out loud rather than left implicit: the model was shown a partial file, and a
           resolution made without the surrounding code deserves more scrutiny, not less. -->
      <p v-if="active.windowed" class="rounded-md bg-warning/10 px-2 py-1 text-[11px] text-warning">
        {{ $t("repo.resolve.windowedNote") }}
      </p>
      <p v-if="!active.hasBase" class="rounded-md bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground">
        {{ $t("repo.resolve.noBaseNote") }}
      </p>

      <ConflictHunkCard
        v-for="h in active.hunks"
        :key="h.index"
        :hunk="h"
        :resolution="active.resolutions.get(h.index)"
        :rejected-reason="
          active.rejected.has(h.index) ? rejectedLabel(active.rejected.get(h.index)!) : undefined
        "
        :accepted="!!accepted[h.index]"
        :content="contents[h.index] ?? ''"
        @update:accepted="(v: boolean) => (accepted[h.index] = v)"
        @update:content="(v: string) => (contents[h.index] = v)"
      />

      <div class="flex items-center gap-2">
        <Button
          v-if="cleanIndices.length"
          variant="ghost"
          size="sm"
          :disabled="applying"
          @click="acceptClean"
        >
          {{ $t("repo.resolve.acceptClean", { n: cleanIndices.length }) }}
        </Button>
        <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {{ $t("repo.resolve.applySummary", { n: acceptedCount, total: active.hunks.length }) }}
        </span>
        <Button size="sm" :disabled="acceptedCount === 0 || applying" @click="apply">
          <Loader2 v-if="applying" :size="12" class="animate-spin" />
          {{ $t("repo.resolve.applyButton") }}
        </Button>
      </div>
      <p class="text-[10px]/relaxed text-muted-foreground">{{ $t("repo.resolve.applyFootnote") }}</p>
    </div>
  </div>
</template>
