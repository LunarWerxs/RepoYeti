import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../deps.ts";
import { VERSION } from "../../config.ts";
import { addListener, removeListener } from "../../bus.ts";
import { effectiveGuest } from "../../auth.ts";
import { guestEventData } from "../../share/events.ts";

export const MAX_SSE_QUEUE = 500;
export const MAX_SSE_QUEUE_BYTES = 2 * 1024 * 1024;

interface QueuedSseEvent {
  event: string;
  data: string;
}

/** Per-client queue bounded by both event count and retained UTF-8 bytes. */
export class BoundedSseQueue {
  readonly items: QueuedSseEvent[] = [];
  bytes = 0;

  /**
   * Queue one event. Returns FALSE when this stream can no longer be kept coherent and the
   * caller must close it.
   *
   * Two ways that happens, and the second used to be silent. An oversized snapshot obviously
   * can't be made to fit. But so does a client that simply cannot drain fast enough: the
   * eviction loop below drops the OLDEST queued events to stay under the caps, and it used to
   * return true anyway. The connection stayed open and looked perfectly healthy while individual
   * repo_state_changed events evaporated — and because the stream has no replay and the client
   * has no way to know it missed anything, the affected repo's card stayed wrong indefinitely.
   * A dropped event is a desync, so it is reported like one: closing the stream makes
   * EventSource reconnect, and the client resyncs on reconnect.
   */
  push(message: QueuedSseEvent): boolean {
    const bytes = Buffer.byteLength(message.event) + Buffer.byteLength(message.data);
    if (bytes > MAX_SSE_QUEUE_BYTES) return false;
    this.items.push(message);
    this.bytes += bytes;
    let dropped = false;
    while (this.items.length > MAX_SSE_QUEUE || this.bytes > MAX_SSE_QUEUE_BYTES) {
      const removed = this.items.shift();
      if (!removed) break;
      this.bytes -= Buffer.byteLength(removed.event) + Buffer.byteLength(removed.data);
      dropped = true;
    }
    return !dropped;
  }

  drain(): QueuedSseEvent[] {
    const batch = this.items.splice(0);
    this.bytes = 0;
    return batch;
  }
}

export function register(app: Hono, { cfg }: Deps): void {
  // ── SSE stream ─────────────────────────────────────────────────────────────
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue = new BoundedSseQueue();
      let wake: (() => void) | null = null;
      let aborted = false;
      let overloaded = false;

      // Resolved ONCE, at connect: this is a long-lived stream, so re-reading the cookie per event
      // would be pointless (the cookie can't change mid-stream). Revocation still bites — every
      // other request the guest makes re-checks the DB, and the dashboard is useless without them.
      // The share object is only read for its id/scope here, never for permissions.
      const share = effectiveGuest(c, cfg);

      const listener = (event: string, data: string, payload: unknown): void => {
        // A guest sees only events for repos their share covers, and only from an allowlist of
        // event types — the raw bus carries the owner's settings, tunnel URL, and scan activity.
        // The projection can rename the event as well as rewrite its body (hiding a repo reaches
        // an all-repos guest as `repo_removed`), so take BOTH fields from it, never just the data.
        if (share) {
          const projected = guestEventData(share, event, payload);
          if (projected === null) return;
          if (!queue.push(projected)) overloaded = true;
        } else {
          if (!queue.push({ event, data })) overloaded = true;
        }
        wake?.();
        wake = null;
      };
      addListener(listener);
      stream.onAbort(() => {
        aborted = true;
        removeListener(listener);
        wake?.();
        wake = null;
      });

      try {
        await stream.writeSSE({ event: "hello", data: JSON.stringify({ ok: true, version: VERSION }) });

        while (!aborted && !overloaded) {
          if (queue.items.length === 0) {
            const { promise, resolve } = Promise.withResolvers<void>();
            wake = resolve;
            const timeout = setTimeout(resolve, 25_000);
            await promise;
            clearTimeout(timeout);
            if (aborted || overloaded) break;
            if (queue.items.length === 0) {
              await stream.writeSSE({ event: "ping", data: String(Date.now()) });
              continue;
            }
          }
          while (queue.items.length > 0 && !aborted && !overloaded) {
            const batch = queue.drain();
            for (const m of batch) {
              if (aborted || overloaded) break;
              await stream.writeSSE({ event: m.event, data: m.data });
            }
          }
        }
      } finally {
        // Also runs on write errors and byte-budget overload, not just a browser abort.
        removeListener(listener);
        wake?.();
        wake = null;
      }
    }),
  );
}
