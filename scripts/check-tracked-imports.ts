#!/usr/bin/env bun
/**
 * Guard against committing code that imports a file git does not have.
 *
 * Every other gate in this repo reads the WORKING TREE, where a newly written file is sitting on
 * disk whether or not it was ever `git add`ed. So `vue-tsc`, biome and the tests can all pass
 * locally on a commit that ships the imports but not the file they point at. That is not a
 * hypothetical: on 2026-08-27 commit c216aa3 landed `web/src/store/settings-cloud-sync.ts` and
 * `web/src/main.ts` importing `@/lib/sign-in-nudge`, and 82d75bb landed the ui barrels importing
 * `./button-variants`, while both target files stayed untracked ("Untracked files were deliberately
 * NOT added"). `main` went red, and every source install that tried to self-update pulled a tree it
 * could not build and rolled straight back (issue #24). It took three days and a human reading CI
 * to notice, because the only thing that could see it was a push away.
 *
 * This check closes that: it resolves every relative / `@/`-aliased import in the repo's TRACKED
 * source files against the set of paths git actually tracks — the index, so a file you have staged
 * counts and a file you have merely created does not. It is the same view a fresh clone gets, run
 * before the push instead of after it.
 *
 * The importing files are read from the index too, not from disk. Reading them from the working
 * tree failed every commit while someone else in the same checkout had an unstaged edit importing a
 * file they had not added yet, even a commit that touched neither file; the commit ships the staged
 * text, so that is the text to check.
 *
 * Deliberately NOT a module resolver: bare package specifiers ("vue", "node:fs", "virtual:…") are
 * skipped outright. Only paths this repo owns are checked, which is the only class of import that
 * can go missing in a commit.
 *
 * Run: `bun run check:imports` (wired into `bun run check` and .githooks/pre-commit).
 */
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");

/** Files whose imports we parse. */
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/;

/** Extensions a specifier may resolve to, tried in order against the tracked-path set. */
const CANDIDATE_EXT = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".d.mts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".json",
  ".css",
  ".scss",
  ".svg",
];

/** TS/ESM writes `./x.js` for a file that is really `./x.ts`; map the extension back. */
const REWRITE: Array<[RegExp, string[]]> = [
  [/\.js$/, [".ts", ".tsx"]],
  [/\.mjs$/, [".mts"]],
  [/\.cjs$/, [".cts"]],
];

interface Problem {
  file: string;
  line: number;
  specifier: string;
}

/** Tracked paths, i.e. the INDEX, each mapped to the blob it holds there: a staged new file counts,
 *  an unstaged one does not — which is exactly the distinction that makes this check catch what the
 *  working-tree gates cannot. `-z` keeps unusual path characters unquoted. */
async function indexEntries(): Promise<Map<string, string>> {
  const out = await $`git -C ${ROOT} ls-files -s -z`.quiet().text();
  const entries = new Map<string, string>();
  for (const record of out.split("\0")) {
    // "<mode> <blob> <stage>\t<path>"
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const blob = record.slice(0, tab).split(" ")[1];
    if (blob) entries.set(record.slice(tab + 1), blob);
  }
  return entries;
}

/** The staged text of each blob, read in one `git cat-file --batch` round trip. */
async function blobTexts(blobs: string[]): Promise<Map<string, string>> {
  const input = Buffer.from(`${[...new Set(blobs)].join("\n")}\n`);
  const out = Buffer.from(await $`git -C ${ROOT} cat-file --batch < ${input}`.quiet().arrayBuffer());
  const texts = new Map<string, string>();
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(10, at);
    if (eol === -1) break;
    // "<blob> <type> <size>\n<content>\n", or "<blob> missing\n"
    const [blob, type, size] = out.toString("utf8", at, eol).split(" ");
    at = eol + 1;
    if (!blob || type === "missing" || size === undefined) continue;
    const end = at + Number(size);
    texts.set(blob, out.toString("utf8", at, end));
    at = end + 1;
  }
  return texts;
}

/** Normalize a POSIX-ish path, resolving `.` and `..` segments. Paths here are always repo-relative
 *  and forward-slashed (git's own output format), so node's `path` would only add Windows quirks. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function dirOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i === -1 ? "" : file.slice(0, i);
}

/**
 * The repo-relative base path a specifier points at, or null if it is not ours to check.
 * `@/` maps to `web/src/` and `@daemon/` to the daemon's `src/` (both in web/tsconfig.json `paths` +
 * web/vite.config.ts `alias`); nothing outside web/ declares an alias, so an aliased import from the
 * daemon tree would be a different bug entirely and typecheck already owns it.
 */
function basePathFor(file: string, specifier: string): string | null {
  const clean = specifier.split("?")[0]?.split("#")[0] ?? "";
  if (!clean) return null;
  if (clean.startsWith("@/")) return file.startsWith("web/") ? normalize(`web/src/${clean.slice(2)}`) : null;
  // The dashboard's one crossing into the daemon tree (web/src/lib/identity-firewall.ts importing the
  // daemon's glob matcher). It still has to resolve to a TRACKED file like any other import this repo
  // owns — an alias is exactly the kind of specifier that silently stops being checked.
  if (clean.startsWith("@daemon/")) return file.startsWith("web/") ? normalize(`src/${clean.slice(8)}`) : null;
  if (clean.startsWith("./") || clean.startsWith("../")) return normalize(`${dirOf(file)}/${clean}`);
  return null; // bare package, node: builtin, virtual module, absolute URL — not this check's business
}

function resolves(base: string, tracked: Set<string>): boolean {
  for (const ext of CANDIDATE_EXT) {
    if (tracked.has(base + ext)) return true;
    if (tracked.has(`${base}/index${ext}`)) return true;
  }
  for (const [pattern, replacements] of REWRITE) {
    if (!pattern.test(base)) continue;
    for (const replacement of replacements) {
      if (tracked.has(base.replace(pattern, replacement))) return true;
    }
  }
  return false;
}

const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const SIDE_EFFECT_RE = /^\s*import\s+["']([^"']+)["']/;

/** Specifiers in `file`, with 1-based line numbers. Comment lines are skipped rather than stripped:
 *  this repo's doc comments quote old module paths (`src/ai.ts:6`, `src/git-actions/commit.ts:62`),
 *  and a gate that fails on prose is a gate people learn to bypass. */
function specifiersIn(text: string): Array<{ line: number; specifier: string }> {
  const found: Array<{ line: number; specifier: string }> = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
    for (const re of [FROM_RE, DYNAMIC_RE, REQUIRE_RE]) {
      re.lastIndex = 0;
      let match = re.exec(raw);
      while (match) {
        if (match[1]) found.push({ line: index + 1, specifier: match[1] });
        match = re.exec(raw);
      }
    }
    const sideEffect = SIDE_EFFECT_RE.exec(raw);
    if (sideEffect?.[1]) found.push({ line: index + 1, specifier: sideEffect[1] });
  }
  return found;
}

const index = await indexEntries();
const tracked = new Set(index.keys());
const sources = [...tracked].filter((p) => SOURCE_EXT.test(p));
const texts = await blobTexts(sources.map((p) => index.get(p) ?? ""));

const problems: Problem[] = [];
for (const file of sources) {
  const text = texts.get(index.get(file) ?? "");
  if (text === undefined) continue;
  for (const { line, specifier } of specifiersIn(text)) {
    const base = basePathFor(file, specifier);
    if (base === null || resolves(base, tracked)) continue;
    problems.push({ file, line, specifier });
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} import(s) point at a file git does not track:`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line} — "${p.specifier}"`);
  }
  console.error("");
  console.error("      The file exists in your working tree but was never `git add`ed, so a fresh");
  console.error("      clone — CI, or anyone's source self-update — cannot build this commit.");
  console.error("      Stage it (`git add <file>`), or drop the import.");
  process.exit(1);
}
console.log(
  `✓ ${sources.length} tracked source files: every relative/@ import resolves to a tracked file`,
);
