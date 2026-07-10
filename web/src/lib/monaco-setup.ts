// Monaco bootstrap, kept out of the main bundle.
//
// Only ever imported by MonacoViewer.vue, which is loaded lazily (defineAsyncComponent)
// the first time a file is opened — so monaco-editor never ships in the initial app
// chunk. Vite turns each `?worker` import into its own same-origin worker chunk; those
// (and the editor chunk) are excluded from the PWA precache (see vite.config.ts) and
// fetched on demand instead.
//
// IMPORTANT — we import the *editor core* (`editor.api`) plus only the Monarch
// syntax-highlighting grammars (see ./monaco-languages), NOT the full `monaco-editor`
// barrel. The barrel additionally bundles four IntelliSense *language services*
// (typescript/css/html/json), whose workers total ~8.8 MB (ts.worker alone is a full
// ~6.6 MB TypeScript compiler). This is a strictly read-only viewer with ALL validation
// disabled, so those services do nothing for us. We therefore drop three of them
// (typescript/css/html — their languages keep full colorization from the basic grammars)
// and keep ONLY the json service, because JSON is the one common language with no basic
// grammar. That roughly halves both `web/dist` and the `vite build` the tray's
// Rebuild & Restart runs, with no highlighting regression. Colorization is a main-thread
// Monarch concern; the only workers we bundle are the generic `editor.worker` (backs the
// diff editor's diff computation) and the small `json.worker`.
// NB: the explicit `.js` extensions are required for `vue-tsc` under moduleResolution
// "bundler" — monaco-editor's package `exports` map is `"./*": "./*"`, so TS only maps a
// deep import to its `.d.ts` when the `.js` is spelled out (matching ./monaco-languages).
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// ~80 Monarch grammars (colorization only — tiny per-language chunks, no services).
import "./monaco-languages";
// JSON is the one common language with no basic grammar — keep its (small, 400 KB) service.
// Its .d.ts is `export {}`, so the runtime `jsonDefaults` export is untyped; we reach it
// through an explicit shape below rather than a named import (which won't typecheck).
import * as jsonContribution from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

// The json service module really exports `jsonDefaults` (a LanguageServiceDefaults); its
// type declaration just doesn't say so. Narrow to only the method we call.
const { jsonDefaults } = jsonContribution as unknown as {
  jsonDefaults: { setDiagnosticsOptions(opts: { validate?: boolean }): void };
};

export type EditorTheme = "light" | "dark";

let ready = false;

function init(): void {
  if (ready) return;
  ready = true;

  // Monaco reads `self.MonacoEnvironment` to find its workers. We bundle only two: the
  // generic editor worker (backs the diff editor's diff computation and is the default for
  // any language) and the json service's worker. monaco-editor's own `editor.api.d.ts`
  // ambiently declares `globalThis.MonacoEnvironment`, so this assigns straight to the real
  // global — no cast needed.
  globalThis.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      return label === "json" ? new JsonWorker() : new EditorWorker();
    },
  };

  // Read-only viewer: never lint. The three dropped services (ts/css/html) can't draw
  // squiggles because they aren't bundled; only JSON's service remains, so turn its
  // validation off so it never marks unresolved-schema / trailing-comma "errors".
  jsonDefaults.setDiagnosticsOptions({ validate: false });

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
