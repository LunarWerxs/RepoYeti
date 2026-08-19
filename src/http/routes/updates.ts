import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { applyUpdate, checkForUpdate } from "../../updater.ts";
import { requestRelaunch, type RelaunchRefusal } from "../../auto-update.ts";
import { jsonError, type ApiErrorCode } from "../../contract.ts";

/**
 * What each refusal from requestRelaunch() looks like on the wire.
 *
 * The message is the WHOLE answer the caller gets: this route's only client is a badge in the
 * dashboard, and the setup it exists for (an installed PWA on a phone) has no terminal and no tray
 * beside it to go and look at. So each one names the work that is in the way and what resolves it,
 * in the same plain register as the update dialog's blocked reason.
 */
const REFUSALS: Record<RelaunchRefusal, { code: ApiErrorCode; message: string }> = {
  "no-handler": {
    code: "NOT_CONFIGURED",
    message: "this daemon can't restart itself — restart it from the tray or the terminal",
  },
  "update-in-flight": {
    code: "BUSY",
    message: "an update is installing right now — it restarts on its own when it finishes",
  },
  "pending-approval": {
    code: "BUSY",
    message: "an agent is waiting on an approval — answer it, then restart",
  },
  "active-operation": {
    code: "BUSY",
    message: "a git operation is running right now — try again in a moment",
  },
  "spawn-failed": {
    code: "ERROR",
    message: "couldn't start the replacement daemon — this one is still running, so nothing was lost",
  },
};

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

  /**
   * "Restart to finish" — finish a MANUAL update by relaunching the daemon (issue #23).
   *
   * A manual apply installs the new build and deliberately does not restart (only the opt-in
   * unattended apply does that), so the version row correctly reads "Restart to finish" — and, until
   * now, that was the end of it: a statement of what had to happen, with nothing that could make it
   * happen from the one screen the owner had.
   *
   * Deliberately NOT POST /api/shutdown, which means "stop the whole application" and writes the
   * sentinel telling the tray host to dispose its icon and exit. This is the auto-updater's own
   * relaunch — a detached successor inheriting the bound port — reached through
   * src/auto-update.ts requestRelaunch, which also owns the guards against interrupting work in
   * flight. See that function for why there is one relaunch mechanism here and not two.
   */
  app.post("/api/updates/restart", (c) => {
    const outcome = requestRelaunch();
    if (outcome.ok) return c.json({ ok: true });
    const refusal = REFUSALS[outcome.reason];
    // 409 for every refusal, including the "can't restart itself" one: nothing about the REQUEST is
    // malformed (which is what NOT_CONFIGURED's default 400 would claim) — the daemon's state is
    // what conflicts with it, and the caller's move is to resolve that and ask again.
    return jsonError(c, refusal.code, refusal.message, refusal.code === "ERROR" ? 500 : 409);
  });
}
