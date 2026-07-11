// ───────────────────────────────────────────────────────────────────────────────
// Hardcore guard for the one-click launcher. The promise to a user is: there is
// ALWAYS a clickable shortcut in the project root that, when run, boots the daemon
// and shows the tray icon. These tests fail LOUD ("thou shalt not pass") the moment
// any link in that chain is missing, uncommitted, mis-wired, or the icon is broken.
//
// The chain:  RepoYeti.lnk (root)  →  wscript  →  misc/Tray-Launch.vbs (shared,
//             auto-discovering)  →  misc/RepoYeti-Tray.ps1 (thin adapter)  →
//             misc/Tray-Host.ps1 (shared kit-synced engine)  →  bun src/index.ts
//             start  +  misc/RepoYeti.ico
//
// Tray-Launch.vbs and Create-Shortcut.ps1's engine (New-TrayShortcut.ps1) are now
// ALSO kit-synced shared files (from lunarwerx-ui/src/tray-host/), same story as
// Tray-Host.ps1: zero per-app content, never edited in-app. The old per-app
// RepoYeti.vbs is DELETED — Tray-Launch.vbs auto-discovers RepoYeti-Tray.ps1 by
// scanning misc/ for the one file whose name ends in "-tray.ps1".
//
// RepoYeti-Tray.ps1 is now a THIN ADAPTER over the shared LunarWerx tray-host engine
// (misc/Tray-Host.ps1, synced from lunarwerx-ui/src/tray-host/Tray-Host.ps1 — never
// edited here). Assertions below are split accordingly:
//   - engine-INVARIANT behavior (mutex lifecycle, watchdog, worker, hide-tray gate,
//     portable-window open path, sentinel handling, self-test shape) is grepped
//     against Tray-Host.ps1, since that's where the behavior actually lives now.
//   - RepoYeti-SPECIFIC config (mutex name, daemon command, icon name, menu label,
//     self-test marker, service id, sentinel/force-kill choice) is grepped against
//     the adapter, since that's where RepoYeti's config values live now.
//   - end-to-end proofs (-SelfTest subprocess, Create-Shortcut regenerate+resolve)
//     keep exercising the real adapter (which dot-sources the real engine), so a
//     wiring break between the two is still caught live, not just by grep.
//
// The .lnk itself is gitignored (it stores absolute, per-machine paths), so the
// guarantee is enforced via the COMMITTED machinery that regenerates it
// (Create-Shortcut.ps1) — and, on Windows, by actually regenerating + resolving it
// and by running the tray's headless self-test.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MISC = join(ROOT, "misc");
const isWin = process.platform === "win32";

/** Loud assertion — a failure here should read like a stop sign, not a diff. */
function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`THOU SHALT NOT PASS — ${msg}`);
}
const read = (p: string): string => readFileSync(p, "utf8");
/** Is this path committed (in git's index)? Untracked files never reach a clone. */
function tracked(relFromRoot: string): boolean {
  return Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", relFromRoot], { cwd: ROOT }).exitCode === 0;
}

// The committed pieces that let ANY clone regenerate a working shortcut + tray.
// Tray-Host.ps1, Tray-Launch.vbs, and New-TrayShortcut.ps1 are the kit-synced shared
// files the adapter/shortcut dot-source or run — without them the adapter is inert,
// so they're just as load-bearing as the adapter itself.
const REQUIRED = [
  "Create-Shortcut.ps1",
  "New-TrayShortcut.ps1",
  "Tray-Launch.vbs",
  "RepoYeti-Tray.ps1",
  "Tray-Host.ps1",
  "RepoYeti.ico",
] as const;

test("launcher machinery exists, is non-empty, and is COMMITTED (a clone must be able to make the shortcut)", () => {
  for (const name of REQUIRED) {
    const abs = join(MISC, name);
    must(existsSync(abs), `misc/${name} is MISSING — the tray launcher is incomplete`);
    must(statSync(abs).size > 0, `misc/${name} is EMPTY`);
    must(
      tracked(`misc/${name}`),
      `misc/${name} is NOT committed to git — a fresh clone would have NO shortcut or tray. Run: git add misc/`,
    );
  }
});

test("the tray icon is a real .ico file (so the tray icon can't silently be broken)", () => {
  const buf = readFileSync(join(MISC, "RepoYeti.ico"));
  // ICO header: reserved=0x0000, type=0x0001(icon), count>=1.
  const headerOk = buf.length > 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0;
  const count = buf.length > 6 ? buf[4]! | (buf[5]! << 8) : 0;
  must(headerOk && count >= 1, `misc/RepoYeti.ico is not a valid icon (bad header / 0 images) — the tray icon would be broken`);
  // The Windows tray needs a SMALL frame (16/24/32/48). A 256-only icon renders BLANK in
  // the tray (the classic "tray icon is broken"). Walk the ICONDIR and require a <=48px
  // frame. Each 16-byte ICONDIRENTRY starts at 6 + i*16; byte 0 is the width (0 => 256).
  const frames: number[] = [];
  for (let i = 0; i < count; i++) {
    const w = buf[6 + i * 16]!;
    frames.push(w === 0 ? 256 : w);
  }
  must(
    frames.some((w) => w >= 1 && w <= 48),
    `misc/RepoYeti.ico has no small (<=48px) frame (frames: ${frames.join(",")}) — a 256-only icon renders blank in the tray`,
  );
});

test("the engine file carries the kit-synced header (must never be hand-edited in-app)", () => {
  const engine = read(join(MISC, "Tray-Host.ps1"));
  must(
    /DO NOT EDIT THIS FILE INSIDE AN APP/.test(engine),
    "misc/Tray-Host.ps1 is missing its kit-synced 'do not edit in-app' header — did a local edit strip it, or is this not the shared engine?",
  );
  must(
    /shared, source of truth: lunarwerx-ui\/src\/tray-host\/Tray-Host\.ps1|source of truth: lunarwerx-ui\/src\/tray-host\/Tray-Host\.ps1/.test(engine),
    "misc/Tray-Host.ps1 doesn't declare lunarwerx-ui as its source of truth",
  );
});

test("the shared launcher vbs and shortcut engine also carry the kit-synced header (must never be hand-edited in-app)", () => {
  const vbs = read(join(MISC, "Tray-Launch.vbs"));
  must(
    /DO NOT EDIT THIS FILE INSIDE AN APP/.test(vbs),
    "misc/Tray-Launch.vbs is missing its kit-synced 'do not edit in-app' header",
  );
  must(
    /source of truth: lunarwerx-ui\/src\/tray-host\/Tray-Launch\.vbs/.test(vbs),
    "misc/Tray-Launch.vbs doesn't declare lunarwerx-ui as its source of truth",
  );

  const shortcutEngine = read(join(MISC, "New-TrayShortcut.ps1"));
  must(
    /DO NOT EDIT THIS FILE INSIDE AN APP/.test(shortcutEngine),
    "misc/New-TrayShortcut.ps1 is missing its kit-synced 'do not edit in-app' header",
  );
  must(
    /source of truth: lunarwerx-ui\/src\/tray-host\/New-TrayShortcut\.ps1/.test(shortcutEngine),
    "misc/New-TrayShortcut.ps1 doesn't declare lunarwerx-ui as its source of truth",
  );
});

test("the adapter is a thin config layer: it dot-sources the engine rather than reimplementing it", () => {
  const tray = read(join(MISC, "RepoYeti-Tray.ps1"));
  must(
    /\.\s*\(Join-Path\s+\$scriptDir\s+"Tray-Host\.ps1"\)/.test(tray),
    "RepoYeti-Tray.ps1 doesn't dot-source misc/Tray-Host.ps1 — it must be a thin adapter, not a standalone script",
  );
  must(
    /Invoke-TrayHostSelfTest\s+\$TrayConfig/.test(tray),
    "RepoYeti-Tray.ps1 doesn't call the engine's Invoke-TrayHostSelfTest",
  );
  must(
    /Start-TrayHost\s+\$TrayConfig/.test(tray),
    "RepoYeti-Tray.ps1 doesn't call the engine's Start-TrayHost",
  );
  // The adapter must NOT reimplement engine-owned machinery — those symbols only exist
  // in Tray-Host.ps1 now. Their presence in the adapter would mean drift back toward a
  // full copy instead of a config layer.
  for (const engineOnly of [/function\s+New-TrayHostIcon/i, /function\s+Test-Daemon\(/i, /\$healthTimer\s*=\s*New-Object/i, /\$pollTimer\s*=\s*New-Object/i]) {
    must(!engineOnly.test(tray), `RepoYeti-Tray.ps1 reimplements engine machinery (${engineOnly}) instead of delegating to Tray-Host.ps1`);
  }
});

test("launcher chain is wired: shortcut → wscript → Tray-Launch.vbs (auto-discovers) → RepoYeti-Tray.ps1 → daemon + icon", () => {
  const cs = read(join(MISC, "Create-Shortcut.ps1"));
  must(/New-TrayShortcut/.test(cs), "Create-Shortcut.ps1 doesn't call New-TrayShortcut");
  must(/-LnkName\s+"RepoYeti"/.test(cs), "Create-Shortcut.ps1 doesn't pass -LnkName \"RepoYeti\"");
  must(/-IconFile\s+"RepoYeti\.ico"/.test(cs), "Create-Shortcut.ps1 doesn't set the tray icon via -IconFile");
  must(/-Description\s+"Launch RepoYeti \(system tray\)"/.test(cs), "Create-Shortcut.ps1 doesn't pass the expected -Description");
  // The actual wscript/.lnk-building mechanics now live in New-TrayShortcut.ps1 (kit-synced),
  // not in this thin adapter — assert them there instead of re-asserting app-side literals.
  const shortcutEngineSrc = read(join(MISC, "New-TrayShortcut.ps1"));
  must(/wscript/i.test(shortcutEngineSrc), "New-TrayShortcut.ps1 doesn't launch via wscript");
  must(/\.lnk/.test(shortcutEngineSrc), "New-TrayShortcut.ps1 doesn't write a .lnk");

  const vbs = read(join(MISC, "Tray-Launch.vbs"));
  must(
    /Right\(lname,\s*9\)\s*=\s*"-tray\.ps1"/.test(vbs),
    "Tray-Launch.vbs doesn't auto-discover the sibling *-Tray.ps1 adapter",
  );
  must(!/RepoYeti-Tray\.ps1/.test(vbs), "Tray-Launch.vbs must be app-agnostic — it must NOT hard-code RepoYeti-Tray.ps1 by name");

  const tray = read(join(MISC, "RepoYeti-Tray.ps1"));
  const engine = read(join(MISC, "Tray-Host.ps1"));

  // Daemon entry / start command: RepoYeti-specific, now lives in the adapter's config.
  must(/src\\index\.ts/.test(tray), "RepoYeti-Tray.ps1's config doesn't reference the daemon entry (src\\index.ts)");
  must(/\bstart\b/.test(tray), "RepoYeti-Tray.ps1's StartCommand doesn't run the daemon's 'start' subcommand");
  must(/RepoYeti\.ico/.test(tray), "RepoYeti-Tray.ps1 doesn't configure the tray icon RepoYeti.ico");
  must(/RepoYetiTrayHost/.test(tray), "RepoYeti-Tray.ps1 doesn't set MutexName to guard against duplicate tray hosts");
  must(/"repoyeti"/.test(tray), "RepoYeti-Tray.ps1 doesn't set ServiceName to the anti-collision health-check id 'repoyeti'");

  // The mutex-collision / hard-icon-gate machinery itself is now engine-owned.
  must(/function\s+New-TrayHostIcon/.test(engine), "Tray-Host.ps1 is missing the shared hard tray-icon startup gate");
  must(
    /System\.Threading\.Mutex/.test(engine) && /trayMutex/.test(engine),
    "Tray-Host.ps1 doesn't guard against duplicate tray hosts via a named mutex",
  );

  // No generic-icon fallback — still a hard requirement, now engine-enforced.
  must(!/SystemIcons\]::Application/.test(engine), "Tray-Host.ps1 falls back to a generic icon instead of refusing to start");
  must(!/SystemIcons\]::Application/.test(tray), "RepoYeti-Tray.ps1 falls back to a generic icon instead of refusing to start");

  // Tray-icon-before-daemon-launch ordering is an engine invariant now (both apply to every
  // app, not just RepoYeti) — assert it holds in the engine rather than via an app-specific
  // literal line, since the adapter no longer spells out that sequence itself.
  const iconCreateIdx = engine.indexOf("$tray = New-TrayHostIcon");
  const daemonLaunchIdx = engine.indexOf("$startProc = Start-DaemonHere $null");
  must(iconCreateIdx >= 0, "Tray-Host.ps1 doesn't create the tray icon via New-TrayHostIcon");
  must(daemonLaunchIdx >= 0 && iconCreateIdx < daemonLaunchIdx, "Tray-Host.ps1 can start the daemon before the tray icon exists");

  // Portable window: every browser-open call site goes through Open-AppUi (which picks a
  // chromeless --app= window vs. a normal tab based on runtime.json's portableMode), not a
  // bare Start-Process $url/$u. This is engine machinery now.
  must(/function\s+Open-AppUi/.test(engine), "Tray-Host.ps1 is missing the Open-AppUi helper");
  must(/--app=\$url/.test(engine), "Tray-Host.ps1's Open-AppUi doesn't launch a chromeless --app= window");
  must(/function\s+Resolve-ChromiumBrowser/.test(engine), "Tray-Host.ps1 is missing the Resolve-ChromiumBrowser helper");
  must(
    !/Start-Process\s+\$(script:url|u)\b/.test(engine),
    "Tray-Host.ps1 still opens the browser directly instead of going through Open-AppUi",
  );

  // Dedicated portable-window profile: same family convention as POST /api/portable-window
  // (src/http/routes/health.ts) — <dir of runtime.json>/portable-profile — so both open paths
  // share one profile and Chromium remembers the window's size/position across launches.
  must(
    /--user-data-dir=`"\$profileDir`"/.test(engine),
    "Tray-Host.ps1's Open-AppUi doesn't pass --user-data-dir for the dedicated portable profile",
  );
  must(
    /Join-Path\s+\(Split-Path -Parent \$infoFile\)\s+"portable-profile"/.test(engine),
    "Tray-Host.ps1 doesn't derive the portable profile dir from the same runtime.json path ($infoFile)",
  );

  // Auto-restart watchdog: a health timer must relaunch a daemon that died on its own, and it
  // must NOT fight a deliberate stop (Quit sets $intentionalStop). Both are engine invariants now.
  must(/\$healthTimer\b/.test(engine), "Tray-Host.ps1 has no health/watchdog timer to auto-restart a crashed daemon");
  must(
    /\$healthTimer\.Add_Tick/.test(engine) && /Start-DaemonHere\s+\$null/.test(engine),
    "Tray-Host.ps1's watchdog doesn't relaunch the daemon on its tick",
  );
  must(
    /\$script:intentionalStop\s*=\s*\$true/.test(engine),
    "Tray-Host.ps1 doesn't guard the watchdog against a deliberate Quit ($intentionalStop)",
  );
  must(/\$healthTimer\.Start\(\)/.test(engine), "Tray-Host.ps1 never starts the watchdog timer");

  // "Hide tray icon" owner setting: the NotifyIcon must ALWAYS be created (Quit/menu/watchdog
  // machinery hangs off it) — only its .Visible may be gated, and only AFTER creation. This
  // ordering + the never-skip-creation invariant are engine-owned now.
  must(/function\s+Get-HideTrayIcon/.test(engine), "Tray-Host.ps1 is missing the Get-HideTrayIcon helper");
  const visibleTrueIdx = engine.indexOf("$tray.Visible = $true");
  const visibleGateIdx = engine.indexOf("if (Get-HideTrayIcon) { $tray.Visible = $false }");
  must(visibleTrueIdx >= 0, "Tray-Host.ps1 doesn't unconditionally create the tray icon visible");
  must(
    visibleGateIdx >= 0 && visibleTrueIdx < visibleGateIdx,
    "Tray-Host.ps1 doesn't gate .Visible on hideTrayIcon strictly AFTER creating the icon",
  );
  must(
    !/if\s*\(.*hideTrayIcon.*\)\s*\{\s*return\s*\}/i.test(engine),
    "Tray-Host.ps1 must never skip tray icon creation based on hideTrayIcon",
  );
  // Live re-sync: the health timer tick must also re-read hideTrayIcon every tick, so
  // re-enabling it from web Settings restores the icon without a restart.
  const healthTickIdx = engine.indexOf("$healthTimer.Add_Tick");
  const liveSyncIdx = engine.indexOf("Get-HideTrayIcon", healthTickIdx);
  must(healthTickIdx >= 0, "Tray-Host.ps1 is missing the $healthTimer tick");
  must(
    liveSyncIdx >= 0 && liveSyncIdx > healthTickIdx,
    "Tray-Host.ps1's $healthTimer tick doesn't live re-read hideTrayIcon off runtime.json",
  );
  must(
    /\$tray\.Visible = -not \$wantHidden/.test(engine),
    "Tray-Host.ps1's health timer doesn't reconcile the NotifyIcon's .Visible with the live hideTrayIcon flag",
  );

  // Full-shutdown sentinel: RepoYeti opts INTO the engine's sentinel watch (SentinelFile set to
  // shutdown.request, unlike CCManagerUI which passes $null). The polling/clear/Quit-reuse
  // machinery itself is engine-owned; RepoYeti's opt-in + exact filename live in the adapter.
  must(/function\s+Invoke-QuitApp/.test(engine), "Tray-Host.ps1 is missing the shared Quit teardown Invoke-QuitApp");
  must(/\$watchTimer\.Add_Tick/.test(engine), "Tray-Host.ps1 is missing the sentinel watch timer");
  must(
    /Remove-Item\s+\$script:shutdownRequestFile/.test(engine),
    "Tray-Host.ps1 doesn't clear a stale shutdown sentinel",
  );
  must(/"shutdown\.request"/.test(tray), "RepoYeti-Tray.ps1 doesn't configure SentinelFile as shutdown.request");

  // Force-kill shutdown flavor (no HTTP token) — RepoYeti-specific choice, asserted on the
  // adapter; the branch-on-token machinery itself lives in the engine (Stop-Daemon).
  must(/ShutdownTokenEnvVar\s*=\s*\$null/.test(tray), "RepoYeti-Tray.ps1 must use the force-kill shutdown flavor (ShutdownTokenEnvVar = $null)");
  must(/function\s+Stop-Daemon/.test(engine), "Tray-Host.ps1 is missing the shared Stop-Daemon helper");

  // Stray-daemon adoption: RepoYeti attaches rather than warns.
  must(/OnStrayDaemon\s*=\s*"attach"/.test(tray), "RepoYeti-Tray.ps1 must adopt (not warn on) a stray daemon found at startup");

  // RepoYeti's domain-specific "no scan root" guidance is app config now.
  must(/NoScanRootHint/.test(tray), "RepoYeti-Tray.ps1 is missing its NoScanRootHint config key");
  must(/add-root/.test(tray), "RepoYeti-Tray.ps1's NoScanRootHint lost the exact `add-root` remediation command");
  must(/NoScanRootHint/.test(engine), "Tray-Host.ps1 doesn't support the NoScanRootHint config key");
});

test("the adapter always shows Rebuild & Restart (no dev/distribution split for this app)", () => {
  const tray = read(join(MISC, "RepoYeti-Tray.ps1"));
  must(/IsDevTree\s*=\s*\$true/.test(tray), "RepoYeti-Tray.ps1 must set IsDevTree = $true so Rebuild & Restart is always shown");
});

test("the adapter pins RepoYeti's own timing/menu/rebuild config", () => {
  const tray = read(join(MISC, "RepoYeti-Tray.ps1"));
  must(/MenuOpenLabel\s*=\s*"Open RepoYeti"/.test(tray), "RepoYeti-Tray.ps1's menu open label drifted from 'Open RepoYeti'");
  must(/SelfTestMarker\s*=\s*"REPOYETI_TRAY_SELFTEST"/.test(tray), "RepoYeti-Tray.ps1's self-test marker drifted from REPOYETI_TRAY_SELFTEST");
  must(/RebuildLogName\s*=\s*"RepoYeti-Rebuild\.log"/.test(tray), "RepoYeti-Tray.ps1's rebuild log filename drifted");
  must(/StartupWaitSec\s*=\s*60/.test(tray), "RepoYeti-Tray.ps1's StartupWaitSec must stay pinned at 60s (large scan roots)");
  must(/WorkerWaitSec\s*=\s*60/.test(tray), "RepoYeti-Tray.ps1's WorkerWaitSec must stay pinned at 60s (large scan roots)");
  must(/PortEnvVar\s*=\s*\$null/.test(tray), "RepoYeti-Tray.ps1 must pass PortEnvVar = $null — the port is pinned via the --port CLI flag, not an env var");
});

// ── Windows-only runtime proofs (the tray is Windows-only) ────────────────────────

test.skipIf(!isWin)("tray self-test passes: bun on PATH + daemon entry + the icon LOADS into a real NotifyIcon", () => {
  const r = Bun.spawnSync(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(MISC, "RepoYeti-Tray.ps1"), "-SelfTest"],
    { cwd: ROOT },
  );
  const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
  must(out.includes("REPOYETI_TRAY_SELFTEST_OK"), `the tray self-test did not pass:\n${out.trim()}`);
  must(r.exitCode === 0, `tray self-test exit code ${r.exitCode}:\n${out.trim()}`);
});

test.skipIf(!isWin)("a root shortcut can be (re)generated and resolves to the tray launcher + icon", () => {
  // Regenerate the root shortcut — gitignored + per-machine, so this is the canonical
  // way "there is always a shortcut in the root". Then resolve it and prove every hop.
  const gen = Bun.spawnSync(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(MISC, "Create-Shortcut.ps1")],
    { cwd: ROOT },
  );
  must(gen.exitCode === 0, `Create-Shortcut.ps1 failed:\n${gen.stderr?.toString()?.trim()}`);

  const lnk = join(ROOT, "RepoYeti.lnk");
  must(existsSync(lnk), "no RepoYeti.lnk in the project root after running Create-Shortcut.ps1");

  const resolve = [
    `$ws = New-Object -ComObject WScript.Shell;`,
    `$s = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}');`,
    `$icon = ($s.IconLocation -split ',')[0];`,
    `$arg = $s.Arguments.Trim([char]34);`,
    `[pscustomobject]@{ target=$s.TargetPath; args=$s.Arguments; iconExists=[bool](Test-Path $icon); vbsExists=[bool](Test-Path $arg) } | ConvertTo-Json -Compress`,
  ].join(" ");
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", resolve], { cwd: ROOT });
  const info = JSON.parse((r.stdout?.toString() ?? "{}").trim()) as {
    target: string;
    args: string;
    iconExists: boolean;
    vbsExists: boolean;
  };
  must(/wscript/i.test(info.target), `shortcut target isn't wscript: ${info.target}`);
  must(/Tray-Launch\.vbs/i.test(info.args), `shortcut doesn't launch the shared Tray-Launch.vbs: ${info.args}`);
  must(info.vbsExists, "shortcut points at a Tray-Launch.vbs that doesn't exist");
  must(info.iconExists, "shortcut's tray icon (RepoYeti.ico) doesn't exist");
  expect(info.iconExists && info.vbsExists).toBe(true);
});

test("Create-Shortcut.ps1 dot-sources the shared New-TrayShortcut.ps1 engine", () => {
  const cs = read(join(MISC, "Create-Shortcut.ps1"));
  must(
    /\.\s*\(Join-Path\s+\$scriptDir\s+"New-TrayShortcut\.ps1"\)/.test(cs),
    "Create-Shortcut.ps1 must dot-source misc/New-TrayShortcut.ps1 rather than reimplement the shortcut-building logic",
  );
});

test.skipIf(!isWin)("the shared Tray-Launch.vbs auto-discovers RepoYeti-Tray.ps1 as the sole *-Tray.ps1 adapter (no real launch)", () => {
  // Echo-probe: monkeypatch-free proof that WSH's own file-iteration + Right() logic in
  // Tray-Launch.vbs would select RepoYeti-Tray.ps1 and ONLY RepoYeti-Tray.ps1, without
  // actually invoking sh.Run (so this never launches the real tray). We reproduce the exact
  // discovery snippet from Tray-Launch.vbs against the REAL misc/ dir and echo the winner.
  const probe = [
    `Dim fso, f, lname, matchName, matchCount`,
    `Set fso = CreateObject("Scripting.FileSystemObject")`,
    `matchName = "" : matchCount = 0`,
    `For Each f In fso.GetFolder("${MISC.replace(/\\/g, "\\\\")}").Files`,
    `  lname = LCase(f.Name)`,
    `  If Len(lname) >= 9 Then`,
    `    If Right(lname, 9) = "-tray.ps1" Then`,
    `      matchName = f.Name`,
    `      matchCount = matchCount + 1`,
    `    End If`,
    `  End If`,
    `Next`,
    `WScript.Echo matchName & "|" & matchCount`,
  ].join("\r\n");
  const probePath = join(ROOT, ".launcher-discovery-probe.vbs");
  writeFileSync(probePath, probe);
  try {
    const r = Bun.spawnSync(["cscript", "//NoLogo", probePath], { cwd: ROOT });
    const out = (r.stdout?.toString() ?? "").trim();
    must(r.exitCode === 0, `discovery probe failed (exit ${r.exitCode}): ${(r.stderr?.toString() ?? "").trim()}`);
    const [matchName, matchCount] = out.split("|");
    must(matchName === "RepoYeti-Tray.ps1", `Tray-Launch.vbs's discovery rule would resolve "${matchName}", not RepoYeti-Tray.ps1`);
    must(matchCount === "1", `Tray-Launch.vbs's discovery rule found ${matchCount} *-Tray.ps1 candidates in misc/, expected exactly 1`);
  } finally {
    try {
      unlinkSync(probePath);
    } catch {}
  }
});
