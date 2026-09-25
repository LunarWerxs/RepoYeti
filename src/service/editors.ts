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
 * Windows every editor launch goes through a `cmd /c start ""` hand-off (the shared kit primitive
 * buildDetachedSpawn) so the editor escapes the daemon's process tree and survives a tray Quit; cmd
 * re-parses each arg and would expand `%…%` / strip `^` in the path AFTER confinement, so such a
 * path is refused up front (see cmdReparseHazard) to keep the confinement guarantee intact.
 *
 * Open at a line: a caller may pass a line (and column) so the file opens AT that spot instead of
 * the top, using each editor's own flag (GotoStyle). The position must be a positive integer before
 * it reaches an argv (parseEditorPosition), so it can never smuggle text into a launch. With no
 * explicit editor and no owner default, the editor already RUNNING on the desktop is preferred over
 * the first installed one (guessRunningEditor), because that is the window the owner is working in.
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { buildDetachedSpawn } from "../detached-spawn.mjs";
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
  /** How this editor is told to open a file AT a line:column (see GotoStyle); omitted means it
   *  has no such flag, so a requested position is dropped and the file opens at the top. */
  goto?: GotoStyle;
  /** Extra POSIX process names the running GUI shows under, when that differs from every launcher
   *  (Zed's `zed` CLI hands off to a `zed-editor` process on Linux). Used only by guessRunningEditor. */
  processNames?: string[];
}

/**
 * Each editor's own "open at line:column" convention. WHY a table: there is no shared flag, and
 * guessing wrong opens a file literally named `a.ts:12:3`. The conventions follow
 * react-dev-utils launchEditor's getArgumentsForLineNumber (MIT), written fresh here.
 *   - vscode       VS Code and its forks: `-g <file>:<line>:<col>` (--goto)
 *   - path-suffix  Zed, Sublime Text: a bare `<file>:<line>:<col>` argument
 *   - notepad++    `-n<line> -c<col> <file>`
 */
export type GotoStyle = "vscode" | "path-suffix" | "notepad++";

/** A 1-based position inside a file, validated by parseEditorPosition. */
export interface EditorPosition {
  line: number;
  column: number;
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
    goto: "vscode",
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
    goto: "vscode",
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
    goto: "vscode",
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
    goto: "vscode",
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
    goto: "vscode",
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
    goto: "path-suffix",
    winPaths: ["%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe"],
    macApp: "Zed",
    linuxPaths: ["/usr/bin/zed", "/usr/bin/zeditor"],
    processNames: ["zed-editor"],
  },
  {
    id: "sublime",
    label: "Sublime Text",
    folder: true,
    commands: ["subl"],
    goto: "path-suffix",
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
    goto: "notepad++",
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
 * file, which is exactly the "see the whole file list" intent. With a `pos` and a file, the file
 * argument becomes the editor's own line:column form (GotoStyle); an editor without one just gets
 * the file, since a wrong guess would open a nonexistent `file:12:3`.
 */
export function buildEditorArgs(
  def: EditorDef,
  folderAbs: string,
  fileAbs?: string,
  pos?: EditorPosition,
): string[] | null {
  const fileArgs = fileAbs ? gotoArgs(def.goto, fileAbs, pos) : [];
  if (def.folder) return [folderAbs, ...fileArgs];
  if (!fileAbs) return null; // a file-only editor with nothing to open
  return fileArgs;
}

/**
 * buildEditorArgs for a resolved launch. WHY: a macOS app found only as its bundle is launched as
 * `open -a <App> <args>`, and `open` parses those args itself: it reads VS Code's `-g` as its own
 * background flag and treats `file:12:3` as a document that does not exist, so it opens nothing.
 * (`open --args` is no fix either: it reaches only a NEW instance, not the window already open.)
 * So that launch drops the position and opens the plain folder + file, which `open` does handle.
 */
export function launchEditorArgs(
  def: EditorDef,
  res: Resolution,
  folderAbs: string,
  fileAbs?: string,
  pos?: EditorPosition,
): string[] | null {
  return buildEditorArgs(def, folderAbs, fileAbs, res.kind === "macApp" ? undefined : pos);
}

/** The argv fragment that opens `fileAbs`, at `pos` when the editor has a GotoStyle for it. */
function gotoArgs(style: GotoStyle | undefined, fileAbs: string, pos: EditorPosition | undefined): string[] {
  if (!pos || !style) return [fileAbs];
  const { line, column } = pos;
  if (style === "vscode") return ["-g", `${fileAbs}:${line}:${column}`];
  if (style === "path-suffix") return [`${fileAbs}:${line}:${column}`];
  return [`-n${line}`, `-c${column}`, fileAbs];
}

/** Largest line/column accepted: far past any real file, small enough to stay a plain integer. */
const MAX_POSITION = 10_000_000;

function isPositionNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_POSITION;
}

/**
 * Validate a caller-supplied line/column. WHY strict: the value is spliced into an editor argv, so
 * only a positive integer may pass (react-dev-utils launchEditor refuses non-integer lines for the
 * same reason). No line means no position; a column without a line is refused as a malformed
 * request rather than silently dropped; a line without a column opens at column 1.
 */
export function parseEditorPosition(
  line: unknown,
  column: unknown,
): { position?: EditorPosition } | { error: string } {
  if (line === undefined || line === null) {
    return column === undefined || column === null ? {} : { error: "column needs a line" };
  }
  if (!isPositionNumber(line)) return { error: "line must be a positive integer" };
  if (column === undefined || column === null) return { position: { line, column: 1 } };
  if (!isPositionNumber(column)) return { error: "column must be a positive integer" };
  return { position: { line, column } };
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
 * True when a win32 launch carries an arg with a character cmd.exe re-parses destructively.
 * Every win32 editor launch now routes through `cmd /c start ""` (buildDetachedSpawn, so the editor
 * escapes the daemon's process tree and survives Quit), and cmd re-parses each arg:
 *   · `%…%`  cmd expands it against the environment INSIDE its own command-line parse, AFTER our
 *            repo confinement; a repo file literally named `%COMSPEC%` would reach the editor as an
 *            env-derived path OUTSIDE the repo (a confinement bypass). Verified 2026-07-12.
 *   · `^`    cmd's escape char, silently stripped, so the editor opens a different/nonexistent path.
 * The argv quoting keeps these contained (no command injection), but the *value* the editor receives
 * is wrong, so such a launch is refused up front rather than silently misbehaving. This used to apply
 * only to the .cmd/.bat PATH-shim launch (real .exe installs spawned directly); now that all win32
 * launches go through `cmd /c start`, it applies to every win32 editor launch.
 */
export function cmdReparseHazard(platform: EditorPlatform, args: string[]): boolean {
  return platform === "win32" && args.some((a) => /[%^]/.test(a));
}

/**
 * True when an arg would reach cmd.exe as COMMAND TEXT on the `.cmd`/`.bat` shim launch.
 *
 * That launch is a plain `cmd /c <shim> <args>`, and it is the one win32 path cmd still parses
 * (the detached path goes through WMI and never touches cmd; see detached-spawn.mjs). Bun quotes an
 * argv element for CreateProcess only when it holds a space, tab or quote, so a spaceless path
 * reaches cmd bare and every metacharacter in it is live. Measured on Windows 11 with Bun 1.4:
 * spawning `["cmd", "/c", "echo", "C:\\repo\\x&ver"]` ran `ver`. A repo is untrusted input (a clone of
 * someone else's code), `&` is legal in a Windows file name, and so a file named `x&calc` became a
 * command the moment the owner opened it in an editor found only as its PATH shim.
 *
 * `%` and `^` are the cmdReparseHazard pair. `&` `|` `<` `>` chain or redirect commands; `!`
 * expands variables wherever delayed expansion is on, which a registry value can turn on for every
 * cmd.exe. Refusing is the whole fix, not a stopgap: this shim path is a rare fallback (probeEditor
 * resolves nearly every editor to its real .exe), and a correct quoting scheme for cmd would be far
 * more code on a path that almost never runs.
 */
export function cmdShimHazard(args: string[]): boolean {
  return args.some((a) => /[%^&|<>!]/.test(a));
}

/**
 * Reveal a location in the OS file manager (the `system` pseudo-editor). Always resolvable.
 * With `fileAbs` it reveals (SELECTS) that specific file inside its folder — `explorer /select,` on
 * Windows, `open -R` on macOS; Linux has no portable "select" verb, so it opens the file's parent
 * folder. Without `fileAbs` (or on Linux) it just opens `folderAbs`.
 */
export function systemRevealArgv(
  platform: EditorPlatform,
  folderAbs: string,
  fileAbs?: string,
): string[] {
  if (platform === "win32") {
    // `/select,<path>` must be ONE argv token (explorer is famously picky about the comma form).
    return fileAbs ? ["explorer", `/select,${fileAbs}`] : ["explorer", folderAbs];
  }
  if (platform === "darwin") return fileAbs ? ["open", "-R", fileAbs] : ["open", folderAbs];
  return ["xdg-open", fileAbs ? dirname(fileAbs) : folderAbs];
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

/** Last path segment, lower-cased: `C:\...\Code.exe` and `/usr/bin/code` both reduce to a name. */
function baseNameLower(p: string): string {
  return (p.split(/[\\/]/).pop() ?? "").toLowerCase();
}

/** True when one process-list entry is `def`'s editor on `platform`. */
function processMatches(def: EditorDef, platform: EditorPlatform, proc: string): boolean {
  // macOS `ps -o comm=` prints the full binary path inside the bundle, and the bundle name is the
  // only stable part (the binary may be called Electron, Code or Cursor across versions).
  if (platform === "darwin" && def.macApp && proc.includes(`/${def.macApp}.app/`)) return true;
  const name = baseNameLower(proc);
  if (!name) return false;
  const names =
    platform === "win32"
      ? [def.winExe, ...(def.winPaths ?? [])].filter((n): n is string => !!n).map(baseNameLower)
      : [...(def.commands ?? []), ...(def.linuxPaths ?? []), ...(def.processNames ?? [])].map(baseNameLower);
  return names.includes(name);
}

/**
 * Which catalog editor is already running, given the process list, or null. WHY: with no owner
 * choice, "the first installed editor" can be one the owner never uses; the one with a window open
 * right now is the one they mean (the react-dev-utils guessEditor idea, written fresh here). Only an
 * editor that is also detected as installed and can jump to a line counts, so the launch still goes
 * through the vetted catalog path (never the raw process path) and a stray Notepad never wins.
 * Catalog order breaks ties when several are running.
 */
export function guessRunningEditor(
  processes: string[],
  platform: EditorPlatform,
  editors: EditorInfo[],
): string | null {
  for (const def of CATALOG) {
    if (!def.goto || (def.platforms && !def.platforms.includes(platform))) continue;
    if (!editors.some((e) => e.id === def.id && e.available)) continue;
    if (processes.some((p) => processMatches(def, platform, p))) return def.id;
  }
  return null;
}

/** Bound on the process-list read: a hung `ps`/`tasklist` must not stall an Open click. */
const PROCESS_LIST_TIMEOUT_MS = 2000;

/**
 * The running processes' image names (win32, from `tasklist /FO CSV /NH`) or binary paths (POSIX,
 * from `ps -eo comm=`). Best-effort: any failure or timeout yields [], which just means "no guess".
 */
async function listProcesses(platform: EditorPlatform): Promise<string[]> {
  const argv = platform === "win32" ? ["tasklist", "/FO", "CSV", "/NH"] : ["ps", "-eo", "comm="];
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, PROCESS_LIST_TIMEOUT_MS);
    try {
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) return [];
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // tasklist CSV: the image name is the first quoted field.
      return platform === "win32" ? lines.map((l) => /^"([^"]*)"/.exec(l)?.[1] ?? "") : lines;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}

/** Result of an "Open with" launch. */
export interface OpenResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "NO_EDITOR" | "BAD_PATH" | "BAD_LINE";
  message?: string;
  /** The editor id actually launched (after default resolution). */
  editor?: string;
  /** The argv that was (or, in dry-run, would be) spawned — for tests/telemetry. */
  argv?: string[];
}

/**
 * Confine the optional file path to the repo (blocks `../` escapes). A path that no longer exists
 * on disk (a just-deleted file) degrades to opening the folder only. A resolution failure is
 * returned as the BAD_PATH result itself — distinguished from the success shape by its `ok` field.
 */
function resolveEditorFile(repoAbsPath: string, relPath: string | undefined): { fileAbs?: string } | OpenResult {
  if (!relPath?.trim()) return {};
  const r = resolveRepoPath(repoAbsPath, relPath);
  if ("error" in r) return { ok: false, code: "BAD_PATH", message: r.error };
  return { fileAbs: existsSync(r.abs) ? r.abs : undefined };
}

/** The argv + detach decision for one editor, or the error result that stops the launch. */
type LaunchPlan = { ok: true; argv: string[]; detached: boolean } | { ok: false; result: OpenResult };

/**
 * Work out how (and whether) `wanted` can be launched on `platform`. Pure decision: nothing is
 * spawned here.
 */
function planLaunch(
  wanted: string,
  platform: EditorPlatform,
  folderAbs: string,
  fileAbs: string | undefined,
  pos?: EditorPosition,
): LaunchPlan {
  if (wanted === SYSTEM_FILE_MANAGER) {
    // The OS file manager (explorer / open / xdg-open) hands the request to the existing shell
    // singleton and exits; it is never a lasting child of the daemon, so it needs no detach
    // hand-off (and stays off the `cmd /c start` path, so a `%`/`^` folder name isn't refused).
    // With a resolved file path, reveal (select) that file inside its folder rather than just
    // opening the repo root — so a right-click "Reveal in File Explorer" lands on the file.
    return { ok: true, argv: systemRevealArgv(platform, folderAbs, fileAbs), detached: false };
  }
  const def = CATALOG.find((e) => e.id === wanted)!;
  const res = probeEditor(def, platform, realDeps());
  if (!res) return { ok: false, result: { ok: false, code: "NO_EDITOR", message: `${def.label} isn't installed`, editor: wanted } };
  const editorArgs = launchEditorArgs(def, res, folderAbs, fileAbs, pos);
  if (!editorArgs) {
    return { ok: false, result: { ok: false, code: "BAD_PATH", message: `${def.label} can't open a folder`, editor: wanted } };
  }
  // A real GUI editor must OUTLIVE the daemon (quitting RepoYeti must not close your editor), so
  // on win32 it's launched through a `cmd /c start ""` hand-off (buildDetachedSpawn below) to escape
  // the tray's `taskkill /T` Quit. cmd re-parses every arg, expanding `%…%` (a post-confinement bypass)
  // and stripping `^` — so refuse such a path up front, on every win32 launch that goes through cmd
  // (both the detached `cmd /c start` and the .cmd-shim `cmd /c` below), keeping the repo-confinement
  // guarantee intact. See cmdReparseHazard.
  if (cmdReparseHazard(platform, editorArgs)) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "BAD_PATH",
        message: "the file path contains a character (% or ^) this editor's Windows launcher can't open safely",
        editor: wanted,
      },
    };
  }
  const wrapped = wrapForPlatform(platform, res, editorArgs);
  // Detach so the editor survives a tray Quit — EXCEPT a win32 .cmd/.bat shim, which `cmd /c start`
  // can't reliably relaunch (start's internal `cmd /c "<batch>"` hits cmd's double-quote-strip on a
  // spaced path and launches nothing). Such a shim keeps its plain `cmd /c <shim>` launch, unchanged
  // (it stays a daemon child that a Quit reaps — same as before this fix). probeEditor resolves
  // nearly every catalog editor to its real .exe, which IS detached, so this is a rare fallback.
  if (platform === "win32" && res.kind === "exe" && isWindowsScript(res.exe)) {
    if (cmdShimHazard(editorArgs)) {
      return {
        ok: false,
        result: {
          ok: false,
          code: "BAD_PATH",
          message: `the path contains a character (one of % ^ & | < > !) that ${def.label}'s command-line shim would run as a command; install ${def.label}'s desktop app or open the file another way`,
          editor: wanted,
        },
      };
    }
    return { ok: true, argv: wrapped, detached: false };
  }
  const { argv, detached } = buildDetachedSpawn(platform, wrapped);
  return { ok: true, argv, detached };
}

/**
 * Spawn a resolved editor argv. `detached` (POSIX setsid) plus the win32 `cmd /c start` hand-off in
 * buildDetachedSpawn keep the editor out of the daemon's process tree, so a tray Quit
 * (taskkill /T) can't reap it. Don't await exit — a GUI editor runs for as long as the user keeps
 * it open. Unref so the child never keeps the daemon's event loop alive.
 */
function spawnEditor(editor: string, argv: string[], detached: boolean): OpenResult {
  try {
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      ...(detached ? { detached: true } : {}),
    });
    proc.unref();
    return { ok: true, code: "OK", editor, argv };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e), editor };
  }
}

/**
 * The editor an Open with no explicit choice launches: the owner's saved default when there is one
 * (their word beats any guess), else the one already running, else the first installed. The
 * process list is read only on that last path, so a configured default costs no spawn. Exported so
 * a test can pin this wiring with an injected process list and editor list.
 */
export async function defaultLaunchEditor(
  opts: { defaultEditor?: string; processes?: string[] },
  platform: EditorPlatform,
  editors: EditorInfo[],
): Promise<string> {
  if (!opts.defaultEditor?.trim()) {
    const running = guessRunningEditor(opts.processes ?? (await listProcesses(platform)), platform, editors);
    if (running) return running;
  }
  return effectiveDefaultEditor(opts.defaultEditor, editors);
}

/**
 * Launch an editor on a repo (and optionally one changed file within it). `editorId` omitted /
 * empty ⇒ the effective default is used. The file path is confined to the repo before it reaches
 * an argv. Set `REPOYETI_EDITOR_DRYRUN=1` (or pass `dryRun`) to resolve the argv WITHOUT spawning
 * (used by the tests so they never pop a real window). `line`/`column` (validated by
 * parseEditorPosition) open the file at that spot in editors that support it. With no explicit
 * editor and no owner default, a running editor wins over the first installed one; `processes`
 * injects the process list for tests (omitted: read from the OS).
 */
export async function openInEditor(
  repoId: string,
  editorId: string | undefined,
  relPath: string | undefined,
  opts: {
    defaultEditor?: string;
    dryRun?: boolean;
    platform?: EditorPlatform;
    line?: unknown;
    column?: unknown;
    processes?: string[];
  } = {},
): Promise<OpenResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };

  const platform = opts.platform ?? (process.platform as EditorPlatform);
  const folderAbs = resolve(repo.absPath);

  const parsedPos = parseEditorPosition(opts.line, opts.column);
  if ("error" in parsedPos) return { ok: false, code: "BAD_LINE", message: parsedPos.error };

  const resolvedFile = resolveEditorFile(repo.absPath, relPath);
  if ("ok" in resolvedFile) return resolvedFile;

  // Resolve which editor to launch (explicit choice → owner default → running → first available).
  const editors = detectEditors(platform);
  const wanted = editorId?.trim() ? editorId : await defaultLaunchEditor(opts, platform, editors);
  if (!isKnownEditor(wanted)) return { ok: false, code: "NO_EDITOR", message: `unknown editor: ${wanted}` };

  const plan = planLaunch(wanted, platform, folderAbs, resolvedFile.fileAbs, parsedPos.position);
  if (!plan.ok) return plan.result;

  if (opts.dryRun || process.env.REPOYETI_EDITOR_DRYRUN === "1") {
    return { ok: true, code: "OK", editor: wanted, argv: plan.argv };
  }
  return spawnEditor(wanted, plan.argv, plan.detached);
}
