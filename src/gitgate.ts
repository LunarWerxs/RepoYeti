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
 * Gates are taken only around a SINGLE git invocation and released immediately, and a
 * remote op's preflight read finishes (releasing readGate) before it takes netGate — so
 * the two pools are never held nested and can't deadlock regardless of pool size.
 */
export interface Semaphore {
  /** Run `fn` once a slot is free; releases the slot when it settles (even on throw). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Currently-running count (diagnostics/tests). */
  readonly active: number;
  /** Queued-and-waiting count (diagnostics/tests). */
  readonly waiting: number;
}

export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) {
      active++; // hand the freed slot straight to the next waiter
      next();
    }
  };

  return {
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      let slot: Promise<void>;
      if (active < max) {
        active++;
        slot = Promise.resolve();
      } else {
        slot = new Promise<void>((res) => queue.push(res));
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

/** Local git reads (status / changed-files / diff). Override: REPOYETI_GIT_READ_CONCURRENCY. */
export const readGate = createSemaphore(envConcurrency("REPOYETI_GIT_READ_CONCURRENCY", 8));
/** Remote git network ops (fetch / pull / push). Override: REPOYETI_GIT_NET_CONCURRENCY. */
export const netGate = createSemaphore(envConcurrency("REPOYETI_GIT_NET_CONCURRENCY", 4));
