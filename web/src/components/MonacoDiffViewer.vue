<script setup lang="ts">
// Read-only Monaco diff editor (HEAD ↔ working tree). Loaded lazily like MonacoViewer.
// `hideUnchangedRegions` gives the GitHub-style collapsed unchanged blocks with
// "show N more lines" expanders; side-by-side auto-folds to inline in a narrow panel.
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { getMonaco, monacoThemeFor, type EditorTheme } from "@/lib/monaco-setup";

type MonacoApi = Awaited<ReturnType<typeof getMonaco>>;
type DiffEditor = ReturnType<MonacoApi["editor"]["createDiffEditor"]>;
type TextModel = ReturnType<MonacoApi["editor"]["createModel"]>;

const props = defineProps<{
  /** Original (HEAD) text — left/removed side. */
  original: string;
  /** Modified (working-tree) text — right/added side. */
  modified: string;
  /** Repo-relative path — Monaco infers the language from its extension. */
  filename: string;
  theme: EditorTheme;
  /** Word/character-level inner highlights (Monaco default) vs whole-line only. */
  wordLevel: boolean;
  /** true = split (side-by-side), false = unified (inline). */
  split: boolean;
}>();

const host = ref<HTMLElement | null>(null);
let monaco: MonacoApi | null = null;
let editor: DiffEditor | null = null;
let originalModel: TextModel | null = null;
let modifiedModel: TextModel | null = null;

// The diff is computed asynchronously in a worker; until its first result lands, Monaco
// paints the whole un-collapsed file (no hideUnchangedRegions folding, no add/remove
// highlights) and then snaps into the diff — a visible flash, especially as the panel
// slides in. So we keep the editor hidden until that first result, then fade it in. While
// hidden the host is transparent, revealing the matching bg-card behind it (no flash).
const ready = ref(false);
let diffListener: { dispose(): void } | null = null;
let revealTimer: ReturnType<typeof setTimeout> | null = null;

/** Re-arm the hold-until-diff-ready gate for the model currently set on the editor. The
 *  timer is a safety net so we always reveal — even if the diff resolves to "no changes"
 *  or the event is missed for any reason — rather than leaving the editor stuck hidden. */
function revealOnFirstDiff(): void {
  ready.value = false;
  diffListener?.dispose();
  if (revealTimer != null) clearTimeout(revealTimer);
  const reveal = (): void => {
    ready.value = true;
    diffListener?.dispose();
    diffListener = null;
    if (revealTimer != null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
  };
  diffListener = editor?.onDidUpdateDiff(reveal) ?? null;
  revealTimer = setTimeout(reveal, 600);
}

/** Fresh original+modified models. Both URIs carry the filename (→ correct grammar); the
 *  original gets a distinct scheme so the two never collide. */
function makeModels(m: MonacoApi): { original: TextModel; modified: TextModel } {
  const modUri = m.Uri.file(props.filename || "untitled.txt");
  const origUri = modUri.with({ scheme: "repoyeti-head" });
  m.editor.getModel(modUri)?.dispose();
  m.editor.getModel(origUri)?.dispose();
  return {
    original: m.editor.createModel(props.original, undefined, origUri),
    modified: m.editor.createModel(props.modified, undefined, modUri),
  };
}

onMounted(async () => {
  monaco = await getMonaco();
  if (!host.value) return; // unmounted while monaco loaded
  const models = makeModels(monaco);
  originalModel = models.original;
  modifiedModel = models.modified;
  editor = monaco.editor.createDiffEditor(host.value, {
    readOnly: true,
    originalEditable: false,
    theme: monacoThemeFor(props.theme),
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    renderSideBySide: props.split,
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: 700,
    hideUnchangedRegions: {
      enabled: true,
      contextLineCount: 3,
      minimumLineCount: 4,
      revealLineCount: 20,
    },
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    scrollbar: { useShadows: false },
  });
  editor.setModel({ original: originalModel, modified: modifiedModel });
  revealOnFirstDiff();
});

// Swap both models in place when a different file is opened into the same diff editor.
watch(
  () => [props.original, props.modified, props.filename],
  () => {
    if (!editor || !monaco) return;
    const prevO = originalModel;
    const prevM = modifiedModel;
    const models = makeModels(monaco);
    originalModel = models.original;
    modifiedModel = models.modified;
    editor.setModel({ original: originalModel, modified: modifiedModel });
    revealOnFirstDiff();
    prevO?.dispose();
    prevM?.dispose();
  },
);

watch(
  () => props.theme,
  (t) => monaco?.editor.setTheme(monacoThemeFor(t)),
);

// Split ↔ unified is a live option change — no need to rebuild the editor.
watch(
  () => props.split,
  (split) => editor?.updateOptions({ renderSideBySide: split }),
);

onBeforeUnmount(() => {
  diffListener?.dispose();
  if (revealTimer != null) clearTimeout(revealTimer);
  editor?.dispose();
  originalModel?.dispose();
  modifiedModel?.dispose();
  editor = null;
  originalModel = null;
  modifiedModel = null;
});
</script>

<template>
  <!-- `gm-line-level-diff` (when wordLevel is off) suppresses Monaco's inner char
       highlights so only whole-line backgrounds show — see web/src/style.css.
       Opacity is held at 0 until the first diff is computed (see revealOnFirstDiff),
       then faded in, so the un-diffed file never flashes on open. -->
  <div
    ref="host"
    class="h-full w-full transition-opacity duration-150 ease-out"
    :class="[{ 'gm-line-level-diff': !wordLevel }, ready ? 'opacity-100' : 'opacity-0']"
  />
</template>
