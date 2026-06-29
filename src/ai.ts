/**
 * Bring-your-own-key AI provider adapters.
 *
 * The DAEMON makes every provider call (model discovery + commit-message drafting);
 * the owner's API key never leaves this host. Each provider is one entry in the
 * `AI_ADAPTERS` map, so adding/renaming a provider is a single localized change instead
 * of edits spread across five parallel switch/if chains. An adapter owns the per-provider
 * knobs — model-list URL, generate URL, auth headers, model-list parser, request body,
 * and completion extraction — and the four OpenAI-compatible providers share one factory.
 *
 * Public surface (unchanged, unit-tested):
 *   - listModels(key)            validates the key AND returns the models it unlocks
 *   - generateCommitMessage(...) drafts a commit message from a git diff
 *   - parseModels / extractCompletion are PURE and delegate to the relevant adapter.
 *
 * Network is reached via the global `fetch`, injectable (`fetchImpl`) so parsing + request
 * shaping are testable without hitting a provider. Failures map to a small set of stable
 * codes the UI can render (mirrors the classify() pattern in git-actions.ts).
 */
import type { AiProviderId, CommitStyle } from "./config.ts";

export type AiCode = "OK" | "AI_AUTH_FAILED" | "AI_UNREACHABLE" | "AI_BAD_REQUEST" | "AI_ERROR";

export class AiError extends Error {
  code: AiCode;
  status: number;
  constructor(code: AiCode, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface AiModel {
  id: string;
  label: string;
}

/** Injectable fetch (defaults to the global). */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000;
/** The commit-plan call returns a JSON object listing files across groups, so it needs a
 *  higher ceiling than a one-line message — but NOT too high: a provider counts the full
 *  `max_tokens` reservation against its rate limit (the free Groq tier is 6000 tokens/min),
 *  so an oversized reservation gets the whole request rejected. 4096 is ample for the actual
 *  output (even 100 files is ~2k tokens of JSON) while staying within the free tier. */
const PLAN_MAX_TOKENS = 4096;
const PLAN_TIMEOUT_MS = 45_000;

// ── model-list parsing helpers (PURE) ────────────────────────────────────────────

const OPENAI_KEEP = /^(gpt-|o[0-9]|chatgpt)/i;
const OPENAI_DROP =
  /(embedding|tts|whisper|dall-?e|audio|realtime|image|moderation|transcribe|search|babbage|davinci)/i;

/** The `data[]` array of an OpenAI-style model list (or [] if shaped otherwise). */
function dataList(json: unknown): Array<Record<string, unknown>> {
  const j = (json ?? {}) as Record<string, unknown>;
  return Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>) : [];
}

/** Map an OpenAI-style `data[]` list to models, with an optional id filter + label fn. */
function openaiModels(
  json: unknown,
  opts: { keep?: (id: string) => boolean; label?: (m: Record<string, unknown>) => string } = {},
): AiModel[] {
  return dataList(json)
    .map((m) => ({ id: String(m.id ?? ""), label: opts.label ? opts.label(m) : String(m.id ?? "") }))
    .filter((m) => m.id !== "" && (opts.keep ? opts.keep(m.id) : true));
}

/** Dedup by id, drop empties, sort descending (tends to surface newer models first). */
function finalizeModels(raw: AiModel[]): AiModel[] {
  const seen = new Set<string>();
  const out: AiModel[] = [];
  for (const m of raw) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((a, b) => b.id.localeCompare(a.id));
  return out;
}

// ── shared OpenAI-compatible bits (openai · deepseek · groq · openrouter) ─────────

const bearerHeaders = (apiKey: string): Record<string, string> => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`,
});

const chatBody = (model: string, system: string, user: string): unknown => ({
  model,
  messages: [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
});

const chatExtract = (json: unknown): string => {
  const j = json as Record<string, any>;
  return j?.choices?.[0]?.message?.content ?? "";
};

// ── per-provider adapters ─────────────────────────────────────────────────────────

interface AiAdapter {
  /** Model-list endpoint (key in query for gemini, else a constant). */
  modelsUrl: (apiKey: string) => string;
  /** Generation endpoint (model + key in path/query for gemini, else a constant). */
  generateUrl: (model: string, apiKey: string) => string;
  /** Auth headers for both calls. */
  headers: (apiKey: string) => Record<string, string>;
  /** Raw `{ id, label }[]` from the provider's model-list body (pre dedup/sort). */
  models: (json: unknown) => AiModel[];
  /** The generation request body for this provider's API shape. */
  buildBody: (model: string, system: string, user: string) => unknown;
  /**
   * Request body for STRUCTURED-JSON generation (the commit-plan call): enables the
   * provider's JSON mode where it has one and raises the token ceiling (JSON is wordier
   * than a one-line message). Falls back to `buildBody` when a provider has no JSON mode
   * (Anthropic) — there the strict-JSON instruction in the prompt carries it.
   */
  jsonBody?: (model: string, system: string, user: string) => unknown;
  /** Pull the generated text out of this provider's response shape. */
  extractCompletion: (json: unknown) => string;
}

/** Factory for the four OpenAI-compatible providers (Bearer + chat/completions + data[]). */
function openAiCompatible(opts: {
  modelsUrl: string;
  generateUrl: string;
  keep?: (id: string) => boolean;
  label?: (m: Record<string, unknown>) => string;
}): AiAdapter {
  return {
    modelsUrl: () => opts.modelsUrl,
    generateUrl: () => opts.generateUrl,
    headers: bearerHeaders,
    models: (json) => openaiModels(json, { keep: opts.keep, label: opts.label }),
    buildBody: chatBody,
    // JSON mode + a raised token ceiling. `response_format: json_object` makes the four
    // OpenAI-compatible providers emit a bare JSON object (no fences/preamble) reliably.
    jsonBody: (model, system, user) => ({
      ...(chatBody(model, system, user) as Record<string, unknown>),
      response_format: { type: "json_object" },
      max_tokens: PLAN_MAX_TOKENS,
    }),
    extractCompletion: chatExtract,
  };
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const AI_ADAPTERS: Record<AiProviderId, AiAdapter> = {
  anthropic: {
    modelsUrl: () => "https://api.anthropic.com/v1/models?limit=1000",
    generateUrl: () => "https://api.anthropic.com/v1/messages",
    headers: (apiKey) => ({
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    models: (json) =>
      dataList(json).map((m) => ({ id: String(m.id ?? ""), label: String(m.display_name ?? m.id ?? "") })),
    buildBody: (model, system, user) => ({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    }),
    // Anthropic has no JSON-mode flag; the strict-JSON prompt instruction carries it. We
    // only raise the token ceiling so a multi-group plan can't be truncated mid-object.
    jsonBody: (model, system, user) => ({
      model,
      max_tokens: PLAN_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
    extractCompletion: (json) => {
      const parts = Array.isArray((json as any)?.content) ? (json as any).content : [];
      return parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
    },
  },

  gemini: {
    // model id goes in the path; the key goes in the query string (no auth header).
    modelsUrl: (apiKey) => `${GEMINI_BASE}?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
    generateUrl: (model, apiKey) =>
      `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    headers: () => ({ "content-type": "application/json" }),
    models: (json) => {
      const models = Array.isArray((json as any)?.models) ? ((json as any).models as Array<Record<string, unknown>>) : [];
      return models
        .filter((m) => {
          const methods = m.supportedGenerationMethods;
          return Array.isArray(methods) && methods.includes("generateContent");
        })
        .map((m) => {
          const id = String(m.name ?? "").replace(/^models\//, "");
          return { id, label: String(m.displayName ?? id) };
        });
    },
    buildBody: (_model, system, user) => ({
      // gemini puts the model in the URL, not the body.
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 1024 },
    }),
    // `responseMimeType: application/json` is Gemini's JSON mode; raise the output ceiling.
    jsonBody: (_model, system, user) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: PLAN_MAX_TOKENS, responseMimeType: "application/json" },
    }),
    extractCompletion: (json) => {
      const cand = (json as any)?.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      return parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
    },
  },

  // OpenAI-compatible: same Bearer auth + /chat/completions shape; they differ only in
  // endpoint host and which model ids they expose.
  openai: openAiCompatible({
    modelsUrl: "https://api.openai.com/v1/models",
    generateUrl: "https://api.openai.com/v1/chat/completions",
    keep: (id) => OPENAI_KEEP.test(id) && !OPENAI_DROP.test(id),
  }),
  deepseek: openAiCompatible({
    modelsUrl: "https://api.deepseek.com/models",
    generateUrl: "https://api.deepseek.com/chat/completions",
  }),
  groq: openAiCompatible({
    modelsUrl: "https://api.groq.com/openai/v1/models",
    generateUrl: "https://api.groq.com/openai/v1/chat/completions",
  }),
  openrouter: openAiCompatible({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    generateUrl: "https://openrouter.ai/api/v1/chat/completions",
    keep: (id) => id.endsWith(":free"), // free models only
    label: (m) => String(m.name ?? m.id ?? ""), // OpenRouter ships a friendly `name`
  }),
};

/** Normalize a provider's raw model-list JSON into `{ id, label }[]` (deduped + sorted). */
export function parseModels(provider: AiProviderId, json: unknown): AiModel[] {
  return finalizeModels(AI_ADAPTERS[provider].models(json));
}

/** Pull the generated text out of each provider's response shape (PURE). */
export function extractCompletion(provider: AiProviderId, json: unknown): string {
  return AI_ADAPTERS[provider].extractCompletion(json);
}

// ── prompt building (PURE) ───────────────────────────────────────────────────────

const BASE_SYSTEM =
  "You write a git commit message from a diff. Output ONLY the commit message text — " +
  "no markdown code fences, no surrounding quotes, no preamble like 'Here is', no explanation.";

export function systemPromptFor(style: CommitStyle): string {
  switch (style) {
    case "conventional":
      return (
        BASE_SYSTEM +
        " Use the Conventional Commits format: a `type(scope): summary` subject line in the " +
        "imperative mood (types: feat, fix, docs, style, refactor, perf, test, build, ci, chore), " +
        "at most 72 characters. If the change is non-trivial, add a blank line then a short body."
      );
    case "detailed":
      return (
        BASE_SYSTEM +
        " Write an imperative subject line of at most 72 characters, then a blank line, then a " +
        "concise body (a few sentences or bullet points) explaining what changed and why."
      );
    case "concise":
    default:
      return (
        BASE_SYSTEM +
        " Write a single concise imperative subject line of at most 72 characters that summarizes " +
        "the change. Do not add a body."
      );
  }
}

const userPromptFor = (diff: string): string =>
  `Write a commit message for the following staged/working changes.\n\n${diff}`;

/** Strip stray code fences / wrapping quotes a model sometimes adds despite instructions. */
export function cleanCommitMessage(text: string): string {
  let s = text.trim();
  // Remove a leading/trailing ``` fence (optionally ```text).
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```$/, "").trim();
  // Remove symmetric wrapping quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

function extractErrMessage(json: unknown, fallback: string): string {
  const j = json as Record<string, any> | null;
  const msg = j?.error?.message ?? j?.message ?? j?.error ?? fallback;
  return String(typeof msg === "string" ? msg : fallback)
    .split("\n")[0]!
    .slice(0, 280);
}

/** One JSON request with a timeout; maps non-2xx + network/timeout to AiError. */
async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: FetchFn,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
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
    throw new AiError("AI_ERROR", message, res.status);
  }
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

/** Draft a commit message from a diff using the chosen provider + model. */
export async function generateCommitMessage(
  provider: AiProviderId,
  apiKey: string,
  model: string,
  diff: string,
  style: CommitStyle,
  fetchImpl: FetchFn = fetch,
): Promise<string> {
  const adapter = AI_ADAPTERS[provider];
  const system = systemPromptFor(style);
  const user = userPromptFor(diff);
  const json = await requestJson(
    adapter.generateUrl(model, apiKey),
    {
      method: "POST",
      headers: adapter.headers(apiKey),
      body: JSON.stringify(adapter.buildBody(model, system, user)),
    },
    fetchImpl,
  );
  const text = adapter.extractCompletion(json);
  const cleaned = cleanCommitMessage(text ?? "");
  if (!cleaned) throw new AiError("AI_ERROR", "the model returned an empty message");
  return cleaned;
}

// ── commit plan: split a working tree into multiple logical commits ────────────────
//
// "Smart commit": instead of one stage-all commit, the model partitions the changed FILES
// into several scoped commits, each with its own message. File-level only (a file is never
// split across commits) — see docs/SMART_COMMIT.md for why (the safety invariant). The plan
// is a SUGGESTION: the daemon validates it, the owner edits it, and a separate call commits.

/** One changed file as the planner sees it (built locally; never the file's contents). */
export interface PlanInputFile {
  path: string;
  /** M · A · D · R · U · C (same letters as the changes tree). */
  status: string;
  /** Rename source path (only for status "R"). */
  from?: string;
  additions: number;
  removals: number;
  binary: boolean;
}

/** The bounded snapshot fed to the planner. */
export interface CommitPlanInput {
  files: PlanInputFile[];
  /** Per-file-delimited unified diff (`git diff HEAD -M`), bounded. */
  diff: string;
  /** True when the diff hit its size cap (the model saw a partial picture). */
  truncated: boolean;
}

/** One proposed commit. */
export interface CommitPlanGroup {
  /** Conventional-commits type (coerced to `chore` if the model invents one). */
  type: string;
  /** Optional lowercase subsystem scope. */
  scope?: string;
  /** Imperative subject line. */
  subject: string;
  /** Optional body (e.g. the "this file also carries a minor X change" note). */
  body?: string;
  /** Repo-relative paths assigned to this commit. */
  files: string[];
  /** One-line "why these belong together" — a UI hint, never committed. */
  rationale?: string;
}

/** The full proposed plan. */
export interface CommitPlan {
  groups: CommitPlanGroup[];
  /** Files the planner couldn't confidently place — the UI surfaces these as "Unassigned"
   *  and blocks commit until every file is in a group. */
  leftovers: string[];
  /** True when this came from the deterministic fallback, not the model. */
  degraded: boolean;
  /** Mirrors CommitPlanInput.truncated (the diff was capped). */
  truncated: boolean;
}

/** The conventional-commits types we accept; anything else is coerced to `chore`. */
const CONVENTIONAL_TYPES = new Set([
  "feat", "fix", "refactor", "test", "docs", "chore", "style", "perf", "build", "ci", "revert",
]);

/** Normalise a model-supplied type to a known conventional type (default `chore`). */
function coerceType(t: unknown): string {
  const s = String(t ?? "").toLowerCase().trim();
  return CONVENTIONAL_TYPES.has(s) ? s : "chore";
}

export function planSystemPrompt(_style: CommitStyle): string {
  return (
    "You are a senior engineer splitting a messy working tree into a series of small, " +
    "logically-scoped git commits. You are given the list of changed FILES and a unified diff.\n\n" +
    "RULES:\n" +
    "1. Group at the FILE level. Every file goes in exactly ONE commit. NEVER split a single " +
    "file across commits.\n" +
    "2. Group files that implement one logical change together (a source file with its tests, " +
    "types, and docs belong in the same commit). Keep tightly-coupled files together. But PREFER " +
    "several small, focused commits over one broad commit: if two sets of files serve different " +
    "intents (e.g. a feature vs an unrelated fix), separate them even when they sit in the same folder.\n" +
    "3. Isolate purely-cosmetic changes (formatting/whitespace) into their own `style`/`chore` commit.\n" +
    "4. Keep a lockfile (package-lock.json, bun.lock, yarn.lock, Cargo.lock, …) in the SAME commit " +
    "as the manifest change that caused it.\n" +
    "5. Order the commits foundation-first: schema/types → shared utilities → feature logic → " +
    "tests → docs/CI. New files that others depend on come before their dependents.\n" +
    "6. If ONE file genuinely contains two unrelated changes, put it in the commit for its " +
    "dominant change and mention the secondary change in that commit's `body`.\n" +
    "7. Each `subject` is an imperative, ≤72-char summary. Use a conventional `type` " +
    "(feat, fix, refactor, test, docs, chore, style, perf, build, ci) and an optional lowercase `scope`.\n\n" +
    "OUTPUT: return ONLY a JSON object (no prose, no markdown fences) of this exact shape:\n" +
    `{"groups":[{"type":"feat","scope":"auth","subject":"add token refresh","body":"optional longer text","files":["src/auth.ts","tests/auth.test.ts"],"rationale":"short why"}],"leftovers":[]}\n` +
    "Put a file in `leftovers` ONLY if you truly cannot decide where it belongs. " +
    "Every path from the input MUST appear once across all `groups[].files` and `leftovers`. " +
    "Files with status A or U are NEW and have NO diff shown — place them by their path and name; " +
    "do not forget them."
  );
}

export function planUserPrompt(input: CommitPlanInput): string {
  const fileLines = input.files
    .map((f) => {
      const ren = f.from ? ` (renamed from ${f.from})` : "";
      const bin = f.binary ? " [binary]" : ` (+${f.additions}/-${f.removals})`;
      return `- ${f.path} [${f.status}]${bin}${ren}`;
    })
    .join("\n");
  const paths = input.files.map((f) => f.path).join("\n");
  return (
    `Changed files (${input.files.length}):\n${fileLines}\n\n` +
    `Partition exactly these paths (each appears once across groups+leftovers):\n${paths}\n\n` +
    (input.truncated ? "NOTE: the diff below is truncated; rely on the file list for the full set.\n\n" : "") +
    `Unified diff:\n${input.diff || "(no textual diff — new/binary files only)"}`
  );
}

/** Pull the first balanced top-level JSON object out of arbitrary model text. */
function extractJsonObject(text: string): string | null {
  const s = text.trim().replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```$/, "").trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse + VALIDATE a model's plan text into a normalized CommitPlan, or null if unusable.
 * Pure (no network, no git) so it is fully unit-testable. `knownPaths` is the authoritative
 * changed-file set: hallucinated paths are dropped, and any known path the model forgot is
 * swept into `leftovers`, so the result is always a complete, disjoint partition.
 */
export function parseCommitPlan(text: string, knownPaths: string[]): CommitPlan | null {
  const jsonStr = extractJsonObject(text ?? "");
  if (!jsonStr) return null;
  let raw: any;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const known = new Set(knownPaths);
  const seen = new Set<string>();
  const groups: CommitPlanGroup[] = [];

  const rawGroups = Array.isArray(raw?.groups) ? raw.groups : [];
  for (const g of rawGroups) {
    const subject = String(g?.subject ?? "").trim();
    const rawFiles = Array.isArray(g?.files) ? g.files : [];
    // Keep only real, not-yet-claimed paths (drops hallucinations + dedupes across groups).
    const files = rawFiles
      .map((p: unknown) => String(p ?? "").replace(/\\/g, "/").trim())
      .filter((p: string) => known.has(p) && !seen.has(p));
    if (!subject || files.length === 0) continue;
    for (const p of files) seen.add(p);
    const scope = String(g?.scope ?? "").trim();
    const body = String(g?.body ?? "").trim();
    const rationale = String(g?.rationale ?? "").trim();
    groups.push({
      type: coerceType(g?.type),
      ...(scope ? { scope } : {}),
      subject,
      ...(body ? { body } : {}),
      files,
      ...(rationale ? { rationale } : {}),
    });
  }

  // Any known path the model never placed → leftovers (the UI makes the owner resolve them).
  const leftovers = knownPaths.filter((p) => !seen.has(p));
  if (groups.length === 0 && leftovers.length === 0) return null;
  return { groups, leftovers, degraded: false, truncated: false };
}

/** Top-level path segment used as a grouping bucket ("src", "web", "tests", "docs", "root"). */
function topSegment(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const seg = norm.split("/")[0] ?? "";
  return seg && norm.includes("/") ? seg : "root";
}

/** A reasonable conventional type for a deterministic bucket, from its files' paths. */
function bucketType(files: string[]): string {
  if (files.every((f) => /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(f))) return "test";
  if (files.every((f) => /(^|\/)docs?(\/|$)|\.mdx?$/i.test(f))) return "docs";
  if (files.every((f) => /\.(ya?ml)$|(^|\/)\.github(\/|$)/i.test(f))) return "ci";
  return "chore";
}

/**
 * Deterministic fallback plan (no model): bucket files by their top-level directory so the
 * owner still gets a sensible, editable split when the AI is unavailable or returns garbage.
 * Pure + unit-testable. Always marks `degraded: true` so the UI can explain itself.
 */
export function heuristicPlan(input: CommitPlanInput): CommitPlan {
  const buckets = new Map<string, string[]>();
  for (const f of input.files) {
    const b = topSegment(f.path);
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(f.path);
  }
  const groups: CommitPlanGroup[] = [...buckets.entries()].map(([bucket, files]) => {
    const type = bucketType(files);
    const scope = bucket === "root" ? "" : bucket;
    const subject = `${type}${scope ? `(${scope})` : ""}: update ${files.length} file${files.length === 1 ? "" : "s"}`;
    // subject already carries the conventional prefix; keep type/scope for the editor too.
    return { type, ...(scope ? { scope } : {}), subject: subject.replace(/^[^:]+:\s*/, ""), files };
  });
  return { groups, leftovers: [], degraded: true, truncated: input.truncated };
}

/**
 * Ask the model to split the working tree into a validated, complete, disjoint commit plan.
 * Throws AiError on a provider failure or an unparseable response — the caller (the route)
 * then falls back to `heuristicPlan` so Smart Commit never dead-ends.
 */
export async function generateCommitPlan(
  provider: AiProviderId,
  apiKey: string,
  model: string,
  input: CommitPlanInput,
  style: CommitStyle,
  fetchImpl: FetchFn = fetch,
): Promise<CommitPlan> {
  const adapter = AI_ADAPTERS[provider];
  const system = planSystemPrompt(style);
  const build = adapter.jsonBody ?? adapter.buildBody;
  const knownPaths = input.files.map((f) => f.path);

  const ask = async (user: string): Promise<CommitPlan | null> => {
    const json = await requestJson(
      adapter.generateUrl(model, apiKey),
      { method: "POST", headers: adapter.headers(apiKey), body: JSON.stringify(build(model, system, user)) },
      fetchImpl,
      PLAN_TIMEOUT_MS,
    );
    return parseCommitPlan(adapter.extractCompletion(json), knownPaths);
  };

  // One retry: models occasionally wrap the JSON in prose or truncate it. A terse second ask
  // ("ONLY the JSON object") recovers most of those before we give up to the heuristic fallback.
  let plan = await ask(planUserPrompt(input));
  if (!plan) {
    plan = await ask(
      planUserPrompt(input) +
        "\n\nIMPORTANT: respond with ONLY the JSON object described above — no prose, no markdown fences.",
    );
  }
  if (!plan) throw new AiError("AI_ERROR", "the model did not return a usable commit plan");
  return { ...plan, truncated: input.truncated };
}
