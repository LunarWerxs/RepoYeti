/**
 * Safe remote git actions — fetch / pull / push — with the non-negotiable guards:
 *  - The daemon NEVER leaves a repo half-merged. Pull is fast-forward-only and is
 *    refused outright on a dirty tree or detached HEAD ("resolve at your desk").
 *  - Push is never `--force`. A non-fast-forward push is reported, not forced.
 *  - Every failure maps to a stable, first-class error code the UI can render.
 *
 * Auth + author identity are injected per operation (`-c core.sshCommand` + `-c user.*`)
 * via git.ts — global/repo config is never mutated.
 */
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gitFor, identityConfigArgs, safeGitEnv } from "./git.ts";
import { readStatus, readChanges } from "./status.ts";
import { netGate } from "./gitgate.ts";
import type { Identity } from "./db.ts";
import type { CommitPlanInput, PlanInputFile } from "./ai.ts";
// The result envelope + code now live in contract.ts (the contract layer) so the VCS
// abstraction can depend on them without importing this git module. Re-exported here for
// back-compat — service.ts and the vcs backends still import them from git-actions.ts.
import { ok, fail, PATCH_CAP, type ActionResult, type ActionCode } from "./contract.ts";
export type { ActionResult, ActionCode };

/** Map a thrown git error (simple-git surfaces stderr in the message) to a code. */
function classify(err: unknown): ActionResult {
  const raw = err instanceof Error ? err.message : String(err);
  const low = raw.toLowerCase();

  if (
    low.includes("non-fast-forward") ||
    low.includes("fetch first") ||
    low.includes("updates were rejected") ||
    low.includes("not possible to fast-forward") ||
    low.includes("cannot fast-forward") ||
    low.includes("need to specify how to reconcile")
  ) {
    return fail("NON_FAST_FORWARD", "remote has diverged — resolve at your desk");
  }
  if (low.includes("has no upstream branch") || low.includes("no upstream configured")) {
    return fail("NO_UPSTREAM", "branch has no upstream — set one at your desk");
  }
  if (
    low.includes("permission denied") ||
    low.includes("could not read from remote repository") ||
    low.includes("authentication failed") ||
    low.includes("host key verification failed") ||
    low.includes("publickey")
  ) {
    return fail("SSH_AUTH_FAILED", "authentication failed — check this repo's identity / SSH key");
  }
  if (low.includes("timed out") || low.includes("timeout") || low.includes("block timeout")) {
    return fail(
      "SSH_PASSPHRASE_REQUIRED",
      "git timed out — the SSH key may need a passphrase; use ssh-agent or a passphrase-free key",
    );
  }
  if (
    low.includes("no configured push destination") ||
    low.includes("does not appear to be a git repository") ||
    low.includes("no such remote") ||
    low.includes("no remote")
  ) {
    return fail("NO_REMOTE", "no remote configured for this repo");
  }
  return fail("ERROR", raw.split("\n")[0]?.slice(0, 300) ?? "git error");
}

export async function gitFetch(absPath: string, identity: Identity | null): Promise<ActionResult> {
  try {
    const git = gitFor(absPath);
    await netGate.run(() => git.raw([...identityConfigArgs(identity), "fetch", "--prune"]));
    return ok("fetched");
  } catch (err) {
    return classify(err);
  }
}

export async function gitPullFfOnly(
  absPath: string,
  identity: Identity | null,
): Promise<ActionResult> {
  // Preflight: never pull into an unsafe state.
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) {
    return fail("DETACHED_HEAD", "detached HEAD — resolve at your desk");
  }
  if (pre.dirty > 0) {
    return fail("DIRTY_WORKING_TREE", "working tree has uncommitted changes — resolve at your desk");
  }
  try {
    const git = gitFor(absPath);
    await netGate.run(() => git.raw([...identityConfigArgs(identity), "pull", "--ff-only"]));
    return ok("pulled (fast-forward)");
  } catch (err) {
    return classify(err);
  }
}

/**
 * Stage everything and commit, attributed to the repo's identity. This is atomic and
 * can never produce a merge/conflicted state, so it's allowed from the phone (unlike a
 * partial stage). A pull/push still guard separately. Empty trees are refused.
 *
 * `amend` rewrites the previous commit (`commit --amend`) instead of adding a new one —
 * useful to fix the last message or fold in a forgotten change. It's allowed on a clean
 * tree (message-only edit) but still refused on a detached HEAD or before the first
 * commit (classify() maps "you have nothing to amend" to a plain ERROR). Amending an
 * already-pushed commit only diverges locally; the next non-force push reports
 * NON_FAST_FORWARD rather than rewriting the remote.
 */
export async function gitCommitAll(
  absPath: string,
  identity: Identity | null,
  message: string,
  amend = false,
): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) return fail("DETACHED_HEAD", "detached HEAD — resolve at your desk");
  if (!amend && pre.dirty === 0) return fail("NOTHING_TO_COMMIT", "nothing to commit");
  try {
    const git = gitFor(absPath);
    await git.raw([...identityConfigArgs(identity), "add", "-A"]);
    const commitArgs = [...identityConfigArgs(identity), "commit"];
    if (amend) commitArgs.push("--amend");
    commitArgs.push("-m", message);
    await git.raw(commitArgs);
    return ok(amend ? "amended" : "committed");
  } catch (err) {
    return classify(err);
  }
}

// ── smart commit: split the working tree into several scoped commits ─────────────────

/** One proposed commit to execute: a message + the exact paths to stage for it. Paths are
 *  already expanded by the caller to include a rename's old path (see service.smartCommitRepo). */
export interface CommitGroupSpec {
  message: string;
  paths: string[];
}

/** Per-group outcome, in plan order. */
export interface CommitGroupResult {
  ok: boolean;
  code: ActionCode;
  /** First line of the message (a label for the UI). */
  subject: string;
  message?: string;
}

export interface CommitGroupsResult {
  ok: boolean;
  code: ActionCode;
  message: string;
  /** Outcome of each group we attempted, in order. */
  committed: CommitGroupResult[];
  /** Groups never attempted because an earlier one failed (their changes stay in the tree). */
  remaining: number;
}

const subjectOf = (message: string): string => (message.split("\n")[0] ?? "").slice(0, 120);

/**
 * Execute a multi-commit plan: stage each group's files in isolation and commit it,
 * attributed to the repo's identity. FILE-LEVEL only — `git add -A -- <paths>` stages the
 * whole-file change (modify / add / delete / rename) for exactly those paths, then a commit
 * captures just the staged set. Between groups the index returns to clean, so the next add
 * stages only the next group (the caller guarantees the groups are disjoint + complete).
 *
 * Safety: starts with a MIXED `git reset` (index → HEAD, working tree UNTOUCHED — never
 * `--hard`) so each commit contains exactly its group regardless of any pre-staged state.
 * If a commit fails mid-sequence we STOP and report a partial result: the changes for the
 * remaining groups simply stay in the working tree (a normal, safe, recoverable state — never
 * a half-merge). The whole sequence must run inside ONE op-queue slot (the service wrapper
 * enqueues once and refreshes after).
 */
export async function gitCommitGroups(
  absPath: string,
  identity: Identity | null,
  groups: CommitGroupSpec[],
): Promise<CommitGroupsResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return { ok: false, code: "ERROR", message: pre.error, committed: [], remaining: groups.length };
  if (pre.detached || !pre.branch)
    return { ok: false, code: "DETACHED_HEAD", message: "detached HEAD — resolve at your desk", committed: [], remaining: groups.length };
  if (pre.dirty === 0)
    return { ok: false, code: "NOTHING_TO_COMMIT", message: "nothing to commit", committed: [], remaining: groups.length };

  const git = gitFor(absPath);
  const committed: CommitGroupResult[] = [];
  try {
    // Normalise the index to HEAD so each group's commit contains exactly its own files.
    // Mixed reset (the default) never touches the working tree — categorically not `--hard`.
    await git.raw(["reset", "-q"]);
  } catch {
    // `git reset` fails on an UNBORN HEAD (a fresh repo with no commit yet) — there's nothing
    // to reset to. That's fine: the index is the only state and the per-group add/commit below
    // creates the first commit(s). Swallow and proceed (any real corruption surfaces per group).
  }

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const subject = subjectOf(g.message);
    try {
      // Stage in path-list chunks so a huge group can't overflow the OS command-line limit.
      for (const chunk of chunkByBytes(g.paths)) {
        await git.raw(["add", "-A", "--", ...chunk]);
      }
      // Skip a group that staged nothing (defensive — disjoint/complete validation should
      // prevent it) rather than aborting the whole plan on a "nothing to commit". Use
      // `--name-only` (non-empty = something staged) instead of `--quiet`: under
      // GIT_OPTIONAL_LOCKS=0 the `--quiet`/`--exit-code` fast path can wrongly report "no
      // diff" for a staged deletion (it skips the index refresh), which `--name-only` doesn't.
      const stagedNames = (await git.raw(["diff", "--cached", "--name-only"])).trim();
      if (!stagedNames) {
        committed.push({ ok: true, code: "OK", subject, message: "skipped (no changes)" });
        continue;
      }
      await git.raw([...identityConfigArgs(identity), "commit", "-m", g.message]);
      committed.push({ ok: true, code: "OK", subject });
    } catch (err) {
      const r = classify(err);
      committed.push({ ok: false, code: r.code, subject, message: r.message });
      // Stop on the first failure; the remaining groups' changes stay safely in the tree.
      return { ok: false, code: r.code, message: r.message, committed, remaining: groups.length - i - 1 };
    }
  }
  const made = committed.filter((c) => c.message !== "skipped (no changes)").length;
  return { ok: true, code: "OK", message: `committed ${made} change set${made === 1 ? "" : "s"}`, committed, remaining: 0 };
}

/**
 * Collect a compact, read-only snapshot of the working tree for an AI prompt:
 * the porcelain file list (so untracked names — which `add -A` will commit — show up)
 * plus the tracked diff vs HEAD. Capped so we never post a huge payload to a provider.
 * Never mutates the index. On an unborn HEAD (brand-new repo) the diff is empty and the
 * file list carries the context.
 */
const DIFF_CAP = 24_000;
const STATUS_CAP = 4_000;
const DIFF_TIMEOUT_MS = 30_000;

/**
 * Run `git <args>` in `absPath` and collect at most `cap` bytes of stdout, then KILL the
 * child. The previous version buffered the ENTIRE `git diff HEAD` into a string only to
 * slice it to 24 KB afterwards — so a generated file, a near-binary blob, or a 100k-line
 * change would still be fully read into memory (and block the per-repo queue) before the
 * cap applied. Streaming + early-kill bounds memory and time up front. Uses the same
 * daemon-safe git env as gitFor() (no pager, no prompts, GIT_OPTIONAL_LOCKS=0). Read-only.
 */
async function boundedGit(absPath: string, args: string[], cap: number): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: absPath,
    env: safeGitEnv(),
    stdout: "pipe",
    stderr: "ignore",
  });
  const killTimer = setTimeout(() => proc.kill(), DIFF_TIMEOUT_MS);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  try {
    while (out.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    if (out.length > cap) out = out.slice(0, cap);
  } catch {
    /* child killed or stream errored — keep whatever we read */
  } finally {
    clearTimeout(killTimer);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    proc.kill(); // no-op if it already exited; stops a still-streaming huge diff
    try {
      await proc.exited;
    } catch {
      /* ignore */
    }
  }
  return out;
}

export async function collectCommitDiff(absPath: string): Promise<string> {
  const status = (await boundedGit(absPath, ["status", "--porcelain=v1"], STATUS_CAP)).trim();
  // `git diff HEAD` is empty (non-zero exit) on an unborn HEAD → fall back to `git diff`.
  let diff = (await boundedGit(absPath, ["diff", "HEAD"], DIFF_CAP)).trim();
  if (!diff) diff = (await boundedGit(absPath, ["diff"], DIFF_CAP)).trim();
  let combined =
    `# git status --porcelain\n${status || "(clean)"}\n\n# git diff\n${diff || "(no textual diff — new/untracked files only)"}`;
  if (combined.length > DIFF_CAP) combined = combined.slice(0, DIFF_CAP) + "\n…[truncated]";
  return combined;
}

/**
 * Like collectCommitDiff but SCOPED to a subset of paths — the input for regenerating ONE
 * proposed commit's message from just its files (`git status`/`git diff HEAD -- <paths>`).
 * Bounded + read-only; chunks the pathspec so a big group can't overflow the OS arg limit.
 */
export async function collectPathsDiff(absPath: string, paths: string[]): Promise<string> {
  if (paths.length === 0) return "";
  const chunks = chunkByBytes(paths);
  let status = "";
  for (const chunk of chunks) {
    if (status.length >= STATUS_CAP) break;
    status += await boundedGit(absPath, ["status", "--porcelain=v1", "--", ...chunk], STATUS_CAP);
  }
  status = status.trim();
  let diff = "";
  for (const chunk of chunks) {
    if (diff.length >= DIFF_CAP) break;
    diff += await boundedGit(absPath, ["diff", "HEAD", "--", ...chunk], DIFF_CAP);
  }
  diff = diff.trim();
  if (!diff) {
    // Unborn HEAD → `git diff HEAD` errors/empties; fall back to the worktree diff.
    for (const chunk of chunks) {
      if (diff.length >= DIFF_CAP) break;
      diff += await boundedGit(absPath, ["diff", "--", ...chunk], DIFF_CAP);
    }
    diff = diff.trim();
  }
  let combined =
    `# git status --porcelain\n${status || "(clean)"}\n\n# git diff\n${diff || "(no textual diff — new/untracked files only)"}`;
  if (combined.length > DIFF_CAP) combined = combined.slice(0, DIFF_CAP) + "\n…[truncated]";
  return combined;
}

/** The smart-commit planner gets a larger diff budget than the message path — grouping needs
 *  more of the picture than a one-line summary does. Still bounded so a giant change-set can't
 *  balloon the provider payload; the per-file list (always complete) carries the rest. */
const PLAN_DIFF_CAP = 40_000;

/** Lockfile basenames whose DIFF BODY is high-noise / low-signal for commit GROUPING. */
const NOISE_BASENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "cargo.lock", "composer.lock", "gemfile.lock", "poetry.lock", "pipfile.lock", "go.sum", "flake.lock",
]);
/** Generated / minified / derived extensions (matched on the lowercased basename). */
const NOISE_EXT = /\.(min\.js|min\.css|map|snap|lock|lockb)$/i;

/**
 * True for a file whose diff body the planner doesn't need to READ — lockfiles, minified bundles,
 * source maps, snapshots. It only needs to KNOW the file changed (its name + stat ride in the
 * file list either way), so we fold the body out of the planner's diff to save a lot of tokens
 * (a single lockfile diff can be thousands of lines). Borrowed concept: claw-compactor's "diff
 * folding". Pure + unit-tested. NOTE: only the PLANNER's diff folds these; message generation
 * (collectPathsDiff / collectCommitDiff) keeps full content.
 */
export function isNoisyPath(path: string): boolean {
  const base = (path.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  return NOISE_BASENAMES.has(base) || NOISE_EXT.test(base);
}

/**
 * Build the read-only input for the AI commit planner: the complete changed-file list (with
 * per-file +/- stats and rename sources) plus a bounded, TOKEN-TRIMMED diff. Never mutates the
 * index. The file list is authoritative (it drives validation + grouping); the diff is best-
 * effort context, sent at ZERO context (`-U0`, just the changed lines) and with noisy files'
 * bodies folded out (see isNoisyPath) — so a big change-set stays small enough for a provider's
 * rate limit. May still be truncated on a pathological change-set.
 */
export async function collectCommitPlanInput(absPath: string): Promise<CommitPlanInput> {
  const changed = await readChanges(absPath, true); // withStats → per-file add/remove counts

  // Only diff the files worth reading; fold out lockfiles/generated/minified (their name + stat
  // in the file list is enough for grouping). `-U0` trims to just the changed lines.
  const diffPaths = changed.map((f) => f.path).filter((p) => !isNoisyPath(p));
  let diff = "";
  if (diffPaths.length > 0) {
    for (const chunk of chunkByBytes(diffPaths)) {
      if (diff.length >= PLAN_DIFF_CAP) break;
      diff += await boundedGit(absPath, ["diff", "HEAD", "-U0", "--no-color", "-M", "--", ...chunk], PLAN_DIFF_CAP + 1);
    }
    diff = diff.trim();
    if (!diff) {
      // Unborn HEAD → `git diff HEAD` errors/empties; fall back to the worktree diff.
      for (const chunk of chunkByBytes(diffPaths)) {
        if (diff.length >= PLAN_DIFF_CAP) break;
        diff += await boundedGit(absPath, ["diff", "-U0", "--no-color", "-M", "--", ...chunk], PLAN_DIFF_CAP + 1);
      }
      diff = diff.trim();
    }
  }
  const truncated = diff.length > PLAN_DIFF_CAP;
  if (truncated) diff = diff.slice(0, PLAN_DIFF_CAP) + "\n…[truncated]";

  // Best-effort binary flag: git prints "Binary files <a> and b/<p> differ". Match the b-side
  // path so both modified ("a/x and b/x") and newly-added ("/dev/null and b/x") binaries flag.
  const binaryPaths = new Set<string>();
  for (const m of diff.matchAll(/^Binary files .+? and b\/(.+?) differ$/gm)) {
    if (m[1]) binaryPaths.add(m[1]);
  }

  const files: PlanInputFile[] = changed.map((f) => ({
    path: f.path,
    status: f.status,
    ...(f.from ? { from: f.from } : {}),
    additions: f.stat?.addedLines ?? 0,
    removals: f.stat?.removedLines ?? 0,
    binary: binaryPaths.has(f.path),
  }));
  return { files, diff, truncated };
}

/**
 * A single tracked file's unified `git diff HEAD`, bounded via boundedGit so a pathological
 * change can't balloon memory. Powers the file viewer's compact-diff mode for LARGE modified
 * files: rather than shipping both whole copies and diffing in the browser, the daemon lets
 * git compute the patch and sends only that. `truncated` flags a patch that itself hit the
 * cap. The caller guarantees the path is a tracked, modified, non-binary file.
 */
export async function fileDiffPatch(
  absPath: string,
  relPath: string,
): Promise<{ patch: string; truncated: boolean }> {
  // `--` separates the pathspec so a filename that looks like a flag can't be misread.
  const raw = await boundedGit(absPath, ["diff", "HEAD", "--", relPath], PATCH_CAP + 1);
  const truncated = raw.length > PATCH_CAP;
  return { patch: truncated ? raw.slice(0, PATCH_CAP) : raw, truncated };
}

/**
 * VcsBackend.discardFile for git — restore ONE file to its committed/absent state. Backs the
 * changes-tree "Discard" action (DESTRUCTIVE; the UI confirms first). Two cases:
 *  - tracked in HEAD (modified/deleted) → `git checkout HEAD -- <path>` restores index+worktree.
 *  - added/untracked (not in HEAD)      → delete the working file + unstage any add.
 * HEAD is never touched and no merge state is possible. The caller (service.discardFile)
 * guarantees the path is repo-relative, resolved, and not inside the `.git` marker dir.
 */
export async function gitDiscardFile(absPath: string, relPath: string): Promise<ActionResult> {
  try {
    const git = gitFor(absPath);
    let inHead = false;
    try {
      await git.raw(["cat-file", "-e", `HEAD:${relPath}`]);
      inHead = true;
    } catch {
      /* not in HEAD → newly added or untracked */
    }
    if (inHead) {
      // Restores both the index and the working tree to the committed content.
      await git.raw(["checkout", "HEAD", "--", relPath]);
    } else {
      const abs = join(absPath, relPath);
      if (existsSync(abs) && lstatSync(abs).isFile()) unlinkSync(abs);
      // Drop any staged "add" for this path. No-op (harmless throw) on an unborn HEAD.
      try {
        await git.raw(["reset", "-q", "--", relPath]);
      } catch {
        /* unborn HEAD or nothing staged */
      }
    }
    return ok("discarded");
  } catch (e) {
    return fail("DISCARD_FAILED", e instanceof Error ? e.message : String(e));
  }
}

/** Cap the `-l` name list we read back from `git grep`. A few thousand paths fit easily;
 *  the changed-file set is the real bound — this just guards a pathological match storm. */
const GREP_CAP = 512_000;

/** Group `paths` so no single `git grep` invocation's pathspec list overflows the OS
 *  command-line limit (Windows ~32 KB). Greedy packing under a conservative byte budget. */
function chunkByBytes(paths: string[], maxBytes = 8_000): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let used = 0;
  for (const p of paths) {
    const cost = p.length + 1; // path + the separating space/arg slot
    if (used + cost > maxBytes && cur.length) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(p);
    used += cost;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * The subset of `paths` whose WORKING-TREE content contains `needle` (literal, case-
 * insensitive). Powers the changes-tree "search content" toggle: the tree only shows
 * changed files, so the caller scopes this to that set. Flags:
 *   -l names only · -I skip binaries · -i case-insensitive · -F literal (no regex)
 *   --untracked also search new/untracked files · core.quotePath=false → raw paths.
 * `git grep` exits 1 on "no match" — boundedGit ignores the exit code, so that's a no-op,
 * not an error. Read-only; same daemon-safe env + 30 s kill-timer as every bounded read.
 */
export async function grepChangedContent(
  absPath: string,
  needle: string,
  paths: string[],
): Promise<string[]> {
  if (!needle || paths.length === 0) return [];
  const matched = new Set<string>();
  for (const chunk of chunkByBytes(paths)) {
    const out = await boundedGit(
      absPath,
      ["-c", "core.quotePath=false", "grep", "--no-color", "-l", "-I", "-i", "-F", "--untracked", "-e", needle, "--", ...chunk],
      GREP_CAP,
    );
    for (const line of out.split("\n")) {
      const p = line.trim();
      if (p) matched.add(p);
    }
  }
  return [...matched];
}

export async function gitPush(absPath: string, identity: Identity | null): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) {
    return fail("DETACHED_HEAD", "detached HEAD — cannot push");
  }
  try {
    const git = gitFor(absPath);
    // Plain push of the current branch to its upstream. No `--force`, ever.
    await netGate.run(() => git.raw([...identityConfigArgs(identity), "push"]));
    return ok("pushed");
  } catch (err) {
    return classify(err);
  }
}

// ── clone ───────────────────────────────────────────────────────────────────────────

/** A clone can pull a large history — give it far more headroom than a normal op (which is
 *  capped at 30s). Still bounded so a hung transport can't wedge a net slot forever. */
const CLONE_TIMEOUT_MS = 300_000;

/**
 * Clone `url` into `<parentDir>/<name>` with per-operation identity injection (the SSH key is
 * selected via `-c core.sshCommand`, same seam as fetch/pull/push). The caller validates the
 * URL scheme, the name, and that `parentDir` sits under a scan root; `--` separates the args so
 * a URL/name can't be read as a flag. Runs behind `netGate` (it's a network op) with the long
 * clone timeout. git cleans up its own partial target directory on failure.
 */
export async function gitClone(
  parentDir: string,
  url: string,
  name: string,
  identity: Identity | null,
): Promise<ActionResult> {
  try {
    await netGate.run(() =>
      gitFor(parentDir, CLONE_TIMEOUT_MS).raw([...identityConfigArgs(identity), "clone", "--", url, name]),
    );
    return ok("cloned");
  } catch (err) {
    return classify(err);
  }
}

// ── remotes (add / set-url / remove — local config only, no network) ────────────────

/**
 * Point a remote (default `origin`) at `url`: add it if absent, else update its URL. This is a
 * pure `.git/config` edit — no network — so it's the missing piece that lets a `git init`-from-
 * the-phone repo gain a remote and become pushable. The caller validates the URL scheme; `--`
 * isn't used (remote subcommands take fixed positional args), but the URL is passed as one arg
 * (parameterized, never a shell string) so it can't inject.
 */
export async function gitRemoteSet(absPath: string, name: string, url: string): Promise<ActionResult> {
  try {
    const git = gitFor(absPath);
    const remotes = await git.getRemotes();
    if (remotes.some((r) => r.name === name)) await git.raw(["remote", "set-url", name, url]);
    else await git.raw(["remote", "add", name, url]);
    return ok("remote saved");
  } catch (err) {
    return classify(err);
  }
}

/** Remove a remote (default `origin`). Local config only. */
export async function gitRemoteRemove(absPath: string, name: string): Promise<ActionResult> {
  try {
    await gitFor(absPath).raw(["remote", "remove", name]);
    return ok("remote removed");
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("no such remote")) return fail("NO_REMOTE", `no remote named ${name}`);
    return classify(err);
  }
}

// ── tags ────────────────────────────────────────────────────────────────────────────

/**
 * Create a tag — "tag a release from your phone". Annotated (`-a -m`, identity-attributed) when a
 * message is given, else lightweight. Creating a tag is a local, safe ref write. When `push` is
 * set the tag is then pushed to origin (network → identity SSH key + `netGate`); a push failure is
 * reported but the LOCAL tag is kept (honest partial result, nothing lost). The caller validates
 * that this is a git repo; the name is validated here with the shared ref-name check.
 */
export async function gitTagCreate(
  absPath: string,
  identity: Identity | null,
  name: string,
  message?: string,
  push = false,
): Promise<ActionResult> {
  if (!isValidBranchName(name)) return fail("INVALID_REF_NAME", "invalid tag name");
  try {
    const git = gitFor(absPath);
    const msg = (message ?? "").trim();
    // `--` separates the tag name so one starting with a dash can't be read as a flag.
    const args = [...identityConfigArgs(identity), "tag", ...(msg ? ["-a", "-m", msg] : []), "--", name];
    await git.raw(args);
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("already exists")) return fail("EXISTS", `tag already exists: ${name}`);
    return classify(err);
  }
  if (push) {
    try {
      await netGate.run(() => gitFor(absPath).raw([...identityConfigArgs(identity), "push", "origin", name]));
    } catch (err) {
      const c = classify(err);
      return fail(c.code, `tag created locally, but push failed: ${c.message}`);
    }
  }
  return ok(push ? "tag created and pushed" : "tag created");
}

// ── branches ──────────────────────────────────────────────────────────────────────

/** Branch names we refuse to delete from the phone (a slip is too costly). */
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/**
 * A conservative branch-name check (a subset of `git check-ref-format`) so a crafted name
 * can never inject a flag or a path. Rejects whitespace, the git-special characters
 * (`~^:?*[\`), control bytes, `..`, `@{`, leading/trailing dot or slash, `//`, and `.lock`.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return false;
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.startsWith("-")) return false; // git refuses a leading dash (also avoids flag injection)
  if (name === "@") return false;
  return true;
}

/**
 * Switch to an existing branch. Guarded exactly like pull: refused on a dirty working
 * tree ("resolve at your desk") so a checkout can never carry changes into a conflict.
 * Uses `git switch`, which refuses to silently detach onto a remote-tracking ref (it will
 * dwim-create a local tracking branch for an unambiguous `origin/<name>`, which is safe).
 */
export async function gitCheckout(absPath: string, branch: string): Promise<ActionResult> {
  if (!isValidBranchName(branch)) return fail("INVALID_REF_NAME", "invalid branch name");
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.dirty > 0) {
    return fail("DIRTY_WORKING_TREE", "working tree has uncommitted changes — stash or resolve at your desk");
  }
  if (pre.branch === branch) return ok("already on branch");
  try {
    await gitFor(absPath).raw(["switch", branch]);
    return ok(`switched to ${branch}`);
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("did not match") || low.includes("invalid reference") || low.includes("not a commit") || low.includes("could not find") || low.includes("unknown")) {
      return fail("NOT_FOUND", `branch not found: ${branch}`);
    }
    return classify(err);
  }
}

/**
 * Create a new branch from the current HEAD. Creating a branch never touches the working
 * tree, so it is safe even on a dirty tree — and creating-and-switching to a brand-new
 * branch at the same commit can't conflict either, so `switchTo` is allowed regardless of
 * dirtiness (the uncommitted changes simply carry over).
 */
export async function gitCreateBranch(
  absPath: string,
  name: string,
  switchTo = true,
): Promise<ActionResult> {
  if (!isValidBranchName(name)) return fail("INVALID_REF_NAME", "invalid branch name");
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) return fail("DETACHED_HEAD", "detached HEAD — resolve at your desk");
  try {
    // `switch -c` creates + checks out; `branch` creates without switching. Both fail if the
    // name already exists (git: "already exists").
    await gitFor(absPath).raw(switchTo ? ["switch", "-c", name] : ["branch", name]);
    return ok(switchTo ? `created and switched to ${name}` : `created ${name}`);
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("already exists")) return fail("BRANCH_EXISTS", `branch already exists: ${name}`);
    return classify(err);
  }
}

/**
 * Delete a LOCAL branch — safe-delete only (`-d`, which git refuses for an unmerged branch),
 * never the force `-D`. Refuses the currently checked-out branch and the protected set
 * (main/master/develop/trunk). An unmerged branch surfaces UNMERGED_BRANCH so the UI can
 * say "not fully merged — delete at your desk" rather than silently force-deleting.
 */
export async function gitDeleteBranch(absPath: string, name: string): Promise<ActionResult> {
  if (!isValidBranchName(name)) return fail("INVALID_REF_NAME", "invalid branch name");
  if (PROTECTED_BRANCHES.has(name)) return fail("PROTECTED_BRANCH", `refusing to delete protected branch: ${name}`);
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.branch === name) return fail("CANNOT_DELETE_CURRENT", "cannot delete the current branch");
  try {
    await gitFor(absPath).raw(["branch", "-d", name]);
    return ok(`deleted ${name}`);
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("not fully merged")) {
      return fail("UNMERGED_BRANCH", `'${name}' is not fully merged — delete at your desk`);
    }
    if (low.includes("not found")) return fail("NOT_FOUND", `branch not found: ${name}`);
    return classify(err);
  }
}

// ── stash ───────────────────────────────────────────────────────────────────────────

const stashRef = (index: number): string => `stash@{${Math.max(0, Math.floor(index))}}`;

/**
 * Stash the working tree (including untracked files) — the phone-side escape from the
 * "dirty tree blocks pull" dead-end: stash → pull → pop. Always safe (a save can never
 * conflict). Refuses a clean tree (nothing to stash). Attributed to the repo's identity so
 * the stash commit objects carry the right author.
 */
export async function gitStashSave(
  absPath: string,
  identity: Identity | null,
  message?: string,
): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.dirty === 0) return fail("NOTHING_TO_STASH", "nothing to stash — working tree is clean");
  try {
    const args = [...identityConfigArgs(identity), "stash", "push", "--include-untracked"];
    const msg = (message ?? "").trim();
    if (msg) args.push("-m", msg);
    await gitFor(absPath).raw(args);
    return ok("stashed");
  } catch (err) {
    return classify(err);
  }
}

/**
 * Pop a stash entry (default the newest) back onto a CLEAN working tree. Refused on a dirty
 * tree so the apply starts from a known-good state. If the apply conflicts, git leaves the
 * stash entry intact (it only drops on a clean apply) — so nothing is ever lost; we report
 * STASH_CONFLICT ("applied with conflicts — resolve at your desk") and the post-action
 * refresh shows the now-dirty tree. HEAD is never touched, so there is no half-merged commit.
 */
export async function gitStashPop(absPath: string, index = 0): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.dirty > 0) {
    return fail("DIRTY_WORKING_TREE", "working tree has uncommitted changes — commit or stash them first");
  }
  try {
    await gitFor(absPath).raw(["stash", "pop", stashRef(index)]);
    return ok("stash popped");
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("no stash entries") || low.includes("is not a valid reference") || low.includes("does not exist")) {
      return fail("STASH_EMPTY", "no such stash entry");
    }
    if (low.includes("conflict")) {
      return fail("STASH_CONFLICT", "stash applied with conflicts — resolve at your desk (the stash was kept)");
    }
    return classify(err);
  }
}

/** Drop a stash entry (default the newest). Irreversible — the UI confirms first. */
export async function gitStashDrop(absPath: string, index = 0): Promise<ActionResult> {
  try {
    await gitFor(absPath).raw(["stash", "drop", stashRef(index)]);
    return ok("stash dropped");
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("no stash entries") || low.includes("is not a valid reference") || low.includes("does not exist")) {
      return fail("STASH_EMPTY", "no such stash entry");
    }
    return classify(err);
  }
}
