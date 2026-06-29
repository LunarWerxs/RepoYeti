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
      includeAssets: ["icon.svg"],
      manifest: {
        name: "RepoYeti",
        short_name: "RepoYeti",
        description: "System-wide remote git manager",
        theme_color: "#0e0e12",
        background_color: "#0e0e12",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        // Never let the service worker cache live data or the auth dance.
        navigateFallbackDenylist: [/^\/api\//, /^\/oauth\//, /^\/assets\//],
        // The Monaco code viewer is lazy-loaded (its language-service workers run several
        // MB); keep those heavy chunks out of the install-time precache and let them load
        // on demand the first time a file is opened. The core app shell still precaches.
        // NB: glob the viewer component chunks (Monaco*.js) and monaco-setup.{js,css} too —
        // an earlier "monaco-setup-*.js"-only pattern silently let the viewer chunks precache.
        globIgnores: ["**/*.worker-*.js", "**/monaco-setup-*", "**/Monaco*.js"],
        runtimeCaching: [
          { urlPattern: /\/api\//, handler: "NetworkOnly" },
          { urlPattern: /\/oauth\//, handler: "NetworkOnly" },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 4319,
    proxy: {
      "/api": DAEMON,
      "/oauth": DAEMON,
    },
  },
});
