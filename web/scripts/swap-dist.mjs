// Atomically publish a fresh build: vite builds into web/dist-next (see package.json
// scripts), then this swaps it into web/dist with two renames. Building straight into
// dist/ (emptyOutDir) left the directory empty/partial for the whole build while the
// daemon kept serving requests from it — any tab lazy-loading a Monaco chunk in that
// window got a 404 even after the vite:preloadError recovery reload. The rename swap
// shrinks the missing-assets window from the full build duration to milliseconds.
//
// Windows note: renames can transiently fail with EPERM/EBUSY while the daemon holds a
// file handle open mid-request (or AV scans the tree), so every rename retries briefly.
import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const next = join(webRoot, "dist-next");
const dist = join(webRoot, "dist");
const old = join(webRoot, "dist-old");

function renameWithRetry(from, to, attempts = 10) {
  for (let i = 1; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      const wait = 100 * i;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait); // sync sleep
    }
  }
}

if (!existsSync(join(next, "index.html"))) {
  console.error("[swap-dist] dist-next missing or incomplete (no index.html) — aborting, dist untouched");
  process.exit(1);
}

rmSync(old, { recursive: true, force: true });
let published = "renamed";
try {
  if (existsSync(dist)) renameWithRetry(dist, old);
  renameWithRetry(next, dist);
} catch {
  // A rename can stay blocked past the whole retry budget (an AV/indexer scan of the
  // fresh tree holds directory handles — 2026-07-10 this killed BOTH the swap and the
  // rollback, leaving no dist at all and the daemon serving 404s). Renames need
  // exclusive handles; copying doesn't. Publish by copying the fresh build into place
  // instead: if dist was already renamed away this recreates it complete, if it wasn't
  // it overlays the new files (index.html points only at the new hashed chunks).
  cpSync(next, dist, { recursive: true, force: true });
  published = "copied";
}
// Best-effort cleanup — either dir may still be pinned by a scanner; retried next build.
for (const leftover of [next, old]) {
  try {
    rmSync(leftover, { recursive: true, force: true });
  } catch {
    console.warn(`[swap-dist] could not remove ${leftover} (locked) — will retry next build`);
  }
}
console.log(`[swap-dist] web/dist updated (${published})`);
