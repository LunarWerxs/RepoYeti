/**
 * Make "owner-only" mean owner-only on Windows too.
 *
 * `writeFileSync(p, …, { mode: 0o600 })` is a POSIX permission bit. On NTFS it is very nearly a
 * no-op: Node maps only the write bit onto the read-only ATTRIBUTE, and grants nothing and denies
 * nothing in the file's ACL. So a file this codebase writes as "0600" inherits whatever its parent
 * directory hands out. Under a default `%USERPROFILE%` that inheritance is already restrictive,
 * which is why this has never bitten — but it is inheritance doing the work, not us, and it stops
 * being true on a shared machine, on a relocated `REPOYETI_HOME`, or in any directory whose ACL
 * somebody has loosened.
 *
 * That matters for exactly two files, and they are the two that matter most: the HMAC key that
 * signs every owner session, local bypass and share cookie (src/signing.ts), and the plaintext
 * config fallback used when the OS keychain is unavailable (src/config.ts).
 *
 * `icacls` is the only way to do this without a native addon. Best-effort by design: a failure
 * here must never stop the daemon from starting, and the file is no worse off than before.
 */
import { spawnSync } from "node:child_process";

/**
 * Restrict `path` to the current user (plus SYSTEM, which is needed for backup/AV and cannot
 * meaningfully be excluded anyway). No-op off win32, where the `mode` argument already works.
 *
 * `/inheritance:r` is the load-bearing flag: without it the inherited grants stay and the added
 * ACE is additive, which restricts nothing.
 */
export function restrictToCurrentUser(path: string): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    spawnSync(
      "icacls",
      [path, "/inheritance:r", "/grant:r", `${user}:F`, "/grant:r", "*S-1-5-18:F"],
      { stdio: "ignore", windowsHide: true, timeout: 5000 },
    );
  } catch {
    /* best-effort: an unrestricted file is what we had before, not a reason to fail startup */
  }
}
