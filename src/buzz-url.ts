/** Pure Buzz URL/config normalization shared by config persistence and the runtime adapter. */

export interface NormalizedBuzzCommunity {
  id: string;
  name: string;
  url: string;
  gitUrl?: string;
}

/** Buzz community URLs are public HTTP(S)/WebSocket relay addresses, never credential-bearing. */
export function normalizeBuzzPublicUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    if (url.username || url.password || !url.hostname) return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** A diagnostic repository must be a public HTTP(S) Buzz Smart HTTP path. */
export function normalizeBuzzGitUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password || !url.hostname) return null;
    if (!/^\/git\/[^/]+\/[^/]+(?:\.git)?\/?$/i.test(url.pathname)) return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * A preflight repository must belong to the saved community origin. NIP-98 signs the requested
 * method + URL; accepting an unrelated host here would let a community entry aim the owner's
 * system Nostr identity at a third party. WebSocket relay schemes map to their HTTP equivalents.
 */
export function buzzGitUrlMatchesCommunity(communityUrl: string, gitUrl: string): boolean {
  const normalizedCommunity = normalizeBuzzPublicUrl(communityUrl);
  const normalizedGit = normalizeBuzzGitUrl(gitUrl);
  if (!normalizedCommunity || !normalizedGit) return false;
  const community = new URL(normalizedCommunity);
  if (community.protocol === "ws:") community.protocol = "http:";
  if (community.protocol === "wss:") community.protocol = "https:";
  return community.origin === new URL(normalizedGit).origin;
}

/**
 * Strict public projection for untrusted/legacy config JSON. Invalid entries disappear, invalid or
 * cross-origin diagnostic Git URLs are omitted, and collection/field sizes stay bounded.
 */
export function normalizeBuzzCommunities(value: unknown): NormalizedBuzzCommunity[] {
  if (!Array.isArray(value)) return [];
  const normalized: NormalizedBuzzCommunity[] = [];
  for (const candidate of value.slice(0, 100)) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 128) continue;
    if (typeof raw.name !== "string" || raw.name.length > 100) continue;
    if (typeof raw.url !== "string") continue;
    const url = normalizeBuzzPublicUrl(raw.url);
    if (!url) continue;
    const gitUrl = typeof raw.gitUrl === "string" ? normalizeBuzzGitUrl(raw.gitUrl) : null;
    normalized.push({
      id: raw.id,
      name: raw.name.trim() || new URL(url).host,
      url,
      ...(gitUrl && buzzGitUrlMatchesCommunity(url, gitUrl) ? { gitUrl } : {}),
    });
  }
  return normalized;
}
