/**
 * The per-install HMAC signing key, and the sign/unsign primitives built on it.
 *
 * Extracted from auth.ts so that BOTH auth.ts (owner sessions, the local bypass, OAuth `state`)
 * and share/index.ts (guest cookies) can sign cookies without importing each other — auth.ts's
 * gate has to read a guest cookie, and share/index.ts has to sign one, which as a single module
 * pair would be an import cycle. auth.ts re-exports `sign`/`unsign`/`rotateKey` unchanged, so this
 * split is invisible to every existing caller.
 *
 * One key signs everything, which is what makes rotateKey() a true "sign out everywhere": owner
 * sessions, local bypasses, and share-link cookies all stop verifying at once. (A share link's
 * REVOCATION doesn't need this hammer — that's a row in `shares`, see share/index.ts.)
 */
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "./config.ts";

// ── signing key (persisted so sessions survive a restart) ──────────────────────
let KEY: Buffer | null = null;
export function key(): Buffer {
  if (KEY) return KEY;
  ensureConfigDir();
  const p = join(CONFIG_DIR, "session.key");
  if (existsSync(p)) {
    KEY = Buffer.from(readFileSync(p, "utf8").trim(), "hex");
  } else {
    KEY = randomBytes(32);
    writeFileSync(p, KEY.toString("hex"), { mode: 0o600 });
  }
  return KEY;
}

/** @internal exported for security tests only — not part of the public API. */
export function sign(payload: string, secret?: Buffer): string {
  const body = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", secret ?? key()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** @internal exported for security tests only — not part of the public API. */
export function unsign(token: string | undefined, secret?: Buffer): string | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret ?? key()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(body, "base64url").toString();
}

/**
 * Rotate the HMAC signing key — the "sign out everywhere" primitive. Sessions are stateless
 * signed cookies (no server-side session store to revoke), so regenerating the key instantly
 * invalidates EVERY existing `gm_session` (and `gm_local` bypass, and `ry_share` guest) cookie on
 * every device: the next request fails `unsign` and is treated as unauthenticated. The new key is
 * persisted so it survives a restart. A login in flight when this fires just fails state
 * verification and the user retries. Returns the new key (for symmetry/testing).
 */
export function rotateKey(): Buffer {
  ensureConfigDir();
  const fresh = randomBytes(32);
  writeFileSync(join(CONFIG_DIR, "session.key"), fresh.toString("hex"), { mode: 0o600 });
  KEY = fresh;
  return fresh;
}
