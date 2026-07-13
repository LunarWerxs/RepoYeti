import { relative, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * True when `p` is `root` itself or sits inside it — the canonical path-confinement check that
 * blocks `../` escapes. Used for BOTH scan-root membership (clone/discovery) and the file-viewer/
 * editor path-safety guards. One definition so a fix (e.g. a Windows drive-letter edge case)
 * lands in every caller at once.
 */
export function pathWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Case-insensitive `pathWithin` for win32 (Windows paths vary in case; "C:\Temp" and "c:\temp"
 * name the same root), and a plain case-sensitive `pathWithin` everywhere else. Segment-boundary
 * aware via `relative()` (same as `pathWithin`), so "C:\Temperature\repo" is never mistaken for
 * being inside "C:\Temp": relative("C:\Temp", "C:\Temperature\repo") does NOT start with "..",
 * but it also isn't "" and its first segment differs, so `relative` naturally returns something
 * like "..\Temperature\repo": the ".." prefix check is exactly what rejects the false match.
 */
function pathWithinCaseAware(root: string, p: string): boolean {
  if (process.platform === "win32") {
    return pathWithin(root.toLowerCase(), p.toLowerCase());
  }
  return pathWithin(root, p);
}

/**
 * The OS temp roots this machine/process currently recognizes: `os.tmpdir()` plus any of
 * `TEMP` / `TMP` / `TMPDIR` that are set (Node's `os.tmpdir()` already prefers `TMPDIR` on
 * POSIX and `TEMP`/`TMP` on win32, but a caller may have one of the others set to something
 * `os.tmpdir()` doesn't pick, so all are checked explicitly too). Resolved + deduped; empty/
 * whitespace-only values are ignored.
 */
function tempRoots(): string[] {
  const candidates = [tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const c of candidates) {
    if (!c?.trim()) continue;
    const resolved = resolve(c);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  return roots;
}

/**
 * True iff the resolved absolute path `absPath` IS, or is nested inside, any recognized OS temp
 * root (see `tempRoots`). This is the hard, unbypassable "never import a temp-path repo"
 * invariant (owner directive): every import choke point (upsertRepo in src/db.ts) calls this, not
 * just the scan-time SKIP_DIRS pruning in src/discovery.ts. That pruning is an efficiency
 * optimization, not a guarantee: a manual "Point to Folder" pin or a clone destination never goes
 * through the directory walk at all.
 *
 * Boundary-aware: reuses `pathWithin`'s segment-boundary semantics (via `relative()`), so a
 * sibling directory that merely shares a string prefix with a temp root ("C:\Temperature\repo"
 * vs "C:\Temp", or "C:\Temp2" vs "C:\Temp") is never mistaken for being inside it. Case-
 * insensitive on win32 (Windows paths vary in case), case-sensitive elsewhere.
 */
export function isUnderTempDir(absPath: string): boolean {
  const resolved = resolve(absPath);
  return tempRoots().some((root) => pathWithinCaseAware(root, resolved));
}

/**
 * Canonicalize a repo-relative path: backslashes → forward slashes, trimmed, leading/trailing
 * slashes stripped. The one normalizer for every place an untrusted or cross-platform relative
 * path enters (file routes, commit plans, diff headers, untracked-file stats) so they all agree
 * on the same spelling before comparing/joining.
 */
export function normalizeRelPath(p: unknown): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}
