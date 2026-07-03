// ── commit plan: split a working tree into multiple logical commits ────────────────
//
// "Smart commit": instead of one stage-all commit, the model partitions the changed FILES
// into several scoped commits, each with its own message. File-level only (a file is never
// split across commits) — see docs/SMART_COMMIT.md for why (the safety invariant). The plan
// is a SUGGESTION: the daemon validates it, the owner edits it, and a separate call commits.
import type { AiProviderId, CommitStyle } from "../config.ts";
import { AI_ADAPTERS } from "./adapters.ts";
import { AiError, requestJson, type FetchFn } from "./commit-message.ts";

const PLAN_TIMEOUT_MS = 45_000;

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
  let raw: { groups?: unknown } | null;
  try {
    raw = JSON.parse(jsonStr) as { groups?: unknown } | null;
  } catch {
    return null;
  }
  const known = new Set(knownPaths);
  const seen = new Set<string>();
  const groups: CommitPlanGroup[] = [];

  const groupsVal = raw?.groups;
  const rawGroups = Array.isArray(groupsVal) ? groupsVal : [];
  for (const g0 of rawGroups) {
    const g = (g0 ?? {}) as Record<string, unknown>;
    const subject = String(g.subject ?? "").trim();
    const rawFiles = Array.isArray(g.files) ? g.files : [];
    // Keep only real, not-yet-claimed paths (drops hallucinations + dedupes across groups).
    const files = rawFiles
      .map((p: unknown) => String(p ?? "").replace(/\\/g, "/").trim())
      .filter((p: string) => known.has(p) && !seen.has(p));
    if (!subject || files.length === 0) continue;
    for (const p of files) seen.add(p);
    const scope = String(g.scope ?? "").trim();
    const body = String(g.body ?? "").trim();
    const rationale = String(g.rationale ?? "").trim();
    groups.push({
      type: coerceType(g.type),
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
