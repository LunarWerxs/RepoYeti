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
  // We inject SSH auth via `-c core.sshCommand` per operation (see identityConfigArgs),
  // not via this env var — simple-git refuses to run with GIT_SSH_COMMAND in the env.
  delete env.GIT_SSH_COMMAND;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function gitFor(absPath: string, blockMs = 30_000): SimpleGit {
  return simpleGit({
    baseDir: absPath,
    timeout: { block: blockMs },
    // We intentionally inject the identity's SSH key via `-c core.sshCommand`
    // (identityConfigArgs). simple-git blocks that by default; the value is derived
    // from the owner's own stored key path — trusted input — so we opt in here.
    unsafe: { allowUnsafeSshCommand: true },
  }).env(safeGitEnv());
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
