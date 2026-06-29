// ───────────────────────────────────────────────────────────────────────────────
// Hardcore guard for the one-click launcher. The promise to a user is: there is
// ALWAYS a clickable shortcut in the project root that, when run, boots the daemon
// and shows the tray icon. These tests fail LOUD ("thou shalt not pass") the moment
// any link in that chain is missing, uncommitted, mis-wired, or the icon is broken.
//
// The chain:  GitMob.lnk (root)  →  wscript  →  misc/GitMob.vbs  →
//             misc/GitMob-Tray.ps1  →  bun src/index.ts start  +  misc/GitMob.ico
//
// The .lnk itself is gitignored (it stores absolute, per-machine paths), so the
// guarantee is enforced via the COMMITTED machinery that regenerates it
// (Create-Shortcut.ps1) — and, on Windows, by actually regenerating + resolving it
// and by running the tray's headless self-test.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
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
const REQUIRED = ["Create-Shortcut.ps1", "GitMob.vbs", "GitMob-Tray.ps1", "GitMob.ico"] as const;

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
  const buf = readFileSync(join(MISC, "GitMob.ico"));
  // ICO header: reserved=0x0000, type=0x0001(icon), count>=1.
  const headerOk = buf.length > 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0;
  const count = buf.length > 6 ? buf[4]! | (buf[5]! << 8) : 0;
  must(headerOk && count >= 1, `misc/GitMob.ico is not a valid icon (bad header / 0 images) — the tray icon would be broken`);
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
    `misc/GitMob.ico has no small (<=48px) frame (frames: ${frames.join(",")}) — a 256-only icon renders blank in the tray`,
  );
});

test("launcher chain is wired: shortcut → wscript → GitMob.vbs → GitMob-Tray.ps1 → daemon + icon", () => {
  const cs = read(join(MISC, "Create-Shortcut.ps1"));
  must(/wscript/i.test(cs), "Create-Shortcut.ps1 doesn't launch via wscript");
  must(/GitMob\.vbs/.test(cs), "Create-Shortcut.ps1 doesn't point the shortcut at GitMob.vbs");
  must(/GitMob\.ico/.test(cs), "Create-Shortcut.ps1 doesn't set the tray icon");
  must(/GitMob\.lnk/.test(cs), "Create-Shortcut.ps1 doesn't write a GitMob.lnk in the root");

  const vbs = read(join(MISC, "GitMob.vbs"));
  must(/GitMob-Tray\.ps1/.test(vbs), "GitMob.vbs doesn't launch the tray host GitMob-Tray.ps1");

  const tray = read(join(MISC, "GitMob-Tray.ps1"));
  must(/src[\\/]index\.ts/.test(tray), "GitMob-Tray.ps1 doesn't start the daemon (src/index.ts)");
  must(/\bstart\b/.test(tray), "GitMob-Tray.ps1 doesn't run the daemon's 'start' command");
  must(/GitMob\.ico/.test(tray), "GitMob-Tray.ps1 doesn't load the tray icon GitMob.ico");
});

// ── Windows-only runtime proofs (the tray is Windows-only) ────────────────────────

test.skipIf(!isWin)("tray self-test passes: bun on PATH + daemon entry + the icon LOADS into a real NotifyIcon", () => {
  const r = Bun.spawnSync(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(MISC, "GitMob-Tray.ps1"), "-SelfTest"],
    { cwd: ROOT },
  );
  const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
  must(out.includes("GITMOB_TRAY_SELFTEST_OK"), `the tray self-test did not pass:\n${out.trim()}`);
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

  const lnk = join(ROOT, "GitMob.lnk");
  must(existsSync(lnk), "no GitMob.lnk in the project root after running Create-Shortcut.ps1");

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
  must(/GitMob\.vbs/i.test(info.args), `shortcut doesn't launch GitMob.vbs: ${info.args}`);
  must(info.vbsExists, "shortcut points at a GitMob.vbs that doesn't exist");
  must(info.iconExists, "shortcut's tray icon (GitMob.ico) doesn't exist");
  expect(info.iconExists && info.vbsExists).toBe(true);
});
