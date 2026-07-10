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
  GitCommitHorizontal,
  Combine,
  RefreshCw,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { ApiError } from "../api";
import type { CommitPlan, DiffStat as DiffStatT } from "../types";
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

const props = defineProps<{ open: boolean; repoId: string; repoName: string; hasRemote: boolean; defaultSync?: boolean }>();
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
const truncated = ref(false);
const groups = ref<EditableGroup[]>([]);
const leftovers = ref<string[]>([]);
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
  truncated.value = plan.truncated;
  openDiff.value = null; // a fresh plan → collapse any open preview
  openAll.value = null;
}

async function generate(): Promise<void> {
  loading.value = true;
  error.value = null;
  // Make sure the changes tree is loaded so file chips can show a status colour.
  if (!store.changesByRepo[props.repoId]) void store.loadChanges(props.repoId);
  try {
    const res = await store.genCommitPlan(props.repoId);
    applyPlan(res.plan);
    if (res.fallback) degraded.value = true;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
    groups.value = [];
    leftovers.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void generate();
  },
);

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
function collapseToOne(): void {
  const all = [...groups.value.flatMap((g) => g.files), ...leftovers.value];
  groups.value = [{ key: nextKey(), subjectLine: groups.value[0]?.subjectLine ?? "chore: update changes", body: "", showBody: false, files: all }];
  leftovers.value = [];
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
      <DialogHeader class="border-b border-border px-5 py-4">
        <DialogTitle class="flex items-center gap-2">
          <Sparkles :size="18" class="text-primary" />
          {{ $t("repo.smartCommit.title") }}
        </DialogTitle>
        <DialogDescription>{{ $t("repo.smartCommit.subtitle", { name: repoName }) }}</DialogDescription>
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
            <span>{{ $t("repo.smartCommit.degraded") }}</span>
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
          <button
            v-if="!loading && !error && groups.length > 1"
            type="button"
            class="inline-flex items-center gap-1 underline-offset-2 hover:underline"
            @click="collapseToOne"
          >
            <Combine :size="13" />{{ $t("repo.smartCommit.commitAll") }}
          </button>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" :disabled="loading || committing" @click="generate">
            <RefreshCw :size="15" :class="cn(loading && 'animate-spin')" />
          </Button>
          <Button
            size="sm"
            :variant="defaultSync && hasRemote ? 'secondary' : 'default'"
            :disabled="!canCommit"
            @click="execute(false)"
          >
            <Loader2 v-if="committing" :size="15" class="animate-spin" />
            <GitCommitHorizontal v-else :size="15" />
            <span>{{ $t("repo.smartCommit.commitAll") }}</span>
          </Button>
          <Button
            v-if="hasRemote"
            size="sm"
            :variant="defaultSync ? 'default' : 'secondary'"
            :disabled="!canCommit"
            @click="execute(true)"
          >
            <RefreshCw v-if="defaultSync" :size="15" />
            <span>{{ $t("repo.smartCommit.commitSync") }}</span>
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
