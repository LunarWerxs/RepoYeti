// ── conflict resolve: propose a merge resolution for a conflicted working-tree file ────────
//
// The highest-stakes AI call in the app, and the only one whose output can end up as SOURCE
// rather than as a commit message. Every design choice here follows from that:
//
//   - It PROPOSES. Generating and applying are two separate endpoints, and the model's text
//     never reaches disk without an explicit owner action (src/http/routes/files.ts).
//   - It is resolved per HUNK, not per file. A file with four conflicts where the model got
//     three right is a useful result; forcing all-or-nothing would throw those three away.
//   - Every proposal is MECHANICALLY audited (assessResolution) on top of whatever confidence
//     the model claims for itself. A model that drops a line both sides agreed on is wrong no
//     matter how confident it sounds, and that check costs nothing.
//   - Unaccepted hunks keep their conflict markers, so a partial apply leaves the file still
//     unmerged and git still refuses to commit it. There is no state where a half-resolved
//     file looks finished.
//
// The transport is a DELIMITED text protocol, not JSON — deliberately. The payload here is
// source code, and JSON string escaping is where models break on exactly that: one Windows
// path or regex literal and the whole reply fails to parse, taking every hunk with it. A
// sentinel-delimited block is per-hunk recoverable, so a mangled hunk 3 costs hunk 3 only.
import type { AiProviderId } from "../config.ts";
import { AI_ADAPTERS, CONFLICT_SAMPLING, conflictMaxTokens, type AiProviderRuntime } from "./adapters.ts";
import { AiError, requestJson, type AiCode, type FetchFn } from "./commit-message.ts";

const RESOLVE_TIMEOUT_MS = 90_000;

/** Refuse to even parse beyond this — a conflicted file this large is not a review the owner
 *  can do in a browser, and shipping it to a provider would be a large bill for a bad idea. */
export const MAX_CONFLICT_FILE_BYTES = 512_000;

/** A file with more conflicts than this is a botched rebase, not a merge to resolve one-by-one. */
export const MAX_CONFLICT_HUNKS = 40;

/** Prompt budget for the whole-file context block. Past this the file is windowed around the
 *  conflicts (the isolated per-region blocks are always sent in full regardless). */
const MAX_CONTEXT_BYTES = 60_000;

/** Lines of surrounding context kept on each side of a conflict when the file is windowed. */
const WINDOW_LINES = 60;

// ── marker parsing (PURE) ──────────────────────────────────────────────────────────────

/** One conflict region as git wrote it into the working-tree file. */
export interface ConflictHunk {
  /** 1-based position in the file, in file order — the id the model answers against. */
  index: number;
  /** 0-based line number of the `<<<<<<<` marker (for the UI's "line 412" label). */
  line: number;
  /** Label after `<<<<<<<` — usually "HEAD" or the current branch name. */
  oursLabel: string;
  /** Label after `>>>>>>>` — the incoming branch/commit. */
  theirsLabel: string;
  /** Our side, verbatim including line terminators. */
  oursText: string;
  /** Common-ancestor side — present only when the file carries diff3/zdiff3 markers, or when
   *  the service layer enriched it from the index stages (see src/service/conflicts.ts). Its
   *  absence is why prompt rule 7 is conditional: without a base, add-vs-delete is ambiguous. */
  baseText?: string;
  /** Their side, verbatim including line terminators. */
  theirsText: string;
  /** The ENTIRE original region, `<<<<<<<` line through `>>>>>>>` line inclusive. Rebuilding an
   *  unaccepted hunk splices this back byte-for-byte, so declining a proposal is a true no-op. */
  raw: string;
}

/** A parsed conflicted file: original text sliced into verbatim spans and conflict regions. */
export interface ParsedConflictFile {
  /** Alternating spans. `text` segments are exact slices of the original file, so anything
   *  outside a conflict region survives a rebuild byte-for-byte (line endings included). */
  segments: Array<{ kind: "text"; text: string } | { kind: "conflict"; hunk: ConflictHunk }>;
  hunks: ConflictHunk[];
  /** The file's dominant line terminator — the one applied to model-supplied content. */
  eol: "\n" | "\r\n";
}

/** Split text into lines that KEEP their terminators, so slices rejoin byte-exactly. */
function linesWithEol(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Strip a line's terminator for content comparisons. */
const bare = (line: string): string => line.replace(/\r?\n$/, "");

/** True when the text contains a git conflict marker at the start of any line. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})(?![<=>])/m.test(text);
}

/**
 * Parse a conflicted file into verbatim spans plus structured hunks, or null when the file is
 * not parseable as a conflict.
 *
 * Returns null (rather than a partial parse) on a NESTED `<<<<<<<` inside an open region. That
 * shape comes from a conflicted file that was itself merged again, and guessing at its structure
 * risks splicing a resolution into the wrong nesting level — a way to corrupt a file that no
 * amount of downstream review would catch. The owner resolves those by hand.
 */
export function parseConflictFile(text: string): ParsedConflictFile | null {
  if (!hasConflictMarkers(text)) return null;
  const lines = linesWithEol(text);
  const segments: ParsedConflictFile["segments"] = [];
  const hunks: ConflictHunk[] = [];

  let pending = ""; // verbatim run of non-conflict text
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const content = bare(raw);
    if (!/^<{7}(?!<)/.test(content)) {
      pending += raw;
      i++;
      continue;
    }
    // ── an open conflict region ──
    const startLine = i;
    const oursLabel = content.slice(7).trim();
    let ours = "";
    let base: string | undefined;
    let theirs = "";
    let theirsLabel = "";
    let phase: "ours" | "base" | "theirs" = "ours";
    let closed = false;
    let block = raw;
    i++;
    for (; i < lines.length; i++) {
      const l = lines[i]!;
      const c = bare(l);
      if (/^<{7}(?!<)/.test(c)) return null; // nested conflict — refuse the whole file
      block += l;
      if (/^\|{7}(?!\|)/.test(c)) {
        phase = "base";
        base = "";
        continue;
      }
      if (/^={7}(?!=)/.test(c)) {
        phase = "theirs";
        continue;
      }
      if (/^>{7}(?!>)/.test(c)) {
        theirsLabel = c.slice(7).trim();
        closed = true;
        i++;
        break;
      }
      if (phase === "ours") ours += l;
      else if (phase === "base") base += l;
      else theirs += l;
    }
    if (!closed) return null; // unterminated region — not a file we understand

    if (pending) {
      segments.push({ kind: "text", text: pending });
      pending = "";
    }
    const hunk: ConflictHunk = {
      index: hunks.length + 1,
      line: startLine,
      oursLabel: oursLabel || "ours",
      theirsLabel: theirsLabel || "theirs",
      oursText: ours,
      ...(base !== undefined ? { baseText: base } : {}),
      theirsText: theirs,
      raw: block,
    };
    hunks.push(hunk);
    segments.push({ kind: "conflict", hunk });
  }
  if (pending) segments.push({ kind: "text", text: pending });
  if (hunks.length === 0) return null;

  // Dominant terminator: CRLF only when it is what the file actually uses throughout. A file
  // that is mostly LF gets LF for model-supplied content, which is what its next diff expects.
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return { segments, hunks, eol: crlf > 0 && crlf >= lf / 2 ? "\r\n" : "\n" };
}

/**
 * Splice accepted resolutions back into the file. Hunks with no entry in `accepted` keep their
 * ORIGINAL conflict markers verbatim, which is the invariant that makes a partial apply safe:
 * git still sees the path as unmerged, still refuses to commit it, and the auto-commit gate
 * (src/auto-commit.ts) still skips the repo.
 */
export function renderResolvedFile(
  parsed: ParsedConflictFile,
  accepted: Map<number, string>,
): string {
  let out = "";
  for (const seg of parsed.segments) {
    if (seg.kind === "text") {
      out += seg.text;
      continue;
    }
    const replacement = accepted.get(seg.hunk.index);
    if (replacement === undefined) {
      out += seg.hunk.raw;
      continue;
    }
    out += normalizeContent(replacement, parsed.eol, seg.hunk.raw.endsWith("\n"));
  }
  return out;
}

/**
 * Fit model-supplied content to the file: its terminator, and a trailing newline only where the
 * region it replaces had one. Without the second rule, resolving the LAST hunk of a file with no
 * trailing newline would silently add one — a one-byte diff on a line nobody edited.
 */
function normalizeContent(content: string, eol: "\n" | "\r\n", trailingNewline: boolean): string {
  if (!content) return "";
  const body = content.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const joined = eol === "\r\n" ? body.replace(/\n/g, "\r\n") : body;
  return trailingNewline ? joined + eol : joined;
}

// ── mechanical audit of a proposal (PURE) ──────────────────────────────────────────────

/** What the model claims about its own resolution. Advisory — `flags` is the part we verify. */
export type ResolutionConfidence = "high" | "medium" | "low";

/**
 * Machine-checked observations about a proposed resolution. These are NOT the model's opinion:
 * every one is computed from the three texts, so a confidently-worded bad merge still carries
 * its evidence into the review UI. This is the check that does the most work when the owner has
 * pointed a small model at their merge.
 */
export type ResolutionFlag =
  /** A non-blank line present on BOTH sides is missing from the resolution. The single strongest
   *  bad-merge signal there is: if the two sides agreed on a line, dropping it is a mistake. */
  | "dropped-shared-lines"
  /** Byte-identical to our side — the model picked, it did not combine. Often right, but the
   *  owner should know that their incoming change was discarded wholesale. */
  | "identical-to-ours"
  /** Byte-identical to their side — same, in the other direction. */
  | "identical-to-theirs"
  /** Materially shorter than the shorter of the two sides — code went missing somewhere. */
  | "much-shorter"
  /** A large share of the output appears on neither side nor in the base: the model wrote new
   *  code rather than merging existing code. Sometimes the necessary glue, often a rewrite. */
  | "invented-lines"
  /** Empty output where at least one side had content. */
  | "emptied";

export interface ResolutionAudit {
  flags: ResolutionFlag[];
  /** Non-blank lines present on both sides that the resolution dropped (UI shows them). */
  droppedLines: string[];
  /** Non-blank lines in the resolution that appear on neither side nor in the base. */
  inventedLines: string[];
}

const nonBlank = (text: string): string[] =>
  text.split("\n").map((l) => l.trim().replace(/\r$/, "")).filter(Boolean);

/**
 * Audit a proposed resolution against the sides it claims to merge. Pure and unit-tested; runs
 * on every hunk regardless of provider, so the guarantees here hold even for a provider whose
 * self-reported confidence is meaningless.
 */
export function assessResolution(hunk: ConflictHunk, content: string): ResolutionAudit {
  const ours = nonBlank(hunk.oursText);
  const theirs = nonBlank(hunk.theirsText);
  const base = hunk.baseText === undefined ? [] : nonBlank(hunk.baseText);
  const got = nonBlank(content);
  const gotSet = new Set(got);
  const oursSet = new Set(ours);
  const theirsSet = new Set(theirs);
  const knownSet = new Set([...ours, ...theirs, ...base]);

  const flags: ResolutionFlag[] = [];

  // Lines both sides kept, that the resolution did not.
  const droppedLines = [...oursSet].filter((l) => theirsSet.has(l) && !gotSet.has(l));
  if (droppedLines.length > 0) flags.push("dropped-shared-lines");

  const inventedLines = got.filter((l) => !knownSet.has(l));
  // A little glue (a brace, a comma, a merged import line) is legitimate and expected; a quarter
  // of the output being novel is a rewrite wearing a merge's clothes. The floor of 2 keeps a
  // one-line region from tripping this on its single necessary edit.
  if (inventedLines.length >= 2 && inventedLines.length > got.length * 0.25) {
    flags.push("invented-lines");
  }

  if (got.length === 0 && (ours.length > 0 || theirs.length > 0)) flags.push("emptied");
  else {
    const floor = Math.min(ours.length || Infinity, theirs.length || Infinity);
    if (Number.isFinite(floor) && floor >= 3 && got.length < floor * 0.5) flags.push("much-shorter");
  }

  // Compared on trimmed content, not bytes: a resolution that differs from our side only by
  // trailing whitespace picked a side, and saying otherwise would be a distinction without one.
  const same = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((l, i) => l === b[i]);
  if (ours.length > 0 && same(got, ours)) flags.push("identical-to-ours");
  else if (theirs.length > 0 && same(got, theirs)) flags.push("identical-to-theirs");

  return { flags, droppedLines: droppedLines.slice(0, 20), inventedLines: inventedLines.slice(0, 20) };
}

// ── model-tier heuristic (PURE) ────────────────────────────────────────────────────────

/**
 * Whether the selected model id LOOKS like a small/fast tier.
 *
 * Merge resolution is the one place in this app where a weaker model does not degrade
 * gracefully: a bad commit message is a cosmetic annoyance the owner reads before it lands,
 * while a bad merge is plausible-looking source that compiles. So the UI warns on every model
 * and warns harder on these — the ones sold on latency and price rather than reasoning.
 *
 * Deliberately two-valued. There is no "capable" list here because such a list is wrong within
 * a quarter, and telling an owner their model is good enough for this is a claim this heuristic
 * has no business making. A non-match means "we don't recognise this as a small tier", not
 * "this is fine".
 *
 * Note that several of AI_CATALOG's own `recommended` models match (gpt-4o-mini, flash, haiku).
 * That is the correct and intended result: those defaults were chosen for cheap commit
 * messages, and this call is not that.
 */
export function looksSmallTierModel(model: string): boolean {
  const m = model.toLowerCase();
  if (/(^|[^a-z0-9])(mini|nano|tiny|small|lite|instant|haiku|flash-?lite|distill|turbo-instruct)([^a-z0-9]|$)/.test(m)) {
    return true;
  }
  if (/(^|[^a-z0-9])flash([^a-z0-9]|$)/.test(m)) return true;
  // Parameter counts at or below ~13B — "llama-3.1-8b", "qwen2.5-7b", "gemma-2-2b", "0.5b".
  const params = m.match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/g) ?? [];
  return params.some((p) => {
    const n = Number.parseFloat(p);
    return Number.isFinite(n) && n <= 13;
  });
}

// ── prompt building (PURE) ─────────────────────────────────────────────────────────────

const SENTINEL_START = "<<<REPOYETI-HUNK";
const SENTINEL_END = "<<<REPOYETI-END";
const SENTINEL_BODY = "---CONTENT---";

export function resolveSystemPrompt(hasBase: boolean): string {
  return (
    "You are resolving git merge conflicts in one source file. You are shown the file with its " +
    "conflict markers intact, then each conflict region again on its own, numbered. For every " +
    "numbered region you output the exact text that replaces the WHOLE region — the `<<<<<<<` " +
    "line, both sides, and the `>>>>>>>` line all go away and your text stands in their place.\n\n" +
    "NON-NEGOTIABLE RULES\n" +
    "1. Combine both sides' INTENT. A conflict normally means two people edited nearby lines for " +
    "two unrelated reasons, and the correct resolution keeps BOTH changes. Picking a side is the " +
    "exception, not the default.\n" +
    "2. Never drop a line that appears on BOTH sides. If the two sides agreed on it, it stays.\n" +
    "3. Never invent, rewrite, rename, refactor or reformat. Every line you emit should come from " +
    "one of the sides, plus the minimum glue needed to join them (a comma, a closing brace, one " +
    "merged import list). You are merging code, not editing it.\n" +
    "4. Preserve indentation, whitespace and comment style exactly as the surrounding file uses " +
    "them. Match the file, not your habits.\n" +
    "5. Never emit `<<<<<<<`, `=======` or `>>>>>>>` in your output.\n" +
    "6. WHEN YOU CANNOT TELL WHICH SIDE IS RIGHT, DO NOT GUESS. If the two sides make genuinely " +
    "incompatible claims about the same thing — different constants, opposite conditions, two " +
    "different algorithms for one job — output OUR side verbatim, set `CONFIDENCE: low`, and say " +
    "in the NOTE exactly what the two sides disagree about. A conflict you flag costs a human ten " +
    "seconds. A confident wrong merge costs them a debugging session, and they will not know to " +
    "look. Flagging is the better answer and you will not be penalised for it.\n" +
    (hasBase
      ? "7. BASE is the common ancestor. Use it to tell an addition from a deletion: a side that " +
        "differs from BASE changed something, a side that matches BASE did not. If one side " +
        "deleted what the other modified, that is rule 6 — flag it, do not pick.\n"
      : "7. There is no common-ancestor text available for this file, so you CANNOT tell an " +
        "addition from a deletion. Be correspondingly more willing to use rule 6.\n") +
    "\n" +
    "OUTPUT FORMAT — one block per region, in order, and nothing else:\n" +
    `${SENTINEL_START} n>>>\n` +
    "CONFIDENCE: high|medium|low\n" +
    "NOTE: one short line — what you did, and for low confidence what the disagreement is\n" +
    `${SENTINEL_BODY}\n` +
    "the replacement text, verbatim, no markdown fences\n" +
    `${SENTINEL_END} n>>>\n\n` +
    "No prose before, between or after the blocks. If a region should resolve to nothing (both " +
    "sides deleted it), emit the block with an empty content section."
  );
}

/** Render a hunk for the isolated per-region section of the prompt. */
function renderHunk(h: ConflictHunk): string {
  const side = (label: string, text: string): string =>
    `--- ${label} ---\n${text.replace(/\r\n/g, "\n") || "(empty)\n"}`;
  return (
    `### REGION ${h.index} (file line ${h.line + 1})\n` +
    side(`OURS (${h.oursLabel})`, h.oursText) +
    (h.baseText !== undefined ? side("BASE (common ancestor)", h.baseText) : "") +
    side(`THEIRS (${h.theirsLabel})`, h.theirsText)
  );
}

/**
 * Window a large file down to the neighbourhoods of its conflicts.
 *
 * The isolated per-region blocks are never windowed — only this whole-file context block is, and
 * only when the file would blow the prompt budget. Elisions are marked so the model can tell a
 * gap from adjacency (an unmarked jump reads as "these two functions are neighbours", which is
 * exactly the sort of false context that produces a confident wrong merge).
 */
function windowFile(text: string, parsed: ParsedConflictFile): { body: string; windowed: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_CONTEXT_BYTES) return { body: text, windowed: false };
  const lines = linesWithEol(text);
  const keep = new Set<number>();
  let cursor = 0;
  for (const seg of parsed.segments) {
    const count = linesWithEol(seg.kind === "text" ? seg.text : seg.hunk.raw).length;
    if (seg.kind === "conflict") {
      const from = Math.max(0, cursor - WINDOW_LINES);
      const to = Math.min(lines.length, cursor + count + WINDOW_LINES);
      for (let i = from; i < to; i++) keep.add(i);
    }
    cursor += count;
  }
  let body = "";
  let elided = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (elided > 0) {
        body += `\n… ${elided} unchanged line${elided === 1 ? "" : "s"} not shown …\n\n`;
        elided = 0;
      }
      body += lines[i];
    } else elided++;
  }
  if (elided > 0) body += `\n… ${elided} unchanged line${elided === 1 ? "" : "s"} not shown …\n`;
  return { body, windowed: true };
}

export function resolveUserPrompt(path: string, text: string, parsed: ParsedConflictFile): string {
  const { body, windowed } = windowFile(text, parsed);
  return (
    `File: ${path}\n` +
    `Conflicts: ${parsed.hunks.length}, numbered 1 to ${parsed.hunks.length} in the order they appear.\n` +
    (windowed
      ? "NOTE: this file is large, so the context below shows only the neighbourhoods of each " +
        "conflict. Elisions are marked. Every conflict region itself is shown in full.\n"
      : "") +
    `\n===== FILE (conflict markers intact) =====\n${body}\n` +
    `\n===== CONFLICT REGIONS =====\n${parsed.hunks.map(renderHunk).join("\n")}\n` +
    `\nResolve all ${parsed.hunks.length} region${parsed.hunks.length === 1 ? "" : "s"} using the ` +
    "output format. Apply rule 6 whenever you are not sure — a flagged region is a good outcome."
  );
}

// ── response parsing (PURE) ────────────────────────────────────────────────────────────

/** One region's proposed replacement, after parsing, validation and the mechanical audit. */
export interface HunkResolution {
  index: number;
  /** The replacement text (line terminators normalised on apply, not here). */
  content: string;
  /** The model's own claim about this resolution. */
  confidence: ResolutionConfidence;
  /** The model's one-line explanation, for the review UI. */
  note: string;
  /** Machine-checked observations — see ResolutionFlag. */
  flags: ResolutionFlag[];
  droppedLines: string[];
  inventedLines: string[];
}

/** A region the model answered for, but whose answer we refused. Surfaced so the UI can say
 *  WHICH regions came back unusable rather than silently showing fewer cards than conflicts. */
export interface RejectedHunk {
  index: number;
  reason: "conflict-markers" | "missing" | "malformed" | "duplicate";
}

export interface ConflictResolution {
  path: string;
  resolutions: HunkResolution[];
  rejected: RejectedHunk[];
  /** True when the whole-file context was windowed (the model saw a partial file). */
  windowed: boolean;
}

const CONFIDENCES = new Set<ResolutionConfidence>(["high", "medium", "low"]);

/** Drop a markdown fence the model wrapped the content in despite being told not to. */
function stripFence(content: string): string {
  const m = /^\s*```[a-zA-Z0-9+#.-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(content);
  return m?.[1] ?? content;
}

/**
 * Parse the delimited reply into validated per-hunk resolutions.
 *
 * Per-hunk recovery is the point: a region whose block is malformed, duplicated, or still
 * carrying conflict markers is dropped into `rejected` and the rest survive. A region the model
 * skipped entirely is rejected as "missing" rather than quietly omitted, because "the model did
 * not answer for hunk 3" and "hunk 3 needs no change" must never look the same in the UI.
 */
export function parseConflictResolution(
  text: string,
  hunks: ConflictHunk[],
): { resolutions: HunkResolution[]; rejected: RejectedHunk[] } {
  const byIndex = new Map(hunks.map((h) => [h.index, h]));
  const resolutions: HunkResolution[] = [];
  const rejected: RejectedHunk[] = [];
  const seen = new Set<number>();

  const blockRe = new RegExp(
    `${escapeRe(SENTINEL_START)}\\s*(\\d+)\\s*>>>\\r?\\n([\\s\\S]*?)${escapeRe(SENTINEL_END)}\\s*\\1\\s*>>>`,
    "g",
  );
  for (const m of (text ?? "").matchAll(blockRe)) {
    const index = Number.parseInt(m[1] ?? "", 10);
    const hunk = byIndex.get(index);
    if (!hunk) continue; // a region number that does not exist — ignore rather than reject
    if (seen.has(index)) {
      rejected.push({ index, reason: "duplicate" });
      continue;
    }
    seen.add(index);

    const block = m[2] ?? "";
    const split = block.indexOf(SENTINEL_BODY);
    if (split === -1) {
      rejected.push({ index, reason: "malformed" });
      continue;
    }
    const header = block.slice(0, split);
    // The newlines either side of the content are the protocol's own separators, not content:
    // one after `---CONTENT---`, one before the END sentinel. Keeping the trailing one would put
    // a phantom blank line in the review textarea and in whatever the owner sends back on apply.
    const content = stripFence(
      block.slice(split + SENTINEL_BODY.length).replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
    );

    // A resolution carrying conflict markers is not a resolution. Refusing it here is what keeps
    // "applied" from ever meaning "the markers moved somewhere else in the file".
    if (hasConflictMarkers(content)) {
      rejected.push({ index, reason: "conflict-markers" });
      continue;
    }

    const rawConf = (/CONFIDENCE:\s*(\w+)/i.exec(header)?.[1] ?? "").toLowerCase();
    // An unparseable confidence becomes "low", never "high": the failure mode of guessing high
    // is an owner trusting a proposal nobody vouched for.
    const confidence = (CONFIDENCES.has(rawConf as ResolutionConfidence)
      ? rawConf
      : "low") as ResolutionConfidence;
    const note = (/NOTE:\s*(.+)/i.exec(header)?.[1] ?? "").trim().slice(0, 400);
    const audit = assessResolution(hunk, content);
    resolutions.push({ index, content, confidence, note, ...audit });
  }

  for (const h of hunks) if (!seen.has(h.index)) rejected.push({ index: h.index, reason: "missing" });
  resolutions.sort((a, b) => a.index - b.index);
  rejected.sort((a, b) => a.index - b.index);
  return { resolutions, rejected };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── the call ───────────────────────────────────────────────────────────────────────────

/**
 * Ask the model to propose a resolution for every conflict in one file. Writes NOTHING — the
 * caller returns this to the UI for review, and a separate endpoint applies whatever the owner
 * accepts.
 *
 * Throws AiError on a provider failure or a reply with no usable block at all. There is
 * deliberately NO heuristic fallback here, unlike the commit planner: a deterministic
 * "resolution" of a merge conflict would be a guess dressed as an answer, and the honest
 * degraded state for this feature is the conflict markers the owner already has.
 */
export async function generateConflictResolution(
  provider: AiProviderId,
  apiKey: string,
  model: string,
  path: string,
  text: string,
  parsed: ParsedConflictFile,
  fetchImpl: FetchFn = fetch,
  runtime: AiProviderRuntime = {},
): Promise<ConflictResolution> {
  const adapter = AI_ADAPTERS[provider];
  const hasBase = parsed.hunks.some((h) => h.baseText !== undefined);
  const user = resolveUserPrompt(path, text, parsed);
  const windowed = user.includes("unchanged line");

  const json = await requestJson(
    adapter.generateUrl(model, apiKey, runtime),
    {
      method: "POST",
      headers: adapter.headers(apiKey, runtime),
      body: JSON.stringify(
        adapter.buildBody(
          model,
          [
            { role: "system", content: resolveSystemPrompt(hasBase) },
            { role: "user", content: user },
          ],
          conflictMaxTokens(parsed.hunks, text.length),
          CONFLICT_SAMPLING,
        ),
      ),
    },
    fetchImpl,
    RESOLVE_TIMEOUT_MS,
    provider, // shares the rate-limit pause with the message/plan calls — same provider budget
  );

  const completion = adapter.extractCompletion(json) ?? "";
  const { resolutions, rejected } = parseConflictResolution(completion, parsed.hunks);
  if (resolutions.length === 0) {
    throw new AiError("AI_ERROR", "the model did not return a usable resolution for any conflict");
  }
  return { path, resolutions, rejected, windowed };
}

export type { AiCode };
