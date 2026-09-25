import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import {
  buildEditorArgs,
  wrapForPlatform,
  cmdReparseHazard,
  cmdShimHazard,
  systemRevealArgv,
  probeEditor,
  detectEditors,
  isKnownEditor,
  effectiveDefaultEditor,
  guessRunningEditor,
  openInEditor,
  parseEditorPosition,
  type EditorInfo,
} from "../src/service/index.ts";

// "Open with…" external-editor launcher: the catalogue/detection, the pure argv builders, the
// path-confinement + editor-resolution in openInEditor, and the loopback gate on the route.
// Dry-run everywhere so a test run NEVER pops a real editor window.
process.env.REPOYETI_EDITOR_DRYRUN = "1";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const plainRepo = (): string => mkScratchDir("gm-open-");

// ── pure argv builders ────────────────────────────────────────────────────────
test("buildEditorArgs: folder editors get [folder, file?]; file-only editors get [file]", () => {
  const folder = { id: "x", label: "X", folder: true };
  const fileOnly = { id: "n", label: "N", folder: false };
  expect(buildEditorArgs(folder, "/repo", "/repo/a.ts")).toEqual(["/repo", "/repo/a.ts"]);
  expect(buildEditorArgs(folder, "/repo")).toEqual(["/repo"]);
  expect(buildEditorArgs(fileOnly, "/repo", "/repo/a.ts")).toEqual(["/repo/a.ts"]);
  // A single-file editor can't open a folder with no file → null.
  expect(buildEditorArgs(fileOnly, "/repo")).toBeNull();
});

// Open at a line: each editor's own flag. A wrong form opens a nonexistent `file:12:3` (or, for
// Notepad++, ignores the line), so the table is pinned per style.
test("buildEditorArgs: a position uses the editor's own goto form; no goto form drops it", () => {
  const pos = { line: 12, column: 3 };
  const vscode = { id: "vscode", label: "VS Code", folder: true, goto: "vscode" as const };
  const zed = { id: "zed", label: "Zed", folder: true, goto: "path-suffix" as const };
  const npp = { id: "notepad++", label: "Notepad++", folder: false, goto: "notepad++" as const };
  const notepad = { id: "notepad", label: "Notepad", folder: false };
  expect(buildEditorArgs(vscode, "/repo", "/repo/a.ts", pos)).toEqual(["/repo", "-g", "/repo/a.ts:12:3"]);
  expect(buildEditorArgs(zed, "/repo", "/repo/a.ts", pos)).toEqual(["/repo", "/repo/a.ts:12:3"]);
  expect(buildEditorArgs(npp, "/repo", "/repo/a.ts", pos)).toEqual(["-n12", "-c3", "/repo/a.ts"]);
  expect(buildEditorArgs(notepad, "/repo", "/repo/a.ts", pos)).toEqual(["/repo/a.ts"]);
  // No file: the position has nothing to apply to.
  expect(buildEditorArgs(vscode, "/repo", undefined, pos)).toEqual(["/repo"]);
});

test("parseEditorPosition: only positive integers reach an argv", () => {
  expect(parseEditorPosition(undefined, undefined)).toEqual({});
  expect(parseEditorPosition(7, undefined)).toEqual({ position: { line: 7, column: 1 } });
  expect(parseEditorPosition(7, 4)).toEqual({ position: { line: 7, column: 4 } });
  for (const bad of ["7", "7 & calc", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
    expect("error" in parseEditorPosition(bad, undefined)).toBe(true);
    expect("error" in parseEditorPosition(7, bad)).toBe(true);
  }
  expect("error" in parseEditorPosition(undefined, 4)).toBe(true); // a column needs a line
});

test("guessRunningEditor: the running, installed, line-capable editor wins; catalog order breaks ties", () => {
  const all = (ids: string[]): EditorInfo[] => ids.map((id) => ({ id, label: id, folder: true, available: true }));
  const editors = all(["vscode", "cursor", "zed", "sublime", "notepad++", "notepad"]);
  // win32 tasklist image names: Cursor is running, VS Code is not, so Cursor wins over VS Code.
  expect(guessRunningEditor(["svchost.exe", "Cursor.exe", "explorer.exe"], "win32", editors)).toBe("cursor");
  // Both running: catalog order (VS Code first).
  expect(guessRunningEditor(["Cursor.exe", "Code.exe"], "win32", editors)).toBe("vscode");
  // Notepad has no goto form, so a running Notepad is never the guess.
  expect(guessRunningEditor(["notepad.exe"], "win32", editors)).toBeNull();
  expect(guessRunningEditor(["notepad++.exe"], "win32", editors)).toBe("notepad++");
  // Running but not detected as installed: not launchable through the catalog, so no guess.
  expect(guessRunningEditor(["Cursor.exe"], "win32", all(["vscode"]))).toBeNull();
  // Linux ps comm names and macOS bundle paths.
  expect(guessRunningEditor(["bash", "sublime_text"], "linux", editors)).toBe("sublime");
  expect(
    guessRunningEditor(["/Applications/Visual Studio Code.app/Contents/MacOS/Electron"], "darwin", editors),
  ).toBe("vscode");
  expect(guessRunningEditor([], "linux", editors)).toBeNull();
});

test("wrapForPlatform: direct exe vs cmd shim vs macOS open -a", () => {
  expect(wrapForPlatform("win32", { kind: "exe", exe: "C:/VS/Code.exe" }, ["C:/r", "C:/r/a.ts"])).toEqual([
    "C:/VS/Code.exe",
    "C:/r",
    "C:/r/a.ts",
  ]);
  // A .cmd/.bat shim can't be spawned directly on Windows → run through cmd /c.
  expect(wrapForPlatform("win32", { kind: "exe", exe: "C:/VS/bin/code.cmd" }, ["C:/r"])).toEqual([
    "cmd",
    "/c",
    "C:/VS/bin/code.cmd",
    "C:/r",
  ]);
  expect(wrapForPlatform("darwin", { kind: "macApp", app: "Visual Studio Code" }, ["/r", "/r/a.ts"])).toEqual([
    "open",
    "-a",
    "Visual Studio Code",
    "/r",
    "/r/a.ts",
  ]);
  expect(wrapForPlatform("linux", { kind: "exe", exe: "/usr/bin/code" }, ["/r"])).toEqual(["/usr/bin/code", "/r"]);
});

test("cmdReparseHazard: %VAR% / ^ in an arg is unsafe on EVERY win32 launch (all go through cmd /c start)", () => {
  // Every win32 editor launch now routes through `cmd /c start ""` (buildDetachedSpawn), which expands
  // %VAR% (confinement bypass) and strips ^ (silent corruption); those must be refused.
  expect(cmdReparseHazard("win32", ["C:/repo", "C:/repo/%COMSPEC%"])).toBe(true);
  expect(cmdReparseHazard("win32", ["C:/repo/foo^bar.ts"])).toBe(true);
  // A clean path is fine.
  expect(cmdReparseHazard("win32", ["C:/repo", "C:/repo/a.ts"])).toBe(false);
  // A real .exe is now ALSO routed through cmd /c start, so a % in its path IS hazardous (unlike
  // the old direct-spawn behavior).
  expect(cmdReparseHazard("win32", ["C:/repo/%X%"])).toBe(true);
  // Non-Windows never uses cmd /c.
  expect(cmdReparseHazard("linux", ["/repo/%X%"])).toBe(false);
  expect(cmdReparseHazard("darwin", ["/repo/a^b"])).toBe(false);
});

test("cmdShimHazard: a shim launch refuses every character cmd would run or expand", () => {
  // The `.cmd`-shim launch is a plain `cmd /c`, and Bun leaves a spaceless argv element unquoted,
  // so these reach cmd as live syntax. `x&calc` is a legal Windows file name in a cloned repo.
  for (const bad of ["C:/r/x&calc", "C:/r/a|b", "C:/r/a>b", "C:/r/a<b", "C:/r/%PATH%", "C:/r/a^b", "C:/r/!X!"]) {
    expect(cmdShimHazard(["C:/r", bad])).toBe(true);
  }
  expect(cmdShimHazard(["C:/r", "C:/r/src/main (copy).ts", "C:/r/a-b_c.d"])).toBe(false);
});

// NOTE: the win32 `cmd /c start ""` detach contract itself is guarded by the SHARED kit primitive's
// test (tests/server-lib/detached-spawn.test.ts, synced from lunarwerx-ui). Here we only cover the
// RepoYeti-specific pieces layered ON TOP of it: cmdReparseHazard (above) and the `.cmd`-shim
// exception that deliberately stays OFF the detach hand-off (openInEditor test below).

test("systemRevealArgv: the OS file manager per platform (folder only)", () => {
  expect(systemRevealArgv("win32", "C:/r")).toEqual(["explorer", "C:/r"]);
  expect(systemRevealArgv("darwin", "/r")).toEqual(["open", "/r"]);
  expect(systemRevealArgv("linux", "/r")).toEqual(["xdg-open", "/r"]);
});

test("systemRevealArgv: with a file, SELECTS it (reveal), per platform", () => {
  // win32: `/select,<path>` as ONE argv token; darwin: `open -R <file>`; linux has no select verb
  // so it opens the file's parent folder.
  expect(systemRevealArgv("win32", "C:\\r", "C:\\r\\sub\\a.txt")).toEqual([
    "explorer",
    "/select,C:\\r\\sub\\a.txt",
  ]);
  expect(systemRevealArgv("darwin", "/r", "/r/sub/a.txt")).toEqual(["open", "-R", "/r/sub/a.txt"]);
  expect(systemRevealArgv("linux", "/r", "/r/sub/a.txt")).toEqual(["xdg-open", "/r/sub"]);
});

// ── probeEditor (injected which/exists/env — no real machine access) ───────────
test("probeEditor: prefers a known install path over a PATH command", () => {
  const def = { id: "code", label: "VS Code", folder: true, commands: ["code"], winPaths: ["%LA%\\Code.exe"] };
  const res = probeEditor(def, "win32", {
    env: { LA: "C:\\Users\\me\\AppData\\Local" },
    exists: (p) => p === "C:\\Users\\me\\AppData\\Local\\Code.exe",
    which: () => "C:\\should-not-be-used\\code.cmd",
  });
  expect(res).toEqual({ kind: "exe", exe: "C:\\Users\\me\\AppData\\Local\\Code.exe" });
});

test("probeEditor: falls back to PATH (Bun.which) when no known path exists", () => {
  const def = { id: "code", label: "VS Code", folder: true, commands: ["code"], winPaths: ["%LA%\\Code.exe"] };
  const res = probeEditor(def, "win32", {
    env: { LA: "C:\\x" },
    exists: () => false, // known path absent
    which: (c) => (c === "code" ? "C:\\bin\\code.cmd" : null),
  });
  expect(res).toEqual({ kind: "exe", exe: "C:\\bin\\code.cmd" });
});

test("probeEditor: derives the real .exe from a Windows .cmd shim (so launch skips cmd /c)", () => {
  const def = { id: "code", label: "VS Code", folder: true, commands: ["code"], winExe: "Code.exe" };
  const res = probeEditor(def, "win32", {
    env: {},
    exists: (p) => /[\\/]Code\.exe$/i.test(p), // the sibling exe exists next to the shim's parent
    which: (c) => (c === "code" ? "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd" : null),
  });
  expect(res?.kind).toBe("exe");
  const exe = (res as { exe: string }).exe;
  expect(/Code\.exe$/i.test(exe)).toBe(true);
  expect(/\.cmd$/i.test(exe)).toBe(false); // resolved to the exe, not the .cmd shim
});

test("probeEditor: falls back to the .cmd shim when the sibling .exe is absent", () => {
  const def = { id: "code", label: "VS Code", folder: true, commands: ["code"], winExe: "Code.exe" };
  const res = probeEditor(def, "win32", {
    env: {},
    exists: () => false, // neither a known path nor the sibling exe exists
    which: (c) => (c === "code" ? "C:\\portable\\code.cmd" : null),
  });
  expect(res).toEqual({ kind: "exe", exe: "C:\\portable\\code.cmd" });
});

test("probeEditor: a known path with an unset %ENV% token is skipped", () => {
  const def = { id: "code", label: "VS Code", folder: true, commands: ["code"], winPaths: ["%MISSING%\\Code.exe"] };
  const res = probeEditor(def, "win32", {
    env: {}, // %MISSING% unresolved → the whole path is dropped
    exists: () => true, // would match if the path were built — it isn't
    which: () => null,
  });
  expect(res).toBeNull();
});

test("probeEditor: macOS falls back to `open -a` when the .app bundle exists", () => {
  const def = { id: "code", label: "VS Code", folder: true, commands: ["code"], macApp: "Visual Studio Code" };
  const res = probeEditor(def, "darwin", {
    env: {},
    exists: (p) => p === "/Applications/Visual Studio Code.app",
    which: () => null,
  });
  expect(res).toEqual({ kind: "macApp", app: "Visual Studio Code" });
});

test("probeEditor: a platform-restricted editor is null off-platform", () => {
  const def = { id: "notepad", label: "Notepad", folder: false, commands: ["notepad"], platforms: ["win32" as const] };
  expect(probeEditor(def, "linux", { env: {}, exists: () => true, which: () => "/anything" })).toBeNull();
});

// ── catalogue / defaults ──────────────────────────────────────────────────────
test("isKnownEditor: catalog ids + the system pseudo-editor, nothing else", () => {
  expect(isKnownEditor("vscode")).toBe(true);
  expect(isKnownEditor("system")).toBe(true);
  expect(isKnownEditor("definitely-not-an-editor")).toBe(false);
  expect(isKnownEditor("")).toBe(false);
});

test("detectEditors: platform-restricted entries are filtered; system is always available", () => {
  const win = detectEditors("win32");
  const linux = detectEditors("linux");
  // Notepad is Windows-only.
  expect(win.some((e) => e.id === "notepad")).toBe(true);
  expect(linux.some((e) => e.id === "notepad")).toBe(false);
  // The OS file-manager pseudo-editor is present + always available on every platform.
  for (const list of [win, linux]) {
    const sys = list.find((e) => e.id === "system");
    expect(sys?.available).toBe(true);
    for (const e of list) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.available).toBe("boolean");
    }
  }
});

test("effectiveDefaultEditor: honour an available choice, else first installed, else system", () => {
  const editors: EditorInfo[] = [
    { id: "vscode", label: "VS Code", folder: true, available: false },
    { id: "cursor", label: "Cursor", folder: true, available: true },
    { id: "system", label: "File Explorer", folder: true, available: true },
  ];
  expect(effectiveDefaultEditor("cursor", editors)).toBe("cursor"); // available choice wins
  expect(effectiveDefaultEditor("vscode", editors)).toBe("cursor"); // unavailable → first installed
  expect(effectiveDefaultEditor(undefined, editors)).toBe("cursor"); // no choice → first installed
  expect(effectiveDefaultEditor("system", editors)).toBe("system"); // explicit file-manager
  const noneReal: EditorInfo[] = [{ id: "system", label: "File Explorer", folder: true, available: true }];
  expect(effectiveDefaultEditor(undefined, noneReal)).toBe("system"); // nothing installed → system
});

// ── openInEditor (dry-run: resolves argv, spawns nothing) ─────────────────────
test("openInEditor: system editor reveals the repo folder (deterministic, no install needed)", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "open-system", "auto", false);
  const r = await openInEditor(id, "system", undefined, { dryRun: true, platform: "win32" });
  expect(r.ok).toBe(true);
  expect(r.editor).toBe("system");
  expect(r.argv?.[0]).toBe("explorer");
  expect(r.argv?.[1]).toBe(dir);
});

test("openInEditor: 404s an unknown repo", async () => {
  const r = await openInEditor("does-not-exist", "system", undefined, { dryRun: true });
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NOT_FOUND");
});

test("openInEditor: a path escaping the repo is refused (BAD_PATH), before any launch", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "open-escape", "auto", false);
  const r = await openInEditor(id, "system", "../escape.txt", { dryRun: true, platform: "win32" });
  expect(r.ok).toBe(false);
  expect(r.code).toBe("BAD_PATH");
});

test("openInEditor: an unknown editor id is rejected (NO_EDITOR)", async () => {
  const dir = plainRepo();
  const id = mustUpsertRepo(dir, "open-bogus", "auto", false);
  const r = await openInEditor(id, "not-a-real-editor", undefined, { dryRun: true });
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NO_EDITOR");
});

// ── routes ────────────────────────────────────────────────────────────────────
test("GET /api/editors lists the catalogue + an effective default", async () => {
  const res = await createApp(localCfg()).request("/api/editors");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.platform).toBe("string");
  expect(typeof body.effectiveDefault).toBe("string");
  expect(Array.isArray(body.editors)).toBe(true);
  expect(body.editors.some((e: EditorInfo) => e.id === "system")).toBe(true);
});

test("POST /api/repos/:id/open opens locally (dry-run) but is 403 over the tunnel", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "a.txt"), "hi\n");
  const id = mustUpsertRepo(dir, "open-route", "auto", false);
  const app = createApp(localCfg());

  // A local request opens with the system file-manager (dry-run → no window).
  const local = await app.request(`/api/repos/${id}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ editor: "system", path: "a.txt" }),
  });
  expect(local.status).toBe(200);
  expect((await local.json()).editor).toBe("system");

  // The same request over the tunnel (a forwarded header true-localhost never has) is refused.
  const remote = await app.request(`/api/repos/${id}/open`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ editor: "system", path: "a.txt" }),
  });
  expect(remote.status).toBe(403);
  expect((await remote.json()).code).toBe("REMOTE_FORBIDDEN");
});

test("POST /api/repos/:id/open refuses a non-integer line (400 BAD_LINE) before any launch", async () => {
  const dir = plainRepo();
  writeFileSync(join(dir, "a.txt"), "hi\n");
  const id = mustUpsertRepo(dir, "open-bad-line", "auto", false);
  const app = createApp(localCfg());
  const res = await app.request(`/api/repos/${id}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ editor: "system", path: "a.txt", line: "3 & calc" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("BAD_LINE");
});

test("POST /api/repos/:id/open 404s an unknown repo", async () => {
  const res = await createApp(localCfg()).request("/api/repos/nope/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ editor: "system" }),
  });
  expect(res.status).toBe(404);
});

test("PUT /api/settings persists a known defaultEditor and rejects an unknown one", async () => {
  const app = createApp(localCfg());
  const ok = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultEditor: "cursor" }),
  });
  expect(ok.status).toBe(200);
  expect((await ok.json()).defaultEditor).toBe("cursor");

  // An unknown id is ignored (the previous value stands), not stored.
  const bad = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultEditor: "totally-bogus" }),
  });
  expect(bad.status).toBe(200);
  expect((await bad.json()).defaultEditor).toBe("cursor");

  // The empty string clears the preference (auto-pick).
  const clear = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultEditor: "" }),
  });
  expect(clear.status).toBe(200);
  expect((await clear.json()).defaultEditor).toBeNull();
});
