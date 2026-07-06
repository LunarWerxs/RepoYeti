import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { upsertRepo } from "../src/db.ts";
import {
  buildEditorArgs,
  wrapForPlatform,
  cmdReparseHazard,
  systemRevealArgv,
  probeEditor,
  detectEditors,
  isKnownEditor,
  effectiveDefaultEditor,
  openInEditor,
  type EditorInfo,
} from "../src/service/index.ts";

// "Open with…" external-editor launcher: the catalogue/detection, the pure argv builders, the
// path-confinement + editor-resolution in openInEditor, and the loopback gate on the route.
// Dry-run everywhere so a test run NEVER pops a real editor window.
process.env.REPOYETI_EDITOR_DRYRUN = "1";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const plainRepo = (): string => mkdtempSync(join(tmpdir(), "gm-open-"));

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

test("cmdReparseHazard: %VAR% / ^ in a path is unsafe ONLY through a Windows .cmd shim", () => {
  // A .cmd/.bat shim routes args through `cmd /c`, which expands %VAR% (confinement bypass) and
  // strips ^ (silent corruption) — those must be refused.
  expect(cmdReparseHazard("win32", "C:/VS/bin/code.cmd", ["C:/repo", "C:/repo/%COMSPEC%"])).toBe(true);
  expect(cmdReparseHazard("win32", "C:/VS/bin/code.cmd", ["C:/repo/foo^bar.ts"])).toBe(true);
  // A clean path through a .cmd shim is fine.
  expect(cmdReparseHazard("win32", "C:/VS/bin/code.cmd", ["C:/repo", "C:/repo/a.ts"])).toBe(false);
  // A real .exe is spawned directly (no cmd re-parse) → never hazardous, even with % in the path.
  expect(cmdReparseHazard("win32", "C:/VS/Code.exe", ["C:/repo/%X%"])).toBe(false);
  // Non-Windows never uses cmd /c.
  expect(cmdReparseHazard("linux", "/usr/bin/code", ["/repo/%X%"])).toBe(false);
  expect(cmdReparseHazard("darwin", "/usr/bin/code", ["/repo/a^b"])).toBe(false);
});

test("systemRevealArgv: the OS file manager per platform", () => {
  expect(systemRevealArgv("win32", "C:/r")).toEqual(["explorer", "C:/r"]);
  expect(systemRevealArgv("darwin", "/r")).toEqual(["open", "/r"]);
  expect(systemRevealArgv("linux", "/r")).toEqual(["xdg-open", "/r"]);
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
  const id = upsertRepo(dir, "open-system", "auto", false);
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
  const id = upsertRepo(dir, "open-escape", "auto", false);
  const r = await openInEditor(id, "system", "../escape.txt", { dryRun: true, platform: "win32" });
  expect(r.ok).toBe(false);
  expect(r.code).toBe("BAD_PATH");
});

test("openInEditor: an unknown editor id is rejected (NO_EDITOR)", async () => {
  const dir = plainRepo();
  const id = upsertRepo(dir, "open-bogus", "auto", false);
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
  const id = upsertRepo(dir, "open-route", "auto", false);
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
