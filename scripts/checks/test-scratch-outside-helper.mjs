// Guardrail against a test that creates a directory under the REAL OS temp dir.
//
// This is not a style rule, and it is not hypothetical. The suite was migrated to
// tests/helpers/scratch.ts precisely so no test would write to os.tmpdir() — but the migration was
// never finished, and 16 files kept calling `mkdtempSync(join(tmpdir(), "gm-…"))` with no cleanup.
// Measured on a developer machine on 2026-08-17: 1,408 leaked directories and 31,774 files sitting
// in %TEMP% from two days of runs.
//
// Two separate costs, and the second is the serious one:
//   · Disk and file-count churn nothing ever reaps, because os.tmpdir() cleanup on Windows is not
//     a thing you can rely on.
//   · `%TEMP%\gm-*` repositories are the EXACT shape of the ~115 junk rows that motivated
//     src/paths.ts's isUnderTempDir guard and src/db.ts's pruneTempRepos migration. A whole-machine
//     scan that walked a custom TEMP location ingested those test fixtures as real repositories.
//     The scan bug is fixed (src/discovery.ts) and the write path is guarded (src/db.ts), but a
//     suite that keeps manufacturing the hazard is one discovery-code regression away from
//     reproducing the original incident.
//
// The rule: build scratch with tests/helpers/scratch.ts's mkScratchDir(), which roots everything
// under a per-run directory that is torn down when the run ends (and swept if the run is killed).
//
// DELIBERATELY NOT FLAGGED:
//   · tests/db-temp-guard.test.ts. Proving isUnderTempDir rejects a real temp path requires a real
//     temp path; a substitute would prove nothing. It is allowed to use tmpdir() — and it records
//     every directory it creates there and removes them in an afterAll, which is the standard the
//     rest of the suite is held to here.
//   · tests/helpers/scratch.ts, which documents the old pattern in prose.
//   · The indirect `const TEST_HOME = join(tmpdir(), …)` + `mkdirSync(TEST_HOME)` form. Following a
//     path through a variable is a dataflow problem this scan does not attempt, and the files using
//     it (api-token, auth-login, auth-oidc-verify, auth-protocol, connections-sync, sync-routes)
//     already remove their directory in an afterAll. Flagging them would be a false red, and a
//     check that cries wolf gets ignored — including when it is right.
//   · Anything inside a comment or a string literal. Both are blanked before the scan: this file's
//     own prose, and scratch.ts's, describe the very pattern being detected.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'test-scratch-outside-helper'

const ALLOWED = new Set(['tests/db-temp-guard.test.ts', 'tests/helpers/scratch.ts'])

// tests/server-lib/ is owned by lunarwerx-ui and synced byte-identically into every app, so this
// repo cannot edit those files — sync.mjs's guard rejects the commit, correctly. They are also not
// the problem: every one of them already removes its temp directory in an afterEach, and
// updater-engine.test.ts documents exactly why ("each run otherwise leaks 9 full git repos into the
// temp dir, which accumulates unbounded on a long-lived CI runner"). They cannot use mkScratchDir
// either, since the helper is RepoYeti's and the kit copy has to compile in four apps.
//
// Skipped rather than reported, deliberately: a check that fails on files the repo is forbidden to
// change is a false red, and a false red teaches people to ignore the check — including on the day
// it is right. If a kit test ever does start leaking, the fix belongs upstream in lunarwerx-ui.
const ALLOWED_PREFIXES = ['tests/server-lib/']

// The directory-creating calls. A `tmpdir()` anywhere in the argument list of one of these is the
// violation; `tmpdir()` on its own (a bare path comparison, as db-temp-guard makes) is not.
const CREATORS = /\b(mkdtempSync|mkdtemp|mkdirSync|mkdir)\s*\(/g

/** End index of a `//` line comment starting at `i` (index of the first `/`). */
function skipLineComment(src, i, n) {
  let j = i
  while (j < n && src[j] !== '\n') j++
  return j
}

/** End index of the closing `*` of a `/* ... *\/` block comment starting at `i`. */
function skipBlockComment(src, i, n) {
  let j = i + 2
  while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
  return j
}

/** End index (the closing quote, or `n` if unterminated) of a string/template literal body. */
function skipStringLiteral(src, start, n, quote) {
  let j = start
  while (j < n) {
    if (src[j] === '\\') { j += 2; continue }
    if (src[j] === quote) break
    j++
  }
  return j
}

/** Blank comments and string/template literals, preserving offsets so line numbers stay true. */
function blankNonCode(src) {
  const out = src.split('')
  let i = 0
  const n = src.length
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const j = skipLineComment(src, i, n)
      blank(i, j)
      i = j
      continue
    }
    if (c === '/' && d === '*') {
      const j = skipBlockComment(src, i, n)
      blank(i, Math.min(j + 2, n))
      i = j + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const j = skipStringLiteral(src, i + 1, n, c)
      blank(i + 1, j)
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

/** The argument list of a call whose `(` is at openIdx, by paren matching. */
function argsOf(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return text.slice(openIdx + 1, i)
    }
  }
  return ''
}

const lineAt = (text, idx) => text.slice(0, idx).split('\n').length

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (entry.endsWith('.ts')) acc.push(full)
  }
  return acc
}

export const audit = {
  id: ID,
  title: 'a test must build scratch dirs with mkScratchDir(), never under the real OS temp dir',
  category: 'custom',
  domain: 'code',
  requires: {},
  // Gating: the cost is paid slowly and invisibly on developer machines, and the failure mode it
  // guards against once put junk rows in the owner's live database.
  gating: true,
  async run(ctx) {
    const root = ctx?.root ?? process.cwd()
    const testsDir = join(root, 'tests')
    const findings = []

    let files = []
    try {
      files = walk(testsDir)
    } catch {
      return { failed: false, findings, report: 'No tests/ directory; nothing to check.' }
    }

    for (const file of files) {
      const rel = relative(root, file).split('\\').join('/')
      if (ALLOWED.has(rel)) continue
      if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue

      const text = blankNonCode(readFileSync(file, 'utf8'))
      CREATORS.lastIndex = 0
      let m
      while ((m = CREATORS.exec(text)) !== null) {
        const open = m.index + m[0].length - 1
        if (!/\btmpdir\s*\(\s*\)/.test(argsOf(text, open))) continue
        findings.push({
          id: ID,
          file: rel,
          line: lineAt(text, m.index),
          severity: 'error',
          message:
            `${m[1]}() builds a directory under the real OS temp dir. Nothing reaps it: two days ` +
            'of runs left 1,408 directories and 31,774 files in %TEMP% on 2026-08-17, and ' +
            '`%TEMP%\\gm-*` repos are the exact shape of the ~115 junk rows that isUnderTempDir ' +
            '(src/paths.ts) and pruneTempRepos (src/db.ts) were added to clean up.',
          fix:
            'Use mkScratchDir("prefix-") from tests/helpers/scratch.ts. It roots the directory ' +
            'under a per-run scratch root that is removed when the run ends, and swept on a later ' +
            'run if this one is killed. If the test genuinely needs a REAL temp path (only ' +
            'tests/db-temp-guard.test.ts does, to prove the guard fires), record every directory ' +
            'you create and remove them in an afterAll, and add the file to ALLOWED here.',
        })
      }
    }

    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} test scratch dir(s) under the real OS temp dir:\n${findings
          .map((f) => `- ${f.file}:${f.line}`)
          .join('\n')}`
      : 'Every test builds scratch directories through mkScratchDir(). ✓'

    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation. During an arkitect
// run the module is only IMPORTED, so this block is inert there; it fires only on direct invocation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
