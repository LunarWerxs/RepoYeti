/**
 * GitHub CLI (`gh`) account bridge — read and switch the machine's ACTIVE GitHub account.
 *
 * RepoYeti's *identities* inject a commit author (user.name/email + SSH key) PER git op and never
 * mutate global config (see git.ts identityConfigArgs). This module is the deliberate exception, and
 * it's about AUTH, not authorship: it drives the system's `gh` active account — which is what push /
 * pull, and any external tool that uses git's `gh auth git-credential` helper (a terminal, an AI
 * agent), authenticates as. Switching is two steps:
 *
 *   1. `gh auth switch --hostname <host> --user <login>` — flip gh's active account.
 *   2. `git config --global credential.https://<host>.username <login>` — align the credential
 *      username pin. Without this a lingering pin (or a username baked into a remote URL) makes git's
 *      helper keep serving the OLD account's token, so the switch silently doesn't "stick". Only for
 *      https accounts — ssh auth never consults the credential helper.
 *
 * TOKEN MATERIAL. `accountsSnapshot`/`switchGhAccount` never pass `--show-token`, so no token
 * crosses that path. `ghTokenFor` below is the deliberate, narrow exception — see its comment for
 * why per-repo sync could not be built without it, and what is done to keep the blast radius small.
 */
import { createSemaphore } from "./gitgate.ts";
import { safeGitEnv } from "./git.ts";
import { readTextStreamLimited } from "./process-output.ts";

interface RunResult {
  /** The binary was found and launched (false ⇒ e.g. `gh` not on PATH). */
  spawned: boolean;
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Account discovery can sit in front of a bulk fetch across thousands of repositories. Bound every
 * `gh`/global-git child launched by this module so a cold cache or several permission probes cannot
 * exhaust the machine's process table before the network gate gets a chance to help.
 */
const accountCliConcurrency = (() => {
  const configured = Number(process.env.REPOYETI_ACCOUNT_CLI_CONCURRENCY);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 4;
})();
const accountCliGate = createSemaphore(accountCliConcurrency);

async function run(
  cmd: string[],
  timeoutMs = 5000,
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  return accountCliGate.run(async () => {
    try {
      // safeGitEnv(), not raw process.env. This module is the ONE place RepoYeti writes the
      // machine's GLOBAL git author (`git config --global user.name/user.email`), and an
      // inherited GIT_CONFIG_GLOBAL / GIT_CONFIG_PARAMETERS would silently redirect that write
      // somewhere else. Editors really do export these: git.ts's own header notes VS Code,
      // Claude Code and GitHub Desktop all set GIT_ASKPASS in the terminals they open, which is
      // exactly how a daemon launched from an editor gets a polluted environment. Every other
      // git/gh spawn in this codebase already scrubs; this one did not.
      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...safeGitEnv(), ...(extraEnv ?? {}) },
      });
      let limited = false;
      const kill = (): void => {
        try {
          proc.kill();
        } catch {
          /* already exited */
        }
      };
      const timer = setTimeout(kill, timeoutMs);
      try {
        const onLimit = (): void => {
          limited = true;
          kill();
        };
        const [stdout, stderr, code] = await Promise.all([
          readTextStreamLimited(proc.stdout, 4 * 1024 * 1024, onLimit),
          readTextStreamLimited(proc.stderr, 1024 * 1024, onLimit),
          proc.exited,
        ]);
        return {
          spawned: true,
          ok: code === 0 && !limited,
          stdout: stdout.text.trim(),
          stderr: limited
            ? `${stderr.text}\ncommand output exceeded the daemon limit`.trim()
            : stderr.text.trim(),
        };
      } finally {
        clearTimeout(timer);
        kill();
        await proc.exited.catch(() => undefined);
      }
    } catch {
      // Bun.spawn throws synchronously when the executable can't be found.
      return { spawned: false, ok: false, stdout: "", stderr: "" };
    }
  });
}

/** One authenticated GitHub account on the machine (a `gh` account for a host). */
export interface GhAccount {
  host: string;
  login: string;
  active: boolean;
  /** "https" | "ssh" | "" — how git talks to this host for this account. */
  gitProtocol: string;
  /** Token scopes, split from gh's comma-joined string (never the token itself). */
  scopes: string[];
}

/** The machine's gh account state + the git commit author currently in effect. */
export interface AccountsSnapshot {
  /** The `gh` CLI is installed and reachable. */
  ghAvailable: boolean;
  accounts: GhAccount[];
  /**
   * The GLOBAL git author (user.name / user.email) in effect. Display-only: switching the active
   * account changes authentication, NOT who commits are attributed to — RepoYeti attributes its own
   * commits via per-repo identities, and other tools use whatever this global author is.
   */
  commitIdentity: { name: string; email: string };
}

/**
 * Parse `gh auth status --json hosts` into a flat account list. Pure + tolerant: unknown shape,
 * empty, or non-JSON input yields `[]`. Only ever reads display fields — never a token.
 */
export function parseGhAccounts(json: string): GhAccount[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const hosts = (data as { hosts?: unknown } | null)?.hosts;
  if (!hosts || typeof hosts !== "object") return [];

  const out: GhAccount[] = [];
  for (const [host, entries] of Object.entries(hosts as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      const e = raw as Record<string, unknown>;
      const login = typeof e.login === "string" ? e.login : "";
      if (!login) continue;
      out.push({
        host: typeof e.host === "string" ? e.host : host,
        login,
        active: e.active === true,
        gitProtocol: typeof e.gitProtocol === "string" ? e.gitProtocol : "",
        scopes:
          typeof e.scopes === "string"
            ? e.scopes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
      });
    }
  }
  return out;
}

/** Read the global git author (best-effort; empty strings when unset). */
export async function readGitCommitIdentity(): Promise<{ name: string; email: string }> {
  const [name, email] = await Promise.all([
    run(["git", "config", "--global", "--get", "user.name"], 2000),
    run(["git", "config", "--global", "--get", "user.email"], 2000),
  ]);
  return { name: name.stdout, email: email.stdout };
}

/**
 * Short-lived memo of the account snapshot. Contains NO secrets — logins, hosts, scope names and
 * the global git author, all of which `gh auth status` prints to a terminal — so unlike a token it
 * is safe to hold (see ghTokenFor's note on why the token deliberately is not).
 *
 * It exists because this is now on the path of every network op: "Fetch all" across 50 repos would
 * otherwise run `gh auth status` plus two `git config` reads 50 times over. The window is small
 * enough that an account added in another terminal shows up promptly, and any switch made through
 * RepoYeti invalidates it outright.
 */
const SNAPSHOT_TTL_MS = 10_000;
let snapshotMemo: { at: number; value: AccountsSnapshot } | null = null;
let snapshotGeneration = 0;
let snapshotInFlight: { generation: number; promise: Promise<AccountsSnapshot> } | null = null;

/** Drop the memo — call after anything that changes gh's account state. */
export function invalidateAccountsSnapshot(): void {
  snapshotGeneration++;
  snapshotMemo = null;
  // Do not let a caller after invalidation join a read that began against the old account state.
  // The old promise is allowed to finish for its existing callers, but its generation guard below
  // prevents it from repopulating the memo.
  snapshotInFlight = null;
}

/** Read the current account snapshot (gh accounts + which is active + the global git author). */
export async function accountsSnapshot(): Promise<AccountsSnapshot> {
  const memo = snapshotMemo;
  if (memo && Date.now() - memo.at < SNAPSHOT_TTL_MS) return memo.value;
  const existing = snapshotInFlight;
  if (existing && existing.generation === snapshotGeneration) return existing.promise;

  const generation = snapshotGeneration;
  const promise = (async (): Promise<AccountsSnapshot> => {
    const [status, commitIdentity] = await Promise.all([
      run(["gh", "auth", "status", "--json", "hosts"], 6000),
      readGitCommitIdentity(),
    ]);
    // gh prints the JSON to stdout on success; fall back to stderr defensively.
    const accounts = parseGhAccounts(status.stdout || status.stderr);
    const value = { ghAvailable: status.spawned, accounts, commitIdentity };
    // An explicit invalidation may have happened while the subprocesses were running. Never let
    // that now-stale result overwrite the fresh generation's state.
    if (snapshotGeneration === generation) snapshotMemo = { at: Date.now(), value };
    return value;
  })();
  snapshotInFlight = { generation, promise };
  try {
    return await promise;
  } finally {
    if (snapshotInFlight?.promise === promise) snapshotInFlight = null;
  }
}

/**
 * A GitHub login as `gh` reports it. Restricted to GitHub's own alphabet because this value is
 * interpolated into a `-c credential.helper=...` shell snippet (see credentialConfigArgs in git.ts);
 * anything outside this set is refused rather than escaped.
 */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function isValidLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

/**
 * The token for ONE account, active or not.
 *
 * WHY THIS EXISTS: `gh auth git-credential` only ever serves gh's ACTIVE account. Asked for any
 * other login it declines — even when gh holds a perfectly good token for it — which is exactly
 * why a repo pinned to a non-active account failed to sync with "could not read Password". The
 * only alternatives were to flip the machine's active account around every network op (a global
 * side effect, racy across concurrent ops, and visible to every other tool on the machine) or to
 * fetch the one token we need and hand it to that single git invocation. This is the latter.
 *
 * BLAST RADIUS: the value is returned to callers that put it in a CHILD PROCESS ENV and nowhere
 * else — never argv (world-readable in a process list), never disk, never a log line, never an
 * HTTP response. It is already obtainable by anything running as this user (`gh auth token`), so
 * holding it for the duration of one fetch does not lower the bar for an attacker already inside
 * that boundary.
 *
 * DELIBERATELY NOT CACHED. Caching would be the obvious optimisation, and ARCHITECTURE.md's Secrets
 * section rules it out for exactly this class of value: a git credential is "resolved into a process
 * env var immediately before the git subprocess call, never assigned to a module-level variable".
 * A cache is a module-level variable holding a live credential, so the token is re-read per
 * operation. The cost that motivated caching is paid off elsewhere instead — accountsSnapshot()
 * memoises the account LIST, which holds no secrets and was the heavier of the two calls.
 */
export async function ghTokenFor(host: string, login: string): Promise<string | null> {
  if (!isValidLogin(login)) return null;
  const res = await run(["gh", "auth", "token", "--hostname", host, "--user", login], 5000);
  // gh prints the token on stdout; a failure prints guidance on stderr, which we never surface.
  return (res.ok && res.stdout.trim()) || null;
}

/**
 * Whether one authenticated account can push to one GitHub repository.
 *
 * This is the evidence org-owned remotes cannot carry in their URL: `github.com/acme/widget`
 * names the organization, not the human account whose token has write access. The token is read
 * immediately before the probe and exists only in the `gh api` child's environment. The memo stores
 * only the non-secret boolean result, which avoids repeating three API calls for the pull→push pair.
 *
 * `null` means the permission could not be determined (no token, network/API failure, unexpected
 * response). Callers must not treat an unknown as permission.
 */
const REPO_PERMISSION_TTL_MS = 60_000;
const repoPermissionMemo = new Map<string, { at: number; value: boolean }>();
const repoPermissionInFlight = new Map<string, Promise<boolean | null>>();

export async function ghRepoCanPush(
  host: string,
  login: string,
  owner: string,
  repo: string,
): Promise<boolean | null> {
  if (!isValidLogin(login) || !owner || !repo) return null;
  const key = `${host.toLowerCase()}\0${login.toLowerCase()}\0${owner.toLowerCase()}\0${repo.toLowerCase()}`;
  const memo = repoPermissionMemo.get(key);
  if (memo && Date.now() - memo.at < REPO_PERMISSION_TTL_MS) return memo.value;
  if (memo) repoPermissionMemo.delete(key);

  // A pull and push (or two repos pointing at the same GitHub repository) can arrive together.
  // Share the read-only probe while it is active; unlike a result cache, this promise lives only
  // until the child exits and never stores token material after the operation.
  const existing = repoPermissionInFlight.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<boolean | null> => {
    const token = await ghTokenFor(host, login);
    if (!token) return null;
    const endpoint = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const res = await run(
      ["gh", "api", "--hostname", host, endpoint, "--jq", ".permissions.push"],
      8000,
      { GH_TOKEN: token },
    );
    const output = res.stdout.trim().toLowerCase();
    if (!res.ok || (output !== "true" && output !== "false")) return null;

    const value = output === "true";
    // Bound an otherwise long-lived daemon's cache without retaining token material or repo data
    // indefinitely. Clearing merely causes fresh read-only probes on the next operation.
    if (repoPermissionMemo.size >= 512) repoPermissionMemo.clear();
    repoPermissionMemo.set(key, { at: Date.now(), value });
    return value;
  })();
  repoPermissionInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (repoPermissionInFlight.get(key) === promise) repoPermissionInFlight.delete(key);
  }
}

export type SwitchResult =
  | { ok: true; snapshot: AccountsSnapshot }
  | { ok: false; code: "NOT_CONFIGURED" | "NOT_FOUND" | "ERROR"; message: string };

/** Set the GLOBAL git author (best-effort; skips an empty field). */
async function applyGlobalAuthor(author: { name: string; email: string }): Promise<void> {
  if (author.name) await run(["git", "config", "--global", "user.name", author.name], 3000);
  if (author.email) await run(["git", "config", "--global", "user.email", author.email], 3000);
}

/**
 * Switch the machine's active GitHub account for `host`, then align the https credential username
 * pin so git actually authenticates as the new account. Validates `login` against the live account
 * list first (a clean 404 for a typo, and never a bogus pin). A no-op when it's already active.
 *
 * When `applyAuthor` is given (the account is linked to a saved identity), the global git author
 * (user.name / user.email) is also set — so commits land under the switched-to account too. This is
 * the ONE place RepoYeti writes the global author, and only on an explicit, owner-linked switch.
 */
export async function switchGhAccount(
  host: string,
  login: string,
  applyAuthor?: { name: string; email: string } | null,
): Promise<SwitchResult> {
  invalidateAccountsSnapshot(); // decide against live state, not a memo from a moment ago
  const before = await accountsSnapshot();
  if (!before.ghAvailable) {
    return { ok: false, code: "NOT_CONFIGURED", message: "GitHub CLI (gh) is not installed or not on PATH" };
  }
  const target = before.accounts.find((a) => a.host === host && a.login === login);
  if (!target) {
    return { ok: false, code: "NOT_FOUND", message: `No authenticated GitHub account "${login}" on ${host}` };
  }
  if (target.active) {
    // Already active — no switch needed, but still honor a linked author so it stays in sync.
    if (applyAuthor) {
      await applyGlobalAuthor(applyAuthor);
      return { ok: true, snapshot: await accountsSnapshot() };
    }
    return { ok: true, snapshot: before };
  }

  const switched = await run(["gh", "auth", "switch", "--hostname", host, "--user", login], 8000);
  invalidateAccountsSnapshot(); // the active flag just moved; never serve the pre-switch view
  if (!switched.ok) {
    return { ok: false, code: "ERROR", message: switched.stderr || switched.stdout || "gh auth switch failed" };
  }
  // Keep git's credential helper resolving to the new account (https only — ssh skips the helper).
  if (target.gitProtocol === "https") {
    await run(["git", "config", "--global", `credential.https://${host}.username`, login], 3000);
  }
  if (applyAuthor) await applyGlobalAuthor(applyAuthor);
  return { ok: true, snapshot: await accountsSnapshot() };
}
