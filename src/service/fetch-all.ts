/**
 * "Fetch all": one pass over every repository that has a remote.
 *
 * TWO ENTRY POINTS, ONE LOOP. `fetchAllRepos()` is the plain awaited call the background
 * remote-sync round makes (remote-sync.ts) — no job, no events, nothing for a phone to watch.
 * `startFetchAllJob()` is the owner pressing the button, and that one is a real job: it reports
 * which repository it is on, how many are done, which failed, and it can be stopped (1.0 audit
 * item 24). They share the loop rather than each having their own, because a second copy of "how
 * do we fetch every repo" is a second place for the concurrency rule below to be forgotten.
 *
 * WHY IT IS STILL SERIAL. `netGate` bounds the fetch command itself, but credential and account
 * resolution happens BEFORE that gate and can run its own git probes. An outer pool of eight
 * therefore still produced a large process burst every background round. One worker makes the
 * daemon-wide sweep low-impact, and a user-initiated single-repo operation can still take the
 * other netGate slot in between. Progress reporting is the answer to "this is slow", not
 * concurrency: the audit's own note is that hiding a missing progress bar behind more parallel
 * network work is not a fix.
 *
 * WHAT CANCELLING MEANS. The loop stops STARTING repositories. A fetch already in flight is left
 * to finish: aborting a git process mid-transfer is how an index.lock gets left behind, and the
 * repository the owner was least expecting to touch is the one that would keep it.
 */
import { getWatchableRepos } from "../db.ts";
import { fetchRepo } from "./actions.ts";
import { createJob } from "./job.ts";

export interface FetchAllFailure {
  id: string;
  name: string;
  code: string;
}

export interface FetchAllResult {
  /** Repos that had a remote and were in scope for this pass. */
  total: number;
  /** How many fetched cleanly. */
  ok: number;
  /** Per-repo failures (so the UI can name them). */
  failed: FetchAllFailure[];
  /** In scope but never attempted, because the owner stopped the run. */
  skipped: number;
  /** The owner stopped it. */
  cancelled: boolean;
}

export interface FetchAllOptions {
  /** Stop starting new repositories once this aborts. See the header on what that does not do. */
  signal?: AbortSignal;
  /** Called as each repository is picked up, and again with `done` once it settles. */
  onRepo?: (progress: {
    name: string;
    done: number;
    total: number;
    ok: number;
    failed: readonly FetchAllFailure[];
  }) => void;
}

/**
 * Fetch every repo that has a remote, serially. Repos with no remote are skipped and are not
 * failures. Never throws for a per-repo problem: the failures are the answer.
 */
export async function fetchAllRepos(opts: FetchAllOptions = {}): Promise<FetchAllResult> {
  const repos = getWatchableRepos().filter((r) => r.status?.remote);
  const failed: FetchAllFailure[] = [];
  let ok = 0;
  let done = 0;

  for (const repo of repos) {
    if (opts.signal?.aborted) break;
    opts.onRepo?.({ name: repo.name, done, total: repos.length, ok, failed });
    try {
      const result = await fetchRepo(repo.id);
      if (result.ok) ok++;
      else failed.push({ id: repo.id, name: repo.name, code: result.code });
    } catch {
      failed.push({ id: repo.id, name: repo.name, code: "ERROR" });
    }
    done++;
  }

  return {
    total: repos.length,
    ok,
    failed,
    skipped: repos.length - done,
    cancelled: opts.signal?.aborted === true,
  };
}

/** What the status route answers, and what the terminal event carries. */
export interface FetchAllProgress extends FetchAllResult {
  jobId: string;
  /** How many repositories have been attempted so far. */
  done: number;
  /** The repository being fetched right now, or null once the run has ended. */
  current: string | null;
  running: boolean;
}

const fetchAllJob = createJob<FetchAllResult>("fetch_all");

/**
 * The last run's live counters, kept after it ends.
 *
 * Not just `{ running }` like the scan's status route: the daemon has no event replay, so a phone
 * that backgrounded mid-fetch and came back has missed both the progress heartbeats and the
 * terminal event. Keeping the finished run means it can show what actually happened instead of
 * only learning that nothing is running now.
 */
let progress: FetchAllProgress | null = null;

export function isFetchingAll(): boolean {
  return fetchAllJob.isRunning();
}

/** Ask the in-flight pass to stop after the repository it is on. */
export function cancelFetchAll(): boolean {
  return fetchAllJob.cancel();
}

/** The in-flight run, or the last one that finished, or null if none has run this session. */
export function fetchAllState(): { running: boolean; job: FetchAllProgress | null } {
  return { running: fetchAllJob.isRunning(), job: progress };
}

/**
 * Start the owner-initiated pass. Fire-and-forget from the route: the summary arrives over SSE as
 * `fetch_all_done` / `fetch_all_cancelled`. Returns null when one is already running, which the
 * route reports rather than silently starting a second.
 */
export async function startFetchAllJob(): Promise<FetchAllResult | null> {
  // Counted before the job starts so the very first event can say how much work there is; a
  // spinner that cannot say "of how many" is the thing this item is about.
  const total = getWatchableRepos().filter((r) => r.status?.remote).length;
  return fetchAllJob.start({ total }, async (run) => {
    progress = {
      jobId: run.id,
      total,
      ok: 0,
      failed: [],
      skipped: 0,
      cancelled: false,
      done: 0,
      current: null,
      running: true,
    };
    const result = await fetchAllRepos({
      signal: run.signal,
      onRepo: ({ name, done, ok, failed }) => {
        // The status route keeps the failure LIST (a reconnecting phone wants to know which
        // repos); the heartbeat carries only the count, so a hundred-repo sweep does not push a
        // growing array down the stream every second.
        progress = { ...(progress as FetchAllProgress), current: name, done, ok, failed: [...failed] };
        run.progress({ current: name, done, total, ok, failed: failed.length });
      },
    });
    progress = { ...result, jobId: run.id, done: result.total - result.skipped, current: null, running: false };
    return result;
  });
}
