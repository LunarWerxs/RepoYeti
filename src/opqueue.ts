/**
 * Per-repo operation serialization.
 *
 * Every git operation on a given repo runs behind a single promise chain keyed
 * by repo id, so a user-triggered pull can never race the watcher's status read
 * (or another command) on the same repo. This is the primitive that prevents the
 * forbidden half-merged state — it is built in Phase 1, not bolted on later.
 */
const chains = new Map<string, Promise<unknown>>();

export function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Run `fn` whether or not the previous op resolved or rejected.
  const next = prev.then(fn, fn);
  // Keep a non-rejecting tail so the chain survives a failed op.
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Drop a repo's queue chain — called when the repo is forgotten (its scan root was removed), so
 * `chains` doesn't retain a resolved-promise entry for every repo id ever seen over a long-running
 * daemon's lifetime. No-op for an unknown key; only ever called during removal, when no further ops
 * are enqueued for that repo.
 */
export function forgetQueue(key: string): void {
  chains.delete(key);
}
