import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
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
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    vue(),
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
        navigateFallback: "index.html",
        // Never let the service worker cache live data or the auth dance.
        navigateFallbackDenylist: [/^\/api\//, /^\/oauth\//, /^\/assets\//],
        // The Monaco code viewer is lazy-loaded (its language-service workers run several
        // MB); keep those heavy chunks out of the install-time precache and let them load
        // on demand the first time a file is opened. The core app shell still precaches.
        // NB: glob the viewer component chunks (Monaco*.js) and monaco-setup.{js,css} too —
        // an earlier "monaco-setup-*.js"-only pattern silently let the viewer chunks precache.
        // vite 8's rolldown-vite bundler emits the Monaco core under "editor.api2-*.js" instead
        // of bundling it into monaco-setup — exclude that chunk too so it stays out of precache.
        globIgnores: ["**/*.worker-*.js", "**/monaco-setup-*", "**/Monaco*.js", "**/editor.api2-*.js"],
        runtimeCaching: [
          { urlPattern: /\/api\//, handler: "NetworkOnly" },
          { urlPattern: /\/oauth\//, handler: "NetworkOnly" },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // The Monaco code-viewer chunk is legitimately multi-MB (language services); raise the
  // "chunk too large" warning ceiling so a normal build isn't noisy, while still flagging a
  // real regression. Monaco stays lazy-loaded + out of the PWA precache (see workbox above).
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    port: 4319,
    proxy: {
      "/api": DAEMON,
      "/oauth": DAEMON,
    },
  },
});
