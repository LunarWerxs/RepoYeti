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
 *
 * This module is split by concern:
 *   - adapters.ts        per-provider adapters (model-list parsing, request shaping)
 *   - commit-message.ts  error/result types + HTTP plumbing + single commit-message drafting
 *   - commit-plan.ts     multi-commit "Smart Commit" planning
 */
export type { AiModel } from "./adapters.ts";
export { parseModels, extractCompletion } from "./adapters.ts";

export type { AiCode, FetchFn } from "./commit-message.ts";
export {
  AiError,
  systemPromptFor,
  userPromptFor,
  fewShotTurns,
  cleanCommitMessage,
  wrapCommitBody,
  listModels,
  generateCommitMessage,
  clearRateGate,
  rateGateRemainingMs,
} from "./commit-message.ts";

export type { PlanInputFile, CommitPlanInput, CommitPlanGroup, CommitPlan } from "./commit-plan.ts";
export {
  planSystemPrompt,
  planUserPrompt,
  parseCommitPlan,
  heuristicPlan,
  generateCommitPlan,
} from "./commit-plan.ts";
