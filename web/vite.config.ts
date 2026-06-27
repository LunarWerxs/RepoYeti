import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

// The daemon serves the built app from `web/dist` at its own origin, so the PWA
// talks to /api and /oauth on the same host (no CORS). In dev, Vite proxies them
// to the daemon on :7171.
export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "GitMob",
        short_name: "GitMob",
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
        navigateFallbackDenylist: [/^\/api\//, /^\/oauth\//],
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
      "/api": "http://127.0.0.1:7171",
      "/oauth": "http://127.0.0.1:7171",
    },
  },
});
