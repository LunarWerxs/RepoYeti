#!/usr/bin/env node
/**
 * i18n compliance check for the RepoYeti web UI.
 *
 * Fails (exit 1) on any of:
 *   1. MISSING KEY     — a t()/$t('x') reference in source with no entry in en.json.
 *   2. LOCALE PARITY   — a non-English locale missing keys (or carrying extra keys) vs en.json.
 *   3. HARDCODED STRING — user-facing prose in a template (text node or placeholder/title/
 *                         aria-label/alt attribute) or a toast() literal that isn't run through t().
 * Warns (does not fail) on UNUSED keys present in en.json but never referenced.
 *
 * Templates are parsed with @vue/compiler-sfc (real AST), not regex, so the hardcoded-string
 * scan is accurate. Run: `bun run i18n:check` (from web/).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(WEB, "src");
const LOCALES = join(SRC, "locales");
const EN = join(LOCALES, "en.json");
// Vendored shadcn / LunarWerx-kit primitives (src/components/ui) are library code,
// not app copy — their sr-only "Close" labels etc. are intentionally hardcoded and
// synced from the kit, so they're exempt from the hardcoded-prose scan.
const UI = join(SRC, "components", "ui");
// The shared LunarWerx sidebar/shell (src/shell) is synced kit code too.
const SHELL = join(SRC, "shell");

// Static prose attributes that should be translated when set to a literal.
const PROSE_ATTRS = new Set(["placeholder", "title", "aria-label", "alt", "aria-description"]);
// Elements whose text content is never UI prose.
const SKIP_TEXT_TAGS = new Set(["code", "pre", "style", "script"]);
// Literal text that is allowed to stay hardcoded (brand/символы/technical, non-translatable).
const TEXT_ALLOWLIST = new Set(["RepoYeti", "·", "—", "/"]);

const errors = [];
const warnings = [];
const rel = (p) => relative(WEB, p).replace(/\\/g, "/");

// ── load + flatten en.json ────────────────────────────────────────────────────
const flatten = (obj, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};
const enKeys = new Set(Object.keys(flatten(JSON.parse(readFileSync(EN, "utf8")))));

// ── walk source files ───────────────────────────────────────────────────────────
const walkDir = (dir, files = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === "node_modules" || p === LOCALES || p === UI || p === SHELL) continue;
      walkDir(p, files);
    } else if ([".vue", ".ts"].includes(extname(p))) {
      files.push(p);
    }
  }
  return files;
};
const sourceFiles = walkDir(SRC);

// ── 1. collect t()/$t() key references (negative lookbehind avoids matching `.at(`, `format(`) ──
const referenced = new Set();
const KEY_RE = /(?<![\w$])\$?t\(\s*(['"`])([\w.]+)\1/g;
for (const file of sourceFiles) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(KEY_RE)) {
    const key = m[2];
    referenced.add(key);
    if (!enKeys.has(key)) errors.push(`MISSING KEY   ${rel(file)} → t('${key}') has no entry in en.json`);
  }
}

// ── 2. hardcoded-string scan (templates via AST + toast literals) ─────────────────
const hasLetter = (s) => /\p{L}/u.test(s);
const flagText = (raw, file, line) => {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || !hasLetter(text) || TEXT_ALLOWLIST.has(text)) return;
  errors.push(`HARDCODED     ${rel(file)}:${line} → template text "${text.slice(0, 60)}"`);
};
// A string literal "looks like prose" if it has whitespace or ends with sentence
// punctuation — used to flag display text hidden inside an interpolation expression
// (e.g. `{{ ok ? 'Saved' : '' }}`) while ignoring identifier-ish keys.
const looksLikeProse = (s) => hasLetter(s) && (/\s/.test(s) || /[.…!?:]$/.test(s));
const flagExprLiterals = (expr, file, line) => {
  for (const m of expr.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    const lit = m[2];
    if (lit.includes("${")) continue; // composed code, not static prose
    if (looksLikeProse(lit) && !TEXT_ALLOWLIST.has(lit.trim())) {
      warnings.push(`IN-EXPR       ${rel(file)}:${line} → prose literal in expression "${lit.slice(0, 50)}" — verify it isn't UI copy`);
    }
  }
};
const walkNode = (node, file, parentTag) => {
  if (!node) return;
  switch (node.type) {
    case 2: // TEXT
      if (!SKIP_TEXT_TAGS.has(parentTag)) flagText(node.content, file, node.loc?.start?.line ?? 0);
      return;
    case 5: // INTERPOLATION — {{ expr }}
      flagExprLiterals(node.content?.content ?? "", file, node.loc?.start?.line ?? 0);
      return;
    case 1: // ELEMENT
      for (const prop of node.props || []) {
        if (prop.type === 6 && PROSE_ATTRS.has(prop.name)) {
          const v = prop.value?.content ?? "";
          if (hasLetter(v) && !TEXT_ALLOWLIST.has(v.trim())) {
            errors.push(`HARDCODED     ${rel(file)}:${prop.loc?.start?.line ?? 0} → ${prop.name}="${v}"`);
          }
        }
      }
      for (const c of node.children || []) walkNode(c, file, node.tag);
      return;
    case 9: // IF
      for (const b of node.branches || []) for (const c of b.children || []) walkNode(c, file, parentTag);
      return;
    default: // ROOT / FOR / IF_BRANCH / etc.
      for (const c of node.children || []) walkNode(c, file, parentTag);
  }
};
const TOAST_RE = /toast\.(?:success|error|info|warning|message)\(\s*(['"`])((?:(?!\1).)*?\p{L}{2,}(?:(?!\1).)*?)\1/gu;
for (const file of sourceFiles) {
  const src = readFileSync(file, "utf8");
  if (extname(file) === ".vue") {
    const { descriptor } = parse(src, { filename: file });
    if (descriptor.template?.ast) walkNode(descriptor.template.ast, file, "template");
  }
  for (const m of src.matchAll(TOAST_RE)) {
    const lineNo = src.slice(0, m.index).split("\n").length;
    errors.push(`HARDCODED     ${rel(file)}:${lineNo} → toast literal "${m[2].slice(0, 50)}"`);
  }
}

// ── 3. locale parity + unused keys ────────────────────────────────────────────────
const localeFiles = readdirSync(LOCALES).filter((f) => f.endsWith(".json") && f !== "en.json");
for (const lf of localeFiles) {
  const keys = new Set(Object.keys(flatten(JSON.parse(readFileSync(join(LOCALES, lf), "utf8")))));
  for (const k of enKeys) if (!keys.has(k)) errors.push(`LOCALE PARITY ${lf} is missing key '${k}'`);
  for (const k of keys) if (!enKeys.has(k)) errors.push(`LOCALE PARITY ${lf} has extra key '${k}' (not in en.json)`);
}
for (const k of enKeys) if (!referenced.has(k)) warnings.push(`UNUSED KEY    en.json '${k}' is never referenced`);

// ── report ────────────────────────────────────────────────────────────────────
const locales = ["en", ...localeFiles.map((f) => basename(f, ".json"))];
console.log(
  `i18n-check · ${sourceFiles.length} source files · ${enKeys.size} keys · ${referenced.size} referenced · locales: ${locales.join(", ")}`,
);
for (const w of warnings) console.log(`  ⚠ ${w}`);
if (errors.length === 0) {
  console.log(`\n✓ i18n compliant (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`);
  process.exit(0);
}
console.error(`\n✗ ${errors.length} i18n problem${errors.length === 1 ? "" : "s"}:`);
for (const e of errors) console.error(`  ${e}`);
process.exit(1);
