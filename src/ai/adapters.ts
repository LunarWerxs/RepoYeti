/**
 * Per-provider AI adapters: model-list URL, generate URL, auth headers, model-list parser,
 * request body, and completion extraction. The four OpenAI-compatible providers share one
 * factory so adding/renaming a provider is a single localized change instead of edits spread
 * across five parallel switch/if chains.
 */
import type { AiProviderId } from "../config.ts";

export interface AiModel {
  id: string;
  label: string;
}

/** The commit-plan call returns a JSON object listing files across groups, so it needs a
 *  higher ceiling than a one-line message — but NOT too high: a provider counts the full
 *  `max_tokens` reservation against its rate limit (the free Groq tier is 6000 tokens/min),
 *  so an oversized reservation gets the whole request rejected. 4096 is ample for the actual
 *  output (even 100 files is ~2k tokens of JSON) while staying within the free tier. */
const PLAN_MAX_TOKENS = 4096;

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
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
};

/** Pull the text out of one content "part" of an Anthropic/Gemini response array (defensive). */
const partText = (p: unknown): string => {
  const t = (p as { text?: unknown })?.text;
  return typeof t === "string" ? t : "";
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

export const AI_ADAPTERS: Record<AiProviderId, AiAdapter> = {
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
      const content = (json as { content?: unknown })?.content;
      return (Array.isArray(content) ? content : []).map(partText).join("");
    },
  },

  gemini: {
    // model id goes in the path; the key goes in the query string (no auth header).
    modelsUrl: (apiKey) => `${GEMINI_BASE}?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
    generateUrl: (model, apiKey) =>
      `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    headers: () => ({ "content-type": "application/json" }),
    models: (json) => {
      const raw = (json as { models?: unknown })?.models;
      const models: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : [];
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
      const parts = (json as { candidates?: Array<{ content?: { parts?: unknown } }> })
        ?.candidates?.[0]?.content?.parts;
      return (Array.isArray(parts) ? parts : []).map(partText).join("");
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
