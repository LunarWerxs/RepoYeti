/**
 * Single-message commit drafting: prompt building, HTTP plumbing, and the two simplest
 * public entry points — model discovery (`listModels`) and one-shot message generation
 * (`generateCommitMessage`). Network is reached via the global `fetch`, injectable
 * (`fetchImpl`) so parsing + request shaping are testable without hitting a provider.
 * Failures map to a small set of stable codes the UI can render (mirrors the classify()
 * pattern in git-actions.ts).
 */
import type { AiProviderId, CommitStyle } from "../config.ts";
import { AI_ADAPTERS, MESSAGE_SAMPLING, messageMaxTokens, parseModels, type AiModel } from "./adapters.ts";

export type AiCode =
  | "OK"
  | "AI_AUTH_FAILED"
  | "AI_UNREACHABLE"
  | "AI_BAD_REQUEST"
  | "AI_RATE_LIMITED"
  | "AI_ERROR";

export class AiError extends Error {
  code: AiCode;
  status: number;
  constructor(code: AiCode, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Injectable fetch (defaults to the global). */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000;

// ── rate-limit gate (anti-hammer) ────────────────────────────────────────────────
//
// A provider that just answered 429 will answer 429 again. Re-asking costs a round-trip, burns
// request quota, and makes the owner wait to be told the same thing — so once a generation call
// is rate-limited we remember it and answer from memory for a bit.
//
// The wait is deliberately NOT the provider's own `retry-after`: Groq hands back values like
// 13010s (3.6h), and hard-blocking for hours would be wrong the moment the owner upgrades their
// tier, swaps the key, or the rolling window frees up (Groq's daily budget decays continuously —
// observed dropping while idle). So we cap the local pause at a minute: enough that clicking
// "Auto" or flipping styles can't machine-gun the API, short enough to self-heal. The provider's
// real message (which does say "try again in 3h36m") is kept and re-surfaced verbatim.
const GATE_MAX_MS = 60_000;
/** provider id → when we may probe again, plus the message to answer with until then. */
const rateGate = new Map<string, { until: number; message: string }>();

/** Seconds from a `Retry-After` header (delta-seconds or HTTP-date), or null. */
function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const secs = Number(h.trim());
  if (Number.isFinite(secs) && secs >= 0) return secs;
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, (when - Date.now()) / 1000) : null;
}

/** Clear a provider's pause — call when its key/model changes, so a fix takes effect at once. */
export function clearRateGate(provider?: string): void {
  if (provider) rateGate.delete(provider);
  else rateGate.clear();
}

/** For tests/diagnostics: ms until `provider` may be probed again (0 = not gated). */
export function rateGateRemainingMs(provider: string): number {
  const g = rateGate.get(provider);
  return g ? Math.max(0, g.until - Date.now()) : 0;
}

// ── prompt building (PURE) ───────────────────────────────────────────────────────

const BASE_SYSTEM =
  "You write a git commit message from a diff. Output ONLY the commit message text — " +
  "no markdown code fences, no surrounding quotes, no preamble like 'Here is', no explanation.";

// ── the body doctrine ────────────────────────────────────────────────────────────
//
// Shared VERBATIM with planMessageRules() in commit-plan.ts. Both paths write the same artifact —
// a commit body — and the owner can regenerate a Smart Commit card with the single-message call,
// so a difference between them is a bug the owner sees as "the same button gave me two voices".
// It used to be kept in sync by hand, and had already drifted.
//
// WHY THIS IS SO SPECIFIC. The old wording asked for "WHAT changed and WHY", which a model
// satisfies by re-tensing the subject: real output from this code was `chore: generate plane pwa`
// with the body `- generate plane pwa`. Measured, that body spent ~12 of the ~65 tokens it was
// allowed — so the model was not being cut off, it thought it was DONE. An abstraction it can
// answer with a tautology is an abstraction it will answer with a tautology; naming the questions
// and showing the banned output is what closes that door.

/** The questions a body must answer. Ordered by how safely a diff-only reader can answer them. */
const BODY_CHECKLIST =
  "- MECHANISM — name the specific function, file, config key or flag that was added, removed, " +
  "renamed or restructured, and how the new code differs from the old. A vague verb on its own " +
  '("improved analytics", "fixed the codec") does not answer this. Name the thing.\n' +
  "- REASON — give it only where the diff itself shows it: a comment, a docstring, a renamed " +
  "symbol, a deleted guard. Never assert a root cause, a bug history or a reported issue you " +
  "cannot see.\n" +
  '- EFFECT — a hedged inference from the code\'s own logic ("this means…", "so callers now…"), ' +
  "never stated as an observed or tested fact.\n";

/**
 * The anti-fabrication clause. Load-bearing, not boilerplate: the gold-standard commits this
 * feature is measured against cite deploy hashes, live prod checks and measured timings in ~15 of
 * 18 bodies — and those are exactly the elements a model holding only a diff cannot honestly
 * produce. Told to "write like that corpus" without this clause, it invents them, and a
 * confidently-wrong body is worse than a terse one.
 */
const BODY_GROUNDING =
  "You are reading a diff and nothing else — no repo history, no issue tracker, no runtime. Never " +
  "claim testing, deployment, live verification or a measured number you did not perform. Where " +
  "the diff does not reveal WHY, say WHAT changed precisely and stop: inventing a reason to sound " +
  "thorough is a worse failure than being brief.\n";

/**
 * The banned pattern, STATED — deliberately not rendered. This used to be a full worked example
 * (a bad message and a good one, in commit-message shape) sitting in the system prompt, and it
 * leaked: a live run attributed the example's `decodeRow`/null-timestamp content to a function in
 * the REAL diff ("`openAiCompatible()` now uses a null guard before the Date conversion…"). A
 * rendered example anchors CONTENT, not just shape, and a label like FORBIDDEN is a token while
 * the shape is a pattern — patterns transfer, labels don't. No surveyed tool renders a negative
 * exemplar; they all ban failures by name. The GOOD example still exists, as a real few-shot
 * exchange (fewShotTurns below) where it is visibly the answer to a DIFFERENT diff.
 */
const BODY_BAN =
  "Never write a body that merely re-tenses the subject in past tense, and never pad with a " +
  'vague extra bullet ("improved X logic") to look thorough — a body the subject already implied ' +
  "is worse than no body.\n";

/**
 * Length rule. Deliberately keyed to REASONING, not to line count: measured over the reference
 * corpus, the diff's size does not predict its body's size (a one-line JSON edit earned 136 words
 * because the number needed a caveat; a two-line lint fix earned none). A numeric words-per-diff-
 * line table would force prose out of a 400-line generated lockfile, and the only way to fill that
 * quota is invention — trading terse bodies for padded ones.
 */
const BODY_LENGTH =
  "Scale the body to how much the change actually has to explain, not to how many lines it " +
  "touches. A two-line mechanical edit (a lint fix, a dead-code removal, a rename) earns one " +
  "short sentence or no body at all. A change spanning several files, or carrying a real " +
  "decision, earns a short paragraph or one bullet per distinct piece. A large diff expands the " +
  "body's STRUCTURE, never its invention. Never repeat the subject, and never pad.\n";

export function systemPromptFor(style: CommitStyle): string {
  switch (style) {
    // The default, and the one tuned to read like a hand-written repo commit (the shape VS Code /
    // Copilot emit): Conventional-Commits subject, blank line, then a body that earns its place.
    case "conventional":
      return (
        BASE_SYSTEM +
        " Follow the Conventional Commits format.\n" +
        "SUBJECT (first line): `type(scope): description`, at most 72 characters, imperative mood " +
        '("add", never "added"/"adds"), no trailing period, description in lower case. `type` is ' +
        "one of feat, fix, docs, style, refactor, perf, test, build, ci, chore. `scope` is an " +
        "optional lowercase subsystem — omit it rather than invent a vague one.\n" +
        "BODY: unless the change is a trivial one- or two-line mechanical edit whose cause is " +
        "obvious from the diff, add a blank line after the subject, then write a body that " +
        "answers:\n" +
        BODY_CHECKLIST +
        BODY_BAN +
        BODY_GROUNDING +
        BODY_LENGTH +
        'Use "- " bullets when there is more than one point, one per bullet.'
      );
    // The owner opted into thoroughness, so this asks for more STRUCTURE and one extra question —
    // not for a longer version of the same content. It stays non-Conventional (a plain imperative
    // subject) because that is the distinction the style dial has always drawn.
    case "detailed":
      return (
        BASE_SYSTEM +
        " Write an imperative subject line of at most 72 characters, then a blank line, then a " +
        "body that answers:\n" +
        BODY_CHECKLIST +
        "- REVIEWER NOTE — where the diff itself shows something worth flagging (a TODO left " +
        "behind, a widened type, a removed check, a bumped dependency), say so. Only where the " +
        "diff shows it; do not manufacture a caveat to fill space.\n" +
        BODY_BAN +
        BODY_GROUNDING +
        BODY_LENGTH +
        "Prefer short paragraphs, or one bullet per distinct piece of the change: a diff touching " +
        "several files should not come back as a single line."
      );
    // Untouched: `concise` is a subject and nothing else, so none of the body doctrine applies and
    // it should not pay the prompt tokens for rules it will never follow.
    default:
      return (
        BASE_SYSTEM +
        " Write a single concise imperative subject line of at most 72 characters that summarizes " +
        "the change. Do not add a body."
      );
  }
}

/** The shared body doctrine, for planMessageRules() in commit-plan.ts (see the note above). */
export const BODY_DOCTRINE = {
  checklist: BODY_CHECKLIST,
  ban: BODY_BAN,
  grounding: BODY_GROUNDING,
  length: BODY_LENGTH,
} as const;

// ── few-shot priming (message path only) ─────────────────────────────────────────
//
// The good example is a REAL exchange in the messages array — a user turn carrying an example
// diff, an assistant turn carrying the finished message for it — not a description inside the
// system prompt. OpenCommit's mechanism, and the fix for a failure observed live here: rendered
// inside the system prompt, the example's content leaked into output about unrelated code (the
// model reported a real function gaining "a null guard before the Date conversion" — the
// example's change, not the diff's). As a completed prior turn, the same text is visibly the
// answer to a DIFFERENT diff: it teaches the shape and stays attributed to its own change.
//
// The example diff is rendered in the exact envelope the real call uses (the porcelain-status
// header + "# git diff", through userPromptFor) — the model matches input SHAPE to decide which
// precedent applies, so an envelope mismatch would waste the turn. The plan path takes no few-shot:
// its precedent is the populated JSON shape example in planSystemPrompt, and its input is the
// token-tight one.

const FEW_SHOT_DIFF =
  "# git status --porcelain\n" +
  " M src/db/codec.ts\n M tests/codec.test.ts\n\n" +
  "# git diff\n" +
  "diff --git a/src/db/codec.ts b/src/db/codec.ts\n" +
  "--- a/src/db/codec.ts\n+++ b/src/db/codec.ts\n" +
  "@@ -14,9 +14,12 @@ export interface Row {\n" +
  "   id: string;\n" +
  "-  updated_at: Date;\n" +
  "+  updated_at?: Date;\n" +
  " }\n" +
  " \n" +
  " export function decodeRow(raw: Record<string, unknown>): Row {\n" +
  "+  // NULL means the row was never touched since import — not a zero timestamp.\n" +
  "+  const updated = raw.updated_at == null ? undefined : new Date(raw.updated_at as string);\n" +
  "   return {\n" +
  "     id: String(raw.id),\n" +
  "-    updated_at: new Date(raw.updated_at as string),\n" +
  "+    ...(updated ? { updated_at: updated } : {}),\n" +
  "   };\n" +
  " }\n" +
  "diff --git a/tests/codec.test.ts b/tests/codec.test.ts\n" +
  "--- a/tests/codec.test.ts\n+++ b/tests/codec.test.ts\n" +
  "@@ -8,3 +8,7 @@ test(\"decodeRow maps the basic fields\", () => {\n" +
  " });\n" +
  "+\n" +
  "+test(\"decodeRow omits updated_at when the column is NULL\", () => {\n" +
  "+  expect(decodeRow({ id: \"1\", updated_at: null }).updated_at).toBeUndefined();\n" +
  "+});\n";

/** The finished message for FEW_SHOT_DIFF — pre-wrapped at the body column, one bullet per file. */
const FEW_SHOT_BODY =
  "- `decodeRow()` read a NULL `updated_at` as epoch 0 rather than skipping\n" +
  "  the field, so rows never touched since import serialized as 1970-01-01.\n" +
  "  It now returns `undefined` for a missing timestamp, and `Row` declares\n" +
  "  the field optional to match.\n" +
  "- `codec.test.ts` pins the NULL column case, which nothing covered.";

/**
 * The worked example as real chat turns, styled to match what the current style asks for (the
 * conventional example must show a `type(scope):` subject; `detailed`'s subject is bare). Exported
 * for tests — the invariant worth pinning is that the example rides in the assistant CHANNEL, not
 * in the system prompt it used to leak from.
 */
export function fewShotTurns(style: CommitStyle): Array<{ role: "user" | "assistant"; content: string }> {
  if (style === "concise") return []; // no body to demonstrate, and the anchor is skipped too
  const subject =
    style === "conventional"
      ? "fix(codec): return undefined for a NULL updated_at instead of epoch 0"
      : "return undefined for a NULL updated_at instead of epoch 0";
  return [
    { role: "user", content: userPromptFor(FEW_SHOT_DIFF, 2) },
    { role: "assistant", content: `${subject}\n\n${FEW_SHOT_BODY}` },
  ];
}

/**
 * The user prompt carries a PER-REQUEST anchor: how many files this change touches, and the
 * instruction to account for each. The system prompt's doctrine asks for substance in the
 * abstract, and the model demonstrably satisfies an abstract ask with one line — an unbounded
 * target resolves to the minimum. A number derived from the tree's own structure is different: it
 * cannot be argued down (the files really changed) and cannot be padded past (there are only N).
 * File COUNT, never diff SIZE — a size-keyed quota would force prose out of a big mechanical diff,
 * and the only way to fill that is invention.
 */
export const userPromptFor = (diff: string, fileCount = 0): string => {
  const anchor =
    fileCount > 1
      ? `This change touches ${fileCount} files. Account for each file whose change is not a ` +
        "trivial mechanical edit — roughly one bullet each. Merge files that share a single " +
        `mechanism into one bullet, and say so. A change spanning ${fileCount} files must not ` +
        "come back as a single line.\n\n"
      : "";
  return `Write a commit message for the following staged/working changes.\n\n${anchor}${diff}`;
};

/** Column the BODY wraps at. Subjects are the model's job (≤72 enforced by prompt); bodies are
 *  wrapped here because asking a model to wrap is asking it to count characters — every surveyed
 *  tool that cares (aicommits' wrapLine) wraps client-side instead of trusting the instruction. */
const BODY_WRAP_COL = 72;

/**
 * Word-wrap one body line to BODY_WRAP_COL, git-style: a "- " bullet's continuation lines get a
 * two-space indent so the bullet stays visually one item. A single token longer than the column
 * (a path, a URL) is left unbroken — a split path is worse than a long line.
 */
function wrapBodyLine(line: string): string[] {
  if (line.length <= BODY_WRAP_COL) return [line];
  const bullet = /^[-*]\s/.test(line.trimStart());
  const indent = bullet ? "  " : "";
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(" ")) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (candidate.length > BODY_WRAP_COL && cur) {
      out.push(cur);
      cur = indent + word;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Wrap every line of a commit BODY (never a subject) to the git-conventional column. */
export function wrapCommitBody(body: string): string {
  return body
    .split("\n")
    .flatMap((l) => wrapBodyLine(l))
    .join("\n");
}

/** Strip stray code fences / wrapping quotes a model sometimes adds despite instructions,
 *  enforce git's subject/body separator, and wrap the body to the conventional column. */
export function cleanCommitMessage(text: string): string {
  let s = text.trim();
  // Remove a leading/trailing ``` fence (optionally ```text).
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```$/, "").trim();
  // Remove symmetric wrapping quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Git defines the SUBJECT as everything up to the first blank line. A model that runs its body
  // straight on after line 1 — observed live, despite the prompt asking for the blank line — turns
  // the entire message into one enormous subject in `git log --oneline`, shortlogs and every UI
  // that shows "the first line". The prompt can ask; only this can guarantee. Structural, so it's
  // fixed here rather than left to the model's goodwill.
  const nl = s.indexOf("\n");
  if (nl !== -1) {
    const subject = s.slice(0, nl).trimEnd();
    const rest = s.slice(nl + 1);
    if (rest.trim()) s = `${subject}\n\n${wrapCommitBody(rest.replace(/^\s*\n/, ""))}`;
    else s = subject;
  }
  return s;
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

function extractErrMessage(json: unknown, fallback: string): string {
  const j = json as { error?: { message?: unknown } | string; message?: unknown } | null;
  const err = j?.error;
  const msg = (err && typeof err === "object" ? err.message : undefined) ?? j?.message ?? err ?? fallback;
  return String(typeof msg === "string" ? msg : fallback)
    .split("\n")[0]!
    .slice(0, 280);
}

/**
 * One JSON request with a timeout; maps non-2xx + network/timeout to AiError.
 *
 * `gate` opts this call into the rate-limit pause above. Only GENERATION calls pass it — model
 * listing deliberately does not, so a rate-limited plan can never stop the owner from connecting
 * or re-picking a key in Settings (the one screen where they'd go to fix it).
 */
export async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: FetchFn,
  timeoutMs = REQUEST_TIMEOUT_MS,
  gate?: string,
): Promise<unknown> {
  if (gate) {
    const g = rateGate.get(gate);
    if (g && Date.now() < g.until) throw new AiError("AI_RATE_LIMITED", g.message, 429);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new AiError("AI_UNREACHABLE", "could not reach the AI provider (timeout or network error)");
  }
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* leave json as {}; text used for the error message */
  }
  if (!res.ok) {
    const message = extractErrMessage(json, text || res.statusText);
    if (res.status === 401 || res.status === 403) {
      throw new AiError("AI_AUTH_FAILED", "invalid or unauthorized API key", res.status);
    }
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      throw new AiError("AI_BAD_REQUEST", message, res.status);
    }
    // 429 is its own thing, and the provider's own text is the useful part — it names the limit
    // that tripped and when it resets ("… tokens per day (TPD): Limit 100000 … try again in
    // 4h55m"). Callers surface `message` verbatim rather than guessing at the cause: a free-tier
    // daily cap is a wildly different fix (wait / upgrade / switch provider) from "the AI failed".
    if (res.status === 429) {
      if (gate) {
        const retryS = parseRetryAfter(res.headers.get("retry-after"));
        const pause = Math.min(retryS != null ? retryS * 1000 : GATE_MAX_MS, GATE_MAX_MS);
        rateGate.set(gate, { until: Date.now() + pause, message });
      }
      throw new AiError("AI_RATE_LIMITED", message, res.status);
    }
    throw new AiError("AI_ERROR", message, res.status);
  }
  if (gate) rateGate.delete(gate); // recovered → stop answering from memory
  return json;
}

// ── public API ────────────────────────────────────────────────────────────────

/** Validate the key AND discover the models it unlocks. */
export async function listModels(
  provider: AiProviderId,
  apiKey: string,
  fetchImpl: FetchFn = fetch,
): Promise<AiModel[]> {
  const adapter = AI_ADAPTERS[provider];
  const json = await requestJson(
    adapter.modelsUrl(apiKey),
    { method: "GET", headers: adapter.headers(apiKey) },
    fetchImpl,
  );
  return parseModels(provider, json);
}

/** Draft a commit message from a diff using the chosen provider + model. `fileCount` (when the
 *  caller knows it) anchors the body's bullet floor — see userPromptFor. */
export async function generateCommitMessage(
  provider: AiProviderId,
  apiKey: string,
  model: string,
  diff: string,
  style: CommitStyle,
  fetchImpl: FetchFn = fetch,
  fileCount = 0,
): Promise<string> {
  const adapter = AI_ADAPTERS[provider];
  // `concise` never writes a body, so the anchor would only be an instruction it must ignore
  // (and fewShotTurns already returns [] for it — no body worth demonstrating).
  const user = userPromptFor(diff, style === "concise" ? 0 : fileCount);
  const messages = [
    { role: "system" as const, content: systemPromptFor(style) },
    ...fewShotTurns(style),
    { role: "user" as const, content: user },
  ];
  const json = await requestJson(
    adapter.generateUrl(model, apiKey),
    {
      method: "POST",
      headers: adapter.headers(apiKey),
      body: JSON.stringify(adapter.buildBody(model, messages, messageMaxTokens(style), MESSAGE_SAMPLING)),
    },
    fetchImpl,
    REQUEST_TIMEOUT_MS,
    provider, // share the rate-limit pause with the plan call — same provider, same budget
  );
  const text = adapter.extractCompletion(json);
  const cleaned = cleanCommitMessage(text ?? "");
  if (!cleaned) throw new AiError("AI_ERROR", "the model returned an empty message");
  return cleaned;
}
