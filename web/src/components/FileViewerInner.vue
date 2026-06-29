<script setup lang="ts">
// Shared content of the file viewer (header + body), rendered inside either the desktop
// push-drawer or the mobile bottom sheet. Owns the fetch + the lazily-loaded editor.
import { computed, defineAsyncComponent, h, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useColorMode, usePreferredDark } from "@vueuse/core";
import { X, Loader2, FileWarning, Columns2, AlignJustify, Pencil, Save } from "@lucide/vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { api, ApiError } from "@/api";
import { fileVisual } from "@/lib/file-icons";
import { cn } from "@/lib/utils";
import type { EditorTheme } from "@/lib/monaco-setup";
import {
  viewerMode,
  wordLevelDiff,
  diffSplitView,
  editorDirty,
  confirmDiscardEdits,
  type ViewerMode,
  type ViewerTarget,
} from "@/lib/file-viewer";
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
const mode = useColorMode({ initialValue: "dark" });
const prefersDark = usePreferredDark();
const editorTheme = computed<EditorTheme>(() =>
  (mode.value === "auto" ? prefersDark.value : mode.value === "dark") ? "dark" : "light",
);

// ── header bits ───────────────────────────────────────────────────────────────
const fileName = computed(() => props.target?.path.split("/").pop() ?? "");
const dirName = computed(() => {
  const parts = props.target?.path.split("/") ?? [];
  return parts.slice(0, -1).join("/");
});
const repoName = computed(
  () => store.repos.find((r) => r.id === props.target?.repoId)?.name ?? "",
);
const icon = computed(() => fileVisual(fileName.value || "file", false));

// VS Code-style git-status colours (matches ChangesTree).
const STATUS_COLOR: Record<string, string> = {
  M: "#e2c08d",
  A: "#73c991",
  U: "#73c991",
  D: "#f14c4c",
  R: "#6cb6ff",
  C: "#d18616",
};
const statusColor = computed(() =>
  props.target?.status ? (STATUS_COLOR[props.target.status] ?? "#9aa0a6") : "#9aa0a6",
);

// ── fetch (Content = whole file · Diff = HEAD ↔ working tree) ────────────────────
const loading = ref(false);
const errorMsg = ref<string | null>(null);
const content = ref(""); // content mode — the loaded source
const original = ref(""); // diff mode (HEAD)
const modified = ref(""); // diff mode (working tree)
const patch = ref(""); // diff mode — unified git-diff text (large modified files)
const patchMode = ref(false); // server sent a compact patch instead of both whole sides
const binary = ref(false);
const truncated = ref(false);
const fromHead = ref(false);

// ── edit mode (Content tab only) ────────────────────────────────────────────────
const editing = ref(false);
const draft = ref(""); // latest editor text while editing
const dirty = ref(false);
const saving = ref(false);

// Mirror dirty into the shared store so close / switch-file guards (file-viewer.ts) can prompt.
watch(dirty, (v) => (editorDirty.value = v));

// Editable only when we're showing the real, whole working-tree text. A truncated file
// would be SAVED truncated (data loss); a binary file isn't text; the HEAD fallback means
// the working file is gone (a deletion) — none of those should be editable.
// This browser reached the daemon over the tunnel (not loopback) when the daemon says we can't
// "continue local". If the owner has also turned remote editing off, a save would be refused
// server-side — so disable Edit up front with a clear reason instead of letting it 403 on save.
const remoteEditBlocked = computed(() => !store.canContinueLocal && !store.remoteEditing);

const canEdit = computed(
  () =>
    viewerMode.value === "content" &&
    !loading.value &&
    !errorMsg.value &&
    !binary.value &&
    !truncated.value &&
    !fromHead.value &&
    !remoteEditBlocked.value,
);

// Identity of the request in flight — repo + path + mode. Re-fetches when any changes,
// and lets a returning request bail if a newer open/toggle has superseded it.
const fetchKey = (): string | null =>
  props.target ? `${props.target.repoId}::${props.target.path}::${viewerMode.value}` : null;

watch(
  fetchKey,
  async (key) => {
    if (!key || !props.target) return;
    const { repoId, path } = props.target;
    loading.value = true;
    errorMsg.value = null;
    binary.value = false;
    truncated.value = false;
    fromHead.value = false;
    patchMode.value = false;
    editing.value = false; // a new file/mode drops any in-progress edit
    dirty.value = false;
    try {
      if (viewerMode.value === "diff") {
        const res = await api.fileDiff(repoId, path);
        if (fetchKey() !== key) return; // superseded mid-flight
        original.value = res.original ?? "";
        modified.value = res.modified ?? "";
        patch.value = res.patch ?? "";
        patchMode.value = res.mode === "patch";
        binary.value = !!res.binary;
        truncated.value = !!res.truncated;
      } else {
        const res = await api.fileContent(repoId, path);
        if (fetchKey() !== key) return;
        content.value = res.content ?? "";
        binary.value = !!res.binary;
        truncated.value = !!res.truncated;
        fromHead.value = res.ref === "head";
      }
    } catch (e) {
      if (fetchKey() === key) errorMsg.value = e instanceof ApiError ? e.message : t("fileViewer.error");
    } finally {
      if (fetchKey() === key) loading.value = false;
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
  draft.value = content.value;
  dirty.value = false;
  editing.value = true;
}
function cancelEdit(): void {
  // MonacoViewer resets its buffer to `content` when `editable` flips false.
  editing.value = false;
  dirty.value = false;
}
function onEditorChange(value: string): void {
  draft.value = value;
  dirty.value = value !== content.value;
}
async function save(): Promise<void> {
  if (!props.target || !editing.value || !canEdit.value || !dirty.value || saving.value) return;
  const { repoId, path } = props.target;
  saving.value = true;
  try {
    await api.saveFile(repoId, path, draft.value);
    content.value = draft.value; // editor value catches up; MonacoViewer skips the reset
    dirty.value = false;
    toast.success(t("fileViewer.saved"));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("fileViewer.saveFailed"));
  } finally {
    saving.value = false;
  }
}

// Ctrl/Cmd+S saves while editing (instead of the browser's save-page dialog).
function onKeydown(e: KeyboardEvent): void {
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
});
onBeforeUnmount(() => {
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
          {{ dirName ? `${repoName} · ${dirName}` : repoName }}
        </div>
      </div>
      <!-- Content ↔ Diff toggle -->
      <div class="flex shrink-0 items-center rounded-md border border-border bg-secondary/40 p-0.5 text-[12px] font-medium">
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

      <!-- Edit / Save / Cancel (Content tab only) -->
      <button
        v-if="viewerMode === 'content' && !editing"
        type="button"
        :disabled="!canEdit"
        :class="
          cn(
            'flex h-[26px] shrink-0 items-center gap-1 rounded-md border px-2 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
            'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
            'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground',
          )
        "
        :title="remoteEditBlocked ? $t('fileViewer.editRemoteOff') : $t('fileViewer.editTooltip')"
        @click="startEdit"
      >
        <Pencil :size="13" />
        {{ $t("fileViewer.edit") }}
      </button>
      <template v-else-if="viewerMode === 'content' && editing">
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

      <!-- word-level vs line-level diff highlight (side-by-side diff mode only) -->
      <button
        v-if="viewerMode === 'diff' && !patchMode"
        type="button"
        :class="
          cn(
            'shrink-0 rounded-md border px-2 py-1 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
            wordLevelDiff
              ? 'border-primary/40 bg-primary/15 text-foreground'
              : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
          )
        "
        :aria-pressed="wordLevelDiff"
        :title="$t('fileViewer.wordDiffTooltip')"
        @click="wordLevelDiff = !wordLevelDiff"
      >
        {{ $t("fileViewer.wordDiff") }}
      </button>

      <!-- split (side-by-side) ↔ unified (inline) diff layout; icon shows current mode -->
      <button
        v-if="viewerMode === 'diff' && !patchMode"
        type="button"
        class="flex h-[26px] shrink-0 items-center rounded-md border border-border bg-secondary/40 px-1.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        :aria-label="$t('fileViewer.viewModeTooltip')"
        :title="$t('fileViewer.viewModeTooltip')"
        @click="diffSplitView = !diffSplitView"
      >
        <component :is="diffSplitView ? Columns2 : AlignJustify" :size="15" />
      </button>

      <button
        v-if="props.showClose"
        class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        :aria-label="$t('fileViewer.close')"
        @click="$emit('close')"
      >
        <X :size="17" />
      </button>
    </div>

    <!-- body -->
    <div class="relative min-h-0 flex-1">
      <div
        v-if="loading"
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
          <span v-if="patchMode">{{ $t("fileViewer.compactDiff") }}</span>
          <span v-else-if="fromHead">{{ $t("fileViewer.showingCommitted") }}</span>
          <span v-else>{{ $t("fileViewer.truncated") }}</span>
        </div>
        <div class="min-h-0 flex-1">
          <!-- Large modified files arrive as a unified patch (compact diff) — rendered in a
               read-only editor with `diff` highlighting; small files use the rich side-by-side. -->
          <MonacoDiffViewer
            v-if="viewerMode === 'diff' && !patchMode"
            :original="original"
            :modified="modified"
            :filename="target?.path ?? ''"
            :theme="editorTheme"
            :word-level="wordLevelDiff"
            :split="diffSplitView"
          />
          <MonacoViewer
            v-else-if="viewerMode === 'diff'"
            :value="patch"
            :filename="target?.path ?? ''"
            language="diff"
            :theme="editorTheme"
          />
          <MonacoViewer
            v-else
            :value="content"
            :filename="target?.path ?? ''"
            :theme="editorTheme"
            :editable="editing"
            @change="onEditorChange"
          />
        </div>
      </div>
    </div>
  </div>
</template>
