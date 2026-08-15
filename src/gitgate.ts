/**
 * Daemon-wide caps on concurrent git child processes.
 *
 * Without these, boot hydration (`Promise.all` over every discovered repo) or a burst of
 * SSE clients can spawn hundreds of `git` children at once — exhausting process/disk
 * resources and turning one slow filesystem (a network share, Windows Defender) into
 * whole-machine sluggishness. Two independent pools so a slow network op can never block
 * cheap local reads:
 *   • readGate — local reads: `git status`, changed-files, diff collection.
 *   • netGate  — remote network ops: fetch / pull / push.
 *
 * Local read transactions may need a few sequential Git invocations, but they hold one read
 * slot for the whole transaction. Keeping those inner calls sequential is important on Windows:
 * one logical Git command commonly appears as a wrapper git.exe + worker git.exe + conhost.exe,
 * so parallelising four commands inside four "bounded" repos still produced dozens of processes.
 * A remote op's preflight read finishes before it takes netGate, so the pools are never nested.
 *
 * ── Why the queue has two lanes ───────────────────────────────────────────────────────────
 * The pool is shared by work nobody is waiting on (boot hydration over every known repo, the
 * watcher's coalesced refreshes, the remote-sync check) and by work someone is staring at (the
 * card they just expanded). A single FIFO makes those indistinguishable, so expanding one card
 * while 25 repos hydrate put that card's `git status` behind 25 reads at two-at-a-time — seconds
 * of "Loading changes…" caused entirely by queue position, which is exactly the symptom this
 * lane split removes. Foreground work is human-paced and therefore self-limiting; background
 * work is already coalesced and retried, so deferring it briefly costs nothing observable.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";

/**
 * Marks the async context as user-initiated. Every gate slot taken beneath it jumps the queue
 * ahead of background work. Set once, at the HTTP boundary (src/http/app.ts) — an inbound
 * request IS the definition of "someone is waiting for this", and nothing else reaches Hono.
 */
const foreground = new AsyncLocalStorage<true>();

/** Run `fn` — and everything it awaits — as foreground (queue-jumping) work. */
export function asForeground<T>(fn: () => T): T {
  return foreground.run(true, fn);
}

/** Whether the caller is running inside an `asForeground` context. */
export function isForeground(): boolean {
  return foreground.getStore() === true;
}

export interface Semaphore {
  /** Run `fn` once a slot is free; releases the slot when it settles (even on throw). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Currently-running count (diagnostics/tests). */
  readonly active: number;
  /** Queued-and-waiting count (diagnostics/tests). */
  readonly waiting: number;
  /** Queued-and-waiting foreground count (diagnostics/tests). */
  readonly waitingForeground: number;
  /** The resolved concurrency ceiling, after clamping (diagnostics/tests). */
  readonly limit: number;
}

export function createSemaphore(max: number): Semaphore {
  // Configuration values arrive as numbers from environment strings. Never let a fractional
  // positive value floor to zero and permanently strand every caller in the wait queue.
  const limit = Number.isFinite(max) && max > 0 ? Math.max(1, Math.floor(max)) : 1;
  let active = 0;

  // One lane per priority. Each stays FIFO within itself, so same-priority callers keep the
  // original ordering guarantee; only the choice of WHICH lane to drain is new.
  interface Lane {
    queue: Array<() => void>;
    head: number;
  }
  const hi: Lane = { queue: [], head: 0 };
  const lo: Lane = { queue: [], head: 0 };

  const pending = (lane: Lane): number => lane.queue.length - lane.head;

  // Amortized O(1) FIFO without retaining an indefinitely growing consumed prefix.
  const compact = (lane: Lane): void => {
    if (lane.head > 1024 && lane.head * 2 >= lane.queue.length) {
      lane.queue.splice(0, lane.head);
      lane.head = 0;
    }
  };

  const release = (): void => {
    active--;
    // Foreground first, then background. A waiter is only ever in one lane.
    const lane = pending(hi) > 0 ? hi : pending(lo) > 0 ? lo : null;
    if (lane) {
      const next = lane.queue[lane.head++];
      if (next) {
        active++; // hand the freed slot straight to the next waiter
        next();
      }
      compact(lane);
    }
  };

  return {
    limit,
    get active() {
      return active;
    },
    get waiting() {
      return pending(hi) + pending(lo);
    },
    get waitingForeground() {
      return pending(hi);
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      let slot: Promise<void>;
      if (active < limit) {
        active++;
        slot = Promise.resolve();
      } else {
        // Priority is read HERE, when the caller queues — not when the slot frees — so it
        // reflects the context that actually issued the read.
        const lane = isForeground() ? hi : lo;
        slot = new Promise<void>((res) => lane.queue.push(res));
      }
      return slot.then(async () => {
        try {
          return await fn();
        } finally {
          release();
        }
      });
    },
  };
}

const envConcurrency = (name: string, def: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
};

/**
 * Default width of the local-read pool.
 *
 * This was a flat 2, chosen to keep the visible Git-for-Windows process tree small (one logical
 * git command is a wrapper git.exe + worker git.exe + conhost.exe, so the real process count is
 * ~3× this). Two turned out to be too tight for the machine it runs on: a card expand alone
 * issues four reads (changes, branches, stashes, recent messages), so a single click could not
 * even fill its own request without queueing. Half the cores, clamped to 4–8, keeps the process
 * tree bounded and predictable while letting one interaction complete in one pass.
 */
function defaultReadConcurrency(): number {
  let cores = 8;
  try {
    cores = availableParallelism();
  } catch {
    /* not available on this runtime — keep the conservative assumption */
  }
  return Math.max(4, Math.min(8, Math.floor(cores / 2)));
}

/**
 * Local git reads (status / changed-files / diff). Bounded so one slow disk can't monopolise the
 * daemon, and split into foreground/background lanes so a background sweep can't sit in front of
 * the card the owner just opened. Override: REPOYETI_GIT_READ_CONCURRENCY.
 */
export const readGate = createSemaphore(
  envConcurrency("REPOYETI_GIT_READ_CONCURRENCY", defaultReadConcurrency()),
);
/** Remote git network ops (fetch / pull / push). Override: REPOYETI_GIT_NET_CONCURRENCY. */
export const netGate = createSemaphore(envConcurrency("REPOYETI_GIT_NET_CONCURRENCY", 2));
