/**
 * "What would a pull actually do?" — read-only, computed entirely from objects git ALREADY has.
 *
 * The whole feature rests on one fact: `git pull` is `git fetch` + `git merge`. The fetch half
 * downloads every incoming object into the local object store and moves the remote-tracking ref
 * (origin/main); the merge half is what touches your working tree. So once a fetch has run, the
 * commits, the file list, the line counts and the patches are all sitting in `.git` and can be
 * read without going near the tree. Nothing here mutates anything.
 *
 * Git reads only; none of them modify the working tree or index:
 *   · `rev-list --left-right --count` — one atomic ahead/behind relationship snapshot
 *   · `log HEAD..@{u}`             — the commits you don't have yet
 *   · `diff --numstat HEAD...@{u}` — the net file/line effect (three dots = compare against the
 *                                    merge base, so it excludes YOUR local-only commits; that
 *                                    matches what merging actually brings in)
 *   · `read-tree -n -m -u`         — dry-run the checkout safety rules for a fast-forward,
 *                                    including dirty paths that would be overwritten
 *   · `merge-tree --write-tree`    — a full merge simulated in memory. Exits non-zero and names
 *                                    the paths when the merge would conflict, which is the part
 *                                    most git GUIs make you discover by attempting the merge and
 *                                    then backing out.
 */
import { createHash } from "node:crypto";
import { gitFor } from "../git.ts";
import { readGate } from "../gitgate.ts";
import type { CommitStat, LogEntry } from "./inspect.ts";
import { readWorktreeStateHash } from "./status.ts";

const US = "\x1f"; // field separator — see inspect.ts

/** Cap the previewed commit list; a phone can't scroll 400 commits usefully. */
export const MAX_INCOMING_COMMITS = 100;
/** Cap the previewed file list for the same reason. */
export const MAX_INCOMING_FILES = 500;

/** One file a pull would change, with its net line delta. */
export interface IncomingFile {
  path: string;
  /** A (added) / M (modified) / D (deleted), derived from the numstat + name-status pair. */
  status: string;
  addedLines: number;
  removedLines: number;
  /** True when git reported the file as binary ("-" for both counts). */
  binary: boolean;
}

/**
 * Exact repository state against which the pull verdict was checked.
 *
 * Ahead/behind counts are not identities: HEAD and the upstream can both move while preserving
 * the same counts, and a dirty path can change without moving either ref. Keep all three inputs
 * in one opaque token so the client can fail closed when a later status snapshot no longer
 * describes this preview.
 */
export interface IncomingSnapshot {
  /** Full object id of the checked-out commit. */
  headOid: string;
  /** Full object id of the configured upstream tip. */
  upstreamOid: string;
  /** Same path/status-state hash exposed by RepoStatus for exact client invalidation. */
  worktreeStateHash: string;
  /** SHA-256 of Git's index/worktree/untracked-path state. */
  indexWorktreeHash: string;
  /** SHA-256 of the three fields above; opaque to API consumers. */
  token: string;
}

export interface IncomingResult {
  ok: boolean;
  code: "OK" | "ERROR";
  message?: string;
  /** The upstream ref this compares against, e.g. "origin/main". Empty when none is configured. */
  upstream: string;
  /** True when the branch has no upstream at all — nothing to preview, and nothing to pull. */
  noUpstream: boolean;
  /** Local-only / upstream-only commit counts from one atomic rev-list snapshot. */
  ahead: number;
  behind: number;
  /** The branch relationship that determines whether an ff-only pull is possible. */
  relation:
    | "no_upstream"
    | "up_to_date"
    | "ahead_only"
    | "behind_fast_forward"
    | "diverged"
    | "unknown";
  /** The same safety verdict enforced by `git pull --ff-only`, including dirty-tree overlap. */
  pullDisposition:
    | "noop"
    | "ready_fast_forward"
    | "blocked_non_fast_forward"
    | "blocked_would_overwrite"
    | "unknown";
  /** Wall-clock time at which the final snapshot below was verified. */
  checkedAt: number;
  /** Null for no-upstream/error results that did not produce a trustworthy snapshot. */
  snapshot: IncomingSnapshot | null;
  /** Commits present upstream but not locally, newest first. */
  commits: LogEntry[];
  /** True when the commit list was capped (there are more than MAX_INCOMING_COMMITS). */
  commitsTruncated: boolean;
  /** Files the merge would change, with net line deltas. */
  files: IncomingFile[];
  /** True when the file list was capped. */
  filesTruncated: boolean;
  /** Aggregate across every incoming file (uncapped totals, even if the lists were truncated). */
  stat: CommitStat;
  /**
   * Paths that would conflict if you pulled right now, from a simulated in-memory merge.
   * Empty means the merge is expected to apply cleanly. Absent capability (very old git)
   * surfaces as `conflictCheck: false` rather than a false "clean".
   */
  conflicts: string[];
  /** False when this git couldn't run the merge simulation, so `conflicts` says nothing. */
  conflictCheck: boolean;
  /** True when the merge would fast-forward (no local commits of your own to reconcile). */
  fastForward: boolean;
}

const empty = (code: "OK" | "ERROR", message?: string): IncomingResult => ({
  ok: code === "OK",
  code,
  message,
  upstream: "",
  noUpstream: true,
  ahead: 0,
  behind: 0,
  relation: code === "OK" ? "no_upstream" : "unknown",
  pullDisposition: code === "OK" ? "noop" : "unknown",
  checkedAt: Date.now(),
  snapshot: null,
  commits: [],
  commitsTruncated: false,
  files: [],
  filesTruncated: false,
  stat: { filesChanged: 0, addedLines: 0, removedLines: 0 },
  conflicts: [],
  conflictCheck: false,
  fastForward: false,
});

/** Error-shaped incoming response for a failed fetch or an unreadable relationship. */
export const incomingError = (message: string): IncomingResult => ({
  ...empty("ERROR", message),
  // Unknown is different from "we positively resolved that this branch has no upstream".
  noUpstream: false,
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWouldOverwrite(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("would be overwritten") ||
    message.includes("not uptodate. cannot merge") ||
    message.includes("not up to date. cannot merge") ||
    message.includes("local changes would be lost")
  );
}

function relationship(ahead: number, behind: number): IncomingResult["relation"] {
  if (ahead === 0 && behind === 0) return "up_to_date";
  if (ahead > 0 && behind === 0) return "ahead_only";
  if (ahead === 0 && behind > 0) return "behind_fast_forward";
  return "diverged";
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Capture every input that can change an ff-only verdict.
 *
 * Git status records staged/unstaged state plus every untracked path. The shared state hash also
 * includes exact staged blob OIDs, because the same path can remain `M` while its index contents
 * change enough to alter checkout safety. Hashing those inputs avoids exposing filenames or
 * object IDs through the API snapshot.
 */
async function captureSnapshot(
  git: ReturnType<typeof gitFor>,
  upstream: string,
): Promise<IncomingSnapshot> {
  const headOid = (await git.raw(["rev-parse", "--verify", "HEAD"])).trim().toLowerCase();
  const upstreamOid = (await git.raw(["rev-parse", "--verify", upstream])).trim().toLowerCase();
  const status = await git.status();
  const indexWorktreeHash = await readWorktreeStateHash(git, status.files);
  return {
    headOid,
    upstreamOid,
    worktreeStateHash: indexWorktreeHash,
    indexWorktreeHash,
    token: sha256(`${headOid}\0${upstreamOid}\0${indexWorktreeHash}`),
  };
}

/** Parse one `--numstat` row: "<added>\t<removed>\t<path>" ("-" counts mean binary). */
function parseNumstat(line: string): { path: string; added: number; removed: number; binary: boolean } | null {
  const [addedRaw = "", removedRaw = "", ...rest] = line.split("\t");
  if (rest.length === 0) return null;
  const binary = addedRaw === "-" || removedRaw === "-";
  return {
    // A rename shows as "old => new" (or the brace form); keep git's own rendering rather than
    // trying to re-derive a single path from it.
    path: rest.join("\t"),
    added: binary ? 0 : Number(addedRaw) || 0,
    removed: binary ? 0 : Number(removedRaw) || 0,
    binary,
  };
}

type IncomingEarlyOut = { ok: false; result: IncomingResult };

/** Resolve the upstream. No upstream (or a detached HEAD) is a normal state, not an error. */
async function resolveUpstream(
  git: ReturnType<typeof gitFor>,
): Promise<{ ok: true; upstream: string } | IncomingEarlyOut> {
  let upstream = "";
  try {
    upstream = (await git.raw(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim();
  } catch {
    return { ok: false, result: { ...empty("OK"), message: undefined } };
  }
  if (!upstream) return { ok: false, result: empty("OK") };
  return { ok: true, upstream };
}

/** Capture a snapshot, or the error-shaped result to return early on failure. Shared by the
 *  before/after capture around the multi-command preview below. */
async function snapshotOrError(
  git: ReturnType<typeof gitFor>,
  upstream: string,
): Promise<{ ok: true; snapshot: IncomingSnapshot } | IncomingEarlyOut> {
  try {
    return { ok: true, snapshot: await captureSnapshot(git, upstream) };
  } catch (error) {
    return { ok: false, result: { ...incomingError(errorMessage(error)), upstream } };
  }
}

// One command, one graph snapshot: the left count is commits reachable only from HEAD;
// the right count is commits reachable only from the upstream. Computing these separately
// lets a ref update between calls produce an impossible relationship and a green preview
// that `pull --ff-only` immediately rejects.
async function readAheadBehind(
  git: ReturnType<typeof gitFor>,
  upstream: string,
): Promise<{ ok: true; ahead: number; behind: number } | IncomingEarlyOut> {
  try {
    const counts = (await git.raw(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]))
      .trim()
      .split(/\s+/);
    const ahead = Number(counts[0]);
    const behind = Number(counts[1]);
    if (
      counts.length < 2 ||
      !Number.isSafeInteger(ahead) ||
      !Number.isSafeInteger(behind) ||
      ahead < 0 ||
      behind < 0
    ) {
      throw new Error("git returned invalid ahead/behind counts");
    }
    return { ok: true, ahead, behind };
  } catch (error) {
    return {
      ok: false,
      result: {
        ...empty("ERROR", errorMessage(error)),
        upstream,
        noUpstream: false,
        relation: "unknown",
        pullDisposition: "unknown",
      },
    };
  }
}

/** Parse `log HEAD..@{u} --numstat` rows into ordered LogEntry rows, folding each commit's
 *  numstat lines into its own stat totals. Same field layout as readLog (subject last so an
 *  odd character can't shift a field). */
function parseIncomingCommits(rawLog: string): LogEntry[] {
  const commits: LogEntry[] = [];
  for (const line of rawLog.split("\n")) {
    if (line.trim() === "") continue;
    if (line.includes(US)) {
      const [hash = "", shortHash = "", authorName = "", authorEmail = "", at = "0", parentsRaw = "", refs = "", subject = ""] =
        line.split(US);
      const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
      commits.push({
        hash, shortHash, subject, authorName, authorEmail,
        date: Number(at) * 1000,
        refs: refs.trim(),
        parents,
        isMerge: parents.length > 1,
        stat: { filesChanged: 0, addedLines: 0, removedLines: 0 },
      });
      continue;
    }
    const current = commits.at(-1);
    if (!current?.stat) continue;
    const row = parseNumstat(line);
    if (!row) continue;
    current.stat.filesChanged += 1;
    current.stat.addedLines += row.added;
    current.stat.removedLines += row.removed;
  }
  return commits;
}

/** ── the commits you don't have ──────────────────────────────────────────────── */
async function readIncomingCommits(
  git: ReturnType<typeof gitFor>,
  upstream: string,
): Promise<{ commits: LogEntry[]; commitsTruncated: boolean }> {
  const fmt = ["%H", "%h", "%an", "%ae", "%at", "%P", "%D", "%s"].join(US);
  let rawLog = "";
  try {
    rawLog = await git.raw([
      "log",
      "--no-color",
      `--max-count=${MAX_INCOMING_COMMITS + 1}`, // +1 so we can detect truncation
      "--numstat",
      `--pretty=format:${fmt}`,
      `HEAD..${upstream}`,
    ]);
  } catch {
    rawLog = ""; // unborn HEAD, or an upstream that points at nothing yet
  }
  const commits = parseIncomingCommits(rawLog);
  const commitsTruncated = commits.length > MAX_INCOMING_COMMITS;
  if (commitsTruncated) commits.length = MAX_INCOMING_COMMITS;
  return { commits, commitsTruncated };
}

/** Status letters keyed by path, from a `--name-status` pass over the same range as the numstat
 *  pass below. Best-effort: a nicety layered onto the numstat totals, which are the substance. */
async function readIncomingFileStatuses(git: ReturnType<typeof gitFor>, upstream: string): Promise<Map<string, string>> {
  const statusByPath = new Map<string, string>();
  try {
    const rawStatus = await git.raw(["diff", "--name-status", "--no-color", `HEAD...${upstream}`]);
    for (const l of rawStatus.split("\n")) {
      const t = l.trim();
      if (!t) continue;
      const parts = t.split("\t");
      const letter = (parts[0] ?? "M")[0] ?? "M";
      const path = letter === "R" || letter === "C" ? (parts[2] ?? "") : (parts[1] ?? "");
      if (path) statusByPath.set(path, letter);
    }
  } catch {
    /* status letters are a nicety; the numstat below is the substance */
  }
  return statusByPath;
}

/** The numstat pass itself. Mutates `stat` in place (even on a caught failure mid-loop, matching
 *  the original inline behavior) so the caller's running total reflects whatever was parsed. */
async function readIncomingFiles(
  git: ReturnType<typeof gitFor>,
  upstream: string,
  statusByPath: Map<string, string>,
  stat: CommitStat,
): Promise<IncomingFile[]> {
  try {
    const rawNum = await git.raw(["diff", "--numstat", "--no-color", `HEAD...${upstream}`]);
    const all: IncomingFile[] = [];
    for (const l of rawNum.split("\n")) {
      if (l.trim() === "") continue;
      const row = parseNumstat(l);
      if (!row) continue;
      stat.filesChanged += 1;
      stat.addedLines += row.added;
      stat.removedLines += row.removed;
      all.push({
        path: row.path,
        status: statusByPath.get(row.path) ?? "M",
        addedLines: row.added,
        removedLines: row.removed,
        binary: row.binary,
      });
    }
    return all.slice(0, MAX_INCOMING_FILES);
  } catch {
    /* leave files empty; the commit list still tells the story */
    return [];
  }
}

/** ── the net file effect ─────────────────────────────────────────────────────── Three dots:
 *  compare the upstream tip against the MERGE BASE, not against HEAD. Two dots would also
 *  report your own local-only commits inverted, which is not what a pull brings. */
async function readIncomingFileEffect(
  git: ReturnType<typeof gitFor>,
  upstream: string,
  hasIncoming: boolean,
): Promise<{ files: IncomingFile[]; stat: CommitStat }> {
  const stat: CommitStat = { filesChanged: 0, addedLines: 0, removedLines: 0 };
  if (!hasIncoming) return { files: [], stat };
  // status letters and line counts come from two passes over the same range, keyed by path
  const statusByPath = await readIncomingFileStatuses(git, upstream);
  const files = await readIncomingFiles(git, upstream, statusByPath, stat);
  return { files, stat };
}

// Commit-graph safety is not enough: a fast-forward can still be refused when an
// uncommitted or staged path overlaps an incoming change. `read-tree -n` runs git's
// unpack/checkout safety checks without updating either the index or working tree,
// so this mirrors the important part of `pull --ff-only` without performing the pull.
async function checkFastForwardSafety(
  git: ReturnType<typeof gitFor>,
  upstream: string,
): Promise<{ pullDisposition: IncomingResult["pullDisposition"]; dispositionMessage?: string }> {
  try {
    await git.raw(["read-tree", "-n", "-m", "-u", "HEAD", upstream]);
    return { pullDisposition: "ready_fast_forward" };
  } catch (error) {
    if (isWouldOverwrite(error)) return { pullDisposition: "blocked_would_overwrite" };
    // Fail closed. A preflight Git/version/environment failure must never become a
    // reassuring green state just because it was not one of the expected overlap forms.
    return {
      pullDisposition: "unknown",
      dispositionMessage: "could not verify whether the fast-forward is safe for the working tree",
    };
  }
}

async function checkDivergedMerge(
  git: ReturnType<typeof gitFor>,
  upstream: string,
): Promise<{ conflicts: string[]; conflictCheck: boolean }> {
  try {
    // Output shape (git's documented `--write-tree` format):
    //   <OID of the merged toplevel tree>
    //   <one conflicted path per line, from --name-only>
    //   <blank line>
    //   <informational messages, e.g. "CONFLICT (content): ...">
    // A clean merge emits the OID and nothing else. Parse the path block rather than the
    // human-readable CONFLICT lines: the block is machine-oriented and stable, whereas
    // those messages are prose that varies by conflict type. Note simple-git RESOLVES
    // here even though git exits 1 on conflicts, so the exit code is not available to us
    // and the output is the only signal.
    const out = await git.raw(["merge-tree", "--write-tree", "--name-only", "HEAD", upstream]);
    const lines = out.split("\n");
    const paths: string[] = [];
    for (const line of lines.slice(1)) {
      if (line.trim() === "") break; // blank line closes the conflicted-path block
      paths.push(line);
    }
    return { conflicts: paths, conflictCheck: true };
  } catch {
    // Old git without --write-tree (or the merge could not be simulated at all). Say so
    // rather than reporting a clean merge we never actually checked.
    return { conflicts: [], conflictCheck: false };
  }
}

/** ── would it conflict? ──────────────────────────────────────────────────────── `merge-tree
 *  --write-tree` performs the whole merge against the object store and writes the result as a
 *  tree object. It never reads or writes the working tree or the index, so this is safe to run
 *  on a dirty repo. Older git lacks --write-tree entirely, hence conflictCheck. */
async function evaluateConflictRisk(
  git: ReturnType<typeof gitFor>,
  upstream: string,
  relation: IncomingResult["relation"],
  hasIncoming: boolean,
): Promise<{
  conflicts: string[];
  conflictCheck: boolean;
  pullDisposition: IncomingResult["pullDisposition"];
  dispositionMessage?: string;
}> {
  const fastForward = relation === "behind_fast_forward";
  let pullDisposition: IncomingResult["pullDisposition"] =
    relation === "diverged" ? "blocked_non_fast_forward" : fastForward ? "unknown" : "noop";
  let dispositionMessage: string | undefined;
  let conflicts: string[] = [];
  let conflictCheck = false;

  if (hasIncoming && fastForward) {
    conflictCheck = true; // no commit-level merge is required for a fast-forward
    const probe = await checkFastForwardSafety(git, upstream);
    pullDisposition = probe.pullDisposition;
    dispositionMessage = probe.dispositionMessage;
  } else if (hasIncoming && relation === "diverged") {
    const probe = await checkDivergedMerge(git, upstream);
    conflicts = probe.conflicts;
    conflictCheck = probe.conflictCheck;
  }

  return { conflicts, conflictCheck, pullDisposition, dispositionMessage };
}

/**
 * Everything a pull would bring in. Reflects the last fetch: if nothing has fetched recently the
 * answer is simply "nothing incoming", which is why callers fetch first (see the service layer).
 */
export async function readIncoming(absPath: string): Promise<IncomingResult> {
  try {
    return await readGate.run(async () => {
      const git = gitFor(absPath);

      const upstreamResult = await resolveUpstream(git);
      if (!upstreamResult.ok) return upstreamResult.result;
      const { upstream } = upstreamResult;

      // Capture before and after the multi-command preview. `readGate` limits child-process
      // fan-out but does not serialize this read with every external Git/file-system mutation.
      // If anything relevant changes mid-read, fail closed instead of returning data assembled
      // from two different repository states.
      const initial = await snapshotOrError(git, upstream);
      if (!initial.ok) return initial.result;
      const initialSnapshot = initial.snapshot;

      const counts = await readAheadBehind(git, upstream);
      if (!counts.ok) return counts.result;
      const { ahead, behind } = counts;
      const relation = relationship(ahead, behind);
      const hasIncoming = behind > 0;

      const { commits, commitsTruncated } = await readIncomingCommits(git, upstream);
      const { files, stat } = await readIncomingFileEffect(git, upstream, hasIncoming);
      const { conflicts, conflictCheck, pullDisposition, dispositionMessage } = await evaluateConflictRisk(
        git,
        upstream,
        relation,
        hasIncoming,
      );
      const fastForward = relation === "behind_fast_forward";

      const final = await snapshotOrError(git, upstream);
      if (!final.ok) return final.result;
      const snapshot = final.snapshot;
      if (snapshot.token !== initialSnapshot.token) {
        return {
          ...incomingError("repository changed while the pull preview was being checked"),
          upstream,
        };
      }

      return {
        ok: true,
        code: "OK" as const,
        message: dispositionMessage,
        upstream,
        noUpstream: false,
        ahead,
        behind,
        relation,
        pullDisposition,
        checkedAt: Date.now(),
        snapshot,
        commits,
        commitsTruncated,
        files,
        filesTruncated: stat.filesChanged > files.length,
        stat,
        conflicts,
        conflictCheck,
        fastForward,
      };
    });
  } catch (e) {
    return incomingError(errorMessage(e));
  }
}
