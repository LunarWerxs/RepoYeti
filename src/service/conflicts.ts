/**
 * Working-tree side of AI conflict resolution: find the conflicted files, hand one to the
 * resolver with as much context as git can cheaply provide, and splice accepted resolutions
 * back onto disk.
 *
 * The safety posture lives here as much as in the prompt:
 *   - Reading is free of side effects. Nothing in the "list" or "read" path mutates the repo,
 *     the index, or the file — including the common-ancestor enrichment, which reconstructs
 *     diff3 markers in a temp directory rather than running `git checkout --conflict=diff3`
 *     (that would rewrite the working file and destroy any hand-edits already made to it).
 *   - Applying NEVER stages. A resolved file stays unmerged in git's index until the owner
 *     stages it themselves, so `git commit` keeps refusing and the auto-commit safety gate
 *     (src/auto-commit.ts hasConflict) keeps skipping the repo. "The AI resolved it" and "the
 *     merge is done" stay two different states, which is the whole point.
 *   - Applying is guarded against a stale proposal: the request carries a hash of the file the
 *     proposal was made against, and a file that changed underneath is refused rather than
 *     merged against text nobody reviewed. The check runs twice on purpose — once here, against
 *     the parse the replacement is rendered from, and again INSIDE the file writer's op-queue
 *     slot (writeFileContent's `expectedHash`), because the first check can be minutes stale by
 *     the time the write reaches the front of the queue. The 1.0 audit reproduced exactly that:
 *     a desktop edit landing between the validation and the queued write was overwritten, and
 *     the call returned OK.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepo, type RepoStatus } from "../db.ts";
import { gitFor } from "../git.ts";
import { enqueue } from "../opqueue.ts";
import { pathTouchesVcsMarker } from "../paths.ts";
import { readChanges } from "../read/status.ts";
import { fileContentHash, readFileContent, resolveRepoPath, writeFileContent } from "./files.ts";
import { forceRefresh } from "./core.ts";
import { stageFile } from "./actions.ts";
import {
  MAX_CONFLICT_FILE_BYTES,
  MAX_CONFLICT_HUNKS,
  hasConflictMarkers,
  parseConflictFile,
  renderResolvedFile,
  type ConflictHunk,
  type ParsedConflictFile,
} from "../ai/conflict-resolve.ts";
import type { ChangedFile, ConflictKind } from "../read/status.ts";

/** One conflicted path as the resolver UI lists it. */
export interface ConflictListEntry {
  path: string;
  /** Which unmerged pair this is (both-modified, deleted-by-us, …). */
  kind?: ConflictKind;
  /** Number of marker regions in the working file — 0 when the conflict carries no markers. */
  hunks: number;
  /** Set when this path cannot be resolved by this feature, with the reason why. */
  unsupported?: "no-markers" | "binary" | "too-large" | "too-many-hunks" | "unparseable" | "missing";
}

export interface ConflictListResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  files?: ConflictListEntry[];
}

/** One conflicted file, parsed and ready to show or resolve. */
export interface ConflictFileResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "NOT_CONFLICTED" | "ERROR";
  message?: string;
  path?: string;
  /** Full working-tree text, markers intact. */
  text?: string;
  /** SHA-256 of `text` — the staleness token the apply call must echo back. */
  hash?: string;
  hunks?: ConflictHunk[];
  /** True when common-ancestor text was recovered for the hunks (better resolutions). */
  hasBase?: boolean;
  /** Parsed form, kept out of the HTTP response but used by the resolve route. */
  parsed?: ParsedConflictFile;
}

/** Content hash used as the apply call's staleness token — the file viewer's own hash, so the
 *  writer can re-verify it without knowing which feature produced it. */
export function conflictFileHash(text: string): string {
  return fileContentHash(text);
}

/**
 * Recover the common-ancestor text for each hunk from git's index stages.
 *
 * Git only writes `|||||||` base markers when `merge.conflictStyle` is diff3/zdiff3, which is
 * not the default — so most owners' conflicted files carry only the two sides. That absence is
 * expensive here: without the ancestor a model cannot tell "they added this" from "we deleted
 * it", which is precisely the class of conflict where a wrong guess is silent and severe.
 *
 * The reconstruction is verified before it is trusted. We re-render the merge from stages 1/2/3
 * in a temp directory and graft its base texts across ONLY where the rendered hunks line up with
 * the on-disk hunks side-for-side. An owner who already hand-edited part of the file will fail
 * that check, and then we simply proceed without a base rather than describing their file with
 * text it no longer contains.
 *
 * Best-effort throughout: every failure path returns the parse unchanged.
 */
async function enrichWithBase(absPath: string, relPath: string, parsed: ParsedConflictFile): Promise<boolean> {
  if (parsed.hunks.some((h) => h.baseText !== undefined)) return true; // already diff3
  let dir: string | null = null;
  try {
    const git = gitFor(absPath);
    // Stage 1 is the common ancestor, 2 is ours, 3 is theirs. A conflict with no ancestor
    // (add/add) has no stage 1 at all, and there is nothing to recover for it.
    const [base, ours, theirs] = await Promise.all([
      git.raw(["show", `:1:${relPath}`]).catch(() => null),
      git.raw(["show", `:2:${relPath}`]).catch(() => null),
      git.raw(["show", `:3:${relPath}`]).catch(() => null),
    ]);
    if (base == null || ours == null || theirs == null) return false;

    dir = mkdtempSync(join(tmpdir(), "repoyeti-merge-"));
    const files = { base: join(dir, "base"), ours: join(dir, "ours"), theirs: join(dir, "theirs") };
    writeFileSync(files.ours, ours);
    writeFileSync(files.base, base);
    writeFileSync(files.theirs, theirs);

    // `-p` prints to stdout and touches nothing; a conflicted merge exits non-zero, which
    // simple-git surfaces as a throw even though the output on stdout is exactly what we want.
    let rendered: string;
    try {
      rendered = await git.raw(["merge-file", "-p", "--diff3", files.ours, files.base, files.theirs]);
    } catch (e) {
      const out = (e as { stdout?: string })?.stdout;
      if (typeof out !== "string" || !out) return false;
      rendered = out;
    }
    const reparsed = parseConflictFile(rendered);
    if (!reparsed || reparsed.hunks.length !== parsed.hunks.length) return false;

    // Only graft where BOTH sides match the on-disk hunk — that is what proves this rendering
    // describes the same conflict the owner is looking at.
    const norm = (s: string): string => s.replace(/\r\n/g, "\n");
    let grafted = 0;
    for (let i = 0; i < parsed.hunks.length; i++) {
      const live = parsed.hunks[i]!;
      const from = reparsed.hunks[i]!;
      if (norm(live.oursText) !== norm(from.oursText)) continue;
      if (norm(live.theirsText) !== norm(from.theirsText)) continue;
      if (from.baseText === undefined) continue;
      live.baseText = from.baseText;
      grafted++;
    }
    return grafted > 0;
  } catch {
    return false;
  } finally {
    // A directory this function created moments ago, holding three files it wrote itself.
    if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
  }
}

/** Reads + classifies one conflicted path into its list entry (deleted / binary / too-large /
 *  unparseable / too-many-hunks / resolvable). Read-only, mirrors listConflicts' prior inline logic. */
async function buildConflictListEntry(repoId: string, f: ChangedFile): Promise<ConflictListEntry> {
  const read = await readFileContent(repoId, f.path, "work");
  const entry: ConflictListEntry = { path: f.path, ...(f.conflict ? { kind: f.conflict } : {}), hunks: 0 };
  if (!read.ok || read.ref !== "work") {
    // deleted-by-us / deleted-by-them: there is no working file to carry markers.
    return { ...entry, unsupported: "missing" };
  }
  if (read.binary) return { ...entry, unsupported: "binary" };
  if ((read.size ?? 0) > MAX_CONFLICT_FILE_BYTES || read.truncated) {
    return { ...entry, unsupported: "too-large" };
  }
  const parsed = parseConflictFile(read.content ?? "");
  if (!parsed) {
    return { ...entry, unsupported: hasConflictMarkers(read.content ?? "") ? "unparseable" : "no-markers" };
  }
  if (parsed.hunks.length > MAX_CONFLICT_HUNKS) {
    return { ...entry, hunks: parsed.hunks.length, unsupported: "too-many-hunks" };
  }
  return { ...entry, hunks: parsed.hunks.length };
}

/**
 * Every currently-unmerged path in the repo, each annotated with whether this feature can act
 * on it. Unsupported paths are listed WITH their reason rather than filtered out — an owner
 * whose delete/modify conflict simply vanished from the list would reasonably conclude the
 * feature was broken.
 */
export async function listConflicts(repoId: string): Promise<ConflictListResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  try {
    const changes = await readChanges(repo.absPath);
    const conflicted = changes.filter((f) => f.status === "C");
    const files: ConflictListEntry[] = [];
    for (const f of conflicted) {
      files.push(await buildConflictListEntry(repoId, f));
    }
    return { ok: true, code: "OK", files };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Read + parse one conflicted file, enriching it with common-ancestor text where git can supply
 * it. Read-only. The returned `hash` is what the apply call must echo to prove it is resolving
 * the same bytes the owner reviewed.
 */
export async function readConflictFile(repoId: string, relPath: string): Promise<ConflictFileResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const read = await readFileContent(repoId, relPath, "work");
  if (!read.ok) return { ok: false, code: "NOT_FOUND", message: read.message ?? "file not found" };
  if (read.ref !== "work") {
    return { ok: false, code: "NOT_CONFLICTED", message: "this path has no working-tree file to resolve" };
  }
  if (read.binary) return { ok: false, code: "NOT_CONFLICTED", message: "binary files cannot be resolved here" };
  // A truncated read would rebuild the file from a partial view and silently lop off its tail.
  if (read.truncated || (read.size ?? 0) > MAX_CONFLICT_FILE_BYTES) {
    return { ok: false, code: "NOT_CONFLICTED", message: "file is too large to resolve here" };
  }
  const text = read.content ?? "";
  const parsed = parseConflictFile(text);
  if (!parsed) {
    return {
      ok: false,
      code: "NOT_CONFLICTED",
      message: hasConflictMarkers(text)
        ? "the conflict markers in this file are nested or unterminated — resolve it by hand"
        : "this file has no conflict markers",
    };
  }
  if (parsed.hunks.length > MAX_CONFLICT_HUNKS) {
    return {
      ok: false,
      code: "NOT_CONFLICTED",
      message: `this file has ${parsed.hunks.length} conflicts (limit ${MAX_CONFLICT_HUNKS}) — resolve it in a merge tool`,
    };
  }
  const hasBase = await enrichWithBase(repo.absPath, read.path ?? relPath, parsed);
  return {
    ok: true,
    code: "OK",
    path: read.path ?? relPath,
    text,
    hash: conflictFileHash(text),
    hunks: parsed.hunks,
    hasBase,
    parsed,
  };
}

/** One region the owner accepted, with the text they accepted (possibly hand-edited). */
export interface AcceptedResolution {
  index: number;
  content: string;
}

export interface ApplyConflictResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "NOT_CONFLICTED" | "CONFLICT_STALE" | "ERROR" | "TOO_LARGE" | "IS_BINARY" | "NOT_WRITABLE";
  message?: string;
  path?: string;
  /** Regions written in this call. */
  applied?: number;
  /** Regions still carrying conflict markers afterwards — 0 means the file is fully resolved
   *  (but still NOT staged; see the module doc). */
  remaining?: number;
}

/**
 * Splice accepted resolutions into the conflicted file on disk.
 *
 * Deliberately agnostic about where the text came from: the AI proposal and an owner's
 * hand-edit of that proposal travel the same path and get the same validation. What it will not
 * do is write text still carrying conflict markers, write against a file that changed since the
 * proposal, or stage anything.
 */
export async function applyConflictResolutions(
  repoId: string,
  relPath: string,
  expectedHash: string,
  accepted: AcceptedResolution[],
): Promise<ApplyConflictResult> {
  const current = await readConflictFile(repoId, relPath);
  if (!current.ok || !current.parsed) {
    return { ok: false, code: current.code === "OK" ? "ERROR" : current.code, message: current.message };
  }
  // The file changed under the proposal — refuse rather than merge into text nobody reviewed.
  if (current.hash !== expectedHash) {
    return {
      ok: false,
      code: "CONFLICT_STALE",
      message: "this file changed since the resolution was generated — re-read it and try again",
    };
  }

  const known = new Set(current.parsed.hunks.map((h) => h.index));
  const map = new Map<number, string>();
  for (const a of accepted) {
    if (!known.has(a.index)) {
      return { ok: false, code: "NOT_CONFLICTED", message: `conflict ${a.index} does not exist in this file` };
    }
    if (map.has(a.index)) {
      return { ok: false, code: "ERROR", message: `conflict ${a.index} was accepted twice` };
    }
    // The last line of defence, and the one that holds even if every earlier check is bypassed:
    // markers never get written back into the file under the banner of a resolution.
    if (hasConflictMarkers(a.content)) {
      return {
        ok: false,
        code: "NOT_CONFLICTED",
        message: `the resolution for conflict ${a.index} still contains conflict markers`,
      };
    }
    map.set(a.index, a.content);
  }
  if (map.size === 0) return { ok: false, code: "ERROR", message: "no resolutions were accepted" };

  const next = renderResolvedFile(current.parsed, map);
  // Reuse the viewer's writer: it owns the .git-path refusal, the symlink/directory checks, the
  // size cap and the atomic rename. A second implementation of those guards is a second place
  // for them to be wrong. `expectedHash` makes it a compare-and-write: the bytes `next` was
  // rendered from must still be the bytes on disk when the write reaches the front of the queue.
  const written = await writeFileContent(repoId, current.path ?? relPath, next, { expectedHash });
  if (!written.ok) {
    if (written.code === "FILE_STALE") {
      return {
        ok: false,
        code: "CONFLICT_STALE",
        message: "this file changed since the resolution was generated — re-read it and try again",
      };
    }
    return { ok: false, code: written.code, message: written.message };
  }

  await forceRefresh(repoId); // the conflict badge + change list should update immediately
  return {
    ok: true,
    code: "OK",
    path: current.path ?? relPath,
    applied: map.size,
    remaining: current.parsed.hunks.length - map.size,
  };
}

// ── manual resolution: the path for everything the AI cannot touch (1.0 audit, item 25) ───────
//
// Every verb above needs the working file to be text, small enough to read, and carrying parsable
// markers. A large share of real conflicts are none of those: a binary asset, a generated file
// past the size cap, a delete/modify pair (git leaves the surviving side's file in the tree with
// no markers in it, and nothing on disk can express "keep the deletion" - only the index knows
// that side deleted the path). Those were listed with a reason and then left completely inert -
// no button, nothing to click - so the owner had to leave the panel, find the same path in a
// terminal, and remember the plumbing.
//
// The two verbs below are that missing floor, and they are deliberately the two GIT already
// defines rather than a new merge engine: take one side whole, and stage the result once it is
// right. Taking a side works for every conflict kind including the ones with no text at all,
// because it copies out of the index's stages rather than parsing the file.

/** Which side of the merge to keep whole. `ours` is the branch being merged INTO. */
export type ConflictSide = "ours" | "theirs";

export interface ChooseSideResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "NOT_CONFLICTED" | "ERROR";
  message?: string;
  path?: string;
  /** What the working tree holds afterwards: that side's content, or nothing when it deleted it. */
  result?: "written" | "deleted";
  /** Post-action status for the initiating client (see ActionOutcome.status in service/core.ts). */
  status?: RepoStatus | null;
}

/** Index stage numbers present for one unmerged path: 1 base, 2 ours, 3 theirs. */
async function unmergedStages(absPath: string, relPath: string): Promise<Set<string>> {
  const out = await gitFor(absPath).raw(["ls-files", "-u", "--", relPath]);
  const stages = new Set<string>();
  for (const line of out.split("\n")) {
    // `<mode> <sha> <stage>\t<path>` - the stage is the last field before the tab.
    const meta = line.split("\t")[0];
    const stage = meta?.trim().split(/\s+/)[2];
    if (stage) stages.add(stage);
  }
  return stages;
}

/**
 * Keep one side of a conflict whole.
 *
 * WHY IT COPIES OUT OF THE INDEX rather than reading the file: the stages are the only
 * representation of the two sides that exists for a binary file, a file past the read cap, or a
 * delete/modify pair. `git checkout-index --stage=N` writes exactly those bytes and touches
 * nothing else, so this one verb covers every conflict kind the panel can list.
 *
 * A side that has no stage DELETED the path, and keeping that side means the working file goes
 * away. That is the delete/modify case, which previously had no action at all.
 *
 * DELIBERATELY DOES NOT STAGE, exactly like applyConflictResolutions above. The index stays
 * unmerged until the owner stages on purpose, so `git commit` keeps refusing and auto-commit's
 * safety gate keeps skipping the repo. "I picked a side" and "the merge is finished" stay two
 * different states, and staging is the second, separate verb below.
 */
export async function chooseConflictSide(
  repoId: string,
  relPath: string,
  side: ConflictSide,
): Promise<ChooseSideResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  // Git-only: a Lore repo is centralized and never produces an unmerged index here.
  if (repo.vcs !== "git") {
    return { ok: false, code: "NOT_CONFLICTED", message: "only git repositories have merge conflicts" };
  }
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  if (pathTouchesVcsMarker(r.clean, ".git")) {
    return { ok: false, code: "ERROR", message: "refusing to touch a .git directory" };
  }

  try {
    const stages = await unmergedStages(repo.absPath, r.clean);
    // No stages means the index is not unmerged for this path: it was resolved by someone else,
    // or the panel is stale. Refuse rather than overwrite a file nobody is in a merge over.
    if (stages.size === 0) {
      return { ok: false, code: "NOT_CONFLICTED", message: "this path is not currently conflicted" };
    }
    const wanted = side === "ours" ? "2" : "3";
    const absFile = join(repo.absPath, r.clean);

    if (stages.has(wanted)) {
      await enqueue(repoId, () =>
        gitFor(repo.absPath).raw(["checkout-index", "-f", `--stage=${wanted}`, "--", r.clean]),
      );
      const refreshed = await forceRefresh(repoId);
      return { ok: true, code: "OK", path: r.clean, result: "written", status: refreshed?.status ?? null };
    }

    // That side deleted the path. `resolveRepoPath` has already confined this inside the repo and
    // the marker-directory check above rules out the one place a delete would be unrecoverable.
    await enqueue(repoId, async () => {
      if (existsSync(absFile)) rmSync(absFile, { force: true });
    });
    const refreshed = await forceRefresh(repoId);
    return { ok: true, code: "OK", path: r.clean, result: "deleted", status: refreshed?.status ?? null };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

export interface StageConflictResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "STAGE_FAILED" | "SUBMODULE_NOT_ACTIONABLE" | "CONFLICT_MARKERS_PRESENT";
  message?: string;
  path?: string;
  /** How many marker regions were still in the file when staging was refused. */
  remaining?: number;
  /** Post-action status for the initiating client (see ActionOutcome.status in service/core.ts). */
  status?: RepoStatus | null;
}

/**
 * Stage one path the owner says they have finished resolving, refusing if it still has markers.
 *
 * The marker check is the whole reason this is not just the ordinary per-file Stage. The manual
 * path this feature adds ends with the owner editing the file in the viewer or an external
 * editor, and the file writer has no idea it is looking at a merge - so nothing anywhere stopped
 * `<<<<<<< HEAD` from being staged and then committed. That is a mistake git itself catches only
 * if you happen to look, and it is exactly the mistake a hand-resolution makes.
 *
 * A path with no working file is fine and is NOT an error: it is the delete/modify case where the
 * owner kept the deletion, and `git add` stages a removal for a tracked path.
 */
export async function stageResolvedConflict(repoId: string, relPath: string): Promise<StageConflictResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const read = await readFileContent(repoId, relPath, "work");
  // Only a readable text file can be checked, and only a readable text file can carry markers.
  // A binary, an oversized or a missing file goes straight through: there is nothing to look for.
  if (read.ok && read.ref === "work" && !read.binary && !read.truncated) {
    const text = read.content ?? "";
    if (hasConflictMarkers(text)) {
      const parsed = parseConflictFile(text);
      return {
        ok: false,
        code: "CONFLICT_MARKERS_PRESENT",
        message: "this file still contains conflict markers - finish resolving it before staging",
        path: read.path ?? relPath,
        remaining: parsed?.hunks.length ?? 0,
      };
    }
  }
  const staged = await stageFile(repoId, relPath);
  if (!staged.ok) return { ok: false, code: staged.code, message: staged.message, path: staged.path };
  return { ok: true, code: "OK", path: staged.path, status: staged.status ?? null };
}
