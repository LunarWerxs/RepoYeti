// Monaco bootstrap, kept out of the main bundle.
//
// Only ever imported by MonacoViewer.vue, which is loaded lazily (defineAsyncComponent)
// the first time a file is opened — so monaco-editor never ships in the initial app
// chunk. Vite turns each `?worker` import into its own same-origin worker chunk; those
// (and the editor chunk) are excluded from the PWA precache (see vite.config.ts) and
// fetched on demand instead.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

export type EditorTheme = "light" | "dark";

let ready = false;

function init(): void {
  if (ready) return;
  ready = true;

  // Monaco reads `self.MonacoEnvironment` to find its language-service workers.
  (
    globalThis as unknown as {
      MonacoEnvironment: { getWorker(workerId: string, label: string): Worker };
    }
  ).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };

  // This is a read-only viewer of arbitrary files — never lint them. Turning the
  // language services' validation off keeps Monaco from drawing red "error" squiggles
  // on code it can't fully resolve (unresolved imports, etc.). Highlighting is a
  // separate, main-thread concern and stays on.
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: false });
  monaco.css.cssDefaults.setOptions({ validate: false });

  // Monaco ships no "diff" text language (the diffEditor is a separate feature), so register a
  // tiny Monarch grammar for it. The file viewer renders the compact-diff (unified `git diff`)
  // view of large files in a plain editor with this language → coloured +/- lines + @@ headers.
  // `+++`/`---` headers are matched BEFORE the +/- body rules so they tokenise as metadata.
  monaco.languages.register({ id: "diff" });
  monaco.languages.setMonarchTokensProvider("diff", {
    defaultToken: "",
    tokenizer: {
      root: [
        [/^diff\b.*$/, "diff-meta"],
        [
          /^(index|new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename (from|to)|copy (from|to)|Binary files)\b.*$/,
          "diff-meta",
        ],
        [/^---.*$/, "diff-meta"],
        [/^\+\+\+.*$/, "diff-meta"],
        [/^@@.*$/, "diff-hunk"],
        [/^\+.*$/, "diff-add"],
        [/^-.*$/, "diff-del"],
        [/^\\.*$/, "diff-meta"], // "\ No newline at end of file"
      ],
    },
  });

  // Themes that blend the editor surface into the app's card colour (see web/src/style.css).
  monaco.editor.defineTheme("repoyeti-dark", {
    base: "vs-dark",
    inherit: true,
    // Diff-view token colours (see the "diff" language above) — mirror the app's git-status palette.
    rules: [
      { token: "diff-add", foreground: "73c991" },
      { token: "diff-del", foreground: "f14c4c" },
      { token: "diff-hunk", foreground: "6cb6ff" },
      { token: "diff-meta", foreground: "9aa0a6" },
    ],
    colors: { "editor.background": "#141419" },
  });
  monaco.editor.defineTheme("repoyeti-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "diff-add", foreground: "22863a" },
      { token: "diff-del", foreground: "b31d28" },
      { token: "diff-hunk", foreground: "005cc5" },
      { token: "diff-meta", foreground: "6a737d" },
    ],
    colors: { "editor.background": "#ffffff" },
  });
}

/** Resolve the Monaco namespace, performing one-time worker + theme setup. */
export async function getMonaco(): Promise<typeof monaco> {
  init();
  return monaco;
}

export function monacoThemeFor(mode: EditorTheme): string {
  return mode === "dark" ? "repoyeti-dark" : "repoyeti-light";
}
