/**
 * The SSE event bus — a tiny pub/sub the watcher/service push to and every SSE
 * connection subscribes to. Kept in its own module so `service.ts` can broadcast
 * without importing the HTTP layer (and vice-versa) — no import cycle.
 */
/**
 * A subscriber. `data` is the payload already serialized (the common case — every owner connection
 * forwards it verbatim, so it's serialized once here rather than per listener). `payload` is that
 * same value BEFORE serialization, for the rare listener that must inspect or rewrite it: a share
 * link's SSE connection filters events against the guest's repo scope and re-serializes only what
 * it keeps (see share/events.ts). Passing it costs nothing and saves a parse-per-event-per-guest.
 */
export type BusListener = (event: string, data: string, payload: unknown) => void;

const listeners = new Set<BusListener>();

export function addListener(l: BusListener): void {
  listeners.add(l);
}

export function removeListener(l: BusListener): void {
  listeners.delete(l);
}

export function broadcast(event: string, payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const l of listeners) {
    // Isolate subscribers: one throwing listener must not drop the event for the others.
    try {
      l(event, data, payload);
    } catch {
      /* a bad subscriber is its own problem; keep delivering to the rest */
    }
  }
}
