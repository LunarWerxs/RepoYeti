/**
 * Machine-readable OpenAPI 3.1 surface for the RepoYeti daemon.
 *
 * Agents (and humans) need one authoritative description of the HTTP API. Rather than hand-maintain
 * a separate spec that drifts from the routes, this module DERIVES the document from Hono's live
 * routing table (`app.routes`) at request time, and enriches each route with a curated summary and
 * — for mutating routes — the very same Zod request schema the handler parses (converted via
 * `z.toJSONSchema`). A drift guard test asserts every real /api/* route appears here, so a new route
 * can't ship without a spec entry.
 *
 * Dependency-light: only `zod` (already a dep) plus the contract/config/schema layers. It deliberately
 * does NOT import the git/service layers — the boundary guard (scripts/check-boundaries.ts) forbids it.
 */
import type { Hono } from "hono";
import { z } from "zod";
import { VERSION } from "../config.ts";
import {
  CommitSchema,
  CommitSelectedSchema,
  SmartCommitSchema,
  CheckoutSchema,
  CreateBranchSchema,
  DeleteBranchSchema,
  StashSaveSchema,
  StashRefSchema,
  DiscardSchema,
  TagCreateSchema,
  RemoteSetSchema,
  RemoteDeleteSchema,
  CloneSchema,
  ReorderSchema,
  RootPathSchema,
  ServerAddSchema,
  ServerCloneSchema,
  IdentityCreateSchema,
  IdentityUpdateSchema,
  AssignIdentitySchema,
  IdentityRulesSchema,
  AccountSwitchSchema,
  AccountIdentitySchema,
  TunnelSettingsSchema,
  ConnectSchema,
  AiSettingsSchema,
  ProviderUpdateSchema,
  CommitMessageSchema,
  CommitPlanSchema,
} from "../schemas.ts";

/** One curated entry per route, keyed by `"<METHOD> <hono-path>"` exactly as Hono registers it. */
interface RouteMeta {
  summary: string;
  /** The Zod schema the handler parses for this route's JSON body (mutating routes only). */
  body?: z.ZodType;
  tags?: string[];
  /** Query-string parameters the handler reads (e.g. ?limit, ?path, ?merges). */
  query?: Array<{ name: string; description?: string; required?: boolean; enum?: string[] }>;
}

/**
 * The route registry. Keys mirror Hono's `app.routes` entries verbatim (path params as `:id`,
 * `:hash`, `:provider`). Every /api/* and /oauth/* route the app registers has an entry; the doc
 * builder still emits a generic operation for any route missing here, so the spec is never partial.
 */
export const META: Record<string, RouteMeta> = {
  // ── health / status ──────────────────────────────────────────────────────────
  "GET /api/health": { summary: "Liveness probe (service name + version).", tags: ["system"] },
  "GET /api/status": {
    summary: "Runtime status: access mode, tunnel URL, and owner UI settings.",
    tags: ["system"],
  },
  "POST /api/shutdown": { summary: "Cleanly stop the local daemon.", tags: ["system"] },
  "PUT /api/settings": { summary: "Update owner UI settings (diff-stats, remote editing, sync).", tags: ["system"] },
  "GET /api/updates": { summary: "Check the configured public Git remote for a source update.", tags: ["system"] },
  "POST /api/updates/apply": { summary: "Apply an available source update with git pull --ff-only, then rebuild the web UI.", tags: ["system"] },
  "POST /api/pulse": { summary: "Record an anonymous product pulse.", tags: ["system"] },
  "GET /api/openapi.json": { summary: "This OpenAPI 3.1 document (public, unauthenticated).", tags: ["system"] },

  // ── auth ──────────────────────────────────────────────────────────────────────
  "GET /api/auth/status": { summary: "Auth state: whether sign-in is enforced and who is signed in.", tags: ["auth"] },
  "GET /api/auth/me": { summary: "The signed-in owner's subject + email (nulls when local).", tags: ["auth"] },
  "POST /api/auth/logout": { summary: "Clear this device's session cookie.", tags: ["auth"] },
  "POST /api/auth/logout-all": { summary: "Sign out everywhere by rotating the signing key.", tags: ["auth"] },
  "POST /api/auth/continue-local": { summary: "Grant a loopback-only bypass (refused over the tunnel).", tags: ["auth"] },
  "POST /api/auth/token": { summary: "Mint (or overwrite) the optional API Bearer token; returns the value ONCE (the only time it's returned).", tags: ["auth"] },
  "DELETE /api/auth/token": { summary: "Revoke the optional API Bearer token (back to OIDC-only).", tags: ["auth"] },
  "GET /api/auth/token": { summary: "Whether an API Bearer token is configured (never returns the value).", tags: ["auth"] },
  "GET /oauth/login": { summary: "Begin the OIDC sign-in (PKCE) — redirects to the IdP.", tags: ["auth"] },
  "GET /oauth/finish": { summary: "OIDC completion via the redirect shim bounce.", tags: ["auth"] },
  "GET /oauth/callback": { summary: "OIDC completion via the loopback redirect.", tags: ["auth"] },

  // ── access mode / tunnel ────────────────────────────────────────────────────────
  "PUT /api/mode": { summary: "Flip local ↔ remote access (manages the Cloudflare tunnel).", tags: ["system"] },
  "PUT /api/tunnel": { summary: "Configure the stable named tunnel (hostname + connector token).", body: TunnelSettingsSchema, tags: ["system"] },

  // ── repos ─────────────────────────────────────────────────────────────────────
  "GET /api/repos": { summary: "List all known repositories.", tags: ["repos"] },
  "POST /api/repos/register": { summary: "Register an existing repository folder.", body: RootPathSchema, tags: ["repos"] },
  "POST /api/repos/create": { summary: "Create a new repository (git init) at a folder.", body: RootPathSchema, tags: ["repos"] },
  "POST /api/repos/clone": { summary: "Clone a remote git URL into a folder under a scan root.", body: CloneSchema, tags: ["repos"] },
  "POST /api/repos/reorder": { summary: "Persist a drag-to-reorder of the repo list.", body: ReorderSchema, tags: ["repos"] },
  "POST /api/repos/fetch-all": { summary: "Fetch every repo that has a remote.", tags: ["repos"] },
  "POST /api/repos/:id/refresh": { summary: "Force a fresh status read of one repo.", tags: ["repos"] },

  // ── git actions ─────────────────────────────────────────────────────────────────
  "POST /api/repos/:id/fetch": { summary: "git fetch for one repo.", tags: ["git"] },
  "POST /api/repos/:id/pull": { summary: "git pull (fast-forward) for one repo.", tags: ["git"] },
  "POST /api/repos/:id/push": { summary: "git push for one repo.", tags: ["git"] },
  "POST /api/repos/:id/commit": { summary: "Commit the working tree (optionally amend).", body: CommitSchema, tags: ["git"] },
  "POST /api/repos/:id/commit-selected": { summary: "Commit only a selected subset of changed files.", body: CommitSelectedSchema, tags: ["git"] },
  "POST /api/repos/:id/smart-commit": { summary: "Execute an owner-edited multi-commit plan.", body: SmartCommitSchema, tags: ["git"] },

  // ── branches ──────────────────────────────────────────────────────────────────
  "GET /api/repos/:id/branches": { summary: "List a repo's branches.", tags: ["branches"] },
  "POST /api/repos/:id/checkout": { summary: "Switch to a branch.", body: CheckoutSchema, tags: ["branches"] },
  "POST /api/repos/:id/branch": { summary: "Create a branch (optionally switch to it).", body: CreateBranchSchema, tags: ["branches"] },
  "DELETE /api/repos/:id/branch": { summary: "Delete a branch.", body: DeleteBranchSchema, tags: ["branches"] },

  // ── history ─────────────────────────────────────────────────────────────────────
  "GET /api/repos/:id/log": {
    summary: "Paginated commit history (limit/skip/merges filters).",
    tags: ["history"],
    query: [
      { name: "limit", description: "Max commits to return (page size)." },
      { name: "skip", description: "Commits to skip (pagination offset)." },
      { name: "merges", description: "Filter merge commits.", enum: ["only", "exclude"] },
    ],
  },
  "GET /api/repos/:id/commit/:hash": { summary: "One commit's detail (changed files + bounded diff).", tags: ["history"] },

  // ── stash ───────────────────────────────────────────────────────────────────────
  "GET /api/repos/:id/stashes": { summary: "List a repo's stashes.", tags: ["stash"] },
  "POST /api/repos/:id/stash": { summary: "Stash the working tree (optional message).", body: StashSaveSchema, tags: ["stash"] },
  "POST /api/repos/:id/stash/pop": { summary: "Pop a stash by index.", body: StashRefSchema, tags: ["stash"] },
  "POST /api/repos/:id/stash/drop": { summary: "Drop a stash by index.", body: StashRefSchema, tags: ["stash"] },

  // ── tags ───────────────────────────────────────────────────────────────────────
  "GET /api/repos/:id/tags": { summary: "List a repo's tags.", tags: ["tags"] },
  "POST /api/repos/:id/tag": { summary: "Create a tag (annotated when a message is given; optional push).", body: TagCreateSchema, tags: ["tags"] },

  // ── remotes ─────────────────────────────────────────────────────────────────────
  "POST /api/repos/:id/remote": { summary: "Set/add a remote URL (defaults to origin).", body: RemoteSetSchema, tags: ["remotes"] },
  "DELETE /api/repos/:id/remote": { summary: "Remove a remote (defaults to origin).", body: RemoteDeleteSchema, tags: ["remotes"] },

  // ── files / changes ──────────────────────────────────────────────────────────────
  "GET /api/repos/:id/changes": { summary: "List a repo's changed files.", tags: ["files"] },
  "GET /api/repos/:id/file": {
    summary: "Read one changed file's contents.",
    tags: ["files"],
    query: [
      { name: "path", description: "Repo-relative file path.", required: true },
      { name: "ref", description: "Which side to read.", enum: ["head", "work"] },
    ],
  },
  "PUT /api/repos/:id/file": {
    summary: "Save an edited file back to the working tree.",
    tags: ["files"],
    query: [{ name: "path", description: "Repo-relative file path.", required: true }],
  },
  "GET /api/repos/:id/search": {
    summary: "Search content across the repo's changed files.",
    tags: ["files"],
    query: [{ name: "q", description: "Search query.", required: true }],
  },
  "GET /api/repos/:id/diff": {
    summary: "Both sides (HEAD + working) of a changed file.",
    tags: ["files"],
    query: [{ name: "path", description: "Repo-relative file path.", required: true }],
  },
  "POST /api/repos/:id/discard": { summary: "Discard one changed file's working-tree changes.", body: DiscardSchema, tags: ["files"] },
  "GET /api/editors": { summary: "List detected \"Open with…\" editors + the effective default (loopback convenience).", tags: ["files"] },
  "POST /api/repos/:id/open": { summary: "Open a repo folder (and optional file) in an external editor. Loopback-only.", tags: ["files"] },

  // ── repo display flags / identity ──────────────────────────────────────────────────
  "POST /api/repos/:id/identity": { summary: "Assign (or clear) a commit identity for a repo.", body: AssignIdentitySchema, tags: ["repos"] },
  "POST /api/repos/:id/hidden": { summary: "Hide/unhide a repo from the dashboard.", tags: ["repos"] },
  "POST /api/repos/:id/pinned": { summary: "Pin/unpin a repo.", tags: ["repos"] },
  "POST /api/repos/:id/starred": { summary: "Star/unstar a repo.", tags: ["repos"] },
  "POST /api/repos/:id/auto-commit": { summary: "Opt a repo in/out of the auto-commit timer.", tags: ["repos"] },

  // ── scan roots ──────────────────────────────────────────────────────────────────
  "GET /api/roots": { summary: "List the discovery scan roots.", tags: ["roots"] },
  "POST /api/roots": { summary: "Add a discovery scan root.", body: RootPathSchema, tags: ["roots"] },
  "DELETE /api/roots": { summary: "Remove a discovery scan root.", body: RootPathSchema, tags: ["roots"] },
  "POST /api/scan": { summary: "Rescan all configured scan roots for new repositories.", tags: ["roots"] },
  "POST /api/scan/cancel": { summary: "Cancel the in-flight project scan.", tags: ["roots"] },

  // ── lore servers ───────────────────────────────────────────────────────────────
  "GET /api/servers": { summary: "List registered Lore servers.", tags: ["servers"] },
  "POST /api/servers": { summary: "Register a Lore server (URL + display name).", body: ServerAddSchema, tags: ["servers"] },
  "DELETE /api/servers/:id": { summary: "Remove a registered Lore server.", tags: ["servers"] },
  "POST /api/servers/clone": { summary: "Clone a Lore repo from a server into a folder under a scan root.", body: ServerCloneSchema, tags: ["servers"] },

  // ── identities ─────────────────────────────────────────────────────────────────
  "GET /api/identities": { summary: "List commit identities.", tags: ["identities"] },
  "GET /api/identities/detected": { summary: "Detect local Git/GitHub/SSH identity hints.", tags: ["identities"] },
  "POST /api/identities": { summary: "Create a commit identity.", body: IdentityCreateSchema, tags: ["identities"] },
  "PUT /api/identities/:id": { summary: "Update a commit identity.", body: IdentityUpdateSchema, tags: ["identities"] },
  "DELETE /api/identities/:id": { summary: "Delete a commit identity.", tags: ["identities"] },

  // ── ⭐ Identity Firewall — rules pinning a required identity to a repo-path glob ────────────
  "GET /api/identity-rules": {
    summary: "List Identity Firewall rules (path glob → required identity).",
    tags: ["identities"],
  },
  "PUT /api/identity-rules": {
    summary: "Replace the full Identity Firewall rule list.",
    body: IdentityRulesSchema,
    tags: ["identities"],
  },

  // ── GitHub (gh) accounts — machine-wide active account switcher ─────────────────────
  "GET /api/accounts": { summary: "List the machine's authenticated GitHub (gh) accounts + which is active.", tags: ["accounts"] },
  "POST /api/accounts/switch": { summary: "Switch the active GitHub (gh) account (and align the credential username pin).", body: AccountSwitchSchema, tags: ["accounts"] },
  "PUT /api/accounts/identity": { summary: "Link (or unlink) a GitHub account to a saved commit identity, applied on switch.", body: AccountIdentitySchema, tags: ["accounts"] },

  // ── AI (bring-your-own-key) ───────────────────────────────────────────────────────
  "GET /api/ai/catalog": { summary: "Static provider catalog (display metadata; no secrets).", tags: ["ai"] },
  "GET /api/ai/settings": { summary: "Redacted AI settings (never includes a key).", tags: ["ai"] },
  "PUT /api/ai/settings": { summary: "Update commit style / default provider.", body: AiSettingsSchema, tags: ["ai"] },
  "POST /api/ai/providers/:provider/connect": { summary: "Connect a provider (validates the key, then saves it).", body: ConnectSchema, tags: ["ai"] },
  "GET /api/ai/providers/:provider/models": { summary: "Re-list models for a connected provider.", tags: ["ai"] },
  "PUT /api/ai/providers/:provider": { summary: "Set the selected model and/or mark this provider default.", body: ProviderUpdateSchema, tags: ["ai"] },
  "DELETE /api/ai/providers/:provider": { summary: "Remove a provider's stored key.", tags: ["ai"] },
  "POST /api/repos/:id/commit-message": { summary: "Draft a commit message from the repo's diff.", body: CommitMessageSchema, tags: ["ai"] },
  "POST /api/repos/:id/commit-plan": { summary: "Propose a multi-commit plan (read-only; commits nothing).", body: CommitPlanSchema, tags: ["ai"] },

  // ── events (SSE) — documented for completeness; not a JSON endpoint ───────────────
  "GET /api/events": { summary: "Server-Sent Events stream of live repo/settings updates.", tags: ["system"] },

  // ── MCP (Model Context Protocol) — AI agent tool access ────────────────────────────
  "POST /api/mcp": { summary: "MCP JSON-RPC endpoint (Streamable HTTP) — AI tool access.", tags: ["mcp"] },

  // ── ⭐ Agent Safety Rail — pending MCP mutating-call approvals ──────────────────────
  "GET /api/approvals": { summary: "List MCP tool calls currently pending owner approve/deny.", tags: ["mcp"] },
  "POST /api/approvals/:id/approve": { summary: "Approve a pending MCP mutating tool call.", tags: ["mcp"] },
  "POST /api/approvals/:id/deny": { summary: "Deny a pending MCP mutating tool call.", tags: ["mcp"] },
};

/** Hono path params (`:id`) → OpenAPI template params (`{id}`). */
function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Extract `{name}` path-parameter names from an OpenAPI-style path. */
function pathParamNames(openApiPath: string): string[] {
  return [...openApiPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
}

/** A short fallback summary for any route not curated in META, so the doc is always complete. */
function fallbackSummary(method: string, openApiPath: string): string {
  return `${method} ${openApiPath}`;
}

/**
 * Build a valid OpenAPI 3.1 document from the live Hono routing table.
 *
 * Reads `app.routes` at call time (so it sees every route regardless of registration order),
 * skips middleware (method "ALL") and the static `/*` catch-all, and emits one operation per
 * (method, path). Mutating routes carry their Zod body schema as a JSON-Schema request body.
 */
export function buildOpenApiDoc(app: Hono): object {
  const ERROR_REF = "#/components/schemas/ErrorResponse";
  const paths: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();

  for (const r of app.routes) {
    const method = r.method;
    if (method === "ALL") continue; // middleware, not an operation
    if (r.path === "/*" || r.path === "*") continue; // static PWA catch-all
    if (!r.path.startsWith("/api/") && !r.path.startsWith("/oauth/")) continue;

    const openApiPath = toOpenApiPath(r.path);
    const verb = method.toLowerCase();
    const dedupeKey = `${method} ${openApiPath}`;
    if (seen.has(dedupeKey)) continue; // a route can be registered once but we stay defensive
    seen.add(dedupeKey);

    const meta = META[`${method} ${r.path}`];
    const operation: Record<string, unknown> = {
      summary: meta?.summary ?? fallbackSummary(method, openApiPath),
      responses: {
        "200": { description: "Success" },
        default: {
          description: "Error",
          content: { "application/json": { schema: { $ref: ERROR_REF } } },
        },
      },
    };
    if (meta?.tags?.length) operation.tags = meta.tags;

    const parameters: Array<Record<string, unknown>> = pathParamNames(openApiPath).map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    for (const q of meta?.query ?? []) {
      parameters.push({
        name: q.name,
        in: "query",
        required: q.required ?? false,
        ...(q.description ? { description: q.description } : {}),
        schema: q.enum ? { type: "string", enum: q.enum } : { type: "string" },
      });
    }
    if (parameters.length) operation.parameters = parameters;

    if (meta?.body) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: z.toJSONSchema(meta.body) } },
      };
    }

    let entry = paths[openApiPath];
    if (!entry) {
      entry = {};
      paths[openApiPath] = entry;
    }
    entry[verb] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "RepoYeti API",
      version: VERSION,
      description:
        "Local-first, VCS-agnostic repository daemon. Bound to 127.0.0.1; /api/* is gated by the " +
        "owner-auth middleware except for the public probes and this document.",
    },
    paths,
    components: {
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            ok: { const: false },
            code: { type: "string" },
            message: { type: "string" },
          },
          required: ["ok", "code", "message"],
        },
      },
    },
  };
}
