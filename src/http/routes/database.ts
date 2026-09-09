/**
 * Owner-initiated database diagnosis, snapshot and repair (1.0 audit, item 15).
 *
 * Three verbs, and the split between them is the point. `verify` reads and reports. `backup`
 * writes a consistent snapshot somewhere new and touches the live database not at all. `repair`
 * is the only one that changes stored data, and the owner reaches it after reading the first two
 * rather than as a side effect of running them.
 *
 * Owner-only, all three. A guest holding a share link is scoped to some repositories; the health
 * of the whole store, its file size, and its schema are the owner's plane, and taking a snapshot
 * of every repository they own is not something a scoped link should be able to trigger.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { backupDatabase, repairStatusCache, verifyDatabase } from "../../db/connection.ts";

/** A file-name-safe UTC stamp: sorts chronologically and has no characters a path minds. */
function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/db/verify", (c) => c.json({ ok: true, report: verifyDatabase() }));

  app.post("/api/db/backup", (c) => {
    const result = backupDatabase(backupStamp(Date.now()));
    // A refused backup is a 409, not a 500: the usual cause is a snapshot for this second already
    // existing, which is a conflict with something that is already there rather than a fault.
    return result.ok ? c.json(result) : c.json(result, 409);
  });

  app.post("/api/db/repair-status-cache", (c) => c.json({ ok: true, ...repairStatusCache() }));
}
