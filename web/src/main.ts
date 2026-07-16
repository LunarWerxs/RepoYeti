import { createApp } from "vue";
import { createPinia } from "pinia";
import { autoAnimatePlugin } from "@formkit/auto-animate/vue";
import App from "./App.vue";
import { i18n } from "./i18n";
import { applyWindowSizeHint } from "./lib/window-size-hint";
import "./style.css";
import "vue-sonner/style.css";

// Recover from stale-chunk errors. When the daemon ships a new build, its hashed chunk
// names change; a tab still running the old build then lazy-imports a chunk that no longer
// exists on disk and the import rejects (Vite fires `vite:preloadError`). Reload once to
// pull the fresh build instead of showing a dead editor. A short timestamp guard prevents a
// reload loop if the new build is genuinely broken (chunk truly missing).
//
// Before reloading, nudge the service worker to check for the new build (registration
// .update() fetches the fresh sw.js). Without this, the reload could resurrect the same
// stale shell from the old SW's precache and 404 on the same chunk again — the second half
// of the "Monaco fails even after a reload" bug (the first half was the non-atomic dist
// swap, fixed by scripts/swap-dist.mjs).
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "repoyeti:last-chunk-reload";
  const now = Date.now();
  if (now - Number(sessionStorage.getItem(KEY) ?? 0) < 10_000) {
    // Already reloaded moments ago and it still failed — the build itself is broken, not
    // just stale. Stop reloading; let the async-component error UI show and log for triage.
    console.error("[repoyeti] chunk failed to load again right after a reload", event);
    return;
  }
  sessionStorage.setItem(KEY, String(now));
  event.preventDefault();
  const swUpdate =
    navigator.serviceWorker
      ?.getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.update())))
      .catch(() => undefined) ?? Promise.resolve();
  // Cap the SW check so a hung update can never stall recovery.
  void Promise.race([swUpdate, new Promise((r) => setTimeout(r, 1500))]).finally(() =>
    window.location.reload(),
  );
});

// A portable (--app) window forwarded into an already-running Chromium instance ignores
// --window-size and the saved placement; the daemon/tray tag its URL with the size it should
// be and we correct it here before first paint. No-op in a browser tab or on an un-hinted URL.
applyWindowSizeHint();

createApp(App).use(createPinia()).use(autoAnimatePlugin).use(i18n).mount("#app");
