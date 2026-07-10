#!/usr/bin/env bun
/**
 * Build a distributable RepoYeti bundle into `dist/`:
 *   dist/repoyeti[.exe]   — the compiled daemon (bun --compile)
 *   dist/web/dist/...   — the built PWA, served by the daemon at runtime
 *
 * cloudflared is expected on PATH (or bundle a pinned binary into dist/ for shipping).
 * Run: `bun run scripts/build.ts`
 */
import { $ } from "bun";
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const isWin = process.platform === "win32";
const outBin = join(DIST, isWin ? "repoyeti.exe" : "repoyeti");

console.log("→ clean dist/");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log("→ build web (vite)");
await $`bun run --cwd ${join(ROOT, "web")} build:fast`;

console.log("→ compile daemon (bun --compile)");
// The Lore SDK (@lore-vcs/sdk) is a native-FFI (koffi) binding that can't embed in the single
// binary, so it's kept EXTERNAL — the daemon `import()`s it lazily at runtime (only when a Lore
// repo is read) and falls back to the `lore` CLI when it can't load. Externalising keeps `--compile`
// from choking on the .node/.dll; the libs are bundled next to the binary below so production gets
// the SDK read path too.
await $`bun build --compile --minify --external @lore-vcs/sdk --external koffi ${join(ROOT, "src", "index.ts")} --outfile ${outBin}`;

console.log("→ copy web assets next to the binary");
mkdirSync(join(DIST, "web"), { recursive: true });
cpSync(join(ROOT, "web", "dist"), join(DIST, "web", "dist"), { recursive: true });

console.log("→ bundle the Lore SDK native libs next to the binary (SDK read path; CLI fallback if absent)");
for (const dep of ["koffi", "@lore-vcs"]) {
  const src = join(ROOT, "node_modules", dep);
  if (existsSync(src)) cpSync(src, join(DIST, "node_modules", dep), { recursive: true });
}

const vendor = join(ROOT, "vendor", "cloudflared");
if (existsSync(vendor)) {
  console.log("→ copy bundled cloudflared");
  cpSync(vendor, join(DIST, "vendor", "cloudflared"), { recursive: true });
}

console.log(`\n✓ Built ${outBin}`);
console.log(`  Run it:  ${isWin ? "dist\\repoyeti.exe start" : "./dist/repoyeti start"}`);
