import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../deps.ts";
import { VERSION } from "../../config.ts";
import { addListener, removeListener } from "../../bus.ts";

const MAX_SSE_QUEUE = 500;

export function register(app: Hono, _deps: Deps): void {
  // ── SSE stream ─────────────────────────────────────────────────────────────
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: Array<{ event: string; data: string }> = [];
      let wake: (() => void) | null = null;
      let aborted = false;

      const listener = (event: string, data: string): void => {
        queue.push({ event, data });
        if (queue.length > MAX_SSE_QUEUE) queue.splice(0, queue.length - MAX_SSE_QUEUE);
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

      await stream.writeSSE({ event: "hello", data: JSON.stringify({ ok: true, version: VERSION }) });

      while (!aborted) {
        if (queue.length === 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          wake = resolve;
          const timeout = setTimeout(resolve, 25_000);
          await promise;
          clearTimeout(timeout);
          if (aborted) break;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: String(Date.now()) });
            continue;
          }
        }
        while (queue.length > 0 && !aborted) {
          const batch = queue.splice(0);
          for (const m of batch) {
            if (aborted) break;
            await stream.writeSSE({ event: m.event, data: m.data });
          }
        }
      }
    }),
  );
}
