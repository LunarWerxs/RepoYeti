/**
 * Identity Firewall glob matcher — the ONE implementation, shared by the daemon (src/identity.ts,
 * which enforces) and the web (web/src/lib/identity-firewall.ts, which displays). It's the
 * redaction/enforcement layer, so client/server drift here is security-relevant — never fork it.
 *
 * Dependency-free and runtime-agnostic. The ONLY syntax supported is what the Settings rules
 * editor needs: `*` (anything except a path separator), `**` (anything, including separators),
 * and `?` (one non-separator character). No brace-expansion, no character classes — `[`, `]`,
 * `{`, `}` and every other regex metacharacter match themselves literally. Paths are normalized
 * to forward slashes and compared case-insensitively (Windows paths are case-insensitive; a
 * case-sensitive host still gets a reasonable match).
 */

/** Compile a glob pattern into a RegExp. `**` → `.*`; `*` → `[^/]*`; `?` → `[^/]`; everything
 *  else is escaped literally. Anchored full-string match. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").trim();
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        out += ".*";
        i++; // consume the second '*'
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/** Does `absPath` match a glob `pattern`? Both sides are normalized to forward slashes and
 *  trailing slashes trimmed, so "D:\\Work\\foo" matches "D:/Work/*". */
export function globMatch(pattern: string, absPath: string): boolean {
  if (!pattern.trim()) return false;
  const path = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return globToRegExp(pattern).test(path);
}
