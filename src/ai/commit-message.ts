/**
 * Single-message commit drafting: prompt building, HTTP plumbing, and the two simplest
 * public entry points — model discovery (`listModels`) and one-shot message generation
 * (`generateCommitMessage`). Network is reached via the global `fetch`, injectable
 * (`fetchImpl`) so parsing + request shaping are testable without hitting a provider.
 * Failures map to a small set of stable codes the UI can render (mirrors the classify()
 * pattern in git-actions.ts).
 */
import type { AiProviderId, CommitStyle } from "../config.ts";
import { AI_ADAPTERS, parseModels, type AiModel } from "./adapters.ts";

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

/** Injectable fetch (defaults to the global). */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000;

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
  const j = json as { error?: { message?: unknown } | string; message?: unknown } | null;
  const err = j?.error;
  const msg = (err && typeof err === "object" ? err.message : undefined) ?? j?.message ?? err ?? fallback;
  return String(typeof msg === "string" ? msg : fallback)
    .split("\n")[0]!
    .slice(0, 280);
}

/** One JSON request with a timeout; maps non-2xx + network/timeout to AiError. */
export async function requestJson(
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
