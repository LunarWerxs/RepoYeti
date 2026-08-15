import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The daemon serves the built app from `web/dist` at its own origin, so the PWA
// talks to /api and /oauth on the same host (no CORS). In dev, Vite proxies them
// to the daemon — at whatever port it ACTUALLY bound (it hops past a busy 7171 and
// records the real port in ~/.repoyeti/runtime.json), falling back to :7171. Start
// the daemon before `bun run --cwd web dev` so the pointer exists when Vite reads it.
function daemonTarget(): string {
  try {
    const home = process.env.REPOYETI_HOME ?? join(homedir(), ".repoyeti");
    const info = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")) as { url?: string };
    if (info?.url) return info.url;
  } catch {
    /* daemon not up yet — fall back to the default port */
  }
  return "http://127.0.0.1:7171";
}
const DAEMON = daemonTarget();

// Give every code-viewer chunk a stable directory, including Monaco's many dynamically imported
// language grammars. Workbox globs cannot infer that `abap-<hash>.js`, `yaml-<hash>.js`, etc. are
// lazy Monaco payloads from their filenames alone; a directory marker lets the service-worker
// install exclude the whole dependency graph without maintaining an ever-drifting language list.
function isLazyMonacoChunk(moduleIds: readonly string[]): boolean {
  return moduleIds.some((rawId) => {
    const id = rawId.replaceAll("\\", "/");
    return (
      id.includes("/monaco-editor/") ||
      id.endsWith("/src/lib/monaco-setup.ts") ||
      /\/src\/components\/Monaco(?:Diff)?Viewer\.vue(?:\?|$)/.test(id)
    );
  });
}

/**
 * Drop the kit's Google Fonts `@import` from this app's CSS, because we serve Inter ourselves.
 *
 * styles/kit-base.css opens with `@import url('https://fonts.googleapis.com/css2?family=Inter...')`.
 * A remote @import at the head of a render-blocking stylesheet blocks first paint on a round trip
 * to fonts.googleapis.com: pure dead time for a local desktop app, and an outright stall with no
 * network. The app's entry stylesheet declares the same typeface from public/fonts/ instead; this
 * removes the remote one so the two don't both load.
 *
 * Done here rather than by editing kit-base.css because that file is VENDORED FROM THE SHARED KIT
 * (lunarwerx-ui) and its `--check` fails on any byte of drift. Stripping at build time keeps the
 * checked-in copy identical to the kit while this app opts out of the behaviour.
 */
function stripRemoteFontImport(): Plugin {
  // Both spellings: `@import url('https://...');` as authored in the kit, and the bare
  // `@import"https://...";` Tailwind re-serialises it to.
  //
  // The URL body is matched up to its QUOTE or CLOSING PAREN, never up to a semicolon: the Google
  // Fonts URL contains semicolons of its own (`wght@400;500;600;700`). Matching to `;` cuts the
  // at-rule in half and leaves garbage at the head of the stylesheet, which makes the browser fail
  // to parse the whole file and drops the entire UI to unstyled Times New Roman. Keep these
  // terminators as they are.
  const REMOTE_FONT_IMPORT = new RegExp(
    [
      // @import url("https://fonts.googleapis.com/…") ;   (quoted inside url())
      String.raw`@import\s*url\(\s*(['"])https:\/\/fonts\.googleapis\.com[^'"]*\1\s*\)\s*;`,
      // @import url(https://fonts.googleapis.com/…) ;     (bare inside url())
      String.raw`@import\s*url\(\s*https:\/\/fonts\.googleapis\.com[^)]*\)\s*;`,
      // @import "https://fonts.googleapis.com/…" ;        (no url(), what Tailwind emits)
      String.raw`@import\s*(['"])https:\/\/fonts\.googleapis\.com[^'"]*\2\s*;`,
    ].join("|"),
    "g",
  );
  const strip = (css: string) => css.replace(REMOTE_FONT_IMPORT, "");
  return {
    name: "strip-remote-font-import",
    enforce: "post",
    transform(code, id) {
      if (!id.endsWith(".css") || !code.includes("fonts.googleapis.com")) return null;
      return { code: strip(code), map: null };
    },
    // The hook that actually does the work: @tailwindcss/vite assembles the final stylesheet
    // outside the transform pipeline above, so the `post` transform never sees it. Whatever
    // produced the CSS, the file the daemon serves must not carry a remote font import.
    //
    // Caveat, deliberate: this runs AFTER Rollup hashes the asset filename, so the hash describes
    // the pre-strip content. Harmless in practice (the strip is deterministic), but editing THIS
    // PLUGIN without touching any CSS reuses the old filename. Hard-reload when iterating here.
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        const css =
          typeof file.source === "string" ? file.source : Buffer.from(file.source).toString("utf8");
        if (!css.includes("fonts.googleapis.com")) continue;
        const next = strip(css);
        if (next.includes("fonts.googleapis.com"))
          this.warn(`${file.fileName} still references fonts.googleapis.com; check the pattern.`);
        file.source = next;
      }
    },
  };
}

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    stripRemoteFontImport(), vue(),
    tailwindcss(),
    // File-type glyphs for the changes tree (vscode-icons set), inlined at build time
    // and tree-shaken to only the icons imported in @/lib/file-icons. No runtime fetch.
    Icons({ compiler: "vue3", autoInstall: false }),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icon-light.svg", "icon-dark.svg", "logo-light.svg", "logo-dark.svg"],
      manifest: {
        name: "RepoYeti",
        short_name: "RepoYeti",
        description: "System-wide remote git manager",
        theme_color: "#0e0e12",
        background_color: "#0e0e12",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        // Standalone medallion (a disc, not a full-bleed tile), so only "any" — no maskable
        // variant, which would expect art that fills the icon's safe zone edge to edge.
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        // Apply a new build immediately instead of waiting for every tab to close: the fresh SW
        // activates + claims open clients right away (paired with registerType:"autoUpdate", which
        // reloads on update). Without these, a rebuild would keep serving the stale cached app.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // NO precached shell, NO navigate fallback: navigations always hit the daemon, which
        // serves index.html with no-cache. The old behavior (navigateFallback to a PRECACHED
        // index.html) meant a tab that survived a rebuild kept reloading into the stale shell —
        // whose Monaco chunk names are excluded from the precache (below) and no longer exist
        // on disk — so even the vite:preloadError recovery reload 404'd until the new SW
        // finished installing. This is a localhost daemon app: if the daemon is down a cached
        // shell is useless anyway (every /api call fails), so offline navigation buys nothing.
        navigateFallback: null,
        // The Monaco code viewer is lazy-loaded (its language-service workers run several
        // MB); keep those heavy chunks out of the install-time precache and let them load
        // on demand the first time a file is opened.
        // The build puts the complete graph under assets/lazy-monaco/ (see chunkFileNames).
        // Keep the older filename guards as defense in depth for worker/CSS assets whose names
        // are chosen by Vite's worker/CSS pipelines rather than the normal chunk callback.
        // index.html is excluded to pair with navigateFallback:null above (fresh shell, always).
        globIgnores: [
          "**/lazy-monaco/**",
          "**/editor.worker-*.js",
          "**/json.worker-*.js",
          "**/monaco-setup-*",
          "**/Monaco*",
          "**/editor.api2-*.js",
          "**/jsonMode-*",
          "**/index.html",
        ],
        runtimeCaching: [
          { urlPattern: /\/api\//, handler: "NetworkOnly" },
          { urlPattern: /\/oauth\//, handler: "NetworkOnly" },
          // Cold-start recovery after a Quick Tunnel rotation (issue #21). An installed PWA is
          // pinned to the origin it was installed from, and that origin is gone after the daemon
          // restarts onto a fresh tunnel hostname; the navigation then fails at the network and
          // no application JavaScript ever runs, so relay-home.ts's self-heal — which assumes it
          // has "a place to run at all" — never gets one. The app opened onto a dead URL and the
          // only way out was reinstalling it.
          //
          // NetworkOnly + precacheFallback, NOT navigateFallback, and that distinction is the
          // whole point: navigateFallback answers EVERY navigation from the precache, which is
          // what previously left a rebuilt tab reloading into a stale shell whose Monaco chunks
          // no longer existed. This serves the fallback only when the network actually failed, so
          // a healthy origin is untouched. The fallback is a standalone page referencing no
          // hashed assets, so it cannot go stale the way index.html did.
          {
            urlPattern: ({ request }: { request: Request }) => request.mode === "navigate",
            handler: "NetworkOnly",
            options: { precacheFallback: { fallbackURL: "/offline-heal.html" } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // The Monaco code-viewer chunk is legitimately multi-MB (language services); raise the
  // "chunk too large" warning ceiling so a normal build isn't noisy, while still flagging a
  // real regression. Monaco stays lazy-loaded + out of the PWA precache (see workbox above).
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    // @vueuse/core ships /* #__PURE__ */ comments in positions rolldown can't bind to a call
    // expression (e.g. before an object literal); it flags them as INVALID_ANNOTATION even
    // though the annotation is inert there. Silence that one benign check to keep builds quiet.
    rollupOptions: {
      checks: { invalidAnnotation: false },
      output: {
        chunkFileNames(chunkInfo) {
          return isLazyMonacoChunk(chunkInfo.moduleIds)
            ? "assets/lazy-monaco/[name]-[hash].js"
            : "assets/[name]-[hash].js";
        },
      },
    },
  },
  server: {
    port: 4319,
    proxy: {
      "/api": DAEMON,
      "/oauth": DAEMON,
    },
  },
});
