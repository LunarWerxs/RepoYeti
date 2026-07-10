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
 * We never pass `--show-token`, so no token material ever crosses this boundary.
 */

interface RunResult {
  /** The binary was found and launched (false ⇒ e.g. `gh` not on PATH). */
  spawned: boolean;
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], timeoutMs = 5000): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { spawned: true, ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    // Bun.spawn throws synchronously when the executable can't be found.
    return { spawned: false, ok: false, stdout: "", stderr: "" };
  }
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

/** Read the current account snapshot (gh accounts + which is active + the global git author). */
export async function accountsSnapshot(): Promise<AccountsSnapshot> {
  const [status, commitIdentity] = await Promise.all([
    run(["gh", "auth", "status", "--json", "hosts"], 6000),
    readGitCommitIdentity(),
  ]);
  // gh prints the JSON to stdout on success; fall back to stderr defensively.
  const accounts = parseGhAccounts(status.stdout || status.stderr);
  return { ghAvailable: status.spawned, accounts, commitIdentity };
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
