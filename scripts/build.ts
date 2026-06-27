#!/usr/bin/env bun
/**
 * Build a distributable GitMob bundle into `dist/`:
 *   dist/gitmob[.exe]   — the compiled daemon (bun --compile)
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
const outBin = join(DIST, isWin ? "gitmob.exe" : "gitmob");

console.log("→ clean dist/");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log("→ build web (vite)");
await $`bun run --cwd ${join(ROOT, "web")} build:fast`;

console.log("→ compile daemon (bun --compile)");
await $`bun build --compile --minify ${join(ROOT, "src", "index.ts")} --outfile ${outBin}`;

console.log("→ copy web assets next to the binary");
mkdirSync(join(DIST, "web"), { recursive: true });
cpSync(join(ROOT, "web", "dist"), join(DIST, "web", "dist"), { recursive: true });

const vendor = join(ROOT, "vendor", "cloudflared");
if (existsSync(vendor)) {
  console.log("→ copy bundled cloudflared");
  cpSync(vendor, join(DIST, "vendor", "cloudflared"), { recursive: true });
}

console.log(`\n✓ Built ${outBin}`);
console.log("  Run it:  " + (isWin ? "dist\\gitmob.exe start" : "./dist/gitmob start"));
