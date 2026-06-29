<script setup lang="ts">
// Monaco editor for the file viewer. Read-only by default; flips editable when the viewer's
// Edit mode is on. Loaded lazily (defineAsyncComponent in FileViewerInner), so importing
// getMonaco here is what pulls monaco-editor into this component's own chunk.
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { getMonaco, monacoThemeFor, type EditorTheme } from "@/lib/monaco-setup";

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
    /** When true the editor is writable and emits `change` on every edit. */
    editable?: boolean;
  }>(),
  { editable: false },
);
const emit = defineEmits<{ change: [value: string] }>();

const host = ref<HTMLElement | null>(null);
let monaco: MonacoApi | null = null;
let editor: CodeEditor | null = null;
let model: TextModel | null = null;

// Mirror MonacoDiffViewer: keep the editor hidden until its first paint, then fade it in,
// so opening the panel doesn't pop the content in abruptly. While hidden the host is
// transparent, revealing the matching bg-card behind it.
const ready = ref(false);
let revealRaf = 0;
function revealNextFrame(): void {
  ready.value = false;
  cancelAnimationFrame(revealRaf);
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
    wordWrap: "off",
    smoothScrolling: true,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    padding: { top: 10, bottom: 10 },
    scrollbar: { useShadows: false },
  });
  // Surface every edit to the parent, which owns the dirty/draft state.
  editor.onDidChangeModelContent(() => emit("change", editor!.getValue()));
  revealNextFrame();
});

// Swap the model when a different file opens, or when the source changes out from under us
// (e.g. a revert). Skip the swap when `value` merely catches up to what's already typed
// (right after a save) — re-creating the model would drop the cursor and undo history.
watch(
  () => [props.value, props.filename] as const,
  ([val, file], [, oldFile]) => {
    if (!editor || !monaco) return;
    if (file === oldFile && model && model.getValue() === val) return;
    const old = model;
    model = makeModel(monaco);
    editor.setModel(model);
    revealNextFrame();
    old?.dispose();
  },
);

// Toggle writability. Leaving edit mode discards any unsaved edits back to the source
// (the setValue fires onDidChangeModelContent, so the parent's dirty state clears too).
watch(
  () => props.editable,
  (on) => {
    editor?.updateOptions({ readOnly: !on, domReadOnly: !on });
    if (!on && model && model.getValue() !== props.value) model.setValue(props.value);
    if (on) editor?.focus();
  },
);

watch(
  () => props.theme,
  (t) => monaco?.editor.setTheme(monacoThemeFor(t)),
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
