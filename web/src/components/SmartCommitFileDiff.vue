<script setup lang="ts">
/**
 * Inline, read-only diff preview for ONE file inside the Smart Commit plan editor.
 *
 * The plan editor lists each proposed commit's message + file chips; expanding a chip mounts
 * this to show exactly WHAT that file contributes (HEAD ↔ working tree) — so the owner reviews
 * the actual change, not just the filename, before committing. Deliberately lightweight:
 *  - lazy — the diff is fetched only when a chip is expanded (never up front for the whole plan);
 *  - single-open — the plan editor keeps at most one of these mounted at a time, so this is never
 *    more than one Monaco instance (same cost as the full-screen file viewer's drawer);
 *  - reuses the app's real Monaco diff renderer + persisted split/word-level prefs, so the inline
 *    preview matches the drawer. Large modified files arrive as a compact unified patch instead.
 */
import { computed, defineAsyncComponent, h, ref, watch } from "vue";
import { Loader2, FileWarning } from "@lucide/vue";
import { t } from "@/i18n";
import { api, ApiError } from "@/api";
import type { EditorTheme } from "@/lib/monaco-setup";
import { useTheme } from "@/lib/theme";
import { wordLevelDiff, diffSplitView } from "@/lib/file-viewer";

const props = defineProps<{ repoId: string; path: string; status?: string }>();

// Monaco is heavy — pull it (and its chunk) only when a file is actually expanded.
const Spinner = (): ReturnType<typeof h> =>
  h(
    "div",
    { class: "flex h-full items-center justify-center" },
    h(Loader2, { class: "size-5 animate-spin text-muted-foreground" }),
  );
const EditorFailed = (): ReturnType<typeof h> =>
  h(
    "div",
    { class: "flex h-full items-center justify-center p-4 text-center text-[12px] text-muted-foreground" },
    t("fileViewer.editorFailed"),
  );
const MonacoDiffViewer = defineAsyncComponent({
  loader: () => import("./MonacoDiffViewer.vue"),
  loadingComponent: Spinner,
  errorComponent: EditorFailed,
  delay: 120,
  timeout: 30_000,
});
const MonacoViewer = defineAsyncComponent({
  loader: () => import("./MonacoViewer.vue"),
  loadingComponent: Spinner,
  errorComponent: EditorFailed,
  delay: 120,
  timeout: 30_000,
});

// Mirror the app's resolved light/dark for the editor (same as FileViewerInner).
const { isDark } = useTheme();
const editorTheme = computed<EditorTheme>(() => (isDark.value ? "dark" : "light"));

const loading = ref(true);
const errorMsg = ref<string | null>(null);
const original = ref(""); // HEAD side
const modified = ref(""); // working-tree side
const patch = ref(""); // unified git-diff text (large modified files)
const patchMode = ref(false); // server sent a compact patch instead of both whole sides
const binary = ref(false);
const truncated = ref(false);

// Re-fetch whenever the target file changes. A returning request bails if a newer path
// superseded it (the parent re-keys on path, so in practice each mount sees one path).
watch(
  () => `${props.repoId}::${props.path}`,
  async (key) => {
    loading.value = true;
    errorMsg.value = null;
    binary.value = false;
    truncated.value = false;
    patchMode.value = false;
    try {
      const res = await api.fileDiff(props.repoId, props.path);
      if (`${props.repoId}::${props.path}` !== key) return; // superseded mid-flight
      original.value = res.original ?? "";
      modified.value = res.modified ?? "";
      patch.value = res.patch ?? "";
      patchMode.value = res.mode === "patch";
      binary.value = !!res.binary;
      truncated.value = !!res.truncated;
    } catch (e) {
      if (`${props.repoId}::${props.path}` === key) {
        errorMsg.value = e instanceof ApiError ? e.message : t("fileViewer.error");
      }
    } finally {
      if (`${props.repoId}::${props.path}` === key) loading.value = false;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="overflow-hidden rounded-md border border-border bg-background/40">
    <!-- large-file / compact-diff notice, same wording as the full viewer -->
    <div
      v-if="!loading && !errorMsg && !binary && (patchMode || truncated)"
      class="border-b border-border/60 bg-secondary/40 px-3 py-1 text-[11px] text-muted-foreground"
    >
      <span v-if="patchMode">{{ $t("fileViewer.compactDiff") }}</span>
      <span v-else>{{ $t("fileViewer.truncated") }}</span>
    </div>

    <div class="h-56 sm:h-72">
      <div v-if="loading" class="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 :size="18" class="animate-spin" />
      </div>

      <div
        v-else-if="errorMsg"
        class="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-center"
      >
        <FileWarning :size="18" class="text-destructive" />
        <div class="mono max-w-full text-[11.5px] break-words text-muted-foreground">{{ errorMsg }}</div>
      </div>

      <div
        v-else-if="binary"
        class="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-center text-muted-foreground"
      >
        <FileWarning :size="18" />
        <div class="text-[12px]">{{ $t("fileViewer.binary") }}</div>
      </div>

      <!-- Large modified files arrive as a unified patch, rendered read-only with `diff`
           highlighting; small files use the rich side-by-side (auto-folds to inline here). -->
      <MonacoViewer
        v-else-if="patchMode"
        :value="patch"
        :filename="path"
        language="diff"
        :theme="editorTheme"
      />
      <MonacoDiffViewer
        v-else
        :original="original"
        :modified="modified"
        :filename="path"
        :theme="editorTheme"
        :word-level="wordLevelDiff"
        :split="diffSplitView"
      />
    </div>
  </div>
</template>
