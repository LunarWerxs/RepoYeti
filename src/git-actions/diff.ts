/**
 * Read-only, bounded collection of git diffs/status/grep results — the inputs fed to the AI
 * commit-message/planner prompts and the file viewer's compact-diff mode, plus the changes-tree
 * "search content" toggle. Every reader here streams stdout and kills the child at a byte cap so
 * a pathological change-set can't balloon memory, time, or a provider payload. Never mutates the
 * index.
 */
import { safeGitEnv } from "../git.ts";
import { readChanges } from "../read/status.ts";
import { normalizeRelPath } from "../paths.ts";
import type { CommitPlanInput, PlanInputFile } from "../ai.ts";
import { DEFAULT_DIFF_DETAIL, type DiffDetail } from "../config.ts";
import { PATCH_CAP } from "../contract.ts";

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

/**
 * Accumulate a bounded `git diff` (up to `cap` bytes) with the unborn-HEAD fallback baked in: try
 * `git diff HEAD <extraArgs> [-- <chunk>…]`, and if that comes back empty — a repo with no commits
 * yet errors/empties on `diff HEAD` — retry the same WITHOUT `HEAD` against the worktree. Pass
 * `paths=null` (or empty) for the whole tree (no pathspec); otherwise the pathspec is chunked so a
 * big group can't overflow the OS arg limit. `extraArgs` carries per-caller flags (e.g. -U0 -M).
 * Read-only. Extracted so the three diff collectors share ONE fallback path.
 */
async function boundedDiff(
  absPath: string,
  paths: string[] | null,
  extraArgs: string[],
  cap: number,
): Promise<string> {
  const chunks: (string[] | null)[] = paths?.length ? chunkByBytes(paths) : [null];
  const run = async (base: string[]): Promise<string> => {
    let out = "";
    for (const chunk of chunks) {
      if (out.length >= cap) break;
      out += await boundedGit(absPath, chunk ? [...base, "--", ...chunk] : base, cap);
    }
    return out.trim();
  };
  const withHead = await run(["diff", "HEAD", ...extraArgs]);
  return withHead || (await run(["diff", ...extraArgs]));
}

/**
 * Shared tail of the two message collectors: read the diff generously, fold each file to the
 * owner's diff-detail slice, THEN bound the result.
 *
 * The order is the whole point (same lesson as the planner): capping at READ time is
 * first-come-first-served, so one big file eats the budget and every file behind it never reaches
 * the model. Folding first means a runaway file costs its slice instead of everything — which also
 * finally puts a ceiling on lockfiles here, since this path (unlike the planner) has no
 * isNoisyPath filter and used to send a `package-lock.json` diff in full.
 */
async function statusPlusFoldedDiff(
  absPath: string,
  paths: string[] | null,
  status: string,
  detail: DiffDetail,
): Promise<string> {
  const caps = DIFF_DETAIL_CAPS[detail];
  // `--diff-algorithm=minimal` is what aicommits, lazycommit and gptcommit all send and it is free:
  // git's default Myers can emit a larger, noisier edit script than necessary, and every spurious
  // line is budget spent on a change nobody made. Default 3-line context is deliberate here (unlike
  // the planner's -U0): this diff is read to WRITE PROSE, and the neighbouring statement is usually
  // where a one-line edit's meaning lives.
  const raw = await boundedDiff(absPath, paths, ["--diff-algorithm=minimal"], MSG_RAW_CAP);
  const folded = foldLargeFileDiffs(raw, caps.perFile).diff;
  let combined =
    `# git status --porcelain\n${status || "(clean)"}\n\n# git diff\n${folded || "(no textual diff — new/untracked files only)"}`;
  if (combined.length > caps.msgTotal) combined = `${combined.slice(0, caps.msgTotal)}\n…[truncated]`;
  return combined;
}

export async function collectCommitDiff(absPath: string, detail: DiffDetail = DEFAULT_DIFF_DETAIL): Promise<string> {
  const status = (await boundedGit(absPath, ["status", "--porcelain=v1"], STATUS_CAP)).trim();
  return statusPlusFoldedDiff(absPath, null, status, detail);
}

/**
 * Like collectCommitDiff but SCOPED to a subset of paths — the input for regenerating ONE
 * proposed commit's message from just its files (`git status`/`git diff HEAD -- <paths>`).
 * Bounded + read-only; chunks the pathspec so a big group can't overflow the OS arg limit.
 */
export async function collectPathsDiff(
  absPath: string,
  paths: string[],
  detail: DiffDetail = DEFAULT_DIFF_DETAIL,
): Promise<string> {
  if (paths.length === 0) return "";
  const chunks = chunkByBytes(paths);
  let status = "";
  for (const chunk of chunks) {
    if (status.length >= STATUS_CAP) break;
    status += await boundedGit(absPath, ["status", "--porcelain=v1", "--", ...chunk], STATUS_CAP);
  }
  return statusPlusFoldedDiff(absPath, paths, status.trim(), detail);
}

/**
 * What the AI reads, per the owner's "AI diff detail" dial (Settings → AI). Governs BOTH the
 * ✨ Generate message path and the Auto planner. The point is fairness, not just size: without a per-file slice the diff is
 * first-come-first-served, so one big file eats the whole budget and every file after it is
 * invisible.
 *
 * Measured on a real repo before this existed: `data/car-embeddings.json` (generated) was 97% of
 * a 40k diff — 106 other files shared the remaining 3%, so the planner was grouping essentially
 * blind AND we paid ~10k tokens for a blob of numbers.
 *
 * `perFile` in ~changed lines at -U0 (~40 chars/line): lean ≈ 30, balanced ≈ 50, thorough ≈ 100.
 * Even `lean` is enough to tell what a file's change is ABOUT, which is all GROUPING needs (the
 * complete file list + real +/- stats ride along regardless) — the dial really trades how much of
 * a LARGE file's body feeds its message against tokens spent per commit.
 *
 * BOTH bounds have to move together, or the dial silently does nothing on a repo with many
 * similar-sized files: the total cap binds first, so every setting lands on the same payload.
 * Measured before this was split out — ✨ Generate on a 20-file repo produced an identical 6,003
 * tokens at lean, balanced AND thorough, because all three overran the flat total and got cut to
 * it. `msgTotal`/`planTotal` at `balanced` are exactly the historical caps (24k / 40k), so the
 * default preserves today's behavior and the dial only moves cheaper or richer from there.
 */
export const DIFF_DETAIL_CAPS: Record<DiffDetail, { perFile: number; msgTotal: number; planTotal: number }> = {
  lean: { perFile: 1_200, msgTotal: 12_000, planTotal: 20_000 },
  balanced: { perFile: 2_000, msgTotal: 24_000, planTotal: 40_000 },
  thorough: { perFile: 4_000, msgTotal: 40_000, planTotal: 64_000 },
};

/**
 * Context lines around each planner hunk.
 *
 * Was `-U0` (zero context), which is the cheapest possible diff and reads as a reasonable choice
 * for a CLASSIFIER: to decide which files belong together you do not need the surrounding lines.
 * But the same call also writes each commit's message, and zero context makes a deletion
 * unreadable. Measured, on a file whose only change was deleting an unused local:
 *
 *     @@ -2 +1,0 @@ export function parseTag(raw: string): { … } {
 *     -  const unused = false;
 *
 * The one visible line is a deletion and the most prominent identifier is `parseTag`, from the hunk
 * header — so the model concluded the FUNCTION was removed, in 4 of 6 runs, and said so. That is
 * not a hallucination in any useful sense; it is a fair reading of the only evidence given. One
 * line of context on each side shows the function's body still standing and the claim collapses.
 *
 * Not a coincidence, either: of seven surveyed commit-message tools none send -U0, and gptcommit
 * sends `--function-context` (MORE than git's default). One line is the cheap end of that range —
 * a couple of lines per hunk against a per-file cap, to stop the tool confidently misreporting a
 * deletion.
 */
const PLAN_CONTEXT = "-U1";

/** Raw diff read from git BEFORE folding. Only what survives folding is sent to the provider, so
 *  this is just local memory — read generously so every file's head is available to fold from,
 *  rather than losing late files to the send-cap before folding can even see them. */
const PLAN_RAW_CAP = 400_000;
/** Same idea as PLAN_RAW_CAP, for the message collectors (whose send cap is msgTotal). */
const MSG_RAW_CAP = 400_000;

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
  const base = (normalizeRelPath(path).split("/").pop() ?? "").toLowerCase();
  return NOISE_BASENAMES.has(base) || NOISE_EXT.test(base);
}

/**
 * CONDENSE one over-sized file chunk into a symbol-level change map.
 *
 * This replaces truncation, and the difference matters: cutting a 5,000-line file to its first
 * 50 lines shows the model an ARBITRARY 2% of the change and silently hides the rest. The map
 * shows 100% of WHAT changed — every symbol touched, with its own +/- counts — for a fraction of
 * the tokens the truncated head cost.
 *
 * It's free, because git already computed it. Every hunk header carries the enclosing
 * declaration:
 *
 *     @@ -80,4 @@ export function systemPromptFor(style: CommitStyle): string {
 *
 * That works for .ts/.vue with no diff driver configured — git's default heuristic takes the last
 * line at column 0 that looks like a declaration, and JS/TS declarations live at column 0. Where
 * it yields nothing useful (minified blobs, data files with no structure) the rows degrade to a
 * line-range, which is still honest and still tiny.
 *
 * Pure + unit-testable.
 */
/**
 * Does a hunk-header context line actually name a DECLARATION?
 *
 * This guard exists because a symbol map is only worth sending if the symbols are real. git's
 * default heuristic takes the last column-0 line that looks declaration-ish, which lands on real
 * functions in .ts — but in .ps1 it happily returns `if (-not (Test-Path $pkgPath)) {`. Measured
 * live: fed a map of `if` blocks, the model invented "simplify conditionals for better
 * readability" for what was actually a rewrite of the daemon-identity logic. Confident fiction is
 * worse than a truncated-but-real diff, so when the labels are junk we send real lines instead.
 */
function looksLikeDeclaration(sym: string): boolean {
  const s = sym.trim();
  if (!s) return false;
  // Control flow / punctuation / comments are never declarations, however column-0 they sit.
  if (/^(if|else|elseif|elif|for|foreach|while|switch|case|do|try|catch|finally|return|end|then|begin)\b/i.test(s)) {
    return false;
  }
  if (/^[}\])#]|^\/\/|^<!--|^@ line\b/.test(s)) return false;
  // A declaration keyword, or a name followed by an argument list (a signature).
  return (
    /\b(function|class|def|fn|func|interface|type|struct|impl|trait|enum|sub|proc|module|namespace|const|let|var|public|private|protected|static|async|export|default)\b/i.test(
      s,
    ) || /^[\w.$:<>[\]-]+\s*\(/.test(s)
  );
}

/**
 * The smallest excerpt worth appending to a symbol map. Below this a couple of orphaned diff
 * lines are noise the model has to explain away, so the map alone is the better answer.
 */
const MIN_EXCERPT_CHARS = 240;

/** Smallest useful slice of ONE hunk: its `@@` header plus roughly three real lines. Below this a
 *  hunk excerpt only proves the hunk exists, which the symbol map already said for free. */
const MIN_HUNK_EXCERPT = 160;

/**
 * Allowance for the excerpt's caption, reserved before the excerpt is measured — the caption's own
 * text needs the excerpt's line count, so it cannot be measured first. Deliberately generous
 * against a ~88-char worst case ("# the first 1234 diff lines, verbatim (56789 more folded — the
 * rows above cover them):"). Reserving it tight is a real bug and not a small one: overshooting
 * the cap by a single character makes the fit check below drop the WHOLE excerpt, so the file
 * silently falls back to a bare map — the exact starvation this excerpt exists to end.
 */
const EXCERPT_CAPTION_CHARS = 120;

function condenseFileChunk(chunk: string, perFileCap: number): string {
  const lines = chunk.split("\n");
  const fileHeader = lines[0] ?? "";
  // Everything before the first hunk is the git preamble (index/---/+++ or a binary notice).
  const firstHunk = chunk.search(/^@@ /m);
  if (firstHunk === -1) return chunk; // no hunks (binary/rename-only) — already tiny, leave it

  const hunks = chunk.slice(firstHunk).split(/(?=^@@ )/m);
  // Enclosing declaration → tally. Several hunks share a label whenever they sit inside the same
  // one, so each row records HOW MANY edits it covers and WHERE they start — see the note below
  // on why that matters.
  const rows = new Map<string, { add: number; del: number; hunks: number; lines: number[] }>();
  for (const h of hunks) {
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/m.exec(h);
    if (!head) continue;
    const sym = (head[2] ?? "").trim() || `@ line ${head[1]}`;
    const row = rows.get(sym) ?? { add: 0, del: 0, hunks: 0, lines: [] };
    row.hunks++;
    row.lines.push(Number(head[1]));
    for (const l of h.split("\n").slice(1)) {
      if (l.startsWith("+")) row.add++;
      else if (l.startsWith("-")) row.del++;
    }
    rows.set(sym, row);
  }
  if (rows.size === 0) return chunk;

  // Only trade real lines for a map if the map says something TRUE. Where git couldn't find real
  // declarations the rows are control-flow noise, and a model handed noise doesn't stay vague —
  // it invents. Returning the chunk unchanged makes the caller fall back to a truncated head:
  // partial, but every line of it is a fact.
  const named = [...rows.keys()].filter(looksLikeDeclaration).length;
  if (named * 2 < rows.size) return chunk;

  // A label is the ENCLOSING declaration, which is not always the thing that changed. git's
  // default heuristic is column-0-only, so an INDENTED method never becomes the label — edit two
  // methods of one class and both hunks come back labelled `export class Widget {`. Merging those
  // into a bare "+2/-2" would claim one edit where there were two, and the looksLikeDeclaration
  // gate can't catch it (the label is a perfectly real declaration, just too coarse). So say what
  // we actually know: how many separate edits, and where they start. "2 edits @L3,L8" lets the
  // model describe two changes; "+2/-2" alone would have hidden one of them.
  const body = [...rows.entries()]
    .map(([sym, r]) => {
      const label = sym.length > 90 ? `${sym.slice(0, 90)}…` : sym;
      const where = r.hunks > 1 ? `  ${r.hunks} edits @L${r.lines.join(",L")}` : `  @L${r.lines[0]}`;
      return `  ${label}  +${r.add}/-${r.del}${where}`;
    })
    .join("\n");
  // Terse on purpose. This caption is repeated for EVERY folded file, and it competes for the same
  // per-file budget as the code the model actually needs to read: the three explanatory lines this
  // used to carry cost ~280 chars a file, which on `balanced`'s 2,000 is a hunk's worth of real
  // diff traded for prose the rows mostly speak for themselves.
  const map =
    `${fileHeader}\n` +
    `# condensed: each row is the enclosing declaration of a change, its +/- counts, and where.\n` +
    `${body}\n`;

  // Spend what the cap already allows on REAL lines, SPREAD ACROSS EVERY HUNK.
  //
  // The map answers "which files belong in one commit", which is what this fold was built for. It
  // cannot answer "what changed", and the same call also writes each commit's BODY — so a fully
  // condensed file left the message-writer with nothing but symbol names and +/- counts. It
  // answered exactly as well as that allows: "Modified `AI_ADAPTERS` record to accommodate
  // changes". The budget to fix it was already authorised and going unspent (a condensed file cost
  // ~670 chars against `balanced`'s 2,000 cap), so the leftover buys verbatim lines.
  //
  // Spread, not head-first. Head-first was the obvious choice and it measurably failed: a file's
  // hunks are scattered through it, so an excerpt off the top covers the first symbol or two and
  // leaves every later one named-but-unseen. Live, `AI_ADAPTERS` sat at L214 with its edits fully
  // outside the excerpt, and the model produced that same "to accommodate changes" line — it could
  // read the symbol's NAME in the map and none of its code. Giving every hunk a slice makes the map
  // and the excerpt describe the same set of changes, which is the only way a bullet-per-file body
  // can be written from this input. Depth is what the per-file cap trades away; coverage is not
  // negotiable, because an unseen hunk is exactly what invented prose gets written about.
  const room = perFileCap - map.length - EXCERPT_CAPTION_CHARS;
  if (room < MIN_EXCERPT_CHARS) return map;

  // Rank by how much each hunk actually changed and spend on the biggest first. An equal split is
  // the obvious move and it self-destructs: a 20-hunk file divides an ~880-char budget into 44-char
  // shares, which cannot hold even a `@@` header, so every hunk degrades to a header (or the whole
  // excerpt overflows and the fit check below throws it away). Ranking concentrates the budget
  // where the substance is and lets the map cover the rest, which is what the map is for.
  const weigh = (h: string): number =>
    h.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).length;
  const ranked = hunks.map((h, at) => ({ h, at })).sort((a, b) => weigh(b.h) - weigh(a.h));

  const taken = new Map<number, string>();
  let budget = room;
  let elided = 0;
  for (const { h, at } of ranked) {
    const lines = h.split("\n").filter((l, i, a) => l !== "" || i !== a.length - 1);
    const header = lines[0] ?? ""; // "@@ -a,b +c,d @@ enclosing decl" — cheap, highly informative
    // A hunk excerpt below its header plus a couple of lines says nothing worth the tokens; leave
    // that hunk to the map rather than spend the budget proving we saw it.
    if (budget < header.length + MIN_HUNK_EXCERPT) {
      elided += Math.max(0, lines.length - 1);
      continue;
    }
    const share = Math.min(budget, Math.max(MIN_HUNK_EXCERPT, Math.floor(room / hunks.length)));
    let text = `${header}\n`;
    let n = 1;
    for (; n < lines.length; n++) {
      const line = lines[n]!;
      if (text.length + line.length + 1 > share) break;
      text += `${line}\n`;
    }
    elided += Math.max(0, lines.length - n);
    taken.set(at, text);
    budget -= text.length;
  }
  if (taken.size === 0) return map;
  // Emit in FILE order, not budget order: a diff read out of order is a diff misread.
  const excerpt = [...taken.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("");
  if (excerpt.length < MIN_EXCERPT_CHARS) return map;
  const shown = excerpt.split("\n").length - 1;
  const out =
    `${map}# ${shown} diff lines, verbatim, from the ${taken.size} largest of ${hunks.length} hunks` +
    `${elided > 0 ? ` (${elided} more lines folded — the rows above cover them)` : ""}:\n${excerpt}`;
  // Belt-and-braces: the caption estimate is a constant, so prove the result really fits rather
  // than trusting it. The map alone is always a valid answer.
  return out.length <= perFileCap ? out : map;
}

/**
 * Shrink the diff so a big file costs a summary instead of the whole budget.
 *
 * Two halves, and isNoisyPath() is only the first: it folds by NAME (lockfiles, *.min.js), which
 * can only catch files someone thought to list. A generated `data/car-embeddings.json` is an
 * ordinary .json by name — measured at 97% of a real 40k planner diff, with 106 other files
 * sharing the remaining 3%.
 *
 * Under the per-file cap a chunk is sent VERBATIM: small diffs are both cheap and precise, so
 * there is nothing to gain by touching them. Over it, the chunk becomes its symbol map plus as
 * much verbatim diff as the cap still allows (see condenseFileChunk) — a table of contents AND
 * the first pages, because the caller needs the map to GROUP the files and real lines to
 * DESCRIBE them, and the map alone silently starved every commit body it wrote.
 *
 * Pure + unit-testable. `shrunk` counts files that were shrunk AT ALL (condensed OR truncated);
 * `condensed` counts only the ones that got a real symbol map. They differ whenever a file can't
 * be mapped — a data blob, or the control-flow-noise case — and keeping them separate matters
 * because "we summarised N files" and "we blind-truncated N files" are very different claims for
 * anything downstream to make.
 */
export function foldLargeFileDiffs(
  diff: string,
  perFileCap: number,
): { diff: string; folded: number; condensed: number } {
  if (!diff) return { diff, folded: 0, condensed: 0 };
  // Split BEFORE each "diff --git" so every chunk keeps its own header.
  const chunks = diff.split(/(?=^diff --git )/m);
  let folded = 0;
  let condensedCount = 0;
  const out = chunks.map((chunk) => {
    if (chunk.length <= perFileCap) return chunk;
    folded++;
    const condensed = condenseFileChunk(chunk, perFileCap);
    // Never let the "summary" cost more than the truncation it replaced — a pathological file
    // (thousands of one-line hunks) can out-grow its own body. Fall through to the head cut.
    // condenseFileChunk also returns the chunk UNCHANGED when it refuses (no hunks, no rows, or
    // junk labels), which lands here too — so only count a map when we actually emitted one.
    if (condensed.length <= perFileCap && condensed !== chunk) {
      condensedCount++;
      return condensed;
    }
    // Cut on a line boundary — half a diff line is worse than no line.
    const head = chunk.slice(0, perFileCap);
    const nl = head.lastIndexOf("\n");
    const kept = nl > 0 ? head.slice(0, nl) : head;
    const elided = chunk.slice(kept.length).split("\n").length - 1;
    return `${kept}\n… [${elided} more diff lines folded — large file; its full +/- stat is in the file list]\n`;
  });
  return { diff: out.join(""), folded, condensed: condensedCount };
}

/**
 * Build the read-only input for the AI commit planner: the complete changed-file list (with
 * per-file +/- stats and rename sources) plus a bounded, TOKEN-TRIMMED diff. Never mutates the
 * index. The file list is authoritative (it drives validation + grouping); the diff is best-
 * effort context, sent at ZERO context (`-U0`, just the changed lines) and with noisy files'
 * bodies folded out (see isNoisyPath) — so a big change-set stays small enough for a provider's
 * rate limit. May still be truncated on a pathological change-set.
 *
 * `onlyPaths` optionally SCOPES the plan to a subset of the working tree (the owner's checked
 * selection in the changed-files tree — see ChangesTree). An empty/undefined `onlyPaths` means
 * "no scope requested" and the whole working tree is planned, same as before this param existed —
 * the UI is responsible for turning "nothing checked" into "no scope requested" (empty selection
 * = plan everything), never into an accidental empty plan.
 */
export async function collectCommitPlanInput(
  absPath: string,
  onlyPaths?: string[],
  detail: DiffDetail = DEFAULT_DIFF_DETAIL,
): Promise<CommitPlanInput> {
  const all = await readChanges(absPath, true); // withStats → per-file add/remove counts
  const scope = onlyPaths?.length ? new Set(onlyPaths) : null;
  const changed = scope ? all.filter((f) => scope.has(f.path)) : all;

  // Only diff the files worth reading; fold out lockfiles/generated/minified (their name + stat
  // in the file list is enough for grouping). `-U0` trims to just the changed lines.
  const diffPaths = changed.map((f) => f.path).filter((p) => !isNoisyPath(p));
  // Read generously, THEN fold per-file, THEN apply the send cap. Order matters: capping at read
  // time is first-come-first-served, so a single huge file would consume the budget and hide
  // every file behind it — folding first gives each file a fair slice of what we actually send.
  const raw = diffPaths.length > 0
    ? await boundedDiff(absPath, diffPaths, [PLAN_CONTEXT, "--no-color", "-M", "--diff-algorithm=minimal"], PLAN_RAW_CAP)
    : "";
  const planCaps = DIFF_DETAIL_CAPS[detail];
  let diff = foldLargeFileDiffs(raw, planCaps.perFile).diff;
  // `truncated` means whole files fell off the end — the serious case the UI warns about. A
  // FOLDED file isn't that: the planner still sees its head and its exact stat, and the in-band
  // marker tells the model it's a sample, so folding stays quiet rather than crying wolf on
  // every commit that happens to touch one big file.
  const truncated = diff.length > planCaps.planTotal;
  if (truncated) diff = `${diff.slice(0, planCaps.planTotal)}\n…[truncated]`;

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

/** Cap the `-l` name list we read back from `git grep`. A few thousand paths fit easily;
 *  the changed-file set is the real bound — this just guards a pathological match storm. */
const GREP_CAP = 512_000;

/** Group `paths` so no single `git grep` invocation's pathspec list overflows the OS
 *  command-line limit (Windows ~32 KB). Greedy packing under a conservative byte budget. */
export function chunkByBytes(paths: string[], maxBytes = 8_000): string[][] {
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
