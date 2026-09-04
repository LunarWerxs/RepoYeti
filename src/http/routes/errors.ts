/**
 * Grouped operational-error history: read/mute/dismiss for the rows service/core.ts's
 * `runAction` writes on every failed mutating VCS action (see db.ts recordOperationalError).
 *
 * Lands next to health.ts's live GET /api/status: that route answers "what is this repo's
 * state RIGHT NOW", this one answers "what has gone wrong, and how often" - the history the
 * dashboard had no way to show before. Owner-only, like every other /api/* route (the single
 * auth middleware in app.ts gates this file the same as every other one); a share-link guest
 * never reaches it and the events this emits are not in share/events.ts's allowlist, so a
 * guest's SSE connection never sees them either.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { listOperationalErrors, setOperationalErrorMuted, dismissOperationalError } from "../../db.ts";
import { broadcast } from "../../bus.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── the grouped list itself, most-recently-seen first ────────────────────────
  app.get("/api/errors", (c) => c.json({ ok: true, errors: listOperationalErrors() }));

  // ── mute / unmute one group (keeps its history, just stops calling it out) ───
  app.post("/api/errors/:fingerprint/mute", async (c) => {
    const fingerprint = c.req.param("fingerprint");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const muted = b.muted !== false; // absent body -> mute (the common "silence this" click)
    if (!setOperationalErrorMuted(fingerprint, muted)) {
      return jsonError(c, "NOT_FOUND", "no such error group");
    }
    broadcast("operational_error_changed", { fingerprint, muted });
    return c.json({ ok: true, fingerprint, muted });
  });

  // ── dismiss one group outright - a later matching failure starts a fresh count ─
  app.delete("/api/errors/:fingerprint", (c) => {
    const fingerprint = c.req.param("fingerprint");
    if (!dismissOperationalError(fingerprint)) {
      return jsonError(c, "NOT_FOUND", "no such error group");
    }
    broadcast("operational_error_changed", { fingerprint, dismissed: true });
    return c.json({ ok: true, fingerprint });
  });
}
