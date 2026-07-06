/**
 * "Open with…" — launch a repo folder / changed file in an external desktop editor
 * (VS Code, Cursor, Windsurf, VSCodium, Zed, Sublime, Notepad++, Notepad, …) or the OS
 * file manager, so the owner can jump from the in-app Monaco viewer to their real editor
 * and browse the whole project tree.
 *
 * The editor process is spawned ON THE DAEMON'S MACHINE, so this is only ever useful — and
 * only ever allowed — for a LOCAL (loopback) request: the route gates it on isRemoteRequest.
 * A phone on the tunnel can't (and shouldn't) pop a window on the desktop.
 *
 * Untrusted-path safe: any file path is normalised + confined to the repo (reusing
 * resolveRepoPath) before it reaches a spawn argv, so a crafted `?path=` can never launch an
 * editor on a file outside the repo. The editor id is validated against a fixed catalog. On
 * Windows, an editor resolved as a `.cmd`/`.bat` shim is launched via `cmd /c`, whose re-parse
 * would expand `%…%` / strip `^` in the path AFTER confinement — so such a path is refused up
 * front (see cmdReparseHazard) to keep the confinement guarantee intact.
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { getRepo } from "../db.ts";
import { resolveRepoPath } from "./files.ts";

/** Host platforms we tailor launch/detection for. */
export type EditorPlatform = "win32" | "darwin" | "linux";

/** Static definition of one launchable editor. Cross-platform: `commands` are probed on PATH
 *  (via Bun.which, honouring PATHEXT on Windows), `winPaths`/`macApp`/`linuxPaths` are the
 *  fallbacks for GUI apps that don't put a launcher on PATH. */
interface EditorDef {
  id: string;
  label: string;
  /** Opens a FOLDER as a workspace (shows a file tree) vs a single-file editor (Notepad). */
  folder: boolean;
  /** PATH command names to probe, in order (first found wins). */
  commands?: string[];
  /** Known absolute install paths to probe on Windows (may contain %ENV% tokens). */
  winPaths?: string[];
  /** The real GUI exe basename (e.g. "Code.exe") for VS Code-style editors whose PATH launcher is
   *  a `<install>\bin\<name>.cmd` shim. When `which` finds that shim, we prefer the sibling
   *  `<install>\<winExe>` so we can spawn the exe directly and skip cmd /c's re-parse entirely. */
  winExe?: string;
  /** Known absolute install paths to probe on Linux. */
  linuxPaths?: string[];
  /** macOS .app name for the `open -a "<name>"` fallback when no CLI launcher is on PATH. */
  macApp?: string;
  /** Restrict to these platforms; omitted ⇒ offered on all three. */
  platforms?: EditorPlatform[];
}

/** The pseudo-editor id that reveals the folder in the OS file manager (always available). */
export const SYSTEM_FILE_MANAGER = "system";

/**
 * The catalogue, in PREFERENCE order — the first *available* entry becomes the auto-default
 * when the owner hasn't chosen one. VS Code family (folder-capable, shared `<cmd> <folder>
 * <file>` CLI convention) first, then single-file editors, then the OS file manager.
 */
const CATALOG: readonly EditorDef[] = [
  {
    id: "vscode",
    label: "VS Code",
    folder: true,
    commands: ["code"],
    winExe: "Code.exe",
    winPaths: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe",
      "%PROGRAMFILES%\\Microsoft VS Code\\Code.exe",
    ],
    macApp: "Visual Studio Code",
    linuxPaths: ["/usr/bin/code", "/usr/share/code/code", "/snap/bin/code"],
  },
  {
    id: "cursor",
    label: "Cursor",
    folder: true,
    commands: ["cursor"],
    winExe: "Cursor.exe",
    winPaths: ["%LOCALAPPDATA%\\Programs\\Cursor\\Cursor.exe"],
    macApp: "Cursor",
    linuxPaths: ["/usr/bin/cursor", "/opt/Cursor/cursor"],
  },
  {
    id: "windsurf",
    label: "Windsurf",
    folder: true,
    commands: ["windsurf"],
    winExe: "Windsurf.exe",
    winPaths: ["%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe"],
    macApp: "Windsurf",
    linuxPaths: ["/usr/bin/windsurf", "/opt/Windsurf/windsurf"],
  },
  {
    id: "vscodium",
    label: "VSCodium",
    folder: true,
    commands: ["codium"],
    winExe: "VSCodium.exe",
    winPaths: [
      "%LOCALAPPDATA%\\Programs\\VSCodium\\VSCodium.exe",
      "%PROGRAMFILES%\\VSCodium\\VSCodium.exe",
    ],
    macApp: "VSCodium",
    linuxPaths: ["/usr/bin/codium", "/usr/share/codium/codium"],
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    folder: true,
    commands: ["code-insiders"],
    winExe: "Code - Insiders.exe",
    winPaths: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe",
      "%PROGRAMFILES%\\Microsoft VS Code Insiders\\Code - Insiders.exe",
    ],
    macApp: "Visual Studio Code - Insiders",
    linuxPaths: ["/usr/bin/code-insiders"],
  },
  {
    id: "zed",
    label: "Zed",
    folder: true,
    commands: ["zed", "zeditor"],
    winPaths: ["%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe"],
    macApp: "Zed",
    linuxPaths: ["/usr/bin/zed", "/usr/bin/zeditor"],
  },
  {
    id: "sublime",
    label: "Sublime Text",
    folder: true,
    commands: ["subl"],
    winPaths: [
      "%PROGRAMFILES%\\Sublime Text\\sublime_text.exe",
      "%PROGRAMFILES%\\Sublime Text 3\\sublime_text.exe",
    ],
    macApp: "Sublime Text",
    linuxPaths: ["/usr/bin/subl", "/opt/sublime_text/sublime_text"],
  },
  {
    id: "notepad++",
    label: "Notepad++",
    folder: false,
    commands: ["notepad++"],
    winPaths: [
      "%PROGRAMFILES%\\Notepad++\\notepad++.exe",
      "%PROGRAMFILES(X86)%\\Notepad++\\notepad++.exe",
    ],
    platforms: ["win32"],
  },
  {
    id: "notepad",
    label: "Notepad",
    folder: false,
    commands: ["notepad"],
    winPaths: ["%WINDIR%\\System32\\notepad.exe"],
    platforms: ["win32"],
  },
];

/** A resolved way to launch an editor: a concrete exe path, or a macOS .app to `open -a`. */
type Resolution = { kind: "exe"; exe: string } | { kind: "macApp"; app: string };

/** Expand `%VAR%` tokens against the environment; returns null if a referenced var is unset. */
function expandWinPath(p: string, env: Record<string, string | undefined>): string | null {
  let missing = false;
  const out = p.replace(/%([^%]+)%/g, (_, name: string) => {
    const v = env[name] ?? env[name.toUpperCase()];
    if (v == null) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

/** True for a Windows shell shim (code.cmd / .bat) — must be run via `cmd /c`, not spawned
 *  directly (CreateProcess can't execute a non-PE script). */
function isWindowsScript(p: string): boolean {
  return /\.(cmd|bat)$/i.test(p);
}

/**
 * Resolve how to launch `def` on `platform`, or null if it isn't installed. Prefers a known
 * install path (a real .exe on Windows — so we can spawn it directly and skip a console flash),
 * then a PATH command (Bun.which), then the macOS .app fallback. Injectable `which`/`exists`/`env`
 * keep this unit-testable without touching the real machine.
 */
export function probeEditor(
  def: EditorDef,
  platform: EditorPlatform,
  deps: {
    which: (cmd: string) => string | null;
    exists: (p: string) => boolean;
    env: Record<string, string | undefined>;
  },
): Resolution | null {
  if (def.platforms && !def.platforms.includes(platform)) return null;

  // 1) Known install paths first (a real exe → direct spawn, no cmd shim).
  const knownPaths = platform === "win32" ? def.winPaths : platform === "linux" ? def.linuxPaths : undefined;
  for (const raw of knownPaths ?? []) {
    const p = platform === "win32" ? expandWinPath(raw, deps.env) : raw;
    if (p && deps.exists(p)) return { kind: "exe", exe: p };
  }

  // 2) A launcher on PATH (Bun.which resolves PATHEXT → code.cmd etc. on Windows).
  for (const cmd of def.commands ?? []) {
    const found = deps.which(cmd);
    if (!found) continue;
    // On Windows `which` usually resolves a `.cmd` shim (…\bin\code.cmd). Prefer the sibling real
    // exe (…\Code.exe) so we spawn it DIRECTLY — no cmd /c, so no %VAR%/^ re-parse of the path.
    if (platform === "win32" && def.winExe && isWindowsScript(found)) {
      const exe = resolve(dirname(found), "..", def.winExe);
      if (deps.exists(exe)) return { kind: "exe", exe };
    }
    return { kind: "exe", exe: found };
  }

  // 3) macOS: fall back to `open -a "<App>"` when the app bundle is present but no CLI is linked.
  //    /Applications is always a POSIX path — build it literally (node's path.join would emit
  //    backslashes when the daemon dev-runs on Windows).
  if (platform === "darwin" && def.macApp) {
    if (deps.exists(`/Applications/${def.macApp}.app`)) return { kind: "macApp", app: def.macApp };
  }
  return null;
}

/**
 * Editor-level arguments (the paths handed to the editor), before any platform wrapper. Returns
 * null when a single-file editor is asked to open a folder with no file (it can't). Folder-capable
 * editors get `[folder, file?]` — VS Code & friends open the folder as a workspace AND focus the
 * file, which is exactly the "see the whole file list" intent.
 */
export function buildEditorArgs(def: EditorDef, folderAbs: string, fileAbs?: string): string[] | null {
  if (def.folder) return fileAbs ? [folderAbs, fileAbs] : [folderAbs];
  if (!fileAbs) return null; // a file-only editor with nothing to open
  return [fileAbs];
}

/** Wrap the resolved editor + its args into a full spawn argv for `platform`. */
export function wrapForPlatform(
  platform: EditorPlatform,
  res: Resolution,
  editorArgs: string[],
): string[] {
  if (res.kind === "macApp") return ["open", "-a", res.app, ...editorArgs];
  // Windows shell shim (code.cmd) can't be spawned directly → run through cmd /c.
  if (platform === "win32" && isWindowsScript(res.exe)) return ["cmd", "/c", res.exe, ...editorArgs];
  return [res.exe, ...editorArgs];
}

/**
 * True when launching `exe` on `platform` would route `args` through `cmd /c` (a .cmd/.bat shim)
 * AND some arg carries a character cmd.exe re-parses destructively:
 *   · `%…%`  → cmd expands it against the environment INSIDE its own command-line parse, AFTER our
 *              repo confinement — a repo file literally named `%COMSPEC%` would reach the editor as
 *              an env-derived path OUTSIDE the repo (a confinement bypass).
 *   · `^`    → cmd's escape char, silently stripped — the editor opens a different/nonexistent path.
 * Bun.spawn's argv quoting keeps these contained (no command injection), but the *value* the editor
 * receives is wrong, so such a launch is refused up front rather than silently misbehaving. Only the
 * uncommon PATH-shim launch is affected — a real .exe install (the winPaths probe) spawns directly.
 */
export function cmdReparseHazard(platform: EditorPlatform, exe: string, args: string[]): boolean {
  return platform === "win32" && isWindowsScript(exe) && args.some((a) => /[%^]/.test(a));
}

/** Reveal a folder in the OS file manager (the `system` pseudo-editor). Always resolvable. */
export function systemRevealArgv(platform: EditorPlatform, folderAbs: string): string[] {
  if (platform === "win32") return ["explorer", folderAbs];
  if (platform === "darwin") return ["open", folderAbs];
  return ["xdg-open", folderAbs];
}

/** Platform-appropriate label for the OS file-manager pseudo-editor. */
function fileManagerLabel(platform: EditorPlatform): string {
  return platform === "win32" ? "File Explorer" : platform === "darwin" ? "Finder" : "File manager";
}

/** True when `id` names a real catalog editor or the system file-manager pseudo-editor. */
export function isKnownEditor(id: string): boolean {
  return id === SYSTEM_FILE_MANAGER || CATALOG.some((e) => e.id === id);
}

/** One editor's presence, for the picker + the "Open with" menu. */
export interface EditorInfo {
  id: string;
  label: string;
  /** Opens a folder as a workspace (informational; the file manager & Notepad differ). */
  folder: boolean;
  /** Detected as installed on this machine. */
  available: boolean;
}

/** The default `which`/`exists`/`env` bound to the real machine (Bun.which + fs + process.env). */
function realDeps(): { which: (c: string) => string | null; exists: (p: string) => boolean; env: NodeJS.ProcessEnv } {
  return { which: (c) => Bun.which(c), exists: existsSync, env: process.env };
}

/**
 * The full editor list for this host: every catalog entry with an `available` flag, plus the
 * OS file-manager entry (always available). Pure detection — spawns nothing.
 */
export function detectEditors(platform: EditorPlatform = process.platform as EditorPlatform): EditorInfo[] {
  const deps = realDeps();
  const list: EditorInfo[] = [];
  for (const def of CATALOG) {
    if (def.platforms && !def.platforms.includes(platform)) continue;
    list.push({
      id: def.id,
      label: def.label,
      folder: def.folder,
      available: probeEditor(def, platform, deps) !== null,
    });
  }
  list.push({ id: SYSTEM_FILE_MANAGER, label: fileManagerLabel(platform), folder: true, available: true });
  return list;
}

/**
 * The effective default editor id: the owner's choice when it's known AND currently available,
 * otherwise the first available catalog editor (preference order), otherwise the file manager.
 */
export function effectiveDefaultEditor(chosen: string | undefined, editors: EditorInfo[]): string {
  if (chosen && chosen !== SYSTEM_FILE_MANAGER) {
    const hit = editors.find((e) => e.id === chosen);
    if (hit?.available) return chosen;
  } else if (chosen === SYSTEM_FILE_MANAGER) {
    return SYSTEM_FILE_MANAGER;
  }
  const firstReal = editors.find((e) => e.id !== SYSTEM_FILE_MANAGER && e.available);
  return firstReal?.id ?? SYSTEM_FILE_MANAGER;
}

/** Result of an "Open with" launch. */
export interface OpenResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "NO_EDITOR" | "BAD_PATH";
  message?: string;
  /** The editor id actually launched (after default resolution). */
  editor?: string;
  /** The argv that was (or, in dry-run, would be) spawned — for tests/telemetry. */
  argv?: string[];
}

/**
 * Launch an editor on a repo (and optionally one changed file within it). `editorId` omitted /
 * empty ⇒ the effective default is used. The file path is confined to the repo before it reaches
 * an argv. Set `REPOYETI_EDITOR_DRYRUN=1` (or pass `dryRun`) to resolve the argv WITHOUT spawning
 * — used by the tests so they never pop a real window.
 */
export async function openInEditor(
  repoId: string,
  editorId: string | undefined,
  relPath: string | undefined,
  opts: { defaultEditor?: string; dryRun?: boolean; platform?: EditorPlatform } = {},
): Promise<OpenResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };

  const platform = opts.platform ?? (process.platform as EditorPlatform);
  const folderAbs = resolve(repo.absPath);

  // Confine the optional file path to the repo (blocks `../` escapes). A path that no longer
  // exists on disk (a just-deleted file) degrades to opening the folder only.
  let fileAbs: string | undefined;
  if (relPath && relPath.trim()) {
    const r = resolveRepoPath(repo.absPath, relPath);
    if ("error" in r) return { ok: false, code: "BAD_PATH", message: r.error };
    if (existsSync(r.abs)) fileAbs = r.abs;
  }

  // Resolve which editor to launch (explicit choice → owner default → first available).
  const editors = detectEditors(platform);
  const wanted = editorId && editorId.trim() ? editorId : effectiveDefaultEditor(opts.defaultEditor, editors);
  if (!isKnownEditor(wanted)) return { ok: false, code: "NO_EDITOR", message: `unknown editor: ${wanted}` };

  let argv: string[];
  if (wanted === SYSTEM_FILE_MANAGER) {
    argv = systemRevealArgv(platform, folderAbs);
  } else {
    const def = CATALOG.find((e) => e.id === wanted)!;
    const res = probeEditor(def, platform, realDeps());
    if (!res) return { ok: false, code: "NO_EDITOR", message: `${def.label} isn't installed`, editor: wanted };
    const editorArgs = buildEditorArgs(def, folderAbs, fileAbs);
    if (!editorArgs) return { ok: false, code: "BAD_PATH", message: `${def.label} can't open a folder`, editor: wanted };
    // Refuse a path cmd.exe would re-parse when this editor is launched via a .cmd/.bat shim —
    // see cmdReparseHazard (a `%…%` in the path is a confinement bypass; a `^` corrupts it).
    if (res.kind === "exe" && cmdReparseHazard(platform, res.exe, editorArgs)) {
      return {
        ok: false,
        code: "BAD_PATH",
        message: "the file path contains a character (% or ^) this editor's Windows launcher can't open safely",
        editor: wanted,
      };
    }
    argv = wrapForPlatform(platform, res, editorArgs);
  }

  if (opts.dryRun || process.env.REPOYETI_EDITOR_DRYRUN === "1") {
    return { ok: true, code: "OK", editor: wanted, argv };
  }

  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    // Don't await exit — a GUI editor runs for as long as the user keeps it open. Unref so the
    // child never keeps the daemon's event loop alive.
    proc.unref();
    return { ok: true, code: "OK", editor: wanted, argv };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e), editor: wanted };
  }
}
