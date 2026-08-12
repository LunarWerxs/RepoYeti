<script setup lang="ts">
// Shared content of the file viewer (header + body), rendered inside either the desktop
// push-drawer or the mobile bottom sheet. Owns the fetch + the lazily-loaded editor.
import { computed, defineAsyncComponent, h, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { refDebounced } from "@vueuse/core";
import {
  X,
  Loader2,
  FileWarning,
  Columns2,
  AlignJustify,
  Pencil,
  Save,
  MoreVertical,
  Check,
  ExternalLink,
  WrapText,
  WholeWord,
  Highlighter,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { api, ApiError } from "@/api";
import { fileVisual } from "@/lib/file-icons";
import { STATUS_COLOR } from "@/lib/git-status-colors";
import { binaryPreviewKind, binaryPreviewUrl } from "@/lib/binary-preview";
import { isPreviewableMarkdown } from "@/lib/markdown-preview";
import { cn } from "@/lib/utils";
import type { EditorTheme } from "@/lib/monaco-setup";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import MarkdownPreview from "@/components/MarkdownPreview.vue";
import {
  viewerMode,
  wordLevelDiff,
  wordWrap,
  diffSplitView,
  dirtyDiffGutter,
  editorDirty,
  confirmDiscardEdits,
  type ViewerMode,
  type ViewerTarget,
} from "@/lib/file-viewer";
import { diffLineChanges, type LineChange } from "@/lib/line-diff";
import { useStore } from "@/store";

const props = withDefaults(
  defineProps<{ target: ViewerTarget | null; showClose?: boolean }>(),
  { showClose: true },
);
defineEmits<{ close: [] }>();

const store = useStore();

// Monaco is heavy — load it (and its chunk) only when a file is actually shown.
const Spinner = (): ReturnType<typeof h> =>
  h(
    "div",
    { class: "flex h-full items-center justify-center" },
    h(Loader2, { class: "size-5 animate-spin text-muted-foreground" }),
  );
const EditorFailed = (): ReturnType<typeof h> =>
  h(
    "div",
    { class: "flex h-full items-center justify-center p-6 text-center text-[13px] text-muted-foreground" },
    t("fileViewer.editorFailed"),
  );
const MonacoViewer = defineAsyncComponent({
  loader: () => import("./MonacoViewer.vue"),
  loadingComponent: Spinner,
  errorComponent: EditorFailed,
  delay: 120,
  timeout: 30_000,
});
const MonacoDiffViewer = defineAsyncComponent({
  loader: () => import("./MonacoDiffViewer.vue"),
  loadingComponent: Spinner,
  errorComponent: EditorFailed,
  delay: 120,
  timeout: 30_000,
});

// ── theme (mirror the app's resolved light/dark for the editor) ────────────────
const { isDark } = useTheme();
const editorTheme = computed<EditorTheme>(() => (isDark.value ? "dark" : "light"));

// ── header bits ───────────────────────────────────────────────────────────────
const fileName = computed(() => props.target?.path.split("/").pop() ?? "");
const previewKind = computed(() => binaryPreviewKind(props.target?.path ?? ""));
const binaryPreview = computed(() => previewKind.value !== null);
const previewableImage = computed(() => previewKind.value === "image");
const previewableMarkdown = computed(() => isPreviewableMarkdown(props.target?.path ?? ""));
const previewSrc = computed(() =>
  props.target && previewKind.value ? binaryPreviewUrl(props.target, previewKind.value) : "",
);
const previewLoading = ref(true);
const previewFailed = ref(false);
watch(
  previewSrc,
  () => {
    previewLoading.value = true;
    previewFailed.value = false;
  },
  { immediate: true },
);
const dirName = computed(() => {
  const parts = props.target?.path.split("/") ?? [];
  return parts.slice(0, -1).join("/");
});
const repoName = computed(
  () => store.repos.find((r) => r.id === props.target?.repoId)?.name ?? "",
);
const icon = computed(() => fileVisual(fileName.value || "file", false));

const statusColor = computed(() =>
  props.target?.status ? (STATUS_COLOR[props.target.status] ?? "#9aa0a6") : "#9aa0a6",
);

// ── "Open with…" external editor (local-only: editors launch on the daemon's machine) ──
// The main button opens the owner's default editor; the caret picks a specific one. We open the
// repo FOLDER + the current file, so the editor shows the whole file tree (the "see the file list"
// intent). Only the editors detected as installed are offered.
const openableEditors = computed(() => store.editorsCatalog.filter((e) => e.available));
async function openWith(editor?: string): Promise<void> {
  if (!props.target) return;
  try {
    const r = await store.openInEditor(props.target.repoId, { editor, path: props.target.path });
    const label = store.editorsCatalog.find((e) => e.id === r.editor)?.label;
    toast.success(label ? t("fileViewer.openingIn", { editor: label }) : t("fileViewer.openingEditor"));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("fileViewer.openFailed"));
  }
}

// ── fetch (Content = whole file · Diff = HEAD ↔ working tree) ────────────────────
const loading = ref(false);
// Debounce the full-body spinner: quick (cached) file/tab switches shouldn't flash it — only a
// genuinely slow fetch (>140ms) shows it, so ordinary navigation no longer looks "perpetually
// loading". Clears promptly when the fetch finishes (refDebounced tracks the false transition too).
const loadingDelayed = refDebounced(loading, 140);
const errorMsg = ref<string | null>(null);
const content = ref(""); // content mode — the loaded source
const original = ref(""); // diff mode (HEAD)
const modified = ref(""); // diff mode (working tree)
const patch = ref(""); // diff mode — unified git-diff text (large modified files)
const patchMode = ref(false); // server sent a compact patch instead of both whole sides
const binary = ref(false);
const truncated = ref(false);
const fromHead = ref(false);

// ── edit mode (Content tab, and Diff tab when it's showing the full working-tree text) ──
const editing = ref(false);
const draft = ref(""); // seeded on edit; refreshed from Monaco exactly once when Save is requested
const dirty = ref(false);
const saving = ref(false);
interface MonacoViewerHandle {
  getValue: () => string;
  getSnapshot: () => { value: string; alternativeVersionId: number };
  markClean: (alternativeVersionId?: number) => boolean;
}
const editorViewer = ref<MonacoViewerHandle | null>(null);

// Mirror dirty into the shared store so close / switch-file guards (file-viewer.ts) can prompt.
watch(dirty, (v) => (editorDirty.value = v));

// Editable only when we're showing the real, whole working-tree text. A truncated file
// would be SAVED truncated (data loss); a binary file isn't text; the HEAD fallback means
// the working file is gone (a deletion) — none of those should be editable.
// This browser reached the daemon over the tunnel (not loopback) when the daemon says we can't
// "continue local". If the owner has also turned remote editing off, a save would be refused
// server-side — so disable Edit up front with a clear reason instead of letting it 403 on save.
const remoteEditBlocked = computed(() => !store.canContinueLocal && !store.remoteEditing);

// Diff tab is editable whenever it's rendering the rich side-by-side view (a real `modified`
// working-tree string in hand) rather than a compact unified patch — patch mode ships only
// the hunks, so there's no whole-file text here to seed an editor with.
const diffEditable = computed(
  () => viewerMode.value === "diff" && !patchMode.value && !binaryPreview.value,
);
const showEditControls = computed(
  () =>
    !binaryPreview.value &&
    !props.target?.commit &&
    (viewerMode.value === "content" || diffEditable.value),
);

const canEdit = computed(() => {
  if (props.target?.commit) return false; // a historical commit view is read-only
  if (
    binaryPreview.value ||
    loading.value ||
    !!errorMsg.value ||
    binary.value ||
    truncated.value ||
    remoteEditBlocked.value
  )
    return false;
  if (viewerMode.value === "content") return !fromHead.value;
  // Diff tab: patch mode has no whole-file text (see diffEditable); a Deleted file has
  // nothing left in the working tree to write over (mirrors content mode's fromHead guard).
  return diffEditable.value && props.target?.status !== "D";
});

/** The loaded (unedited) source for whichever tab is currently editable. */
const editableSource = computed(() => (viewerMode.value === "content" ? content.value : modified.value));

// Identity of the request in flight — repo + path + mode. Re-fetches when any changes,
// and lets a returning request bail if a newer open/toggle has superseded it.
// Bumped to make the fetch below re-run for the SAME file and tab. The one case is the owner
// flipping "always side-by-side" from this viewer's own menu: the DAEMON decides patch vs both
// whole sides at request time (see getDiffPatchEnabled), so the answer for this exact file
// changes without the file, the commit or the tab changing — and without this the notice would
// keep saying "compact diff" until you closed and reopened the file.
const reloadNonce = ref(0);
const fetchKey = (): string | null =>
  props.target
    ? `${props.target.repoId}::${props.target.path}::${props.target.commit ?? ""}::${viewerMode.value}::${reloadNonce.value}`
    : null;

// ── patch vs side-by-side, from the viewer instead of Settings ────────────────────
// This is the setting that decided what you are looking at RIGHT NOW, so it belongs on the thing
// it decides — it used to be reachable only from Settings → Appearance, which nobody opens while
// staring at a compact patch wondering how to see the real diff. A daemon setting (it follows the
// owner across devices), hence async + a toast on failure. Owner-only: PUT /api/settings is not on
// the guest allowlist, so a guest's click would just 403.
const alwaysSideBySide = computed(() => !store.diffPatchEnabled);
async function setAlwaysSideBySide(always: boolean): Promise<void> {
  try {
    await store.setDiffPatchEnabled(!always);
    reloadNonce.value++; // the daemon's answer for this file just changed — ask again
  } catch {
    toast.error(t("settings.diffPatchAlwaysFailed"));
  }
}

let contentController: AbortController | null = null;
watch(
  fetchKey,
  async (key) => {
    contentController?.abort();
    contentController = null;
    if (!key || !props.target) {
      loading.value = false;
      return;
    }
    errorMsg.value = null;
    binary.value = false;
    truncated.value = false;
    fromHead.value = false;
    patchMode.value = false;
    editing.value = false; // a new file/mode drops any in-progress edit
    dirty.value = false;
    // Browser-native binary previews load from the authenticated raw representation directly.
    // Avoid asking the text/diff endpoints to decode those bytes as UTF-8 first.
    if (binaryPreview.value) {
      loading.value = false;
      return;
    }
    const controller = new AbortController();
    contentController = controller;
    const { repoId, path, commit } = props.target;
    loading.value = true;
    try {
      if (commit) {
        // History file: the first-parent↔commit models diff (read-only). Both tabs come from one
        // fetch — the Content tab shows the file as it was AT the commit (its `modified` side).
        const res = await api.commitFile(repoId, commit, path, controller.signal);
        if (controller.signal.aborted) return;
        if (fetchKey() !== key) return; // superseded mid-flight
        original.value = res.original ?? "";
        modified.value = res.modified ?? "";
        content.value = res.modified ?? "";
        patch.value = res.patch ?? "";
        patchMode.value = res.mode === "patch";
        binary.value = !!res.binary;
        truncated.value = !!res.truncated;
      } else if (viewerMode.value === "diff") {
        const res = await api.fileDiff(repoId, path, controller.signal);
        if (controller.signal.aborted) return;
        if (fetchKey() !== key) return; // superseded mid-flight
        original.value = res.original ?? "";
        modified.value = res.modified ?? "";
        patch.value = res.patch ?? "";
        patchMode.value = res.mode === "patch";
        binary.value = !!res.binary;
        truncated.value = !!res.truncated;
      } else {
        const res = await api.fileContent(repoId, path, undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (fetchKey() !== key) return;
        content.value = res.content ?? "";
        binary.value = !!res.binary;
        truncated.value = !!res.truncated;
        fromHead.value = res.ref === "head";
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      if (fetchKey() === key) errorMsg.value = e instanceof ApiError ? e.message : t("fileViewer.error");
    } finally {
      // Controller identity closes the A→B→A race: the aborted first A must not clear the
      // spinner for the newer A merely because their string keys happen to match again.
      if (contentController === controller) {
        contentController = null;
        loading.value = false;
      }
    }
  },
  { immediate: true },
);

// ── dirty-diff gutter (Content mode) ────────────────────────────────────────────
// VS Code-style: even with the Diff tab off, mark changed lines in the Content view's gutter. The
// primary content fetch stays as-is (fast); this pulls HEAD↔working in the BACKGROUND only when it's
// meaningful (a changed working-tree file, gutter pref on, full text in hand) and computes the line
// ranges client-side. A large-file compact patch is skipped (no whole-file text to line up).
const changedLines = ref<LineChange[]>([]);
let gutterToken = 0;
let gutterController: AbortController | null = null;
watch(
  () =>
    [
      viewerMode.value,
      content.value,
      dirtyDiffGutter.value,
      props.target?.repoId,
      props.target?.path,
      props.target?.status,
      props.target?.commit,
      fromHead.value,
      binary.value,
      truncated.value,
    ] as const,
  async () => {
    const token = ++gutterToken;
    gutterController?.abort();
    gutterController = null;
    const tgt = props.target;
    const eligible =
      !!tgt &&
      dirtyDiffGutter.value &&
      viewerMode.value === "content" &&
      !tgt.commit &&
      !!tgt.status &&
      tgt.status !== "D" &&
      !fromHead.value &&
      !binary.value &&
      !truncated.value &&
      !!content.value;
    if (!eligible) {
      changedLines.value = [];
      return;
    }
    const controller = new AbortController();
    gutterController = controller;
    try {
      const res = await api.fileDiff(tgt.repoId, tgt.path, controller.signal);
      if (controller.signal.aborted) return;
      if (token !== gutterToken) return; // superseded by a newer open/toggle
      // Compact-patch (large file) has no whole-file original to diff against the shown text.
      changedLines.value = res.mode === "patch" ? [] : diffLineChanges(res.original ?? "", content.value);
    } catch {
      if (controller.signal.aborted) return;
      if (token === gutterToken) changedLines.value = [];
    }
  },
  { immediate: true },
);

// ── edit actions ──────────────────────────────────────────────────────────────
// Switch Content↔Diff, prompting first if there are unsaved edits to discard.
async function requestMode(m: ViewerMode): Promise<void> {
  if (m === viewerMode.value) return;
  if (!(await confirmDiscardEdits())) return;
  viewerMode.value = m;
}
function startEdit(): void {
  if (!canEdit.value) return;
  draft.value = editableSource.value;
  dirty.value = false;
  editing.value = true;
}
function cancelEdit(): void {
  // MonacoViewer resets its buffer to `editableSource` when `editable` flips false.
  editing.value = false;
  dirty.value = false;
}
function onEditorChange(isDirty: boolean): void {
  dirty.value = isDirty;
}
async function save(): Promise<void> {
  if (!props.target || !editing.value || !canEdit.value || !dirty.value || saving.value) return;
  const { repoId, path } = props.target;
  const modeAtSave = viewerMode.value;
  // Monaco keeps its own mutable text model. Pulling it here (rather than on each keystroke)
  // makes a multi-megabyte edit cheap while still sending the exact latest buffer.
  const snapshot = editorViewer.value?.getSnapshot();
  const nextValue = snapshot?.value ?? draft.value;
  saving.value = true;
  try {
    await api.saveFile(repoId, path, nextValue);
    // The viewer may have switched files/tabs (after its discard guard) while the request was in
    // flight. The old file was saved, but its response must not overwrite the newly-loaded view.
    const stillSameView =
      props.target?.repoId === repoId &&
      props.target.path === path &&
      viewerMode.value === modeAtSave;
    if (!stillSameView) {
      toast.success(t("fileViewer.saved"));
      return;
    }
    draft.value = nextValue;
    // Update the source that actually reached disk. With no later edits Monaco keeps its cursor
    // and undo history; with later edits it preserves that newer buffer against this new baseline.
    // The Diff tab's working-tree side also feeds MonacoDiffViewer once editing ends.
    if (modeAtSave === "content") content.value = nextValue;
    else modified.value = nextValue;
    // If typing continued during the network request, only the version actually written becomes
    // the clean baseline. Later keystrokes stay in Monaco and Save remains enabled.
    dirty.value =
      editing.value && snapshot
        ? (editorViewer.value?.markClean(snapshot.alternativeVersionId) ?? false)
        : false;
    toast.success(t("fileViewer.saved"));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("fileViewer.saveFailed"));
  } finally {
    saving.value = false;
  }
}

// Ctrl/Cmd+S saves while editing (instead of the browser's save-page dialog).
function onKeydown(e: KeyboardEvent): void {
  if (store.isGuest) return; // guests never enter edit mode, but keep the shortcut inert too
  if (editing.value && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void save();
  }
}
// Warn the browser before a tab close / refresh would drop unsaved edits.
function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (dirty.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("beforeunload", onBeforeUnload);
  // Populate the Open-with editor list — only meaningful for a local session (the editor opens
  // on this machine), so skip the request entirely over the tunnel.
  if (store.canContinueLocal) void store.loadEditors();
});
onBeforeUnmount(() => {
  contentController?.abort();
  gutterController?.abort();
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("beforeunload", onBeforeUnload);
  editorDirty.value = false; // viewer torn down → nothing to guard
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-card">
    <!-- header -->
    <div class="flex items-center gap-2.5 border-b border-border/60 px-3 py-2.5 sm:px-4">
      <component :is="icon" class="shrink-0 text-[17px]" />
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-2">
          <span class="truncate text-[14px] font-semibold text-foreground">{{ fileName }}</span>
          <span
            v-if="target?.status"
            class="mono shrink-0 text-[11px] font-bold"
            :style="{ color: statusColor }"
            >{{ target.status }}</span
          >
          <span
            v-if="dirty"
            class="size-1.5 shrink-0 rounded-full bg-primary"
            :title="$t('fileViewer.unsaved')"
          />
        </div>
        <div class="mono truncate text-[11px] text-muted-foreground" :title="target?.path">
          {{ dirName ? `${repoName} · ${dirName}` : repoName
          }}<span v-if="target?.commit" class="text-primary"> · @{{ target.commit.slice(0, 7) }}</span>
        </div>
      </div>
      <!-- Content ↔ Diff toggle -->
      <div
        v-if="!binaryPreview"
        class="flex shrink-0 items-center rounded-md border border-border bg-secondary/40 p-0.5 text-[12px] font-medium"
      >
        <button
          type="button"
          :class="
            cn(
              'rounded px-2 py-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              viewerMode === 'content'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )
          "
          @click="requestMode('content')"
        >
          {{ $t("fileViewer.tabContent") }}
        </button>
        <button
          type="button"
          :class="
            cn(
              'rounded px-2 py-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              viewerMode === 'diff'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )
          "
          @click="requestMode('diff')"
        >
          {{ $t("fileViewer.tabDiff") }}
        </button>
      </div>

      <!-- Cancel / Save — while editing (Content tab, or the Diff tab's side-by-side view) -->
      <template v-if="showEditControls && editing">
        <button
          type="button"
          class="flex h-[26px] shrink-0 items-center rounded-md border border-border bg-secondary/40 px-2 text-[12px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          @click="cancelEdit"
        >
          {{ $t("fileViewer.cancel") }}
        </button>
        <button
          type="button"
          :disabled="!dirty || saving"
          :class="
            cn(
              'flex h-[26px] shrink-0 items-center gap-1 rounded-md border px-2 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
              'border-primary/40 bg-primary/15 text-foreground hover:bg-primary/25',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )
          "
          @click="save"
        >
          <Loader2 v-if="saving" :size="13" class="animate-spin" />
          <Save v-else :size="13" />
          {{ saving ? $t("fileViewer.saving") : $t("fileViewer.save") }}
        </button>
      </template>

      <!-- overflow menu: Edit · word wrap · word-level diff · split/unified · Open with.
           Stays visible in BOTH Content and Diff views whenever not mid-edit (word wrap has no gate). -->
      <DropdownMenu v-if="!editing">
        <Tooltip>
          <TooltipTrigger as-child>
            <!-- inert wrapper: two reka `as-child` triggers (Tooltip + DropdownMenu) must never
                 merge onto one element, or the menu stops opening — see ViewOptions.vue. -->
            <span class="inline-flex">
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-sm" :aria-label="$t('fileViewer.viewOptions')">
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent>{{ $t("fileViewer.viewOptions") }}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" class="w-52">
          <DropdownMenuItem v-if="showEditControls && !store.isGuest" @select="startEdit">
            <Pencil :size="14" />
            {{ $t("fileViewer.edit") }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="!binaryPreview" @select.prevent="wordWrap = !wordWrap">
            <WrapText :size="14" />
            {{ $t("fileViewer.wordWrap") }}
            <Check v-if="wordWrap" :size="14" class="ml-auto text-primary" />
          </DropdownMenuItem>
          <DropdownMenuItem v-if="viewerMode === 'content'" @select.prevent="dirtyDiffGutter = !dirtyDiffGutter">
            <Highlighter :size="14" />
            {{ $t("fileViewer.dirtyGutter") }}
            <Check v-if="dirtyDiffGutter" :size="14" class="ml-auto text-primary" />
          </DropdownMenuItem>
          <DropdownMenuItem v-if="diffEditable" @select.prevent="wordLevelDiff = !wordLevelDiff">
            <WholeWord :size="14" />
            {{ $t("fileViewer.wordDiff") }}
            <Check v-if="wordLevelDiff" :size="14" class="ml-auto text-primary" />
          </DropdownMenuItem>
          <DropdownMenuItem v-if="diffEditable" @select="diffSplitView = !diffSplitView">
            <component :is="diffSplitView ? AlignJustify : Columns2" :size="14" />
            {{ diffSplitView ? $t("fileViewer.unifiedView") : $t("fileViewer.splitView") }}
          </DropdownMenuItem>
          <!-- Deliberately NOT gated on diffEditable, unlike the three above: in patch mode
               diffEditable is false, and patch mode is exactly when someone wants this. -->
          <DropdownMenuItem
            v-if="viewerMode === 'diff' && !store.isGuest"
            :title="$t('settings.diffPatchAlwaysHint')"
            @select.prevent="setAlwaysSideBySide(!alwaysSideBySide)"
          >
            <Columns2 :size="14" />
            {{ $t("settings.diffPatchAlways") }}
            <Check v-if="alwaysSideBySide" :size="14" class="ml-auto text-primary" />
          </DropdownMenuItem>
          <template v-if="store.canContinueLocal && !store.isGuest">
            <DropdownMenuSeparator v-if="!binaryPreview" />
            <DropdownMenuItem @select="openWith()">
              <ExternalLink :size="14" />
              {{ $t("fileViewer.openWith") }}
            </DropdownMenuItem>
            <DropdownMenuItem v-for="e in openableEditors" :key="e.id" class="pl-7" @select="openWith(e.id)">
              <span class="truncate">{{ e.label }}</span>
              <Check v-if="e.id === store.effectiveEditor" :size="14" class="ml-auto text-primary" />
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip v-if="props.showClose">
        <TooltipTrigger as-child>
          <button
            class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            :aria-label="$t('fileViewer.close')"
            @click="$emit('close')"
          >
            <X :size="17" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ $t("fileViewer.close") }}</TooltipContent>
      </Tooltip>
    </div>

    <!-- body -->
    <div class="relative min-h-0 flex-1">
      <div
        v-if="loadingDelayed"
        class="flex h-full items-center justify-center text-muted-foreground"
      >
        <Loader2 :size="20" class="animate-spin" />
      </div>

      <div
        v-else-if="errorMsg"
        class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      >
        <FileWarning :size="22" class="text-destructive" />
        <div class="text-[13px] font-medium text-foreground">{{ $t("fileViewer.error") }}</div>
        <div class="mono max-w-sm text-[11.5px] break-words text-muted-foreground">{{ errorMsg }}</div>
      </div>

      <div
        v-else-if="previewableImage && !previewFailed"
        class="relative flex h-full items-center justify-center overflow-auto bg-secondary/15 p-4"
      >
        <Loader2
          v-if="previewLoading"
          :size="20"
          class="absolute animate-spin text-muted-foreground"
        />
        <img
          :src="previewSrc"
          :alt="fileName"
          class="max-h-full max-w-full object-contain transition-opacity"
          :class="previewLoading ? 'opacity-0' : 'opacity-100'"
          @load="previewLoading = false"
          @error="previewFailed = true"
        />
      </div>

      <div
        v-else-if="previewKind === 'pdf' && !previewFailed"
        class="relative h-full bg-secondary/15"
      >
        <Loader2
          v-if="previewLoading"
          :size="20"
          class="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
        />
        <iframe
          :src="previewSrc"
          :title="fileName"
          class="h-full w-full border-0"
          sandbox=""
          @load="previewLoading = false"
          @error="previewFailed = true"
        />
      </div>

      <div
        v-else-if="previewKind === 'audio' && !previewFailed"
        class="relative flex h-full items-center justify-center bg-secondary/15 p-6"
      >
        <Loader2
          v-if="previewLoading"
          :size="20"
          class="absolute animate-spin text-muted-foreground"
        />
        <audio
          :src="previewSrc"
          :aria-label="fileName"
          class="w-full max-w-2xl"
          controls
          preload="metadata"
          @loadedmetadata="previewLoading = false"
          @error="previewFailed = true"
        />
      </div>

      <div
        v-else-if="previewKind === 'video' && !previewFailed"
        class="relative flex h-full items-center justify-center overflow-auto bg-black/90 p-4"
      >
        <Loader2
          v-if="previewLoading"
          :size="20"
          class="absolute animate-spin text-white/70"
        />
        <video
          :src="previewSrc"
          :aria-label="fileName"
          class="max-h-full max-w-full"
          controls
          preload="metadata"
          @loadedmetadata="previewLoading = false"
          @error="previewFailed = true"
        />
      </div>

      <div
        v-else-if="previewFailed"
        class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground"
      >
        <FileWarning :size="22" />
        <div class="text-[13px]">{{ $t("fileViewer.previewUnavailable") }}</div>
      </div>

      <div
        v-else-if="binary"
        class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground"
      >
        <FileWarning :size="22" />
        <div class="text-[13px]">{{ $t("fileViewer.binary") }}</div>
      </div>

      <div v-else class="flex h-full min-h-0 flex-col">
        <div
          v-if="patchMode || fromHead || truncated"
          class="shrink-0 border-b border-border/60 bg-secondary/40 px-3 py-1.5 text-[11.5px] text-muted-foreground sm:px-4"
        >
          <!-- The notice now carries its own way out. Reading "this is a compact diff" and having
               no idea how to get the full one is the whole complaint this fixes. -->
          <span v-if="patchMode" class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{{ $t("fileViewer.compactDiff") }}</span>
            <button
              v-if="!store.isGuest"
              type="button"
              class="inline-flex items-center gap-1 rounded text-[11.5px] font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
              @click="setAlwaysSideBySide(true)"
            >
              <Columns2 :size="11" />
              {{ $t("fileViewer.showSideBySide") }}
            </button>
          </span>
          <span v-else-if="fromHead">{{ $t("fileViewer.showingCommitted") }}</span>
          <span v-else>{{ $t("fileViewer.truncated") }}</span>
        </div>
        <div class="min-h-0 flex-1">
          <MarkdownPreview
            v-if="previewableMarkdown && viewerMode === 'content' && !editing && !truncated"
            :source="content"
          />
          <!-- Large modified files arrive as a unified patch (compact diff) — rendered in a
               read-only editor with `diff` highlighting; small files use the rich side-by-side.
               Clicking Edit on the Diff tab drops the side-by-side view for the same single-pane
               editable editor Content mode uses, seeded from the working-tree (`modified`) text. -->
          <MonacoDiffViewer
            v-else-if="diffEditable && !editing"
            :original="original"
            :modified="modified"
            :filename="target?.path ?? ''"
            :theme="editorTheme"
            :word-level="wordLevelDiff"
            :split="diffSplitView"
            :word-wrap="wordWrap"
          />
          <MonacoViewer
            v-else-if="viewerMode === 'diff' && patchMode"
            :value="patch"
            :filename="target?.path ?? ''"
            language="diff"
            :theme="editorTheme"
            :word-wrap="wordWrap"
          />
          <MonacoViewer
            v-else
            ref="editorViewer"
            :value="viewerMode === 'content' ? content : modified"
            :filename="target?.path ?? ''"
            :theme="editorTheme"
            :editable="editing"
            :word-wrap="wordWrap"
            :changed-lines="viewerMode === 'content' ? changedLines : []"
            @change="onEditorChange"
          />
        </div>
      </div>
    </div>
  </div>
</template>
