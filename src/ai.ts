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
async function requestJson(url: string, init: RequestInit, fetchImpl: FetchFn): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
