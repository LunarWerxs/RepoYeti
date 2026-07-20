#!/usr/bin/env bun
/**
 * Guard against a source file silently becoming BINARY to git's tooling.
 *
 * A single NUL byte anywhere in a tracked text file makes git classify the whole file as binary.
 * `git diff` then prints "Binary files a/… and b/… differ" instead of a line diff, `git grep` skips
 * it, and ripgrep-based secret scanners (gitleaks, trufflehog, detect-secrets all default to
 * skipping binary content) never look inside it. The file still compiles, still lints, and still
 * passes every test — so nothing else in CI notices.
 *
 * This is not hypothetical: a stray NUL landed in src/gh-cli.ts — the module that handles GitHub
 * TOKENS — and survived typecheck, biome, and 777 passing tests. It was caught by a human reading
 * the diff and noticing git had stopped showing one. The file most needing review was the one
 * review could no longer see, which is exactly the failure mode worth spending a CI check on.
 *
 * Also flags a UTF-8 BOM and lone surrogates: both are invisible in most editors and both break
 * tooling in the same quiet, look-fine-locally way.
 *
 * Run: `bun run check:bytes` (wired into `bun run check`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");

/** Extensions we treat as source text. Anything else (png, ico, woff…) is legitimately binary. */
const TEXT_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "d.ts", "d.mts",
  "vue", "json", "jsonc", "md", "css", "scss", "html", "yml", "yaml",
  "toml", "sh", "ps1", "psm1", "sql", "txt", "svg",
]);

function isTextPath(p: string): boolean {
  const base = p.split("/").pop() ?? p;
  const dotted = base.split(".");
  if (dotted.length < 2) return false;
  // Prefer the two-part extension (d.mts) when present, else the last segment.
  const two = dotted.slice(-2).join(".");
  return TEXT_EXT.has(two) || TEXT_EXT.has(dotted.at(-1) ?? "");
}

/**
 * Tracked + new-but-uncommitted files, minus anything .gitignore'd — the same set a reviewer or a
 * scanner would see. Deliberately git-driven rather than a hand-maintained walk/skip-list, so a new
 * directory can't quietly fall outside the check.
 */
async function candidateFiles(): Promise<string[]> {
  const out = await $`git -C ${ROOT} ls-files --cached --others --exclude-standard`.quiet().text();
  return out.split("\n").map((l) => l.trim()).filter(Boolean).filter(isTextPath);
}

interface Problem {
  file: string;
  line: number;
  what: string;
  hint: string;
}

function inspect(rel: string): Problem[] {
  let buf: Buffer;
  try {
    buf = readFileSync(join(ROOT, rel));
  } catch {
    return []; // vanished between listing and reading (a concurrent checkout) — not our problem
  }
  const problems: Problem[] = [];

  const nul = buf.indexOf(0);
  if (nul !== -1) {
    // Report the LINE, so the message points at something a person can navigate to.
    const line = buf.subarray(0, nul).toString("utf8").split("\n").length;
    problems.push({
      file: rel,
      line,
      what: `NUL byte (0x00) at offset ${nul}`,
      hint: "git treats this whole file as BINARY: no line diff, invisible to git grep and secret scanners",
    });
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    problems.push({
      file: rel,
      line: 1,
      what: "UTF-8 BOM",
      hint: "breaks shebangs, JSON parsers, and exact-match tooling while looking fine in an editor",
    });
  }
  return problems;
}

const files = await candidateFiles();
const problems = files.flatMap(inspect);

if (problems.length) {
  console.error(`✗ ${problems.length} source file byte problem(s):`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line} — ${p.what}`);
    console.error(`      ${p.hint}`);
  }
  process.exit(1);
}
console.log(`✓ No NUL bytes or BOMs in ${files.length} source files (all stay diffable + greppable)`);
