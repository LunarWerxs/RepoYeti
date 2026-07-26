#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { $ } from "bun";
import pkg from "../package.json";

/**
 * Build a distributable RepoYeti executable into `dist/`:
 *   dist/repoyeti[.exe] — the compiled daemon + embedded PWA
 *
 * Run: `bun run scripts/build.ts`
 */
const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const TMP = join(ROOT, "tmp", "release-build");
const isWin = process.platform === "win32";
const outBin = join(DIST, isWin ? "repoyeti.exe" : "repoyeti");

function setWindowsGuiSubsystem(path: string): void {
  const image = readFileSync(path);
  if (image.length < 256 || image[0] !== 0x4d || image[1] !== 0x5a) {
    throw new Error("compiled Windows executable has no valid MZ header");
  }
  const pe = image.readInt32LE(0x3c);
  if (pe < 0 || pe + 94 >= image.length || image.readUInt32LE(pe) !== 0x0000_4550) {
    throw new Error("compiled Windows executable has no valid PE header");
  }
  // Bun 1.3.14 leaves the PE as a console-subsystem image even with --windows-hide-console.
  // Stamping the loader-level GUI subsystem prevents a console from being created on double-click.
  image.writeUInt16LE(2, pe + 92);
  image.writeUInt32LE(0, pe + 88);
  writeFileSync(path, image);
  if (readFileSync(path).readUInt16LE(pe + 92) !== 2) {
    throw new Error("failed to stamp Windows GUI subsystem");
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

function importPath(fromFile: string, target: string): string {
  const rel = relative(dirname(fromFile), target).replaceAll("\\", "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Generate the compile-only entrypoint that embeds every Vite output as a Bun file asset. */
function writeReleaseEntrypoint(): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const entry = join(TMP, "entry.ts");
  const webRoot = join(ROOT, "web", "dist");
  const files = filesUnder(webRoot);
  const imports = files.map(
    (file, index) =>
      `import asset${index} from ${JSON.stringify(importPath(entry, file))} with { type: "file" };`,
  );
  const routes = files.map((file, index) => [
    `/${relative(webRoot, file).replaceAll("\\", "/")}`,
    `asset${index}`,
  ]);
  writeFileSync(
    entry,
    `${imports.join("\n")}

(globalThis as { __REPOYETI_EMBEDDED_WEB__?: Readonly<Record<string, string>> })
  .__REPOYETI_EMBEDDED_WEB__ = Object.freeze({
${routes.map(([route, asset]) => `  ${JSON.stringify(route)}: ${asset},`).join("\n")}
});
(globalThis as { __REPOYETI_RELEASE_BUILD__?: boolean }).__REPOYETI_RELEASE_BUILD__ = true;
await import(${JSON.stringify(importPath(entry, join(ROOT, "src", "index.ts")))});
`,
  );
  return entry;
}

console.log("→ clean dist/");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log("→ build web (vite)");
await $`bun run --cwd ${join(ROOT, "web")} build:fast`;

console.log("→ compile daemon + embedded web app (bun --compile)");
const releaseEntry = writeReleaseEntrypoint();
try {
  // The optional Lore SDK remains external because it is native FFI. A standalone release uses
  // the already-supported `lore` CLI fallback when installed; it no longer ships Koffi's source,
  // docs, and native binaries for every operating system beside a 99 MB executable.
  if (isWin) {
    await $`bun build --compile --minify --external @lore-vcs/sdk --external koffi --windows-hide-console --windows-icon=${join(ROOT, "misc", "RepoYeti.ico")} --windows-title=RepoYeti --windows-publisher=LunarWerx --windows-version=${`${pkg.version}.0`} --windows-description=${"System-wide remote Git manager"} ${releaseEntry} --outfile ${outBin}`;
  } else {
    await $`bun build --compile --minify --external @lore-vcs/sdk --external koffi ${releaseEntry} --outfile ${outBin}`;
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
if (isWin) setWindowsGuiSubsystem(outBin);

console.log(`\n✓ Built ${outBin}`);
console.log(`  Run it:  ${isWin ? "dist\\repoyeti.exe" : "./dist/repoyeti"}`);
