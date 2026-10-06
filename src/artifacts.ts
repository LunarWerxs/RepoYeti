/**
 * Cloudflare Artifacts remotes: short-lived, repo-scoped git tokens minted per operation.
 *
 * Artifacts (developers.cloudflare.com/artifacts) is Cloudflare's git-speaking repository store.
 * Every repo is an ordinary smart-HTTP remote,
 *
 *     https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git
 *
 * so fetch, pull, push and clone already work against one, except for authentication. Git there
 * does not take a Cloudflare login. It takes a repo token that the control-plane API mints for ONE
 * repo, ONE scope (read or write) and a bounded lifetime. The documented way to hand one to git is
 * to paste it into the remote URL, which writes a live credential into .git/config, where it
 * outlives its purpose and gets quoted back by every git error that echoes the URL.
 *
 * Instead the owner gives RepoYeti one Cloudflare API token (Account > Artifacts > Edit) in
 * Settings. It lives in the OS keychain and never reaches git. Each network op asks the API for a
 * repo token covering exactly the repo and scope it needs (read for fetch/pull/clone, write for a
 * push), and that token rides the same host-scoped credential helper a GitHub token does (see
 * git.ts credentialConfigArgs): only that one git child sees it, only through its environment,
 * and only for the artifacts host it was minted for. A read-scope token is not just tidiness:
 * measured against a live repo (2026-10-05), Artifacts answers a push made with one with 403
 * "Insufficient permissions", so a fetch can never be turned into a write.
 *
 * Minted tokens are kept in memory only, until ten minutes before they expire. The background sync
 * round fetches every repo on a timer (five minutes by default), and minting per fetch would put a
 * control-plane call, and a live token at Cloudflare, behind every one of them.
 */
import { gitHubAuth, type GitHubAuth } from "./git.ts";
import { getSecret, CLOUDFLARE_API_TOKEN } from "./secrets.ts";

/** What the git operation will do: read covers fetch/pull/clone, write adds push. */
export type ArtifactsAccess = "read" | "write";

/** One Artifacts repo, as named by its remote URL. */
interface ArtifactsRepository {
  /** `<account>.artifacts.cloudflare.net`, lower-cased: the only host its token may go to. */
  host: string;
  accountId: string;
  namespace: string;
  repo: string;
}

/** A Cloudflare account id is 32 lowercase hex, and the remote's hostname is where it lives. */
const HOST_RE = /^([0-9a-f]{32})\.artifacts\.cloudflare\.net$/;
/**
 * Namespace and repo names: a letter or digit, then letters, digits, `.`, `_` or `-` (the
 * platform's own naming limit). Checked because both are interpolated into the API path.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/**
 * The token secret goes into git's credential protocol as `password=<secret>\n`. A newline in it
 * would let the API's answer write extra credential lines (another username, another host), so
 * anything outside this alphabet is refused rather than passed on. Deliberately not the documented
 * `art_v1_<40 hex>` shape: the live API already issues `art_v2_x_<40 hex>`.
 */
const SECRET_RE = /^[A-Za-z0-9_]{16,200}$/;

const API_BASE = "https://api.cloudflare.com/client/v4";
/** Lifetime asked for. One hour, so a timer fetch every five minutes mints once an hour. */
const TOKEN_TTL_S = 3600;
/** Reuse a cached token only while this much life is left: a slow push must not outlive it. */
const REUSE_MARGIN_MS = 10 * 60_000;
const MINT_TIMEOUT_MS = 15_000;

/** True when `host` (as a URL's `host`, lower-cased or not) is an Artifacts git host. */
export function isArtifactsHost(host: string): boolean {
  return HOST_RE.test(host.toLowerCase());
}

/** The Artifacts repo an https remote URL names, or null for any other URL. */
function artifactsRepository(url: string): ArtifactsRepository | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.host.toLowerCase();
  const accountId = HOST_RE.exec(host)?.[1];
  if (!accountId) return null;
  const [prefix, namespace = "", rawRepo = "", ...rest] = parsed.pathname.split("/").filter(Boolean);
  const repo = rawRepo.replace(/\.git$/i, "");
  if (prefix !== "git" || rest.length > 0 || !NAME_RE.test(namespace) || !NAME_RE.test(repo)) return null;
  return { host, accountId, namespace, repo };
}

interface MintedToken {
  secret: string;
  expiresAtMs: number;
}

/**
 * Minted repo tokens, the one deliberate exception to "tokens are never cached" (docs/ARCHITECTURE.md
 * § Secrets). That rule is about long-lived credentials, and the API token below still follows it:
 * it is read from the keychain immediately before each mint and never kept. These are RepoYeti's
 * own short-lived tokens (one repo, one scope, an hour at most), and not caching them would mint one
 * per background fetch.
 */
const minted = new Map<string, MintedToken>();

function cacheKey(ref: ArtifactsRepository, access: ArtifactsAccess): string {
  return `${ref.accountId}/${ref.namespace}/${ref.repo}/${access}`;
}

async function loadApiToken(): Promise<string | null> {
  return (await getSecret(CLOUDFLARE_API_TOKEN))?.trim() || null;
}

/**
 * Drop every repo token minted so far. The Settings route calls this whenever the API token is saved
 * or cleared, so removing it takes effect on the next operation rather than an hour later when the
 * last cached repo token expires.
 */
export function forgetArtifactsCredentials(): void {
  minted.clear();
}

/** Expiry from the token's own `?expires=<unix seconds>` suffix, else the API's `expires_at`. */
function expiryMs(plaintext: string, expiresAt: unknown): number | null {
  const suffix = /[?&]expires=(\d{9,12})(?:&|$)/.exec(plaintext)?.[1];
  if (suffix) return Number(suffix) * 1000;
  const parsed = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Cloudflare's token API did not answer: a network error, the mint timeout, a 429 or a 5xx.
 *
 * Thrown rather than returned as null, because null means "run git with no credential", and the
 * "could not read Username" that follows is classified as ARTIFACTS_NOT_AUTHORIZED, which tells the
 * owner to replace a saved token that was never the problem. A review of the first version found
 * exactly that (2026-10-05): every background fetch during a Cloudflare outage said "add a token in
 * Settings". Callers turn this into an ARTIFACTS_UNAVAILABLE result and do not run git at all.
 */
export class ArtifactsUnavailableError extends Error {}

/** The ARTIFACTS_UNAVAILABLE result for an ArtifactsUnavailableError, or null for any other error. */
export function artifactsOutage(err: unknown): { ok: false; code: "ARTIFACTS_UNAVAILABLE"; message: string } | null {
  return err instanceof ArtifactsUnavailableError
    ? { ok: false, code: "ARTIFACTS_UNAVAILABLE", message: err.message }
    : null;
}

function unavailable(why: string): ArtifactsUnavailableError {
  return new ArtifactsUnavailableError(
    `Cloudflare's token API is not answering (${why}), so this Artifacts repo got no token; the saved API token was not refused, try again shortly`,
  );
}

async function mint(
  ref: ArtifactsRepository,
  access: ArtifactsAccess,
  apiToken: string,
): Promise<MintedToken | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/accounts/${ref.accountId}/artifacts/namespaces/${ref.namespace}/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: ref.repo, scope: access, ttl: TOKEN_TTL_S }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch (err) {
    throw unavailable(
      err instanceof Error && err.name === "TimeoutError"
        ? `no answer in ${MINT_TIMEOUT_MS / 1000}s`
        : "api.cloudflare.com could not be reached",
    );
  }
  // Busy or broken on Cloudflare's side. Any other refusal (401, 403, 404) is about the token or
  // the repo, and falls through to null and ARTIFACTS_NOT_AUTHORIZED.
  if (res.status === 429 || res.status >= 500) throw unavailable(`HTTP ${res.status}`);
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    result?: { plaintext?: unknown; expires_at?: unknown };
  } | null;
  const plaintext = body?.result?.plaintext;
  if (typeof plaintext !== "string") return null;
  const secret = plaintext.split("?")[0] ?? "";
  if (!SECRET_RE.test(secret)) return null;
  const expiresAtMs = expiryMs(plaintext, body?.result?.expires_at) ?? Date.now() + TOKEN_TTL_S * 1000;
  return { secret, expiresAtMs };
}

/**
 * The per-operation credential for an Artifacts remote, or null to leave the operation as it was.
 *
 * Best-effort like the GitHub path: no saved API token, or a token the API refuses, returns null,
 * and git then fails on its own with a "could not read Username" that sync.ts classifies as
 * ARTIFACTS_NOT_AUTHORIZED, pointing the owner at Settings. The API not answering is the one
 * exception: it throws ArtifactsUnavailableError, because Settings is not where that gets fixed.
 *
 * Each scope has its own cached token. A cached write token would also serve a fetch, and an
 * earlier draft let it, which quietly put a push-capable token in every fetch for the hour after a
 * push. One extra mint per repo per hour is the price of a fetch never holding write access.
 *
 * The API token is read from the keychain before the cache is consulted, even when a cached repo
 * token would do. Settings clears the cache itself, but an owner who deletes the entry in the OS's
 * own keychain manager would otherwise keep pushing on cached tokens for up to fifty minutes.
 */
export async function artifactsAuthFor(url: string, access: ArtifactsAccess): Promise<GitHubAuth | null> {
  const ref = artifactsRepository(url);
  if (!ref) return null;
  const apiToken = await loadApiToken();
  if (!apiToken) return null;
  const cached = minted.get(cacheKey(ref, access));
  if (cached && cached.expiresAtMs - Date.now() > REUSE_MARGIN_MS) return gitHubAuth(ref.host, "x", cached.secret);

  const fresh = await mint(ref, access, apiToken);
  if (!fresh) return null;
  minted.set(cacheKey(ref, access), fresh);
  // Artifacts ignores the Basic-auth username, but git's credential protocol needs one.
  return gitHubAuth(ref.host, "x", fresh.secret);
}

/** Whether a Cloudflare API token is saved, for the Settings panel. Never the token itself. */
export async function artifactsTokenSaved(): Promise<boolean> {
  return (await loadApiToken()) !== null;
}
