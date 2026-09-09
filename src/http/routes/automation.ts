/**
 * Automation run history and round cancellation (1.0 audit, item 23).
 *
 * The persisted counterpart to the automation_run_* SSE lifecycle: what the unattended loops did
 * while nobody was connected. The incident routes next door answer "what is still wrong"; these
 * answer "what happened", including the rounds where the answer was "nothing, in four seconds".
 *
 * The cancel route is the only mutating one, and what it does is narrow on purpose: it asks the
 * in-flight round to stop STARTING repositories. The repository being committed, fetched or
 * pulled right now finishes. Nothing is killed. See src/round-controller.ts.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { AutomationCancelSchema, parseBody } from "../../schemas.ts";
import {
  getAutomationRun,
  listAutomationRunRepos,
  listAutomationRuns,
  type AutomationRunKind,
} from "../../db.ts";
import { autoCommitRoundState, cancelAutoCommitRound } from "../../auto-commit.ts";
import { cancelSyncCheckRound, syncCheckRoundState } from "../../remote-sync.ts";

/** Narrow a caller-supplied kind, or undefined for "both loops". Never trusts the string. */
function parseKind(raw: string | undefined): AutomationRunKind | undefined {
  return raw === "auto_commit" || raw === "sync_check" ? raw : undefined;
}

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/automation/runs", (c) => {
    const rawLimit = c.req.query("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    return c.json({
      runs: listAutomationRuns({
        limit: Number.isFinite(limit) ? limit : undefined,
        kind: parseKind(c.req.query("kind")),
      }),
      // What is happening RIGHT NOW, which the run rows deliberately cannot say: an in-flight row
      // looks the same as one whose daemon died until the next boot closes it.
      active: { autoCommit: autoCommitRoundState(), syncCheck: syncCheckRoundState() },
    });
  });

  app.get("/api/automation/runs/:id", (c) => {
    const id = c.req.param("id") ?? "";
    const run = getAutomationRun(id);
    // A run past the cap is genuinely gone rather than empty, and the dashboard needs to tell
    // those apart: "we no longer keep this" reads very differently from "it touched nothing".
    if (!run) return jsonError(c, "NOT_FOUND", "no automation run with that id");
    return c.json({ run, repos: listAutomationRunRepos(id) });
  });

  app.post("/api/automation/cancel", async (c) => {
    const p = await parseBody(c, AutomationCancelSchema);
    if (!p.ok) return p.res;
    const kind = p.data.kind;
    const cancelled = kind === "auto_commit" ? cancelAutoCommitRound() : cancelSyncCheckRound();
    // `cancelled: false` is a successful answer, not an error: it means there was no round in
    // flight, which is exactly what a second tap on a Stop button finds.
    return c.json({ ok: true, kind, cancelled });
  });
}
