<script setup lang="ts">
/**
 * Smart-commit plan editor: the AI proposes an ordered set of file-level commits; the owner
 * edits messages, moves files between commits, reorders/merges/splits, then commits them all
 * in one go (optionally syncing). File-level only — see docs/ARCHITECTURE.md §14 (Smart Commit). Nothing is
 * committed until "Commit all"; until then this is a pure suggestion the owner shapes.
 */
import { computed, reactive, ref, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { dragAndDrop } from "@formkit/drag-and-drop/vue";
import { animations, tearDown } from "@formkit/drag-and-drop";
import {
  Sparkles,
  Loader2,
  AlertTriangle,
  ChevronDown,
  GitCommitHorizontal,
  Pencil,
  RefreshCw,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { ApiError } from "../api";
import type { AiCode, CommitPlan, CommitStyle, DiffStat as DiffStatT } from "../types";
import CommitCard from "./smart-commit-plan/CommitCard.vue";
import UnassignedFiles from "./smart-commit-plan/UnassignedFiles.vue";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const props = defineProps<{
  open: boolean;
  repoId: string;
  repoName: string;
  hasRemote: boolean;
  defaultSync?: boolean;
  /** The owner's checked selection in the changed-files tree, at the moment "Auto" was clicked.
   *  Non-empty → scope the plan to just these files (like GitHub Desktop staging a subset before
   *  committing). Empty/omitted → nothing was checked, so plan the WHOLE working tree — an empty
   *  selection must never turn into an empty plan. */
  selectedPaths?: string[];
}>();
const emit = defineEmits<{ "update:open": [boolean]; committed: [] }>();

const store = useStore();
const { t } = useI18n();

interface EditableGroup {
  key: string;
  subjectLine: string;
  body: string;
  showBody: boolean;
  files: string[];
}

const loading = ref(false);
const committing = ref(false);
const error = ref<string | null>(null);
const degraded = ref(false);
/** WHY the plan degraded (from the daemon), so the banner can state the real cause instead of
 *  always blaming the model — a rate-limited request never reached it at all. */
const degradedCode = ref<AiCode | null>(null);
const degradedMessage = ref("");
const truncated = ref(false);
const groups = ref<EditableGroup[]>([]);
const leftovers = ref<string[]>([]);
/** Signature of the plan as the AI last drafted it (set in applyPlan). `isDirty` compares the live
 *  plan against this so re-drafting actions (style change, Regenerate) can warn before discarding
 *  hand edits — subject/body rewrites, files dragged between commits, merges/reorders/removals. */
const planBaseline = ref("");
/** Per-group "regenerating message" flags, keyed by group key. */
const regenBusy = reactive<Record<string, boolean>>({});
/** Path whose inline diff is expanded, or null. Single-open across the whole editor, so at
 *  most one Monaco diff is ever mounted (same cost as the full-screen file viewer). */
const openDiff = ref<string | null>(null);
/** Group key whose combined "review all changes" view is open, or null. Mutually exclusive with
 *  openDiff so at most one diff surface is mounted at a time (the single-file view uses Monaco). */
const openAll = ref<string | null>(null);
function toggleDiff(path: string): void {
  openDiff.value = openDiff.value === path ? null : path;
  if (openDiff.value) openAll.value = null;
}
function toggleAll(key: string): void {
  openAll.value = openAll.value === key ? null : key;
  if (openAll.value) openDiff.value = null;
}

let keySeq = 0;
const nextKey = (): string => `g${keySeq++}`;

// Drag-to-reorder the commit cards (handle = `.sc-drag`, so inputs/menus stay interactive).
// The library keeps `groups` in sync with the DOM order; our menu Move up/down still work too.
const groupsParent = ref<HTMLElement>();
dragAndDrop({
  parent: groupsParent,
  values: groups,
  dragHandle: ".sc-drag",
  draggingClass: "opacity-60",
  nativeDrag: false,
  longPress: true,
  longPressDuration: 250,
  plugins: [animations()],
});
onBeforeUnmount(() => {
  if (groupsParent.value) tearDown(groupsParent.value);
});

const isOpen = computed({
  get: () => props.open,
  set: (v) => emit("update:open", v),
});

/** Status letter per changed path (for chip colouring), from the already-loaded tree. */
const statusByPath = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const f of store.changesByRepo[props.repoId] ?? []) out[f.path] = f.status;
  return out;
});
/** Per-file line/char delta (for the chip's +adds/−dels), when the diff-stats owner setting is
 *  on — same source + gating as the changed-files tree, so a file reads the same weight here. */
const statByPath = computed<Record<string, DiffStatT>>(() => {
  const out: Record<string, DiffStatT> = {};
  for (const f of store.changesByRepo[props.repoId] ?? []) if (f.stat) out[f.path] = f.stat;
  return out;
});
const totalFiles = computed(() => groups.value.reduce((n, g) => n + g.files.length, 0));
/** Which mode the split button's main half runs: "& sync" when the owner picked "Auto commit &
 *  sync" and there's somewhere to push. The chevron beside it offers the other mode. */
const primarySync = computed(() => !!props.defaultSync && props.hasRemote);
const canCommit = computed(
  () =>
    !loading.value &&
    !committing.value &&
    groups.value.length > 0 &&
    leftovers.value.length === 0 &&
    groups.value.every((g) => g.subjectLine.trim() !== "" && g.files.length > 0),
);

function composeSubject(type: string, scope: string | undefined, subject: string): string {
  const prefix = `${type}${scope ? `(${scope})` : ""}`;
  return `${prefix}: ${subject}`;
}

/** Order-sensitive fingerprint of everything the owner can hand-edit — message text plus which
 *  files sit in which commit, and their order. `key` is deliberately excluded (it's a churn-only
 *  internal id). Two plans with the same fingerprint look identical to the owner. */
function planSignature(gs: EditableGroup[], lo: string[]): string {
  return JSON.stringify([gs.map((g) => [g.subjectLine, g.body, g.files]), lo]);
}
/** True once the live plan diverges from what the AI drafted — i.e. the owner has edits worth not
 *  silently throwing away. False on a pristine plan, while loading, or in the error state. */
const isDirty = computed(
  () =>
    !loading.value &&
    !error.value &&
    groups.value.length > 0 &&
    planSignature(groups.value, leftovers.value) !== planBaseline.value,
);

function applyPlan(plan: CommitPlan): void {
  groups.value = plan.groups.map((g) => ({
    key: nextKey(),
    subjectLine: composeSubject(g.type, g.scope, g.subject),
    body: g.body ?? "",
    showBody: !!(g.body && g.body.trim()),
    files: [...g.files],
  }));
  leftovers.value = [...plan.leftovers];
  degraded.value = plan.degraded;
  degradedCode.value = plan.degradedCode ?? null;
  degradedMessage.value = plan.degradedMessage ?? "";
  truncated.value = plan.truncated;
  planBaseline.value = planSignature(groups.value, leftovers.value); // fresh plan → clean slate
  openDiff.value = null; // a fresh plan → collapse any open preview
  openAll.value = null;
}

/** The degraded banner's headline. The plan still fell back to a folder-based grouping either
 *  way, but WHY decides what the owner should do about it — waiting out a token cap and retrying
 *  a flaky provider are not the same advice, and "the AI couldn't structure this" is simply false
 *  when the request was rejected before the model ever saw it. Static t() keys so i18n-check
 *  sees them referenced. */
const degradedTitle = computed(() => {
  switch (degradedCode.value) {
    case "AI_RATE_LIMITED":
      return t("repo.smartCommit.degradedRateLimited");
    case "AI_UNREACHABLE":
      return t("repo.smartCommit.degradedUnreachable");
    default:
      return t("repo.smartCommit.degraded");
  }
});

/** Monotonic token for plan generations. Two generates can overlap (the style picker fires one
 *  after saving the setting, and `loading` only covers the leg after that save), and the AI call
 *  has no fixed duration — so a slower EARLIER response must never clobber a newer one. Each run
 *  claims a token and drops its result if it's been superseded. */
let genSeq = 0;

async function generate(): Promise<void> {
  const token = ++genSeq;
  loading.value = true;
  error.value = null;
  // Make sure the changes tree is loaded so file chips can show a status colour.
  if (!store.changesByRepo[props.repoId]) void store.loadChanges(props.repoId);
  try {
    // Empty selectedPaths (nothing checked) is passed through as-is — genCommitPlan/the API
    // layer already treat an empty array the same as "no scope", i.e. plan everything.
    const res = await store.genCommitPlan(props.repoId, undefined, props.selectedPaths);
    if (token !== genSeq) return; // superseded mid-flight — a newer plan owns the editor now
    applyPlan(res.plan);
    if (res.fallback) degraded.value = true;
  } catch (e) {
    if (token !== genSeq) return; // a stale failure must not blank a newer plan
    error.value = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
    groups.value = [];
    leftovers.value = [];
  } finally {
    if (token === genSeq) loading.value = false;
  }
}

// `immediate` matters: the caller mounts this dialog with `v-if="smartOpen"` at the very moment
// it flips true, so `open` is already true on the first render and never transitions false→true
// while the instance is alive. Without it the watch never fires and clicking "Auto" lands on an
// empty "0 commits · 0 files" plan until the owner hits Regenerate — but clicking Auto IS the
// request to generate.
watch(
  () => props.open,
  (open) => {
    if (open) void generate();
  },
  { immediate: true },
);

// ── commit-message style ────────────────────────────────────────────────────────
// The same owner setting as Settings → AI → "Commit message style", surfaced here because this
// is where its effect is actually visible. Changing it re-drafts the plan (the style only shapes
// how messages are phrased, so a silent change would look like a no-op).
const style = computed<CommitStyle>(() => store.aiSettings.style ?? "conventional");
const styleLabel = computed(
  () =>
    ({
      conventional: t("settings.aiStyleConventional"),
      concise: t("settings.aiStyleConcise"),
      detailed: t("settings.aiStyleDetailed"),
    })[style.value],
);
// `next` is reka-ui's AcceptableValue (string | number | boolean | Record | null), so narrow it.
async function onStyle(next: unknown): Promise<void> {
  if (typeof next !== "string" || next === style.value || loading.value || committing.value) return;
  // A style change re-drafts the whole plan. If the owner has hand edits, confirm first; otherwise
  // apply straight away. (The picker's checkmark follows the saved setting, so bailing here leaves
  // it visually on the old style until the change actually persists.)
  if (isDirty.value) {
    pendingStyle.value = next as CommitStyle;
    confirmRedraft.value = "style";
    return;
  }
  await applyStyle(next as CommitStyle);
}
async function applyStyle(next: CommitStyle): Promise<void> {
  // Claim `loading` BEFORE the save round-trip, not just for the re-draft: setStyle() updates the
  // setting optimistically, so without this the picker and Regenerate stay enabled (and `style`
  // already reads as the new value) for the whole save — long enough to start a second, racing
  // generate() off one click.
  loading.value = true;
  try {
    await store.setStyle(next);
  } catch {
    loading.value = false;
    toast.error(t("settings.aiStyleFailed"));
    return;
  }
  await generate(); // takes `loading` from here and clears it when it settles
}

// ── re-draft confirmation ─────────────────────────────────────────────────────────
// Both the style picker and the footer Regenerate button throw away hand edits by re-drafting.
// When the plan `isDirty`, funnel them through one confirm modal instead of silently discarding.
// null = closed; "style"/"regen" = which action is pending. pendingStyle rides along for "style".
const confirmRedraft = ref<null | "style" | "regen">(null);
const pendingStyle = ref<CommitStyle | null>(null);
/** Footer Regenerate handler: confirm when there are edits to lose, otherwise just re-draft. */
function requestRegenerate(): void {
  if (loading.value || committing.value) return;
  if (isDirty.value) {
    confirmRedraft.value = "regen";
    return;
  }
  void generate();
}
/** Owner clicked "Discard & re-draft" in the confirm modal. */
function confirmRedraftProceed(): void {
  const action = confirmRedraft.value;
  const nextStyle = pendingStyle.value;
  confirmRedraft.value = null;
  pendingStyle.value = null;
  if (action === "style" && nextStyle) void applyStyle(nextStyle);
  else if (action === "regen") void generate();
}
/** Owner kept their edits — drop the pending action, leave the plan untouched. */
function confirmRedraftCancel(): void {
  confirmRedraft.value = null;
  pendingStyle.value = null;
}

// ── editing ─────────────────────────────────────────────────────────────────────
function pruneEmpty(): void {
  groups.value = groups.value.filter((g) => g.files.length > 0);
}

/** Move `path` out of wherever it is and into `target` (a group key, "new", or "leftovers"). */
function moveFileTo(path: string, target: string): void {
  for (const g of groups.value) {
    const i = g.files.indexOf(path);
    if (i >= 0) g.files.splice(i, 1);
  }
  const li = leftovers.value.indexOf(path);
  if (li >= 0) leftovers.value.splice(li, 1);

  if (target === "leftovers") leftovers.value.push(path);
  else if (target === "new") groups.value.push({ key: nextKey(), subjectLine: "chore: ", body: "", showBody: false, files: [path] });
  else groups.value.find((g) => g.key === target)?.files.push(path);
  pruneEmpty();
}

function moveUp(i: number): void {
  if (i <= 0) return;
  const arr = groups.value;
  [arr[i - 1], arr[i]] = [arr[i]!, arr[i - 1]!];
}
function moveDown(i: number): void {
  if (i >= groups.value.length - 1) return;
  const arr = groups.value;
  [arr[i + 1], arr[i]] = [arr[i]!, arr[i + 1]!];
}
function mergeUp(i: number): void {
  if (i <= 0) return;
  const arr = groups.value;
  arr[i - 1]!.files.push(...arr[i]!.files);
  arr.splice(i, 1);
}
function removeGroup(i: number): void {
  leftovers.value.push(...groups.value[i]!.files);
  groups.value.splice(i, 1);
}
function finalMessage(g: EditableGroup): string {
  const subject = g.subjectLine.trim();
  const body = g.body.trim();
  return body ? `${subject}\n\n${body}` : subject;
}

/** Apply a freshly-drafted message to a card: first line → subject, the rest → body. */
function applyMessageToGroup(g: EditableGroup, msg: string): void {
  const text = msg.trim();
  const nl = text.indexOf("\n");
  if (nl === -1) {
    g.subjectLine = text;
  } else {
    g.subjectLine = text.slice(0, nl).trim();
    const body = text.slice(nl).trim();
    g.body = body;
    g.showBody = !!body;
  }
}

/** Regenerate ONE commit's message from just its files, via the default AI provider. */
async function regenerate(g: EditableGroup): Promise<void> {
  if (regenBusy[g.key] || g.files.length === 0) return;
  regenBusy[g.key] = true;
  try {
    const msg = await store.genCommitMessage(props.repoId, undefined, [...g.files]);
    applyMessageToGroup(g, msg);
  } catch {
    toast.error(t("repo.smartCommit.regenFailed"));
  } finally {
    regenBusy[g.key] = false;
  }
}

async function execute(sync: boolean): Promise<void> {
  if (!canCommit.value || committing.value) return;
  committing.value = true;
  try {
    const commits = groups.value.map((g) => ({ message: finalMessage(g), paths: [...g.files] }));
    const r = await store.smartCommit(props.repoId, commits, sync);
    if (r.code === "PLAN_STALE") {
      toast.message(t("repo.smartCommit.stale"));
      await generate();
      return;
    }
    if (!r.ok) {
      const made = r.committed?.filter((c) => c.ok && !c.message).length ?? 0;
      toast.error(t("repo.smartCommit.execFailed", { message: r.message }));
      emit("committed");
      if (made > 0) await generate(); // some landed → reflect what remains
      return;
    }
    toast.success(r.synced ? t("repo.smartCommit.doneSynced") : t("repo.smartCommit.done"));
    emit("committed");
    isOpen.value = false;
  } finally {
    committing.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
      <!-- The subtitle is sr-only rather than deleted: reka-ui wires DialogDescription to the
           dialog's aria-describedby, so screen readers still get the framing the sighted header
           doesn't need to spell out. `mr-5` keeps the style picker clear of the close X, which
           DialogContent pins at top-2 right-2. -->
      <DialogHeader class="border-b border-border px-5 py-3.5">
        <div class="flex items-center justify-between gap-3">
          <DialogTitle class="flex items-center gap-2">
            <Sparkles :size="18" class="text-primary" />
            {{ $t("repo.smartCommit.title") }}
          </DialogTitle>
          <DropdownMenu v-if="!store.isGuest">
            <DropdownMenuTrigger as-child>
              <Button
                variant="ghost"
                size="sm"
                class="mr-5 h-7 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground"
                :disabled="loading || committing"
                :aria-label="$t('settings.aiStyle')"
                :title="$t('settings.aiStyle')"
              >
                <Pencil :size="13" />
                <span>{{ styleLabel }}</span>
                <ChevronDown :size="13" class="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-52">
              <DropdownMenuLabel>{{ $t("settings.aiStyle") }}</DropdownMenuLabel>
              <DropdownMenuRadioGroup :model-value="style" @update:model-value="onStyle">
                <DropdownMenuRadioItem value="conventional">{{ $t("settings.aiStyleConventional") }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="concise">{{ $t("settings.aiStyleConcise") }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="detailed">{{ $t("settings.aiStyleDetailed") }}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DialogDescription class="sr-only">{{ $t("repo.smartCommit.subtitle", { name: repoName }) }}</DialogDescription>
      </DialogHeader>

      <!-- scrolling body -->
      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <!-- loading -->
        <div v-if="loading" class="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground">
          <Loader2 :size="28" class="animate-spin text-primary" />
          <span class="text-sm">{{ $t("repo.smartCommit.generating") }}</span>
        </div>

        <!-- error -->
        <div v-else-if="error" class="flex flex-col items-center gap-3 py-10 text-center">
          <AlertTriangle :size="24" class="text-warning" />
          <p class="text-sm font-medium">{{ $t("repo.smartCommit.failed") }}</p>
          <p class="text-[12.5px] text-muted-foreground">{{ error }}</p>
          <Button variant="secondary" size="sm" @click="generate">
            <RefreshCw :size="15" />
            <span>{{ $t("repo.smartCommit.button") }}</span>
          </Button>
        </div>

        <template v-else>
          <!-- banners -->
          <div
            v-if="degraded"
            class="mb-3 flex items-start gap-2 rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-[12.5px] text-warning"
          >
            <AlertTriangle :size="15" class="mt-0.5 shrink-0" />
            <div class="min-w-0">
              <span>{{ degradedTitle }}</span>
              <!-- The provider's own words. For a rate limit this is the whole answer — it names
                   the limit that tripped and when it resets — so show it rather than paraphrase. -->
              <p v-if="degradedMessage" class="mt-1 break-words text-[11.5px] opacity-80">{{ degradedMessage }}</p>
            </div>
          </div>
          <div
            v-if="truncated"
            class="mb-3 flex items-start gap-2 rounded-md border border-info/25 bg-info/10 px-3 py-2 text-[12.5px] text-info"
          >
            <AlertTriangle :size="15" class="mt-0.5 shrink-0" />
            <span>{{ $t("repo.smartCommit.truncated") }}</span>
          </div>

          <!-- commit cards (drag the grip to reorder) -->
          <div ref="groupsParent" class="flex flex-col gap-3">
            <CommitCard
              v-for="(g, i) in groups"
              :key="g.key"
              :group="g"
              :index="i"
              :total="groups.length"
              :groups="groups"
              :repo-id="repoId"
              :status-by-path="statusByPath"
              :stat-by-path="statByPath"
              :open-diff="openDiff"
              :open-all="openAll"
              :regen-busy="!!regenBusy[g.key]"
              @toggle-diff="toggleDiff"
              @toggle-all="toggleAll(g.key)"
              @move-up="moveUp(i)"
              @move-down="moveDown(i)"
              @merge-up="mergeUp(i)"
              @remove="removeGroup(i)"
              @regenerate="regenerate(g)"
              @move-file="moveFileTo"
            />
          </div>

          <!-- unassigned (blocks commit) -->
          <UnassignedFiles
            v-if="leftovers.length"
            :leftovers="leftovers"
            :groups="groups"
            :repo-id="repoId"
            :status-by-path="statusByPath"
            :stat-by-path="statByPath"
            :open-diff="openDiff"
            @toggle-diff="toggleDiff"
            @move-file="moveFileTo"
          />
        </template>
      </div>

      <!-- footer -->
      <DialogFooter class="flex-col gap-2 border-t border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-3 text-[12px] text-muted-foreground">
          <span v-if="!loading && !error">{{ $t("repo.smartCommit.summary", { commits: groups.length, files: totalFiles }) }}</span>
        </div>
        <div class="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="secondary"
                size="sm"
                :disabled="loading || committing"
                :aria-label="$t('repo.smartCommit.regeneratePlan')"
                @click="requestRegenerate"
              >
                <RefreshCw :size="15" :class="cn(loading && 'animate-spin')" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ $t("repo.smartCommit.regeneratePlan") }}</TooltipContent>
          </Tooltip>
          <!-- Split "Commit all ▾" — mirrors the Commit/Auto split buttons on the repo card: the
               main half runs the default mode, the chevron picks the other. With no remote there's
               nothing to sync to, so it collapses to a plain button. -->
          <div class="flex">
            <Button
              size="sm"
              :class="cn(hasRemote && 'rounded-r-none')"
              :disabled="!canCommit"
              @click="execute(primarySync)"
            >
              <Loader2 v-if="committing" :size="15" class="animate-spin" />
              <RefreshCw v-else-if="primarySync" :size="15" />
              <GitCommitHorizontal v-else :size="15" />
              <span>{{ primarySync ? $t("repo.smartCommit.commitSync") : $t("repo.smartCommit.commitAll") }}</span>
            </Button>
            <DropdownMenu v-if="hasRemote">
              <DropdownMenuTrigger as-child>
                <Button
                  size="sm"
                  class="rounded-l-none border-l border-l-black/15 px-1.5 dark:border-l-white/20"
                  :disabled="!canCommit"
                  :aria-label="$t('repo.commit.menuLabel')"
                >
                  <ChevronDown :size="16" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-52">
                <DropdownMenuItem @select="execute(false)">
                  <GitCommitHorizontal :size="15" />
                  <span>{{ $t("repo.smartCommit.commitAll") }}</span>
                </DropdownMenuItem>
                <DropdownMenuItem @select="execute(true)">
                  <RefreshCw :size="15" />
                  <span>{{ $t("repo.smartCommit.commitSync") }}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Re-draft confirmation: guards the style picker and Regenerate when the owner has hand edits.
       Nested reka-ui dialogs both portal to <body> and stack by z-index, so this sits above the
       plan editor. Closing via overlay/Esc counts as "keep edits". -->
  <Dialog :open="confirmRedraft !== null" @update:open="(v) => { if (!v) confirmRedraftCancel(); }">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.smartCommit.redraftTitle") }}</DialogTitle>
        <DialogDescription>{{ $t("repo.smartCommit.redraftBody") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button variant="secondary" @click="confirmRedraftCancel">
          {{ $t("repo.smartCommit.redraftKeep") }}
        </Button>
        <Button variant="destructive" @click="confirmRedraftProceed">
          {{ $t("repo.smartCommit.redraftDiscard") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
