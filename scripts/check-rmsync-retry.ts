// Guardrail against passing maxRetries or retryDelay to rmSync.
//
// Incident (measured 2026-10-17, Windows, Bun 1.4.3): Bun's node:fs rmSync accepts maxRetries and
// retryDelay and ignores both. scripts/make-demo-workspace.ts passed { maxRetries: 4, retryDelay:
// 250 } and, with a child process still in the folder, threw EBUSY after 0 ms: one try, not five.
// Windows holds a folder for a moment after the processes in it exit, so a Bun-run cleanup that
// leans on those options passes on a quiet machine and fails under load. The fix is a real retry
// loop, tests/helpers/rm-retry.ts (rmRetry).
//
// The rule: a rmSync call must not pass maxRetries or retryDelay. Call rmRetry instead.
//
// DELIBERATELY NOT FLAGGED:
//   · Anything inside a comment or a string literal. Both are blanked before the scan, so this
//     file's prose and the test's fixtures can describe the pattern without tripping it.
//   · A plain rmSync(path, { recursive, force }). Without the ignored options it is not this bug,
//     and rmRetry itself is written that way.
//   · Other removal calls (rm, rmdir, fs.promises.rm). The incident is about rmSync only.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ID = "rmsync-retry-options";
const ROOTS = ["src", "scripts", "tests", "web/scripts", "web/test"];
const EXTENSIONS = [".ts", ".mjs", ".js"];
const IGNORED_OPTIONS = /\b(maxRetries|retryDelay)\b/;
const QUOTED_OPTION_KEY = /["'`](maxRetries|retryDelay)["'`]\s*:/;
const CALLS = /\brmSync\s*\(/g;

export interface RetryOptionFinding {
  file: string;
  line: number;
  option: string;
}

/** Blank comments and string/template literals, preserving offsets so line numbers stay true. */
function blankNonCode(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** The argument list of a call whose `(` is at openIdx, by paren matching. */
function argsOf(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return "";
}

const lineAt = (text: string, idx: number) => text.slice(0, idx).split("\n").length;

/** Every rmSync call in one file's source that passes maxRetries or retryDelay. */
export function findRetryOptions(file: string, source: string): RetryOptionFinding[] {
  const text = blankNonCode(source);
  const findings: RetryOptionFinding[] = [];
  CALLS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALLS.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const args = argsOf(text, open);
    // A quoted key is blanked along with every other string, so it is matched against the raw
    // source. The call's own offsets are the same in both, since blanking keeps every index.
    const quoted = QUOTED_OPTION_KEY.exec(argsOf(source, open));
    const option = IGNORED_OPTIONS.exec(args)?.[1] ?? quoted?.[1];
    if (!option) continue;
    findings.push({ file, line: lineAt(text, m.index), option });
  }
  return findings;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) acc.push(full);
  }
  return acc;
}

export const audit = {
  id: ID,
  title: "rmSync must not pass maxRetries or retryDelay (Bun ignores both); use rmRetry",
  category: "custom",
  domain: "code",
  requires: {},
  gating: true,
  async run(ctx?: { root?: string }) {
    const root = ctx?.root ?? process.cwd();
    const findings: Array<RetryOptionFinding & { id: string; severity: "error"; message: string; fix: string }> = [];

    for (const scanRoot of ROOTS) {
      let files: string[];
      try {
        files = walk(join(root, scanRoot));
      } catch {
        continue; // this root does not exist in the checkout
      }
      for (const file of files) {
        const rel = relative(root, file).split("\\").join("/");
        for (const hit of findRetryOptions(rel, readFileSync(file, "utf8"))) {
          findings.push({
            ...hit,
            id: ID,
            severity: "error",
            message:
              `rmSync(...) passes ${hit.option}. Bun's rmSync ignores it, so the cleanup tries once ` +
              "and throws EBUSY on Windows while a child process still holds the folder.",
            fix:
              "Call rmRetry(path) from tests/helpers/rm-retry.ts. It loops on EBUSY/EPERM/ENOTEMPTY " +
              "with Bun.sleepSync between tries, which is the retry the option was supposed to give.",
          });
        }
      }
    }

    const failed = findings.length > 0;
    const report = failed
      ? `Found ${findings.length} rmSync call(s) passing ignored retry options:\n${findings
          .map((f) => `- ${f.file}:${f.line} (${f.option})`)
          .join("\n")}`
      : "No rmSync call passes maxRetries or retryDelay. ✓";

    return { failed, findings, report };
  },
};

// Standalone CLI (bun run check:rmsyncretry). Exits 1 on any violation.
if (import.meta.main) {
  const res = await audit.run({ root: process.cwd() });
  console.log(res.report);
  if (res.failed) process.exit(1);
}
