/**
 * One place to construct a `SimpleGit` bound to a repo with a safe, daemon-correct
 * environment. Every git invocation in repoyeti goes through here so the security and
 * watcher-friendliness seams are consistent.
 *
 *  - GIT_OPTIONAL_LOCKS=0  → read-only commands (status) never rewrite .git/index,
 *    so our own reads don't trip the .git watcher into a feedback loop.
 *  - GIT_TERMINAL_PROMPT=0 → git never blocks on an interactive credential prompt.
 *  - BLOCKED_GIT_ENV stripped → no daemon op should ever open an editor, pager or credential
 *    prompt, and nothing ambient may redirect git's config/binaries. simple-git's guard also
 *    HARD-FAILS every call when one of these is present at all (CVE guard), so forwarding the
 *    ambient value is not an option: see the comment on BLOCKED_GIT_ENV for the full rationale.
 *
 * Phase 3 layers per-operation identity on top via `.env(GIT_SSH_COMMAND=…)` and
 * `git -c user.name/user.email` — never by mutating global or repo config.
 */
import { simpleGit, type SimpleGit } from "simple-git";
import { existsSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Identity } from "./db.ts";
import { readTextStreamLimited } from "./process-output.ts";

/**
 * Every environment variable `simple-git`'s block-unsafe guard rejects, plus the ambient
 * config-injection vars git itself honours.
 *
 * These are a hard failure, not a soft one: if any of them is merely PRESENT in the daemon's
 * environment (an empty string counts), simple-git throws
 * `Use of "X" is not permitted without enabling allowUnsafeY` before git is ever spawned, so
 * EVERY RepoYeti git operation fails. And they are not exotic. VS Code, Claude Code and GitHub
 * Desktop all export `GIT_ASKPASS` into the terminals they open, which made the daemon fail every
 * operation when launched from one of those while the same binary launched from a plain shell
 * worked. That "works on my machine, and also on my machine it doesn't" shape is why the list is
 * enumerated here in full rather than grown one incident at a time.
 *
 * Stripping is the right answer for all of them, not opting in: no daemon op may open an editor,
 * pager or credential prompt, and nothing ambient should get to redirect which binaries, hooks,
 * templates or config files git uses. RepoYeti injects what it actually needs per operation via
 * `-c core.sshCommand` / `-c user.*` instead (see identityConfigArgs), where the value is derived
 * from the owner's own stored data rather than from whoever started the process.
 *
 * Keep in sync with simple-git's guard: `bun run scripts/check-git-env.ts` fails if it drifts.
 */
export const BLOCKED_GIT_ENV = [
  // Credential prompts. GIT_TERMINAL_PROMPT=0 below covers git's own prompt; these cover the
  // helper programs git and ssh would shell out to instead.
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  // Editors and pagers: a daemon has no terminal to host either.
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "PAGER",
  // Arbitrary programs git would execute on our behalf.
  "GIT_EXTERNAL_DIFF",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  // Paths that redirect which config, binaries or templates git reads.
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  // Per-process config injection (`git -c` expressed through the environment). Inheriting it would
  // let whoever launches the daemon silently rewrite Git behavior for every RepoYeti operation
  // (author, hooks, credential helper, safe.directory, and more). Numbered KEY/VALUE tuples are
  // swept by pattern below.
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
] as const;

export function safeGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const key of BLOCKED_GIT_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * The idle budget for a NETWORK git op, and the flag that makes it correct. These two are a pair —
 * shipping either one alone is the bug this pair exists to prevent.
 *
 * `simple-git`'s `timeout.block` is an IDLE timer, not a total budget: it is re-armed by every
 * chunk the child writes to stdout/stderr and fires only after `block` ms of complete silence.
 * Git, though, suppresses transfer progress whenever stderr is not a TTY — and a daemon's child
 * process never has one. So without `--progress`, a perfectly healthy push of a large repository
 * writes NOTHING for the whole enumerate/compress/write stretch, the idle timer never re-arms, and
 * simple-git kills a transfer that was working. (Measured on this repo: a piped bare clone emits
 * 148 bytes of stderr without `--progress` and 19 KB with it.)
 *
 * `--progress` forces that stream back on, so the timer measures real idleness: a hung transport
 * still trips it, a slow-but-advancing transfer never does. Passing it also means git's stderr now
 * OPENS with a progress bar, which is why the classifier picks the diagnosis line rather than the
 * first one (see diagnosisLine in git-actions/sync.ts).
 *
 * Env-overridable (`REPOYETI_NET_TIMEOUT_MS`) for a link slow enough that even the progress stream
 * gaps, matching LORE_TIMEOUT_MS in vcs/lore.ts.
 */
export const NET_BLOCK_MS = Number(process.env.REPOYETI_NET_TIMEOUT_MS) || 120_000;
/** Always pass this on any op that talks to a remote — see NET_BLOCK_MS. */
export const PROGRESS_ARG = "--progress";

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
 * Run one read-only Git command with bounded text supplied on stdin.
 *
 * simple-git's raw API has no convenient stdin seam. Activity sampling uses this for
 * `git diff-tree --stdin`, which avoids putting hundreds of commit hashes in argv (and therefore
 * avoids Windows' command-line limit) while retaining the same safe daemon environment as
 * `gitFor()`. Callers remain responsible for taking a readGate slot.
 */
export async function gitRawWithInput(
  absPath: string,
  args: readonly string[],
  input: string,
  blockMs = 30_000,
): Promise<string> {
  const stdoutMax = 8 * 1024 * 1024;
  const stderrMax = 1024 * 1024;
  const proc = Bun.spawn(["git", ...args], {
    cwd: absPath,
    env: safeGitEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = (): void => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  };
  const timer = setTimeout(kill, blockMs);
  let outputLimited = false;
  const limit = (): void => {
    outputLimited = true;
    kill();
  };
  try {
    proc.stdin.write(input);
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      readTextStreamLimited(proc.stdout, stdoutMax, limit),
      readTextStreamLimited(proc.stderr, stderrMax, limit),
      proc.exited,
    ]);
    if (outputLimited || stdout.truncated || stderr.truncated) {
      throw new Error(`git ${args[0] ?? "command"} output exceeded the daemon limit`);
    }
    if (code !== 0) {
      throw new Error(stderr.text.trim() || `git ${args[0] ?? "command"} failed with exit code ${code}`);
    }
    return stdout.text;
  } finally {
    clearTimeout(timer);
    kill();
    await proc.exited.catch(() => undefined);
  }
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

interface GitDirCacheEntry {
  /** Signature of the `.git` pointer (or bare-repository root) that produced `base`. */
  sig: string;
  base: string;
}

// Repo paths can churn in a long-lived daemon, so this is an LRU rather than an unbounded map.
// 10k entries comfortably covers the application's supported large-repository-list use case while
// keeping the retained path strings to a few megabytes at most.
const GIT_DIR_CACHE_MAX = 10_000;
const gitDirCache = new Map<string, GitDirCacheEntry>();

function cachedGitDir(absPath: string, sig: string): string | null {
  const hit = gitDirCache.get(absPath);
  if (!hit || hit.sig !== sig) return null;
  // Refresh insertion order for simple Map-backed LRU eviction.
  gitDirCache.delete(absPath);
  gitDirCache.set(absPath, hit);
  return hit.base;
}

function rememberGitDir(absPath: string, entry: GitDirCacheEntry): string {
  gitDirCache.delete(absPath);
  if (gitDirCache.size >= GIT_DIR_CACHE_MAX) {
    const oldest = gitDirCache.keys().next().value as string | undefined;
    if (oldest !== undefined) gitDirCache.delete(oldest);
  }
  gitDirCache.set(absPath, entry);
  return entry.base;
}

/**
 * Resolve the repository metadata directory without spawning Git on the ordinary hot path:
 * - a normal checkout has a `.git/` directory;
 * - a linked worktree/submodule has a small `.git` file containing `gitdir: <path>`;
 * - a bare/unusual repository falls back to `rev-parse`, with that result cached.
 */
async function gitDirFor(absPath: string): Promise<string | null> {
  const marker = join(absPath, ".git");
  try {
    const markerStat = await stat(marker);
    // The path itself is already the answer for an ordinary checkout. Avoid retaining one cache
    // entry per normal repo; the cache only pays for pointer parsing and the unusual Git fallback.
    if (markerStat.isDirectory()) return marker;
    if (!markerStat.isFile()) return null;
    const sig = `file:${markerStat.dev}:${markerStat.ino}:${markerStat.mtimeMs}:${markerStat.size}`;
    const hit = cachedGitDir(absPath, sig);
    if (hit) return hit;

    // Git's pointer format is one line. Cap the accepted content so a malformed metadata file
    // cannot turn a status refresh into an unexpectedly large retained string.
    if (markerStat.size > 16_384) return null;
    const content = await readFile(marker, "utf8");
    const target = /^gitdir:\s*(.+?)\s*$/im.exec(content)?.[1]?.trim();
    if (!target) return null;
    const base = isAbsolute(target) ? target : resolve(dirname(marker), target);
    return rememberGitDir(absPath, { sig, base });
  } catch {
    // No ordinary marker. Bare repositories and callers rooted below a checkout are rare but were
    // supported by the old implementation, so preserve that behavior without charging every
    // normal status refresh for it.
  }

  let rootSig: string | null = null;
  try {
    const root = await stat(absPath);
    rootSig = `root:${root.dev}:${root.ino}`;
    const hit = cachedGitDir(absPath, rootSig);
    if (hit) return hit;
  } catch {
    return null;
  }
  try {
    const gitDir = (await gitFor(absPath).raw(["rev-parse", "--git-dir"])).trim();
    if (!gitDir) return null;
    const base = isAbsolute(gitDir) ? gitDir : resolve(absPath, gitDir);
    return rootSig ? rememberGitDir(absPath, { sig: rootSig, base }) : base;
  } catch {
    return null;
  }
}

/** Which mid-operation marker is present (first match), or null when the repo is in a normal
 *  state. Best-effort: on any error we can't tell, so callers that need "safe by default"
 *  (auto-commit) should treat a throw/unknown as mid-operation themselves. */
export async function currentGitOperation(absPath: string): Promise<string | null> {
  try {
    const base = await gitDirFor(absPath);
    if (!base) return null;
    // This can run for repositories on slow or temporarily disconnected volumes. Keep filesystem
    // reads asynchronous so one bad mount cannot freeze every API/SSE client on the daemon loop.
    const entries = await readdir(base);
    return GIT_OP_MARKERS.find((marker) => entries.includes(marker)) ?? null;
  } catch {
    return null; // can't tell here; auto-commit's inGitOperation() treats a throw as "yes" itself
  }
}
