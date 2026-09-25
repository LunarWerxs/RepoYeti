import { relative, isAbsolute, resolve, sep } from "node:path";
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

/**
 * True when a repo-relative path names, or reaches into, a VCS metadata directory (`.git` /
 * `.lore`) — the "never touch the repo's own bookkeeping" guard.
 *
 * **Case-insensitive, deliberately, on every platform.** NTFS (and APFS by default) resolve
 * `.GIT` to the same directory as `.git`, so a case-sensitive comparison is not a stricter
 * check — it is a hole. It was one: `deleteFile(repo, ".GIT", { recursive: true })` slipped past
 * the marker guard, then past `findNestedRepo` (which only inspects `.git`'s *children*, never
 * `.git` itself), and reached an unconditional `rmSync(abs, { recursive, force })` — deleting the
 * entire repository history, unrecoverably. Matching case-insensitively everywhere also keeps the
 * guard's behavior identical across platforms, which is worth more than honoring the one case-
 * sensitive filesystem where `.GIT` really would be a different (and still deeply suspicious)
 * directory.
 *
 * `clean` must already be normalized (see `normalizeRelPath`): forward slashes, no leading or
 * trailing separator.
 */
export function pathTouchesVcsMarker(clean: string, marker: string): boolean {
  const needle = marker.toLowerCase();
  return clean.split("/").some((segment) => segment.toLowerCase() === needle);
}

// An 8.3 short name: up to six base characters, `~N`, and an optional extension of up to three.
// `GIT~1` is the short name NTFS gives `.git`, `PROGRA~1` the one it gives `Program Files`.
const SHORT_NAME_SEGMENT = /^[^.\s]{1,6}~\d{1,6}(\.[^.\s]{0,3})?$/;

/**
 * Why a repo-relative path is a Windows ALIAS for some other file, or null when it is not.
 *
 * Every guard in this module compares the path as spelled (`pathTouchesVcsMarker`) or after
 * `resolve()`/`realpath()`, and on Windows three spellings slip past both while naming a file the
 * guard never saw: an 8.3 short name (`GIT~1/config` is `.git/config`), an NTFS alternate data
 * stream (`notes.txt:hidden` writes a stream no diff, status or editor shows; a relative path has
 * no drive letter, so any `:` is one), and a segment ending in a dot or space (Win32 strips it, so
 * `.git./config` is `.git/config`). None of them is a spelling a real file in a repo needs.
 *
 * The idea is vite's `isFileLoadingAllowed` (vitejs/vite, MIT); written fresh for RepoYeti.
 * `platform` is a parameter only so the tests can exercise the win32 rules on any host; the
 * checks are no-ops elsewhere, where `~1`, `:` and a trailing dot are just characters.
 * `clean` must already be normalized (see `normalizeRelPath`).
 */
export function windowsPathAlias(clean: string, platform: string = process.platform): string | null {
  if (platform !== "win32") return null;
  if (clean.includes(":")) return "alternate data streams and drive-qualified paths are not allowed";
  for (const segment of clean.split("/")) {
    if (SHORT_NAME_SEGMENT.test(segment)) return "Windows short (8.3) names are not allowed; use the full name";
    if (segment !== "." && segment !== ".." && /[.\s]$/.test(segment)) {
      return "a path segment may not end in a dot or a space";
    }
  }
  return null;
}

// Secret-shaped file names, matched on the last segment only (a Python venv called `.env/` is a
// folder of ordinary files). `.env.example` and friends are the shareable template, not the secret.
const SECRET_FILE_NAMES = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i,
  /^\.(netrc|git-credentials)$/i,
];
const SECRET_TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;

/**
 * True when a repo-relative path names a file that holds secrets by convention: `.env` files,
 * private keys (`.pem`, `.key`, `.p12`, `.pfx`, `id_rsa`), credential stores. The deny list vite
 * applies before its allow-list of roots; here the route layer refuses such a file over remote access
 * (routes/files.ts), because a tunnel session is the one place it would leave the machine.
 */
export function isSecretFileName(clean: string): boolean {
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  if (SECRET_TEMPLATE.test(base)) return false;
  return SECRET_FILE_NAMES.some((re) => re.test(base));
}

/**
 * The confinement check for a path AFTER symlinks are resolved: inside the real repo root, and not
 * inside its `.git` or `.lore`.
 *
 * Every raw-filesystem read, write, move and delete resolved its target with realpath and checked
 * `pathWithin(realRoot, real)`, while the metadata guard (`pathTouchesVcsMarker`) ran on the path as
 * SPELLED. A committed directory link that points INTO the metadata (`meta -> .git`) passes both:
 * `meta/config` spells no `.git` segment, and `.git` is inside the repo. So a share guest's view
 * link could read `.git/config` (remote URLs with embedded credentials), and a write through
 * `meta/hooks/pre-commit` would plant a hook the daemon's next git command runs. Checking the
 * RESOLVED path's segments closes both. `realRoot` and `real` must both come from realpathSync.
 */
export function realPathConfined(realRoot: string, real: string): boolean {
  if (!pathWithin(realRoot, real)) return false;
  const rel = relative(realRoot, real).split(sep).join("/");
  return !pathTouchesVcsMarker(rel, ".git") && !pathTouchesVcsMarker(rel, ".lore");
}
