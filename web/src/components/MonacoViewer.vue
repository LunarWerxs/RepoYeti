<script setup lang="ts">
// Monaco editor for the file viewer. Read-only by default; flips editable when the viewer's
// Edit mode is on. Loaded lazily (defineAsyncComponent in FileViewerInner), so importing
// getMonaco here is what pulls monaco-editor into this component's own chunk.
import { onMounted, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { getMonaco, monacoThemeFor, type EditorTheme } from "@/lib/monaco-setup";
import type { LineChange } from "@/lib/line-diff";

// Derive Monaco's types from getMonaco's return — no direct monaco-editor type import,
// so this stays in lock-step with the editor.api build that monaco-setup actually loads.
type MonacoApi = Awaited<ReturnType<typeof getMonaco>>;
type CodeEditor = ReturnType<MonacoApi["editor"]["create"]>;
type TextModel = ReturnType<MonacoApi["editor"]["createModel"]>;

const props = withDefaults(
  defineProps<{
    /** File text to display — the loaded source. NOT fed back while the user is editing. */
    value: string;
    /** Repo-relative path — Monaco infers the language from its extension. */
    filename: string;
    theme: EditorTheme;
    /** Explicit Monaco language id (e.g. "diff" for the compact-diff patch view). When
     *  omitted, Monaco infers the grammar from `filename`'s extension. */
    language?: string;
    /** When true the editor is writable and emits a cheap dirty-state `change` on every edit. */
    editable?: boolean;
    /** Soft-wrap long lines (Monaco wordWrap "on"/"off"). */
    wordWrap?: boolean;
    /** VS Code-style "dirty diff" gutter markers (added/modified/deleted lines vs HEAD). Empty/
     *  omitted = no gutter. */
    changedLines?: LineChange[];
  }>(),
  { editable: false, wordWrap: false },
);
const emit = defineEmits<{ change: [dirty: boolean] }>();

const host = useTemplateRef<HTMLElement>("host");
let monaco: MonacoApi | null = null;
let editor: CodeEditor | null = null;
let model: TextModel | null = null;
let gutterIds: string[] = []; // dirty-diff decoration ids (deltaDecorations tracking)
let cleanAlternativeVersionId = 0;
let suppressChange = false;

/** Monaco's alternative version id returns to its earlier value when Undo returns to the saved
 *  state. Comparing this small integer avoids allocating/copying the entire model on each key. */
function emitDirty(): void {
  if (!model || suppressChange) return;
  emit("change", model.getAlternativeVersionId() !== cleanAlternativeVersionId);
}

function markClean(alternativeVersionId = model?.getAlternativeVersionId() ?? 0): boolean {
  if (!model) return false;
  cleanAlternativeVersionId = alternativeVersionId;
  const dirty = model.getAlternativeVersionId() !== cleanAlternativeVersionId;
  emit("change", dirty);
  return dirty;
}

/** The parent pulls the full buffer only when Save is requested. */
function getValue(): string {
  return model?.getValue() ?? props.value;
}

/** Capture text and its Monaco version atomically in the same JavaScript turn. If the user keeps
 *  typing while the save request is in flight, that newer version remains correctly dirty. */
function getSnapshot(): { value: string; alternativeVersionId: number } {
  return {
    value: getValue(),
    alternativeVersionId: model?.getAlternativeVersionId() ?? cleanAlternativeVersionId,
  };
}

defineExpose({ getValue, getSnapshot, markClean });

/** Paint the dirty-diff gutter markers from `changedLines`. Re-applied whenever the model or the
 *  ranges change; cleared when there are none (or the editor is editable — a live edit's line
 *  numbers no longer match HEAD, so the stale gutter would mislead). */
function applyGutter(): void {
  if (!editor || !monaco) return;
  const decos =
    props.editable || !props.changedLines?.length
      ? []
      : props.changedLines.map((c) => ({
          range: new monaco!.Range(c.startLine, 1, c.endLine, 1),
          options: {
            linesDecorationsClassName: `dirty-gutter dirty-gutter-${c.kind}`,
            overviewRuler: {
              color:
                c.kind === "add" ? "#3fb950" : c.kind === "delete" ? "#f85149" : "#58a6ff",
              position: monaco!.editor.OverviewRulerLane.Left,
            },
          },
        }));
  gutterIds = editor.deltaDecorations(gutterIds, decos);
}

// Mirror MonacoDiffViewer: keep the editor hidden until its first paint, then fade it in,
// so opening the panel doesn't pop the content in abruptly. While hidden the host is
// transparent, revealing the matching bg-card behind it.
const ready = ref(false);
let revealRaf = 0;
function revealNextFrame(): void {
  ready.value = false;
  cancelAnimationFrame(revealRaf);
  // A hidden tab paints no frame at all, so the rAF below would never run and the host would sit at
  // opacity-0 until the tab is shown. Reveal outright there — there is no paint to fade in front of.
  if (document.hidden) {
    ready.value = true;
    return;
  }
  // arkitect-allow: raf-one-shot-gate - `@lunawerx/ui/lib/motion/next-paint` is not a dependency of this app and no such module ships in the kit, so there is nothing to import; the hazard it names (a tab that never gets a frame) is closed by the `document.hidden` guard above, and this rAF lands the fade-in on a painted frame.
  revealRaf = requestAnimationFrame(() => {
    ready.value = true;
  });
}

/** A fresh model whose URI carries the filename, so Monaco picks the right grammar. */
function makeModel(m: MonacoApi): TextModel {
  const uri = m.Uri.file(props.filename || "untitled.txt");
  m.editor.getModel(uri)?.dispose(); // reuse the same path across repos → avoid collisions
  // Explicit `language` (e.g. "diff") wins over the URI's extension; undefined → infer.
  const created = m.editor.createModel(props.value, props.language, uri);
  // Pin CRLF when the source uses it, so an edit never silently rewrites every line ending to
  // LF (a noisy whitespace-only diff on Windows checkouts). 13,10 = CR,LF — built at runtime
  // to keep literal newlines out of this source.
  if (props.value.includes(String.fromCharCode(13, 10))) {
    created.setEOL(m.editor.EndOfLineSequence.CRLF);
  }
  return created;
}

onMounted(async () => {
  monaco = await getMonaco();
  if (!host.value) return; // unmounted while monaco loaded
  model = makeModel(monaco);
  cleanAlternativeVersionId = model.getAlternativeVersionId();
  editor = monaco.editor.create(host.value, {
    model,
    readOnly: !props.editable,
    domReadOnly: !props.editable,
    theme: monacoThemeFor(props.theme),
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineNumbers: "on",
    renderLineHighlight: "none",
    wordWrap: props.wordWrap ? "on" : "off",
    smoothScrolling: true,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    padding: { top: 10, bottom: 10 },
    scrollbar: { useShadows: false },
  });
  // Surface dirty state, not a freshly-copied full buffer. The parent reads once when saving.
  editor.onDidChangeModelContent(emitDirty);
  applyGutter();
  revealNextFrame();
});

// Swap the model when a different file opens, or when the source changes out from under us
// (e.g. a revert). Skip the swap when `value` merely catches up to what's already typed
// (right after a save) — re-creating the model would drop the cursor and undo history.
watch(
  () => [props.value, props.filename] as const,
  ([val, file], [, oldFile]) => {
    if (!editor || !monaco) return;
    if (file === oldFile && model) {
      if (model.getValue() === val) {
        markClean();
        return;
      }
      // A successful save updates `value` to the snapshot that reached disk. Preserve any newer
      // keystrokes in Monaco; markClean(savedVersion) keeps them dirty against that new baseline.
      if (props.editable) return;
    }
    const old = model;
    model = makeModel(monaco);
    cleanAlternativeVersionId = model.getAlternativeVersionId();
    editor.setModel(model);
    emit("change", false);
    gutterIds = []; // decorations belonged to the old model
    applyGutter();
    revealNextFrame();
    old?.dispose();
  },
);

// Repaint the gutter when the changed-line ranges arrive/update (the parent computes them async).
watch(() => props.changedLines, applyGutter, { deep: true });

// Toggle writability. Leaving edit mode discards any unsaved edits back to the source
// (the setValue fires onDidChangeModelContent, so the parent's dirty state clears too).
watch(
  () => props.editable,
  (on) => {
    editor?.updateOptions({ readOnly: !on, domReadOnly: !on });
    if (!on && model) {
      if (model.getValue() !== props.value) {
        suppressChange = true;
        try {
          model.setValue(props.value);
        } finally {
          suppressChange = false;
        }
      }
      markClean();
    } else if (on) {
      markClean();
      editor?.focus();
    }
    applyGutter(); // hide the (now line-mismatched) gutter while editing; restore after
  },
);

watch(
  () => props.theme,
  (t) => monaco?.editor.setTheme(monacoThemeFor(t)),
);

watch(
  () => props.wordWrap,
  (on) => editor?.updateOptions({ wordWrap: on ? "on" : "off" }),
);

onBeforeUnmount(() => {
  cancelAnimationFrame(revealRaf);
  editor?.dispose();
  model?.dispose();
  editor = null;
  model = null;
});
</script>

<template>
  <!-- Hidden until the first paint, then faded in (see revealNextFrame) for a smooth
       open, matching MonacoDiffViewer. -->
  <div
    ref="host"
    class="h-full w-full transition-opacity duration-150 ease-out"
    :class="ready ? 'opacity-100' : 'opacity-0'"
  />
</template>

<style scoped>
/* color tokens - lifted from raw literals by Odin's fix_color_tokens.py (2026-09-14); the Architect's
   color-scheme-conformance check wants every color consumed through the token layer. */
:root {
  --color-3fb950: #3fb950;
  --color-58a6ff: #58a6ff;
  --color-f85149: #f85149;
}


/* Dirty-diff gutter markers (VS Code-style) painted in Monaco's line-decorations margin. `:deep`
   so these reach the decoration elements Monaco creates inside the editor host at runtime. */
:deep(.dirty-gutter)::before {
  content: "";
  position: absolute;
  left: 2px;
  width: 3px;
  height: 100%;
  border-radius: 1px;
}
:deep(.dirty-gutter-add)::before {
  background: var(--color-3fb950); /* added lines — green */
}
:deep(.dirty-gutter-modify)::before {
  background: var(--color-58a6ff); /* changed lines — blue */
}
/* Deleted lines have no line of their own → a small red triangle at the boundary. */
:deep(.dirty-gutter-delete)::before {
  left: 1px;
  top: 50%;
  width: 0;
  height: 0;
  border-radius: 0;
  transform: translateY(-50%);
  border-inline-start: 5px solid var(--color-f85149);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  background: transparent;
}
</style>
