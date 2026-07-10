/**
 * The SSE event bus — a tiny pub/sub the watcher/service push to and every SSE
 * connection subscribes to. Kept in its own module so `service.ts` can broadcast
 * without importing the HTTP layer (and vice-versa) — no import cycle.
 */
export type BusListener = (event: string, data: string) => void;

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
      l(event, data);
    } catch {
      /* a bad subscriber is its own problem; keep delivering to the rest */
    }
  }
}
