/**
 * Lore backend — drives Epic Games' `lore` CLI, the same way the git backend drives `git`.
 *
 * Epic's Lore is a centralized, content-addressed VCS (announced 2026-06). The commands and
 * parsers here were VERIFIED against **lore 0.8.4 (x86_64-pc-windows-msvc)** by creating a
 * real local repo and capturing actual output — not guessed from docs. Where 0.8.x is likely
 * to drift, it's noted. Longer term the read paths should move to the `@lore-vcs/sdk` JS SDK's
 * structured events instead of scraping text; this CLI path is the no-dependency baseline.
 *
 * This backend is DORMANT until opted in (REPOYETI_LORE=1, see ./index.ts) and is not yet wired
 * into service.ts or discovery — so the running daemon's git behavior is unchanged.
 *
 * git → lore mapping (verified):
 *   git status            → lore status --scan        (--scan walks the tree; persists dirty flags)
 *   git add -A            → lore stage --scan .
 *   git commit -m         → lore commit <msg>          (identity is the global --identity flag)
 *   git commit --amend    → lore revision amend <msg>
 *   git log               → lore history [n]           (multi-line Revision/Signature/… records)
 *   git branch            → lore branch list
 *   git switch <b>        → lore branch switch <b>
 *   git branch <b>        → lore branch create <b>
 *   git branch -d <b>     → lore branch archive <b>
 *   git pull --ff-only    → lore sync
 *   git push (no-force)   → lore push                  (server fast-forward + compare-and-swap)
 *   git fetch             → (none; Lore is centralized) → fetch() is a benign no-op
 *   git stash             → (none)                       → UNSUPPORTED
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { sdkStatus, sdkBranches, sdkLog } from "./lore-sdk.ts";
import { join } from "node:path";
import type { Identity, RepoStatus } from "../db.ts";
import type { ChangedFile } from "../read/status.ts";
import {
  ok,
  fail,
  PATCH_CAP,
  type ActionResult,
  type CommitGroupSpec,
  type CommitGroupResult,
  type CommitGroupsResult,
} from "../contract.ts";
import type { BranchList, LogResult, StashList, CommitDetail } from "../read/inspect.ts";
import type { VcsBackend } from "./types.ts";

/** The Lore binary. Overridable for tests / non-PATH installs (e.g. a downloaded release). */
const LORE_BIN = process.env.LORE_BIN ?? "lore";
/**
 * Per-op timeout. Far more generous than git's 30s: Lore operations routinely touch the
 * server (commit/push/sync/clone) and move multi-GB assets — VERIFIED that even a trivial
 * commit against a local server took ~30s here (a localhost-QUIC handshake stall), which a
 * 30s cap killed mid-write. Env-overridable for very large-asset repos.
 */
const LORE_TIMEOUT_MS = Number(process.env.LORE_TIMEOUT_MS) || 120_000;

interface LoreRun {
  /** Process exit code (-1 when the binary couldn't be spawned at all). */
  code: number;
  stdout: string;
  stderr: string;
  /** True when `lore` isn't installed / not on PATH (spawn threw). */
  spawnError: boolean;
}

/** Daemon-safe env for a `lore` child: no pager, no colour, never inherit a parent prompt. */
function loreEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.PAGER;
  env.NO_COLOR = "1";
  return env;
}

/**
 * Run `lore <args>` in `absPath`, capped at LORE_TIMEOUT_MS (then killed — a hung prompt can't
 * wedge the daemon since stdin is ignored). `--no-pager` is forced so output never blocks on a
 * pager. Never throws: a missing binary comes back as `spawnError`, a non-zero exit as a
 * populated `code`/`stderr`.
 */
async function runLore(absPath: string, args: string[]): Promise<LoreRun> {
  try {
    const proc = Bun.spawn([LORE_BIN, "--no-pager", ...args], {
      cwd: absPath,
      env: loreEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => proc.kill(), LORE_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    clearTimeout(killer);
    return { code, stdout, stderr, spawnError: false };
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e), spawnError: true };
  }
}

/**
 * Per-op identity for Lore: the global `--identity <name>` flag (verified — an arbitrary name
 * works on a local store; a server would tie it to a `lore login` session). git, by contrast,
 * injects `-c user.*` + an SSH key. Server login is a separate concern owned by the future
 * Connections/Servers registry. We map our Identity.gitUsername to the Lore identity name.
 * Global flags must precede the subcommand, so callers spread these FIRST.
 */
function loreIdentityArgs(identity: Identity | null): string[] {
  return identity?.gitUsername ? ["--identity", identity.gitUsername] : [];
}

/** Map a failed `lore` run to one of our stable action codes (error strings from 0.8.4). */
function classifyLore(run: LoreRun): ActionResult {
  if (run.spawnError) {
    return { ok: false, code: "ERROR", message: "lore CLI not found — install it and ensure it's on PATH" };
  }
  const low = `${run.stdout}\n${run.stderr}`.toLowerCase();
  if (low.includes("repository not found") || low.includes("not a repository")) {
    return { ok: false, code: "NOT_FOUND", message: "not a Lore repository" };
  }
  if (
    low.includes("fast-forward") ||
    low.includes("compare-and-swap") ||
    low.includes("has moved") ||
    low.includes("non-fast-forward")
  ) {
    return { ok: false, code: "NON_FAST_FORWARD", message: "remote has advanced — resolve at your desk" };
  }
  if (low.includes("no commit identity") || low.includes("identity")) {
    return { ok: false, code: "SSH_AUTH_FAILED", message: "no Lore identity configured — set one for this server" };
  }
  if (low.includes("unauthorized") || low.includes("permission denied") || low.includes("not authenticated")) {
    return { ok: false, code: "SSH_AUTH_FAILED", message: "Lore server rejected the request — check your login" };
  }
  const first = (run.stderr || run.stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return { ok: false, code: "ERROR", message: first?.replace(/^\[error\]\s*/i, "").slice(0, 300) || "lore error" };
}

// ── parsers (verified against lore 0.8.4 output) ──────────────────────────────────────

/**
 * Changed-file lines from `lore status --scan`. Real format is a single status letter, a
 * space, then the path (e.g. "A readme.txt"), grouped under section headers ("Untracked
 * files:"). Headers/footers are multi-word so the "<LETTER> <path>" shape never matches them.
 */
const FILE_LINE = /^([AMDRC])\s+(.+)$/;

export function parseChangedLines(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = FILE_LINE.exec(raw.trim());
    if (!m) continue;
    const status = m[1] ?? "M";
    const path = (m[2] ?? "").trim();
    if (path) files.push({ path, status, staged: false });
  }
  return files;
}

/** Current branch from the "On branch <name> revision N -> <sig>" status line. */
export function parseBranchFromStatus(stdout: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^On branch (\S+)\b/.exec(raw.trim());
    if (m) return m[1] ?? null;
  }
  return null;
}

/**
 * `lore branch list` output:
 *   Local branches:
 *   * main
 *   Warning: Could not query remote branch list
 * Skip the "...:" section header and warning/error lines; "*" marks the current branch.
 */
export function parseBranchList(stdout: string): Pick<BranchList, "current" | "branches"> {
  const branches: BranchList["branches"] = [];
  let current: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.endsWith(":")) continue;
    if (/^(warning|error)\b/i.test(line)) continue;
    const isCurrent = line.startsWith("*");
    const name = line.replace(/^\*\s*/, "").split(/\s+/)[0] ?? "";
    if (!name) continue;
    if (isCurrent) current = name;
    branches.push({ name, current: isCurrent, upstream: null, ahead: 0, behind: 0, gone: false });
  }
  return { current, branches };
}

/**
 * `lore history N` emits multi-line records:
 *   Revision  : 1
 *   Signature : 6694f0b5…           (the content hash → our commit "hash")
 *   Branch    : e726318b…
 *   Date      : Mon, 29 Jun 2026 07:08:15 +0000
 *       initial commit              (indented subject)
 *   Creator   : tester
 *   Committer : tester
 * A new "Revision :" line starts the next record. Lore identities are names, not emails, so
 * authorEmail stays "".
 */
export function parseHistory(stdout: string, cap: number): LogResult["commits"] {
  const out: LogResult["commits"] = [];
  let hash = "";
  let subject = "";
  let author = "";
  let date = 0;
  let open = false;
  const flush = (): void => {
    if (open && hash) {
      // Lore history is linear (no merge commits), so parents is always empty / isMerge false.
      out.push({ hash, shortHash: hash.slice(0, 12), subject, authorName: author, authorEmail: "", date, refs: "", parents: [], isMerge: false });
    }
    hash = "";
    subject = "";
    author = "";
    date = 0;
    open = false;
  };
  for (const raw of stdout.split(/\r?\n/)) {
    if (/^Revision\s*:/.test(raw)) {
      flush();
      open = true;
      continue;
    }
    if (!open) continue;
    const sig = /^Signature\s*:\s*(\w+)/.exec(raw);
    const dateM = /^Date\s*:\s*(.+)$/.exec(raw);
    const creator = /^Creator\s*:\s*(.+)$/.exec(raw) ?? /^Committer\s*:\s*(.+)$/.exec(raw);
    if (sig) {
      hash = sig[1] ?? "";
    } else if (dateM) {
      const t = Date.parse((dateM[1] ?? "").trim());
      date = Number.isNaN(t) ? 0 : t;
    } else if (creator) {
      if (!author) author = (creator[1] ?? "").trim();
    } else if (/^\s+\S/.test(raw) && !subject) {
      subject = raw.trim();
    }
  }
  flush();
  return out.slice(0, cap);
}

// ── status / changed files ────────────────────────────────────────────────────────────

function errorStatus(message: string): RepoStatus {
  return {
    branch: null,
    detached: false,
    dirty: 0,
    ahead: 0,
    behind: 0,
    remote: null,
    error: message,
    fetchedAt: null,
    diff: null,
    updatedAt: Date.now(),
  };
}

function statusFrom(branch: string | null, dirty: number): RepoStatus {
  // ahead/behind don't map cleanly to Lore's compare-and-swap model yet, so they stay 0.
  return {
    branch,
    detached: branch === null,
    dirty,
    ahead: 0,
    behind: 0,
    remote: null,
    error: null,
    fetchedAt: null,
    diff: null,
    updatedAt: Date.now(),
  };
}

async function loreReadStatus(absPath: string, _withDiff = false): Promise<RepoStatus> {
  // Prefer the structured SDK (drift-proof); fall back to scraping `lore status --scan` text.
  const s = await sdkStatus(absPath);
  if (s) return statusFrom(s.branch, s.files.length);
  const run = await runLore(absPath, ["status", "--scan"]);
  if (run.spawnError) return errorStatus("lore CLI not available");
  if (run.code !== 0) return errorStatus(classifyLore(run).message);
  return statusFrom(parseBranchFromStatus(run.stdout), parseChangedLines(run.stdout).length);
}

async function loreReadChanges(absPath: string, _withStats = false): Promise<ChangedFile[]> {
  const s = await sdkStatus(absPath);
  if (s) return s.files;
  const run = await runLore(absPath, ["status", "--scan"]);
  if (run.spawnError || run.code !== 0) return [];
  return parseChangedLines(run.stdout);
}

// ── safe actions ──────────────────────────────────────────────────────────────────────

async function loreFetch(_absPath: string, _identity: Identity | null): Promise<ActionResult> {
  // Lore is centralized — no separate fetch. capabilities.fetch === false keeps the UI from
  // offering it; this benign success exists only so a generic "fetch all" can't error.
  return ok("nothing to fetch (lore is centralized)");
}

async function lorePull(absPath: string, _identity: Identity | null): Promise<ActionResult> {
  const run = await runLore(absPath, ["sync"]);
  return run.code === 0 ? ok("synced") : classifyLore(run);
}

async function lorePush(absPath: string, identity: Identity | null): Promise<ActionResult> {
  const run = await runLore(absPath, [...loreIdentityArgs(identity), "push"]);
  return run.code === 0 ? ok("pushed") : classifyLore(run);
}

async function loreCommitAll(
  absPath: string,
  identity: Identity | null,
  message: string,
  amend = false,
): Promise<ActionResult> {
  if (!amend && !message.trim()) return { ok: false, code: "NO_MESSAGE", message: "commit message required" };
  if (!amend) {
    // Stage everything: walk the tree, mark dirty, and stage in one pass.
    const staged = await runLore(absPath, ["stage", "--scan", "."]);
    if (staged.spawnError || staged.code !== 0) return classifyLore(staged);
    const run = await runLore(absPath, [...loreIdentityArgs(identity), "commit", message]);
    return run.code === 0 ? ok("committed") : classifyLore(run);
  }
  // Amend only rewrites the latest commit's message in Lore (history is immutable otherwise).
  const run = await runLore(absPath, [...loreIdentityArgs(identity), "revision", "amend", message]);
  return run.code === 0 ? ok("amended") : classifyLore(run);
}

// ── branches ────────────────────────────────────────────────────────────────────────

async function loreCheckout(absPath: string, branch: string): Promise<ActionResult> {
  const run = await runLore(absPath, ["branch", "switch", branch]);
  return run.code === 0 ? ok(`switched to ${branch}`) : classifyLore(run);
}

async function loreCreateBranch(absPath: string, name: string, switchTo = true): Promise<ActionResult> {
  const created = await runLore(absPath, ["branch", "create", name]);
  if (created.spawnError || created.code !== 0) return classifyLore(created);
  if (switchTo) {
    const sw = await runLore(absPath, ["branch", "switch", name]);
    if (sw.code !== 0) return classifyLore(sw);
  }
  return ok(switchTo ? `created and switched to ${name}` : `created ${name}`);
}

async function loreDeleteBranch(absPath: string, name: string): Promise<ActionResult> {
  // Lore has no destructive branch delete — names are *archived* (recoverable). This is the
  // closest equivalent; the protected-branch/clean-tree guards live in the service layer.
  const run = await runLore(absPath, ["branch", "archive", name]);
  return run.code === 0 ? ok(`archived ${name}`) : classifyLore(run);
}

// ── history ───────────────────────────────────────────────────────────────────────────

async function loreReadLog(absPath: string, limit = 50, _skip = 0): Promise<LogResult> {
  const cap = Math.max(1, Math.floor(limit));
  // Prefer the structured SDK; fall back to scraping `lore history` text.
  const s = await sdkLog(absPath, cap);
  if (s) {
    const commits = s.slice(0, cap).map((c) => ({
      hash: c.hash,
      shortHash: c.hash.slice(0, 12),
      subject: c.subject,
      authorName: c.authorName,
      authorEmail: "",
      date: c.date,
      refs: "",
      parents: [], // Lore history is linear — no merge commits
      isMerge: false,
    }));
    return { ok: true, code: "OK", commits, hasMore: commits.length >= cap };
  }
  const run = await runLore(absPath, ["history", String(cap)]);
  if (run.spawnError || run.code !== 0) {
    return {
      ok: false,
      code: "ERROR",
      message: run.spawnError ? "lore CLI not available" : classifyLore(run).message,
      commits: [],
      hasMore: false,
    };
  }
  const commits = parseHistory(run.stdout, cap);
  return { ok: true, code: "OK", commits, hasMore: commits.length >= cap };
}

// ── branches: list ────────────────────────────────────────────────────────────────────

async function loreListBranches(absPath: string): Promise<BranchList> {
  // Prefer the structured SDK; fall back to scraping `lore branch list` text.
  const s = await sdkBranches(absPath);
  if (s) {
    return {
      ok: true,
      code: "OK",
      current: s.current,
      detached: false,
      branches: s.branches.map((b) => ({ name: b.name, current: b.current, upstream: null, ahead: 0, behind: 0, gone: false })),
    };
  }
  const run = await runLore(absPath, ["branch", "list"]);
  if (run.spawnError || run.code !== 0) {
    return {
      ok: false,
      code: "ERROR",
      message: run.spawnError ? "lore CLI not available" : classifyLore(run).message,
      current: null,
      detached: false,
      branches: [],
    };
  }
  const { current, branches } = parseBranchList(run.stdout);
  return { ok: true, code: "OK", current, detached: false, branches };
}

// ── stash (unsupported — Lore has no stash concept) ───────────────────────────────────

const STASH_UNSUPPORTED: ActionResult = { ok: false, code: "ERROR", message: "Lore has no stash" };

async function loreReadStashes(_absPath: string): Promise<StashList> {
  return { ok: true, code: "OK", stashes: [] };
}
async function loreStashSave(_absPath: string, _identity: Identity | null, _message?: string): Promise<ActionResult> {
  return STASH_UNSUPPORTED;
}
async function loreStashPop(_absPath: string, _index?: number): Promise<ActionResult> {
  return STASH_UNSUPPORTED;
}
async function loreStashDrop(_absPath: string, _index?: number): Promise<ActionResult> {
  return STASH_UNSUPPORTED;
}

// ── file diff / discard (power the file viewer + discard on Lore repos; called from
//    service.ts for non-git repos, alongside the VcsBackend methods) ───────────────────

/**
 * A single file's unified diff — working tree vs the current revision — via `lore diff <path>`.
 * Maps to the file viewer's "patch" mode for Lore repos (we don't reconstruct both sides).
 */
export async function loreFilePatch(
  absPath: string,
  relPath: string,
): Promise<{ ok: boolean; patch: string; truncated: boolean; message?: string }> {
  const run = await runLore(absPath, ["diff", relPath]);
  if (run.spawnError) return { ok: false, patch: "", truncated: false, message: "lore CLI not available" };
  if (run.code !== 0) return { ok: false, patch: "", truncated: false, message: classifyLore(run).message };
  const truncated = run.stdout.length > PATCH_CAP;
  return { ok: true, patch: truncated ? run.stdout.slice(0, PATCH_CAP) : run.stdout, truncated };
}

/**
 * Discard a path's working-tree changes: `lore reset --purge <path>` reverts a tracked file to
 * the current revision and deletes it if it was untracked — the Lore analogue of git's discard
 * (checkout HEAD / remove untracked).
 */
export async function loreDiscardFile(
  absPath: string,
  relPath: string,
): Promise<{ ok: boolean; message?: string }> {
  const run = await runLore(absPath, ["reset", "--purge", relPath]);
  if (run.spawnError) return { ok: false, message: "lore CLI not available" };
  if (run.code !== 0) return { ok: false, message: classifyLore(run).message };
  return { ok: true };
}

/**
 * Clone a Lore repo from a server URL into `dest` via `lore clone <url> <dest>`, run from
 * `cwd` (the parent dir, which must exist; `dest` must not). Server auth is the CLI's own
 * session (`lore login`), so nothing is injected here.
 */
export async function loreClone(
  cwd: string,
  url: string,
  dest: string,
): Promise<{ ok: boolean; message?: string }> {
  const run = await runLore(cwd, ["clone", url, dest]);
  if (run.spawnError) return { ok: false, message: "lore CLI not available" };
  if (run.code !== 0) return { ok: false, message: classifyLore(run).message };
  return { ok: true };
}

// ── AI commit-diff · smart-commit grouping · content search (Lore) ────────────────────

/** Bounded working-tree diff snapshot for an AI prompt — the Lore analogue of
 *  git-actions.collectCommitDiff/collectPathsDiff. `lore status --scan` gives the changed-file
 *  list (so untracked names show) and `lore diff [paths]` the textual diff. `paths` scopes it to a
 *  subset (smart-commit per-group regenerate); omitted = whole tree. */
const LORE_DIFF_CAP = 24_000;
export async function loreCollectDiff(absPath: string, paths?: string[]): Promise<string> {
  const statusRun = await runLore(absPath, ["status", "--scan"]);
  const files = statusRun.code === 0 ? parseChangedLines(statusRun.stdout) : [];
  const status = files.length ? files.map((f) => `${f.status} ${f.path}`).join("\n") : "(clean)";
  const diffRun = await runLore(absPath, paths?.length ? ["diff", ...paths] : ["diff"]);
  const diff = diffRun.code === 0 ? diffRun.stdout.trim() : "";
  let combined = `# lore status\n${status}\n\n# lore diff\n${diff || "(no textual diff — new/untracked files only)"}`;
  if (combined.length > LORE_DIFF_CAP) combined = `${combined.slice(0, LORE_DIFF_CAP)}\n…[truncated]`;
  return combined;
}

const loreSubjectOf = (message: string): string => (message.split("\n")[0] ?? "").slice(0, 120);

/** Execute a smart-commit plan on a Lore repo: stage each group's paths and commit it, in order.
 *  `lore stage <paths>` stages exactly those paths and the commit captures only the staged set,
 *  clearing staging — so groups stay isolated WITHOUT a git-style `reset` (Lore has none). Stops on
 *  the first failure and reports a partial result; the remaining groups' changes stay safely in the
 *  tree. Runs inside one op-queue slot (the service wrapper enqueues once and refreshes after). */
export async function loreCommitGroups(
  absPath: string,
  identity: Identity | null,
  groups: CommitGroupSpec[],
): Promise<CommitGroupsResult> {
  const pre = await runLore(absPath, ["status", "--scan"]);
  if (pre.spawnError)
    return { ok: false, code: "ERROR", message: "lore CLI not available", committed: [], remaining: groups.length };
  if (pre.code !== 0) {
    const c = classifyLore(pre);
    return { ok: false, code: c.code, message: c.message, committed: [], remaining: groups.length };
  }
  if (parseChangedLines(pre.stdout).length === 0)
    return { ok: false, code: "NOTHING_TO_COMMIT", message: "nothing to commit", committed: [], remaining: groups.length };

  const committed: CommitGroupResult[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const subject = loreSubjectOf(g.message);
    const staged = await runLore(absPath, ["stage", ...g.paths]);
    if (staged.spawnError || staged.code !== 0) {
      const c = classifyLore(staged);
      committed.push({ ok: false, code: c.code, subject, message: c.message });
      return { ok: false, code: c.code, message: c.message, committed, remaining: groups.length - i - 1 };
    }
    const run = await runLore(absPath, [...loreIdentityArgs(identity), "commit", g.message]);
    if (run.code !== 0) {
      const c = classifyLore(run);
      committed.push({ ok: false, code: c.code, subject, message: c.message });
      return { ok: false, code: c.code, message: c.message, committed, remaining: groups.length - i - 1 };
    }
    committed.push({ ok: true, code: "OK", subject });
  }
  const n = committed.length;
  return { ok: true, code: "OK", message: `committed ${n} change set${n === 1 ? "" : "s"}`, committed, remaining: 0 };
}

/** Of `paths` (the changed-file set), the ones whose working-tree content contains `needle`
 *  (literal, case-insensitive). A VCS-agnostic JS scan — Lore has no `git grep`. Skips files that
 *  are missing/deleted, oversized, or look binary (a NUL byte in the head). */
const LORE_SEARCH_FILE_CAP = 2_000_000;
export async function loreSearchContent(absPath: string, needle: string, paths: string[]): Promise<string[]> {
  const lower = needle.toLowerCase();
  const hits: string[] = [];
  for (const rel of paths) {
    try {
      const st = statSync(join(absPath, rel));
      if (!st.isFile() || st.size > LORE_SEARCH_FILE_CAP) continue;
      const buf = readFileSync(join(absPath, rel));
      if (buf.subarray(0, 8000).includes(0)) continue; // NUL byte → binary, skip
      if (buf.toString("utf8").toLowerCase().includes(lower)) hits.push(rel);
    } catch {
      /* missing / unreadable (e.g. a deleted file) → skip */
    }
  }
  return hits;
}

export const loreBackend: VcsBackend = {
  kind: "lore",
  marker: ".lore",
  capabilities: { stash: false, fetch: false, multipleRemotes: false, fileModels: false },

  detect: (absPath) => existsSync(join(absPath, ".lore")),

  readStatus: loreReadStatus,
  readChanges: loreReadChanges,

  fetch: loreFetch,
  pull: lorePull,
  push: lorePush,
  commitAll: loreCommitAll,

  listBranches: loreListBranches,
  checkout: loreCheckout,
  createBranch: loreCreateBranch,
  deleteBranch: loreDeleteBranch,

  readLog: loreReadLog,
  // Per-commit diff isn't surfaced by the lore CLI yet (no structured `show`); return a graceful
  // "unavailable" detail so the History UI degrades instead of erroring.
  readCommit: async (_absPath, hash): Promise<CommitDetail> => ({
    ok: false,
    code: "ERROR",
    message: "commit detail isn't available for Lore yet",
    hash,
    shortHash: hash.slice(0, 12),
    subject: "",
    body: "",
    authorName: "",
    authorEmail: "",
    date: 0,
    parents: [],
    isMerge: false,
    committerName: "",
    committerEmail: "",
    committerDate: 0,
    files: [],
    diff: "",
    truncated: false,
  }),

  readStashes: loreReadStashes,
  stashSave: loreStashSave,
  stashPop: loreStashPop,
  stashDrop: loreStashDrop,

  // `lore diff <path>` yields a unified working-vs-current-revision patch (no models mode →
  // capabilities.fileModels is false). `lore reset --purge <path>` is the discard.
  filePatch: loreFilePatch,
  discardFile: async (absPath, relPath): Promise<ActionResult> => {
    const lr = await loreDiscardFile(absPath, relPath);
    return lr.ok ? ok("discarded") : fail("DISCARD_FAILED", lr.message ?? "lore reset failed");
  },

  collectAiDiff: loreCollectDiff,
  commitGroups: loreCommitGroups,
  searchContent: loreSearchContent,
};
