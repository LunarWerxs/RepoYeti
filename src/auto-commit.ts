/**
 * Auto-commit timer — "commit (and sync) my work for me on a schedule".
 *
 * A single daemon-wide timer that, each time it fires, walks the repos the owner OPTED IN
 * per-repo (the repos table's `auto_commit` flag) and, for each one with uncommitted changes,
 * runs the AI **Smart Commit** splitter to turn the working tree into several scoped commits,
 * then — configurably — `pull --ff-only`s and pushes. It reuses the exact same guarded service
 * calls the dashboard buttons use (`smartCommitRepo` → the per-repo op-queue; `pullRepo`/
 * `pushRepo` → the FF-only / no-force guards), so it can never do anything a human tapping the
 * buttons couldn't, and never leaves a repo half-merged.
 *
 * SAFETY — it must NEVER auto-commit a merge conflict. A repo with any unmerged/conflicted path,
 * or that is mid-merge/rebase/cherry-pick/revert, is SKIPPED entirely (reported via
 * `repo_auto_commit_blocked` so the owner knows to resolve it by hand). Pulling before pushing
 * (and skipping the push if the pull fails) mirrors the "commit & sync" order so an unattended
 * run can't publish over a diverged remote.
 *
 * Enable + cadence + pull/push are owner settings (cfg.autoCommit*). Timer shape mirrors
 * remote-sync.ts: a self-rescheduling setTimeout (never setInterval) so a slow round can't stack.
 * Wired in src/cli/lifecycle.ts (startAutoCommit after boot; stopAutoCommit on shutdown) and
 * primed + toggled live from src/http/app.ts + PUT /api/settings. Git-only for now (a Lore repo
 * is centralized and simply never opted in here).
 */
import { getWatchableRepos, getRepo, type RepoStatus, type RepoView } from "./db.ts";
import { broadcast } from "./bus.ts";
import { backendFor } from "./vcs/index.ts";
import { currentGitOperation } from "./git.ts";
import { smartCommitRepo, pullRepo, pushRepo, planCommitInput } from "./service/index.ts";
import {
  effectiveDefaultProvider,
  resolveApiKey,
  resolveModel,
  type RepoYetiConfig,
} from "./config.ts";
import { generateCommitPlan, heuristicPlan, type CommitPlan, type CommitPlanGroup } from "./ai.ts";

/** Interval-mode cadence bounds (seconds): 1 min floor (auto-commit is heavier than a fetch),
 *  24 h ceiling. Default 15 min. */
export const AUTO_COMMIT_INTERVAL_MIN_S = 60;
export const AUTO_COMMIT_INTERVAL_MAX_S = 86_400;
export const AUTO_COMMIT_INTERVAL_DEFAULT_S = 900;
/** Default daily-mode fire time (local wall clock). */
export const AUTO_COMMIT_AT_DEFAULT = "18:00";

/** Clamp a requested interval into [MIN, MAX]; a non-finite value falls back to the default. */
export function clampAutoCommitInterval(secs: number): number {
  if (!Number.isFinite(secs)) return AUTO_COMMIT_INTERVAL_DEFAULT_S;
  return Math.min(AUTO_COMMIT_INTERVAL_MAX_S, Math.max(AUTO_COMMIT_INTERVAL_MIN_S, Math.round(secs)));
}

/** Normalise an "HH:MM" 24-hour time, or the default when it's missing/malformed. */
export function normalizeDailyAt(at: string | undefined): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec((at ?? "").trim());
  if (!m) return AUTO_COMMIT_AT_DEFAULT;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return AUTO_COMMIT_AT_DEFAULT;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Ms from `now` until the next local `HH:MM`. `now` is injected so it's pure + unit-testable. */
export function msUntilDailyAt(at: string | undefined, now: number): number {
  const [h, min] = normalizeDailyAt(at).split(":").map(Number) as [number, number];
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, min, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now;
}

/**
 * Whether a repo's status is even a candidate for auto-commit: a git repo on a branch that isn't
 * errored or detached. Whether there's anything to DO (dirty / ahead / behind) is decided later
 * in processRepo. Pure (mirrors canAutoPull in remote-sync.ts), exported for testing.
 */
export function isAutoCommitActionable(s: RepoStatus | null | undefined): boolean {
  return !!s && !s.error && !s.detached && !!s.branch;
}

// ── runtime state (mirrors cfg.autoCommit*; set at boot in app.ts + on the settings toggle) ──
let enabled = false; // OFF by default — it pushes, so it's opt-in globally AND per-repo
let mode: "interval" | "daily" = "interval";
let intervalSecs = AUTO_COMMIT_INTERVAL_DEFAULT_S;
let dailyAt = AUTO_COMMIT_AT_DEFAULT;
let pullFirst = true; // pull --ff-only before pushing
let pushAfter = true; // push after committing
let started = false; // true only after the daemon finishes booting (startAutoCommit)
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false; // a round is in flight — don't let a reschedule double-arm the timer
let cfgRef: RepoYetiConfig | null = null; // live config (for AI provider resolution)

export function autoCommitEnabled(): boolean {
  return enabled;
}
export function getAutoCommitMode(): "interval" | "daily" {
  return mode;
}
export function getAutoCommitIntervalSecs(): number {
  return intervalSecs;
}
export function getAutoCommitAt(): string {
  return dailyAt;
}
export function autoCommitPullEnabled(): boolean {
  return pullFirst;
}
export function autoCommitPushEnabled(): boolean {
  return pushAfter;
}

/** One repo the timer just auto-committed (payload of the `repo_auto_committed` SSE event). */
export interface AutoCommittedRepo {
  id: string;
  name: string;
  /** How many commits the plan produced (0 when it only pulled/pushed prior work). */
  commits: number;
  pulled: boolean;
  pushed: boolean;
  /** A non-fatal sync note (e.g. NON_FAST_FORWARD) when pull/push couldn't complete. */
  note?: string;
}

/** One repo the timer refused to touch (payload of the `repo_auto_commit_blocked` SSE event). */
export interface AutoCommitBlockedRepo {
  id: string;
  name: string;
  /** Why it was skipped: "CONFLICT" (unmerged / mid-operation) or the failing action code. */
  reason: string;
}

// ── plan → commit groups ──────────────────────────────────────────────────────────────────
/** Build one commit's final message from a plan group: `type(scope): subject` + optional body.
 *  Matches composeSubject/message in web SmartCommitPlan.vue so auto + manual commits read alike. */
function composeMessage(g: CommitPlanGroup): string {
  const subject = `${g.type}${g.scope ? `(${g.scope})` : ""}: ${g.subject}`;
  return g.body ? `${subject}\n\n${g.body}` : subject;
}

/**
 * Turn a validated plan into smart-commit groups. Any files the planner left in `leftovers`
 * (couldn't confidently place) are swept into ONE catch-all commit — unattended, we must commit
 * the WHOLE tree so it ends clean, which is what lets the subsequent pull/push run. Exported for
 * testing. Groups with no files are dropped (defensive).
 */
export function planToCommits(plan: CommitPlan): Array<{ message: string; paths: string[] }> {
  const out = plan.groups
    .filter((g) => g.files.length > 0)
    .map((g) => ({ message: composeMessage(g), paths: g.files }));
  if (plan.leftovers.length > 0) {
    out.push({ message: "chore: auto-commit remaining changes", paths: [...plan.leftovers] });
  }
  return out;
}

// ── conflict / mid-operation guard (NEVER auto-commit these) ────────────────────────────────
/** True when the git repo is mid-merge/rebase/cherry-pick/revert (currentGitOperation is
 *  best-effort and already returns null rather than throwing when it can't tell). */
async function inGitOperation(absPath: string): Promise<boolean> {
  return (await currentGitOperation(absPath)) !== null;
}

/** True when the repo has unmerged/conflicted paths (status "C") OR is mid git-operation. */
async function hasConflict(repo: RepoView): Promise<boolean> {
  try {
    const files = await backendFor(repo.vcs).readChanges(repo.absPath, false);
    if (files.some((f) => f.status === "C")) return true;
  } catch {
    return true; // couldn't read the tree → safest to skip
  }
  return inGitOperation(repo.absPath);
}

// ── build the auto plan for one repo ────────────────────────────────────────────────────────
type BuiltPlan =
  | { ok: true; commits: Array<{ message: string; paths: string[] }> }
  | { ok: false; reason: string };

/**
 * Produce the commit groups for a repo's current working tree. Prefers the AI planner (the
 * owner's configured provider, else the built-in key); on no provider OR any AI failure it falls
 * back to the deterministic `heuristicPlan`, so auto-commit works even with no AI key and never
 * dead-ends on a provider hiccup (mirrors the /commit-plan route's fallback).
 */
async function buildPlan(repoId: string): Promise<BuiltPlan> {
  const collected = await planCommitInput(repoId);
  if (!collected.ok || !collected.input) return { ok: false, reason: collected.code ?? "ERROR" };
  const input = collected.input;
  const cfg = cfgRef;
  const provider = cfg ? effectiveDefaultProvider(cfg) : null;
  let plan: CommitPlan;
  if (cfg && provider) {
    const apiKey = resolveApiKey(cfg, provider);
    const model = resolveModel(cfg, provider);
    const style = cfg.ai?.style ?? "conventional";
    try {
      plan =
        apiKey && model
          ? await generateCommitPlan(provider, apiKey, model, input, style)
          : heuristicPlan(input);
    } catch {
      plan = heuristicPlan(input); // provider down / unparseable → deterministic split
    }
  } else {
    plan = heuristicPlan(input);
  }
  const commits = planToCommits(plan);
  if (commits.length === 0) return { ok: false, reason: "EMPTY_PLAN" };
  return { ok: true, commits };
}

// ── process one repo ────────────────────────────────────────────────────────────────────────
async function processRepo(
  repo: RepoView,
): Promise<{ done?: AutoCommittedRepo; blocked?: AutoCommitBlockedRepo }> {
  const s = repo.status;
  // Git-only; must be on a branch and not errored/detached.
  if (repo.vcs !== "git" || !isAutoCommitActionable(s) || !s) return {};

  const wantsPull = pullFirst && !!s.remote;
  const wantsPush = pushAfter && !!s.remote;
  // Nothing to do at all → skip silently (no event spam): clean tree, nothing to push, and
  // (if we'd pull) nothing known to pull.
  if (s.dirty === 0 && !(wantsPush && s.ahead > 0) && !(wantsPull && s.behind > 0)) return {};

  // Hard safety gate: never auto-commit a conflicted / mid-operation repo.
  if (await hasConflict(repo)) {
    return { blocked: { id: repo.id, name: repo.name, reason: "CONFLICT" } };
  }

  let commits = 0;
  if (s.dirty > 0) {
    const built = await buildPlan(repo.id);
    if (!built.ok) return { blocked: { id: repo.id, name: repo.name, reason: built.reason } };
    const res = await smartCommitRepo(repo.id, built.commits, false);
    if (!res.ok) return { blocked: { id: repo.id, name: repo.name, reason: res.code } };
    commits = res.committed?.filter((c) => c.ok && c.message !== "skipped (no changes)").length ?? 0;
  }

  // Sync — pull first (ff-only, self-guarding), then push. A failed pull BLOCKS the push, exactly
  // like smartCommitRepo's sync: pushing after a failed pull risks publishing over a diverged
  // remote (the NON_FAST_FORWARD the pull-first order exists to prevent).
  let pulled = false;
  let pushed = false;
  let note: string | undefined;
  let pushBlocked = false;
  if (wantsPull) {
    const pr = await pullRepo(repo.id);
    pulled = pr.ok;
    if (!pr.ok) {
      note = pr.code;
      pushBlocked = true;
    }
  }
  if (wantsPush && !pushBlocked) {
    const fresh = getRepo(repo.id)?.status; // smartCommitRepo/pullRepo already refreshed it
    if (fresh && fresh.ahead > 0) {
      const pu = await pushRepo(repo.id);
      pushed = pu.ok;
      if (!pu.ok) note = pu.code;
    }
  }

  if (commits === 0 && !pulled && !pushed && !note) return {}; // nothing observable happened
  return { done: { id: repo.id, name: repo.name, commits, pulled, pushed, ...(note ? { note } : {}) } };
}

async function tick(): Promise<{ done: AutoCommittedRepo[]; blocked: AutoCommitBlockedRepo[] }> {
  const repos = getWatchableRepos().filter((r) => r.autoCommit);
  const done: AutoCommittedRepo[] = [];
  const blocked: AutoCommitBlockedRepo[] = [];
  // Sequential: each repo is already op-queue-bounded, and a gentle one-at-a-time pass keeps the
  // AI + network load predictable regardless of how many repos opted in.
  for (const r of repos) {
    try {
      const out = await processRepo(r);
      if (out.done) done.push(out.done);
      if (out.blocked) blocked.push(out.blocked);
    } catch {
      blocked.push({ id: r.id, name: r.name, reason: "ERROR" });
    }
  }
  if (done.length > 0) broadcast("repo_auto_committed", { repos: done });
  if (blocked.length > 0) broadcast("repo_auto_commit_blocked", { repos: blocked });
  return { done, blocked };
}

// ── timer plumbing (mirrors remote-sync.ts) ─────────────────────────────────────────────────
function nextDelayMs(): number {
  return mode === "daily" ? msUntilDailyAt(dailyAt, Date.now()) : intervalSecs * 1000;
}
function schedule(): void {
  timer = setTimeout(() => void runTick(), nextDelayMs());
}
async function runTick(): Promise<void> {
  timer = null;
  ticking = true;
  try {
    await tick();
  } catch {
    /* a round failing is non-fatal — we just try again next window */
  } finally {
    ticking = false;
  }
  if (started && enabled && !timer) schedule();
}
/** Bring the timer in line with the current enabled/started state (idempotent). */
function reconcile(): void {
  if (!started) return;
  if (enabled && !timer && !ticking) schedule();
  else if (!enabled && timer) {
    clearTimeout(timer);
    timer = null;
  }
}
/** Re-arm a running loop with the current mode/cadence. No-op when idle or mid-tick (runTick's
 *  tail reschedules with the fresh values). */
function retime(): void {
  if (started && enabled && !ticking) {
    if (timer) clearTimeout(timer);
    timer = null;
    schedule();
  }
}

/** Give the module the live config object (for AI provider resolution). Called from app.ts. */
export function setAutoCommitConfig(cfg: RepoYetiConfig): void {
  cfgRef = cfg;
}

/** Begin the loop once the daemon has booted — called from src/cli/lifecycle.ts. No-op (beyond
 *  arming) when auto-commit is disabled in config. */
export function startAutoCommit(): void {
  started = true;
  reconcile();
}

/** Stop the loop (daemon shutdown). Safe to call when it was never started. */
export function stopAutoCommit(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Enable/disable auto-commit (config at boot + PUT /api/settings). Starts/stops the timer live. */
export function setAutoCommitEnabled(value: boolean): void {
  enabled = value;
  reconcile();
}

/** Set the timer mode ("interval" | "daily"). Re-times a running loop. */
export function setAutoCommitMode(value: "interval" | "daily"): void {
  mode = value === "daily" ? "daily" : "interval";
  retime();
}

/** Set the interval-mode cadence in seconds (clamped). Re-times a running loop. Returns clamped. */
export function setAutoCommitIntervalSecs(secs: number): number {
  intervalSecs = clampAutoCommitInterval(secs);
  retime();
  return intervalSecs;
}

/** Set the daily-mode fire time ("HH:MM"; normalised). Re-times a running loop. Returns normalised. */
export function setAutoCommitAt(at: string): string {
  dailyAt = normalizeDailyAt(at);
  retime();
  return dailyAt;
}

/** Enable/disable the pre-push pull. Takes effect next tick (no timer change). */
export function setAutoCommitPull(value: boolean): void {
  pullFirst = value;
}

/** Enable/disable the post-commit push. Takes effect next tick (no timer change). */
export function setAutoCommitPush(value: boolean): void {
  pushAfter = value;
}
