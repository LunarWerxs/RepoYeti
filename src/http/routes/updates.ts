import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { applyUpdate, checkForUpdate } from "../../updater.ts";
import { jsonError } from "../../contract.ts";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/updates", async (c) => {
    const status = await checkForUpdate();
    return c.json(status);
  });

  app.post("/api/updates/apply", async (c) => {
    try {
      const result = await applyUpdate();
      return c.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonError(c, "ERROR", message);
    }
  });
}
