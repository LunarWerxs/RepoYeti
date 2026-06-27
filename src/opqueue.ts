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
