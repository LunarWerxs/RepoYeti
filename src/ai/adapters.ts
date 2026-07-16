/**
 * Per-provider AI adapters: model-list URL, generate URL, auth headers, model-list parser,
 * request body, and completion extraction. The four OpenAI-compatible providers share one
 * factory so adding/renaming a provider is a single localized change instead of edits spread
 * across five parallel switch/if chains.
 */
import type { AiProviderId, CommitStyle } from "../config.ts";

export interface AiModel {
  id: string;
  label: string;
}

/**
 * Hard ceiling for the commit-plan reply. A plan is a JSON object listing files across groups, so
 * it needs more room than a one-line message — but NOT too much: a provider gates on the full
 * `max_tokens` RESERVATION, so an oversized one gets the whole request rejected before a token is
 * generated (Groq answers "Limit 12000, Requested 12994" instantly — "Requested" is input +
 * max_tokens). A rejected plan degrades to the heuristic bucket-split, which is strictly worse
 * than a slightly shorter body, so this stays deliberately conservative.
 *
 * Left at 4096 on purpose. Raising it was the obvious move for terse bodies and the wrong one:
 * measured on the live free tier this targets, `x-ratelimit-limit-tokens` is 12000/min, and the
 * ceiling only binds at ~35+ files (conventional) — trees whose diffs are already near the
 * planTotal cap, where input + reservation is what breaks first. It buys little exactly where it
 * costs most. The per-file RATE below is what actually feeds the bodies; this is just the backstop.
 */
const PLAN_MAX_TOKENS = 4096;

/**
 * Per-FILE token allowance for the plan reply, by the owner's commit-message style.
 *
 * The rate is per FILE but the reply's cost is per GROUP, and those are not the same dimension —
 * that mismatch is why the old flat 60 starved the bodies. planSystemPrompt rule 2 actively tells
 * the model to PREFER more, smaller commits, so the harder it obeys, the more groups share the
 * same file-derived budget: a 14-file tree split 7 ways got ~157 tokens/group, and after the JSON
 * skeleton, subject, `files` array and rationale (~90-110) that left ~45-65 for the body. A body
 * worth reading does not fit in 45 tokens, so the prompt and the ceiling were fighting each other.
 *
 * Sizing rule: G <= N always, so the worst case rule 2 can produce is one commit per file. Setting
 * the rate at roughly ONE BODY'S WORTH per file keeps that worst case affordable, which makes any
 * lighter split comfortable by construction. `concise` stays at 60 because it emits no body at all
 * — there is nothing there to starve.
 */
const PLAN_TOKENS_PER_FILE: Record<CommitStyle, number> = {
  concise: 60,
  conventional: 110,
  detailed: 180,
};

/**
 * Right-size the plan's `max_tokens` to the change-set instead of always reserving the ceiling.
 *
 * The reservation is what the provider gates on, so it is not free: measured against Groq's free
 * tier, an 11-file plan reserved a flat 4096 tokens to produce a ~900-token reply — ~3.2k tokens
 * per commit gated for nothing, on a 100k/day budget. Sizing it to the change-set gives that back
 * to the owner, who commits many times a day.
 *
 * The 512 floor keeps a tiny change-set from being cut off mid-JSON — an unparseable reply costs a
 * retry (and then a degraded heuristic plan), which would cost far more than the floor saves.
 */
export function planMaxTokens(fileCount: number, style: CommitStyle): number {
  return Math.max(512, Math.min(PLAN_MAX_TOKENS, 256 + fileCount * PLAN_TOKENS_PER_FILE[style]));
}

/**
 * Output ceiling for the SINGLE-message path, by style. Same doctrine as planMaxTokens: reserve
 * what this style plausibly needs, because the reservation is what gets rate-limited.
 *
 * `conventional` keeps the 1024 it always had — measured against the real corpus this ceiling was
 * never the thing binding (the bodies that prompted this work came out at ~12 tokens with ~65
 * available, and a hand-written commit body averages ~658 tokens), so raising it would buy nothing
 * and cost reservation on every default-style commit. `detailed` is the style whose whole point is
 * thoroughness, so it gets real room. `concise` is a subject line and nothing else; it was
 * reserving 1024 to emit ~20, which is pure waste on a TPM-gated tier.
 */
const MESSAGE_MAX_TOKENS: Record<CommitStyle, number> = {
  concise: 256,
  conventional: 1024,
  detailed: 2048,
};

export const messageMaxTokens = (style: CommitStyle): number => MESSAGE_MAX_TOKENS[style];

/** Decoding controls, passed per call. Shapes differ per provider (Gemini nests them under
 *  `generationConfig`, Anthropic has no `top_p` by default), so adapters translate. */
export interface Sampling {
  temperature?: number;
  top_p?: number;
}

/**
 * One turn of the conversation a generation call sends. Callers build the ARRAY (so the message
 * path can prime with a worked example as real user/assistant turns — OpenCommit's mechanism, and
 * the reason this is not a `(system, user)` pair); adapters translate roles to their provider's
 * spelling (Anthropic hoists `system` to a top-level field, Gemini calls the assistant `model`).
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * The plan call decodes GREEDILY. It is a classifier with a JSON contract, and its worst outcome
 * by far is an unparseable reply: that costs a retry and then a degraded bucket-split, which is
 * worse than any wording nit. Sending nothing meant Groq's default of 1.0 — the highest value of
 * any comparable tool surveyed (OpenCommit runs temperature 0 / top_p 0.1 against Groq for exactly
 * this call, aicommits 0.4, lazycommit 0.3). Nothing here is a verbosity lever: no tool ties
 * sampling to output LENGTH, and raising temperature to get longer bodies is folklore.
 */
export const PLAN_SAMPLING: Sampling = { temperature: 0, top_p: 0.1 };

/** The message call is prose, not a contract, so it gets a little room — but well under the 1.0
 *  default it was silently inheriting. Matches lazycommit's Groq-native value. */
export const MESSAGE_SAMPLING: Sampling = { temperature: 0.3 };

/** Never set frequency/presence penalty: a good commit body REPEATS the symbol it is about
 *  ("`decodeRow()` …" three times is correct prose), and a positive penalty punishes exactly the
 *  specificity we are asking for. Every surveyed tool that sets them sets them to 0. */

// ── model-list parsing helpers (PURE) ────────────────────────────────────────────

const OPENAI_KEEP = /^(gpt-|o[0-9]|chatgpt)/i;
const OPENAI_DROP =
  /(embedding|tts|whisper|dall-?e|audio|realtime|image|moderation|transcribe|search|babbage|davinci)/i;

/**
 * Non-chat model ids to exclude from the commit-message model list for the OpenAI-compatible
 * providers that expose a MIXED catalog (Groq serves Whisper/TTS/guard models from the same
 * `/models` endpoint as its chat LLMs; DeepSeek/OpenRouter can too). Without this, `finalizeModels`
 * sorts "whisper-large-v3-turbo" to the TOP of Groq's list and it becomes the auto-picked default —
 * a transcription model that can't answer `/chat/completions` (the reported "Groq → Whisper" bug).
 * Deliberately conservative: it drops speech/embedding/moderation/guard/image models but leaves
 * vision-capable chat models (which CAN chat) alone.
 */
const NON_CHAT_MODEL =
  /(whisper|tts|text-to-speech|playai|\bspeech\b|\baudio\b|embed|moderation|transcribe|rerank|guard|dall-?e|stable-diffusion|flux-|sdxl)/i;
const isChatModel = (id: string): boolean => !NON_CHAT_MODEL.test(id);

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

const chatBody = (
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  sampling: Sampling = {},
): unknown => ({
  model,
  messages,
  max_tokens: maxTokens,
  ...sampling,
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
  /** The generation request body for this provider's API shape. `messages` is the full turn
   *  list (system + any few-shot priming + the real user turn). `maxTokens` is the OUTPUT
   *  reservation — every provider gates on it, so callers size it (messageMaxTokens /
   *  planMaxTokens) rather than letting a provider default decide. `sampling` likewise: an unset
   *  temperature is not "neutral", it is whatever that provider defaults to (1.0 on Groq). */
  buildBody: (model: string, messages: ChatMessage[], maxTokens: number, sampling?: Sampling) => unknown;
  /**
   * Request body for STRUCTURED-JSON generation (the commit-plan call): enables the provider's
   * JSON mode where it has one. Omitted by a provider with no JSON-mode flag (Anthropic), where
   * the strict-JSON instruction in the prompt carries it and `buildBody` is used as-is.
   */
  jsonBody?: (model: string, messages: ChatMessage[], maxTokens: number, sampling?: Sampling) => unknown;
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
    // JSON mode. `response_format: json_object` makes the four OpenAI-compatible providers emit a
    // bare JSON object (no fences/preamble) reliably.
    jsonBody: (model, messages, maxTokens, sampling) => ({
      ...(chatBody(model, messages, maxTokens, sampling) as Record<string, unknown>),
      response_format: { type: "json_object" },
    }),
    extractCompletion: chatExtract,
  };
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** OpenAI's `top_p` is Gemini's `topP`; both live inside `generationConfig` there. */
const geminiSampling = (s: Sampling): Record<string, unknown> => ({
  ...(s.temperature != null ? { temperature: s.temperature } : {}),
  ...(s.top_p != null ? { topP: s.top_p } : {}),
});

/** Gemini keeps system text out of `contents`, in `systemInstruction`. */
const geminiSystem = (messages: ChatMessage[]): string =>
  messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");

/** Gemini's `contents` turns: assistant is spelled `model` there. */
const geminiContents = (messages: ChatMessage[]): Array<Record<string, unknown>> =>
  messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

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
    // No `jsonBody`: Anthropic has no JSON-mode flag, so the strict-JSON prompt instruction
    // carries the plan call and this body serves both paths unchanged.
    buildBody: (model, messages, maxTokens, sampling = {}) => ({
      model,
      max_tokens: maxTokens,
      // Anthropic hoists the system turn to a top-level field; user/assistant alternation in
      // `messages` is its documented few-shot form.
      system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
      messages: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content })),
      // Anthropic takes `temperature` top-level, and documents against setting top_p with it.
      ...(sampling.temperature != null ? { temperature: sampling.temperature } : {}),
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
    // gemini nests the decoding controls under `generationConfig` (and spells top_p `topP`).
    buildBody: (_model, messages, maxTokens, sampling = {}) => ({
      // gemini puts the model in the URL, not the body; system goes in `systemInstruction` and
      // the assistant role is spelled `model` in `contents`.
      systemInstruction: { parts: [{ text: geminiSystem(messages) }] },
      contents: geminiContents(messages),
      generationConfig: { maxOutputTokens: maxTokens, ...geminiSampling(sampling) },
    }),
    // `responseMimeType: application/json` is Gemini's JSON mode.
    jsonBody: (_model, messages, maxTokens, sampling = {}) => ({
      systemInstruction: { parts: [{ text: geminiSystem(messages) }] },
      contents: geminiContents(messages),
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
        ...geminiSampling(sampling),
      },
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
    keep: isChatModel,
  }),
  groq: openAiCompatible({
    modelsUrl: "https://api.groq.com/openai/v1/models",
    generateUrl: "https://api.groq.com/openai/v1/chat/completions",
    keep: isChatModel, // drop Whisper/TTS/guard models Groq serves from the same endpoint
  }),
  openrouter: openAiCompatible({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    generateUrl: "https://openrouter.ai/api/v1/chat/completions",
    keep: (id) => id.endsWith(":free") && isChatModel(id), // free CHAT models only
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
