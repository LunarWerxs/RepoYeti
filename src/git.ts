/**
 * One place to construct a `SimpleGit` bound to a repo with a safe, daemon-correct
 * environment. Every git invocation in repoyeti goes through here so the security and
 * watcher-friendliness seams are consistent.
 *
 *  - GIT_OPTIONAL_LOCKS=0  → read-only commands (status) never rewrite .git/index,
 *    so our own reads don't trip the .git watcher into a feedback loop.
 *  - GIT_TERMINAL_PROMPT=0 → git never blocks on an interactive credential prompt.
 *  - editor vars stripped  → no daemon op should ever open an editor; simple-git also
 *    refuses to run when GIT_EDITOR is passed in explicitly (CVE guard), so we must
 *    remove it rather than forward the ambient one.
 *
 * Phase 3 layers per-operation identity on top via `.env(GIT_SSH_COMMAND=…)` and
 * `git -c user.name/user.email` — never by mutating global or repo config.
 */
import { simpleGit, type SimpleGit } from "simple-git";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Identity } from "./db.ts";

export function safeGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.GIT_EDITOR;
  delete env.GIT_SEQUENCE_EDITOR;
  delete env.GIT_PAGER;
  delete env.PAGER;
  // Per-process config injection (`git -c` expressed through the environment). Besides being
  // rejected by simple-git's safety guard, inheriting it would let whoever launches the daemon
  // silently rewrite Git behavior for every RepoYeti operation (author, hooks, credential helper,
  // safe.directory, and more). RepoYeti supplies its own deliberate per-operation `-c` options;
  // ambient COUNT/KEY/VALUE tuples and GIT_CONFIG_PARAMETERS do not cross this boundary.
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  // We inject SSH auth via `-c core.sshCommand` per operation (see identityConfigArgs),
  // not via this env var — simple-git refuses to run with GIT_SSH_COMMAND in the env.
  delete env.GIT_SSH_COMMAND;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function gitFor(absPath: string, blockMs = 30_000, extraEnv?: Record<string, string>): SimpleGit {
  // simple-git also gates `-c credential.helper` behind an opt-in. Enable it ONLY for the
  // invocations actually carrying a token (credentialEnv put it here), so a stray
  // `credential.helper` argument on any other git call is still refused rather than blanket-allowed.
  const withCredential = extraEnv?.[GH_TOKEN_ENV] !== undefined;
  return simpleGit({
    baseDir: absPath,
    timeout: { block: blockMs },
    // We intentionally inject the identity's SSH key via `-c core.sshCommand`
    // (identityConfigArgs). simple-git blocks that by default; the value is derived
    // from the owner's own stored key path — trusted input — so we opt in here.
    unsafe: {
      allowUnsafeSshCommand: true,
      ...(withCredential ? { allowUnsafeCredentialHelper: true } : {}),
    },
  }).env({ ...safeGitEnv(), ...extraEnv });
}

/**
 * The env var a per-op GitHub token rides in.
 *
 * It is referenced BY NAME inside the credential-helper snippet, so the token itself never appears
 * in argv — where any process on the machine could read it out of a process listing. It exists only
 * in the environment of the single git child process that needs it.
 */
export const GH_TOKEN_ENV = "REPOYETI_GH_TOKEN";

/** A GitHub account's credential for one https git operation, bound to the host it is valid for. */
export interface GitHubAuth {
  /** The host this credential may be sent to, and ONLY this host. */
  host: string;
  login: string;
  token: string;
  /** Keep the token out of any accidental log line, error dump, or SSE payload. */
  toJSON?: () => string;
}

/** Wrap a host+login+token so that stringifying it can never spill the token. */
export function gitHubAuth(host: string, login: string, token: string): GitHubAuth {
  return { host, login, token, toJSON: () => `[GitHubAuth ${login}@${host}]` };
}

/**
 * Per-operation GitHub credential injection as `-c` flags — the https sibling of
 * identityConfigArgs (which covers SSH).
 *
 * Two flags, and both the order and the SCOPING matter.
 *
 * The empty `credential.helper=` RESETS the inherited helper chain, so the machine's
 * `gh auth git-credential` helper never gets a say — without it git would consult gh first and we
 * would be back to "gh only serves the active account", which is the bug this fixes.
 *
 * The second is deliberately keyed to `credential.https://<host>.helper`, NOT the bare
 * `credential.helper`. A bare helper answers every credential request the invocation makes,
 * whatever host it is for — so a single git op that touched a non-GitHub remote would be handed a
 * real GitHub token as its password, sending it to a third party. Scoping to the host makes that
 * structurally impossible rather than merely unlikely: git consults this helper only for URLs on
 * `host`, and for anything else finds no helper at all and fails closed.
 *
 * The token is read from the environment (GH_TOKEN_ENV) rather than interpolated, so it stays out
 * of argv. `login` IS interpolated, which is why gh-cli.ts refuses any login outside GitHub's
 * alphabet before we get here — that check is what makes this snippet injection-proof. The body is
 * an `if` rather than `test … &&` so the helper still exits 0 for the `store`/`erase` verbs git
 * invokes after a successful auth, instead of reporting a failing helper.
 */
export function credentialConfigArgs(auth: GitHubAuth | null): string[] {
  if (!auth) return [];
  const helper =
    `!f() { if test "$1" = get; then printf 'username=${auth.login}\\npassword=%s\\n' "$${GH_TOKEN_ENV}"; fi; }; f`;
  return ["-c", "credential.helper=", "-c", `credential.https://${auth.host}.helper=${helper}`];
}

/** The child env carrying the token for this one operation, or nothing when unauthenticated. */
export function credentialEnv(auth: GitHubAuth | null): Record<string, string> {
  return auth ? { [GH_TOKEN_ENV]: auth.token } : {};
}

/**
 * Build the per-operation SSH command for an identity.
 *  -i <key>            use exactly this key…
 *  -o IdentitiesOnly=yes …and NO other (no agent-key fallback to the wrong identity)
 *  -o BatchMode=yes    fail fast instead of hanging on a passphrase prompt
 * The key path is normalised to forward slashes (OpenSSH-friendly on Windows) and quoted.
 */
function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function sshCommandFor(keyPath: string): string {
  const expanded = expandHome(keyPath);
  if (/["'`$\r\n\0]/.test(expanded)) {
    throw new Error("SSH key path contains unsupported shell characters");
  }
  const abs = resolve(expanded);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`SSH key path is not a file: ${abs}`);
  }
  const norm = abs.replace(/\\/g, "/");
  return `ssh -i "${norm}" -o IdentitiesOnly=yes -o BatchMode=yes`;
}

/**
 * Per-operation identity injection as `-c` flags — the security-sensitive seam.
 * Prefix any remote/commit command with these so:
 *   - `core.sshCommand` selects the identity's SSH key for THIS invocation only
 *     (the config-flag equivalent of GIT_SSH_COMMAND, which simple-git blocks),
 *   - `user.name`/`user.email` attribute any commit correctly.
 * Nothing here mutates global or repo git config, and no secret is read — the SSH
 * key is referenced by path only.
 */
export function identityConfigArgs(identity: Identity | null): string[] {
  if (!identity) return [];
  const args: string[] = [];
  if (identity.sshKeyPath) args.push("-c", `core.sshCommand=${sshCommandFor(identity.sshKeyPath)}`);
  if (identity.gitUsername) args.push("-c", `user.name=${identity.gitUsername}`);
  if (identity.gitEmail) args.push("-c", `user.email=${identity.gitEmail}`);
  return args;
}

/**
 * Marker files under `.git/` that mean "mid merge/rebase/cherry-pick/revert". Shared by the
 * auto-commit safety gate (src/auto-commit.ts) and the status read (src/read/status.ts) so both
 * agree on exactly one definition of "mid git-operation" — never duplicated.
 */
export const GIT_OP_MARKERS = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"];

/** Which mid-operation marker is present (first match), or null when the repo is in a normal
 *  state. Best-effort: on any error we can't tell, so callers that need "safe by default"
 *  (auto-commit) should treat a throw/unknown as mid-operation themselves. */
export async function currentGitOperation(absPath: string): Promise<string | null> {
  try {
    const gitDir = (await gitFor(absPath).raw(["rev-parse", "--git-dir"])).trim();
    const base = isAbsolute(gitDir) ? gitDir : join(absPath, gitDir);
    return GIT_OP_MARKERS.find((m) => existsSync(join(base, m))) ?? null;
  } catch {
    return null; // can't tell here; auto-commit's inGitOperation() treats a throw as "yes" itself
  }
}
