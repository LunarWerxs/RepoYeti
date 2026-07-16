/**
 * What a share-link guest is allowed to reach — the capability policy.
 *
 * ── Why this file is an ALLOWLIST ──────────────────────────────────────────────
 * Every other principal in RepoYeti is the owner, so the auth gate has only ever had to answer
 * "is this the owner?" (auth.ts authMiddleware). A share link introduces a second, strictly-lesser
 * principal, and the failure mode we must design against is not "a guest slips past the gate" —
 * it's "someone adds a route in six months and never thinks about guests at all". A DENYLIST leaks
 * by default in exactly that case. So: anything not named here is OWNER-ONLY, full stop, and
 * `tests/share-policy.test.ts` walks the live Hono routing table to force every new route to be
 * classified consciously (see OWNER_ONLY below).
 *
 * ── Why the table is keyed by route PATTERN, matched here ───────────────────────
 * The gate runs as `app.use("/api/*", ...)`, where Hono has not yet matched a route — `c.req.
 * routePath` is the middleware's own "/api/*", not "/api/repos/:id/pull". So this module does its
 * own matching, compiling each pattern once at load. That is a feature, not a workaround: the
 * middleware is the ONE chokepoint every request crosses. There is no equivalent chokepoint deeper
 * in the stack — `db.getRepo(id)` takes only an id and knows nothing about the caller, and routes
 * reach it three inconsistent ways (respond.ts's withRepo/action helpers, a second lookup inside
 * the service layer, and two hand-rolled inline lookups in tags.ts and files.ts that bypass the
 * helpers entirely). Enforcing scope anywhere but here would silently miss those.
 *
 * ── Do NOT key this off openapi.ts's META ──────────────────────────────────────
 * It looks like the obvious registry, but it is NOT exhaustive: buildOpenApiDoc() emits a fallback
 * entry for any route missing from META, so its drift guard passes while META silently lacks
 * ~11 real routes (/api/repos/cleanup-missing, /api/repos/:id/move, /api/settings/sync, …).
 * Enumerate `app.routes` — the live truth — as the drift guard does.
 */

/** A share's permission tier. "control" is a superset of "view". */
export type SharePerm = "view" | "control";

export interface RoutePolicy {
  /** Lowest tier that may call this route. */
  need: SharePerm;
  /**
   * This route names a repo in a path param, so the gate must check that repo against the share's
   * scope before the handler runs. The drift guard asserts every guest-allowed route whose pattern
   * contains `:id` sets this — a scoped route that forgot the flag would expose EVERY repo.
   */
  scoped: boolean;
}

/**
 * The complete guest surface. Everything absent is owner-only.
 *
 * The tiers, as chosen by the owner:
 *   view    — see the repo and its state: what's uncommitted, the diff, the history.
 *   control — the above, plus the sync loop (fetch/pull/push/stage/commit) and Smart Commit.
 *
 * Deliberately NOT here, and why (each was considered and refused for v1):
 *   PUT  /api/repos/:id/file      — editing the owner's working tree is not "commit and sync".
 *   POST /api/repos/:id/discard   — irreversibly destroys the owner's uncommitted work.
 *   POST /api/repos/:id/move|gitignore — filesystem writes beyond the sync loop.
 *   POST /api/repos/:id/checkout|branch|stash — mutates the working state the owner is mid-flight in.
 *   POST /api/repos/:id/remote    — re-points where pushes go; a MITM primitive, not a git op.
 *   POST /api/repos/:id/identity|account — chooses which credential authors/authenticates commits.
 *   POST /api/repos/:id/auto-commit — arms an unattended push timer the owner never opted into.
 *   POST /api/repos/fetch-all     — acts on every repo; cannot be scoped to a share.
 *   GET  /api/identities/detected — leaks the abs path of every watchable repo on the machine.
 *   GET  /api/accounts            — leaks gh logins, token scopes, the global commit author.
 *   POST /api/mcp, /api/approvals/* — the agent surface and its safety rail.
 */
export const GUEST_ROUTES: Record<string, RoutePolicy> = {
  // ── read: the dashboard ──────────────────────────────────────────────────────
  // Projected in the handler down to the display knobs the dashboard needs to render — never the
  // owner's tunnel/MCP/auto-commit/editor settings (routes/health.ts guestRuntimeStatus).
  "GET /api/status": { need: "view", scoped: false },
  // Scope-filtered in the handler (a guest sees only their repos), not by the path matcher.
  "GET /api/repos": { need: "view", scoped: false },
  "POST /api/repos/:id/refresh": { need: "view", scoped: true }, // a POST, but it only re-reads status
  // ── read: one repo ───────────────────────────────────────────────────────────
  "GET /api/repos/:id/changes": { need: "view", scoped: true },
  "GET /api/repos/:id/diff": { need: "view", scoped: true },
  "GET /api/repos/:id/file": { need: "view", scoped: true },
  "GET /api/repos/:id/search": { need: "view", scoped: true },
  "GET /api/repos/:id/branches": { need: "view", scoped: true },
  "GET /api/repos/:id/log": { need: "view", scoped: true },
  "GET /api/repos/:id/commit/:hash": { need: "view", scoped: true },
  "GET /api/repos/:id/commit/:hash/file": { need: "view", scoped: true },
  "GET /api/repos/:id/stashes": { need: "view", scoped: true },
  "GET /api/repos/:id/tags": { need: "view", scoped: true },
  // ── live updates ─────────────────────────────────────────────────────────────
  // Filtered per-connection against the share's scope AND an event allowlist (routes/events.ts).
  "GET /api/events": { need: "view", scoped: false },
  // ── "Leave" ──────────────────────────────────────────────────────────────────
  // Principal-aware in the handler: for a guest it clears only the guest cookie, and can never
  // touch the owner's session (that path needs an owner session to reach in the first place).
  "POST /api/auth/logout": { need: "view", scoped: false },
  // ── control: the sync loop ───────────────────────────────────────────────────
  "POST /api/repos/:id/fetch": { need: "control", scoped: true },
  "POST /api/repos/:id/pull": { need: "control", scoped: true },
  "POST /api/repos/:id/push": { need: "control", scoped: true },
  "POST /api/repos/:id/stage": { need: "control", scoped: true },
  "POST /api/repos/:id/commit": { need: "control", scoped: true },
  "POST /api/repos/:id/commit-selected": { need: "control", scoped: true },
  // ── control: Smart Commit (spends the OWNER's AI key — an explicit owner decision) ──
  "POST /api/repos/:id/smart-commit": { need: "control", scoped: true },
  "POST /api/repos/:id/commit-message": { need: "control", scoped: true },
  "POST /api/repos/:id/commit-plan": { need: "control", scoped: true },
};

/**
 * Every route a guest must NEVER reach. Runtime behaviour does NOT depend on this list — the
 * allowlist above already denies by default, and that is what actually protects the daemon.
 *
 * This exists purely so the drift guard can tell "consciously owner-only" apart from "nobody has
 * thought about this route yet". A new route matches neither list, the guard fails, and whoever
 * added it has to make a decision. That is the entire point: the guard converts an omission (which
 * is invisible, and would otherwise stay invisible until it became a leak) into a failing test.
 */
export const OWNER_ONLY: readonly string[] = [
  // system / daemon lifecycle
  "POST /api/shutdown",
  "PUT /api/settings",
  "POST /api/portable-window",
  "GET /api/updates",
  "POST /api/updates/apply",
  "POST /api/pulse",
  // auth plane
  "GET /api/auth/status", // guests get a projection instead (routes/auth.ts)
  "GET /api/auth/me", // ditto
  "POST /api/auth/logout-all",
  "POST /api/auth/continue-local",
  "GET /api/auth/token",
  "POST /api/auth/token",
  "DELETE /api/auth/token",
  // share administration — a guest minting a link is privilege escalation
  "GET /api/shares",
  "POST /api/shares",
  "DELETE /api/shares/:id",
  "GET /api/shares/:id/events",
  // access mode / tunnel
  "PUT /api/mode",
  "PUT /api/tunnel",
  // repo inventory management — a guest sees a scoped VIEW of the owner's list, so editing that
  // list (renaming a card, removing one, or reading/undoing what the owner removed) is the
  // owner's alone. Nothing here is destructive to the repo itself, but all of it is the owner's
  // organisation of their own dashboard.
  "POST /api/repos/register",
  "POST /api/repos/create",
  "POST /api/repos/clone",
  "POST /api/repos/reorder",
  "POST /api/repos/fetch-all",
  "POST /api/repos/cleanup-missing",
  "PATCH /api/repos/:id/name",
  "DELETE /api/repos/:id",
  "GET /api/repos/ignored",
  "POST /api/repos/ignored/restore",
  // discovery
  "GET /api/roots",
  "POST /api/roots",
  "DELETE /api/roots",
  "POST /api/scan",
  "POST /api/scan/cancel",
  // lore servers
  "GET /api/servers",
  "POST /api/servers",
  "DELETE /api/servers/:id",
  "POST /api/servers/clone",
  // identities / accounts
  "GET /api/identities",
  "GET /api/identities/detected",
  "POST /api/identities/detected/:id/dismiss",
  "POST /api/identities/detected/:id/restore",
  "POST /api/identities/detected/restore",
  "POST /api/identities",
  "PUT /api/identities/:id",
  "DELETE /api/identities/:id",
  "GET /api/identity-rules",
  "PUT /api/identity-rules",
  "GET /api/accounts",
  "POST /api/accounts/switch",
  "PUT /api/accounts/identity",
  // per-repo owner state
  "POST /api/repos/:id/identity",
  "POST /api/repos/:id/account",
  "POST /api/repos/:id/hidden",
  "POST /api/repos/:id/pinned",
  "POST /api/repos/:id/starred",
  "POST /api/repos/:id/auto-commit",
  // working-tree mutation beyond the sync loop
  "PUT /api/repos/:id/file",
  "POST /api/repos/:id/discard",
  "POST /api/repos/:id/move",
  "POST /api/repos/:id/gitignore",
  "POST /api/repos/:id/checkout",
  "POST /api/repos/:id/branch",
  "DELETE /api/repos/:id/branch",
  "POST /api/repos/:id/stash",
  "POST /api/repos/:id/stash/pop",
  "POST /api/repos/:id/stash/drop",
  "POST /api/repos/:id/tag",
  "POST /api/repos/:id/remote",
  "DELETE /api/repos/:id/remote",
  // editors — launches processes on the owner's desktop
  "GET /api/editors",
  "POST /api/repos/:id/open",
  // AI configuration (the keys themselves)
  "GET /api/ai/catalog",
  "GET /api/ai/settings",
  "PUT /api/ai/settings",
  "POST /api/ai/providers/:provider/connect",
  "GET /api/ai/providers/:provider/models",
  "PUT /api/ai/providers/:provider",
  "DELETE /api/ai/providers/:provider",
  // agent surface + its safety rail
  "POST /api/mcp",
  "GET /api/approvals",
  "POST /api/approvals/:id/approve",
  "POST /api/approvals/:id/deny",
  // cloud settings sync
  "GET /api/settings/sync",
  "PUT /api/settings/sync",
  "POST /api/settings/sync/pull",
  "POST /api/settings/sync/push",
  // public probes — unauthenticated by design, never guest-gated
  "GET /api/health",
  "GET /api/openapi.json",
];

// ── pattern matching ────────────────────────────────────────────────────────────

interface Compiled {
  method: string;
  rx: RegExp;
  params: string[];
  policy: RoutePolicy;
}

/**
 * Compile "/api/repos/:id/commit/:hash" into an anchored regex + the param names it captures.
 * Literal segments are regex-escaped: "/api/openapi.json" must not let "." match any character.
 */
function compile(path: string): { rx: RegExp; params: string[] } {
  const params: string[] = [];
  let source = "";
  for (const seg of path.split("/")) {
    if (!seg) continue;
    source += "/";
    if (seg.startsWith(":")) {
      params.push(seg.slice(1));
      source += "([^/]+)";
    } else {
      source += seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return { rx: new RegExp(`^${source}/?$`), params };
}

const COMPILED: Compiled[] = Object.entries(GUEST_ROUTES).map(([key, policy]) => {
  const sp = key.indexOf(" ");
  const method = key.slice(0, sp);
  const { rx, params } = compile(key.slice(sp + 1));
  return { method, rx, params, policy };
});

export interface PolicyMatch {
  policy: RoutePolicy;
  /** Captured path params, e.g. { id: "…", hash: "…" }. */
  params: Record<string, string>;
}

/**
 * The guest policy for a request, or null when no rule matches — which means DENY.
 * `method` is compared case-insensitively; `pathname` must already be just the path.
 */
export function policyFor(method: string, pathname: string): PolicyMatch | null {
  const m = method.toUpperCase();
  for (const c of COMPILED) {
    if (c.method !== m) continue;
    const hit = c.rx.exec(pathname);
    if (!hit) continue;
    const params: Record<string, string> = {};
    c.params.forEach((name, i) => {
      params[name] = decodeURIComponent(hit[i + 1]!);
    });
    return { policy: c.policy, params };
  }
  return null;
}

/** True when a share holding `have` satisfies a route needing `need`. control ⊃ view. */
export function permSatisfies(have: SharePerm, need: SharePerm): boolean {
  return have === "control" || need === "view";
}
