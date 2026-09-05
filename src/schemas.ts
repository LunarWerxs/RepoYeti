/**
 * zod request-body schemas + a tiny parse helper.
 *
 * The routes used to coerce `unknown` JSON by hand (`String(b.x ?? "").trim()`, ad-hoc
 * allowlists) — inconsistent and untyped. Each structured route now declares its body shape
 * here; `parseBody` validates once and hands back typed data, and a shape failure becomes the
 * standard `BAD_REQUEST` envelope (see contract.ts) with the offending field named.
 *
 * Domain rules that have their OWN error code (NO_KEY, NO_MESSAGE, NOT_CONFIGURED, …) stay in
 * the handler AFTER the shape check — so those codes are unchanged. That's why fields like
 * `apiKey`/`message` are `.optional()` here (shape allows absent → the handler still returns
 * its specific code), rather than `.min(1)` (which would collapse them to BAD_REQUEST).
 */
import type { Context } from "hono";
import { z } from "zod";
import { jsonError } from "./contract.ts";

/** Read + validate a JSON body. On failure returns a ready-to-return BAD_REQUEST response. */
export async function parseBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  const issue = r.error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "body";
  return { ok: false, res: jsonError(c, "BAD_REQUEST", `${where}: ${issue?.message ?? "invalid"}`) };
}

const nonEmpty = z.string().trim().min(1);

/** Bounds for a submitted smart-commit plan (defensive — the changed-file set is the real
 *  cap, but keep the request body from being pathological). */
const MAX_PLAN_GROUPS = 200;
const MAX_PLAN_PATHS = 5000;

/**
 * Owner settings (PUT /api/settings). health.ts applies every field as an independent,
 * best-effort partial update: an absent key means "leave this setting alone", not "reset it",
 * several fields clamp out-of-range numbers rather than reject them, and `changesStatDisplay`
 * deliberately rejects an unrecognized value (but only AFTER every other field has already been
 * applied — see the `badStatDisplay` comment in health.ts). None of that can live in the shape
 * check: a strict per-field zod type would fail the WHOLE object on one bad field, which is
 * exactly the "changesStatDisplay wipes out remoteEditing" bug this route was fixed for.
 *
 * So every field here is guaranteed to never fail the object parse:
 *  - boolean/number/string fields use `.optional().catch(undefined)` — a wrong-typed value
 *    collapses to "absent", which is exactly what the handler's own `typeof x === "..."` guards
 *    already treat as "ignore this field". Numbers add `.finite()` to match the handler's
 *    `Number.isFinite` guard (rejects NaN/Infinity the same way).
 *  - `changesStatDisplay` is `z.unknown()` — deliberately UNvalidated here, so the wrong-but-present
 *    value survives into the handler's own equality check + reject-at-the-end logic unchanged.
 *  - `autoCommitMode`/`autoCommitAiFallback` are closed enums with `.catch(undefined)`: a
 *    mismatched value collapses to undefined, which the handler's equality check already treats
 *    as "ignore" (never reject), so this is behavior-identical to the old code, just typed.
 */
export const SettingsUpdateSchema = z.object({
  diffStats: z.boolean().optional().catch(undefined),
  changesStatDisplay: z.unknown().optional(),
  changesChars: z.boolean().optional().catch(undefined),
  remoteEditing: z.boolean().optional().catch(undefined),
  remoteBrowse: z.boolean().optional().catch(undefined),
  diffPatchBytes: z.number().finite().optional().catch(undefined),
  diffPatchEnabled: z.boolean().optional().catch(undefined),
  syncCheck: z.boolean().optional().catch(undefined),
  syncIntervalSecs: z.number().finite().optional().catch(undefined),
  keepInSync: z.boolean().optional().catch(undefined),
  autoCommit: z.boolean().optional().catch(undefined),
  autoCommitMode: z.enum(["interval", "daily"]).optional().catch(undefined),
  autoCommitIntervalSecs: z.number().finite().optional().catch(undefined),
  autoCommitAt: z.string().optional().catch(undefined),
  autoCommitPull: z.boolean().optional().catch(undefined),
  autoCommitPush: z.boolean().optional().catch(undefined),
  autoCommitAiFallback: z.enum(["skip", "basic"]).optional().catch(undefined),
  autoUpdate: z.boolean().optional().catch(undefined),
  updateNotify: z.boolean().optional().catch(undefined),
  autoUpdateIntervalSecs: z.number().finite().optional().catch(undefined),
  autoScan: z.boolean().optional().catch(undefined),
  loreServersEnabled: z.boolean().optional().catch(undefined),
  portableMode: z.boolean().optional().catch(undefined),
  hideTrayIcon: z.boolean().optional().catch(undefined),
  mcpApprovalGate: z.boolean().optional().catch(undefined),
  mcpApprovalTimeoutSecs: z.number().finite().optional().catch(undefined),
  mcpAutoDeny: z.boolean().optional().catch(undefined),
  mcpAutoApprove: z.boolean().optional().catch(undefined),
  mcpAutoApproveTimeoutSecs: z.number().finite().optional().catch(undefined),
  // "" clears the preference; a value must match the live editor catalog (isKnownEditor) — that
  // lookup can't happen at parse time, so it stays a domain check in the handler.
  defaultEditor: z.string().optional().catch(undefined),
});

// ── access mode (local ↔ remote) ────────────────────────────────────────────────
// `mode` is deliberately `z.unknown()` — the "must be 'local' or 'remote'" check keeps its own
// BAD_MODE error code in the handler (mode.ts), matching this file's domain-rule convention
// (see header comment) rather than collapsing to the generic BAD_REQUEST shape error.
export const ModeUpdateSchema = z.object({
  mode: z.unknown().optional(),
});

// ── on-demand scan (whole machine, or one folder) ──────────────────────────────────
// `path` absent/empty/wrong-typed all mean "scan the whole machine" (see scan.ts) — that's a
// deliberate default, not a shape failure, so a wrong type collapses to undefined rather than
// rejecting. A present string is checked against the filesystem in the handler (existence/is-a-
// directory), which can't happen at parse time.
export const ScanSchema = z.object({
  path: z.string().optional().catch(undefined),
});

// ── identities ──────────────────────────────────────────────────────────────────
export const IdentityCreateSchema = z.object({
  displayName: nonEmpty,
  gitUsername: nonEmpty,
  gitEmail: nonEmpty,
  sshKeyPath: z.string().trim().nullish(), // optional; empty/absent → null in the handler
});

export const IdentityUpdateSchema = z.object({
  displayName: nonEmpty.optional(),
  gitUsername: nonEmpty.optional(),
  gitEmail: nonEmpty.optional(),
  // undefined = leave unchanged; null or "" = clear the key path.
  sshKeyPath: z.string().trim().nullish(),
});

export const AssignIdentitySchema = z.object({ identityId: z.string().trim().nullish() });

// ── repo rename / remove ─────────────────────────────────────────────────────────
/** A repo's display label. null/"" clears it back to the folder name; capped so a pasted essay
 *  can't wreck the card layout. Cosmetic only — the folder on disk is never renamed. */
const MAX_REPO_LABEL = 120;
export const RenameRepoSchema = z.object({
  displayName: z.string().trim().max(MAX_REPO_LABEL).nullish(),
});

/** Un-remove a path from the "Removed repos" list (Settings). */
export const RestorePathSchema = z.object({ absPath: nonEmpty });

// ── Identity Firewall (rules pinning a required identity to a path glob) ──────────
const MAX_IDENTITY_RULES = 200;
export const IdentityRulesSchema = z.object({
  rules: z
    .array(
      z.object({
        pathPattern: nonEmpty,
        requiredIdentityId: nonEmpty,
      }),
    )
    .max(MAX_IDENTITY_RULES),
});

// ── GitHub (gh) accounts ──────────────────────────────────────────────────────────
// Switch the machine's active GitHub account. `host` defaults to github.com in the handler; `login`
// is validated against the live `gh` account list there (an unknown login → NOT_FOUND).
export const AccountSwitchSchema = z.object({
  host: z.string().trim().optional(),
  login: nonEmpty,
});

// Link (or unlink) a GitHub account to a saved commit identity. `identityId` null/"" clears the
// link; a value is validated to exist in the handler (unknown id → NOT_FOUND).
export const AccountIdentitySchema = z.object({
  host: z.string().trim().optional(),
  login: nonEmpty,
  identityId: z.string().trim().nullish(),
});

// ── repos ───────────────────────────────────────────────────────────────────────
export const RepoPathSchema = z.object({ path: nonEmpty });

// ── scan roots (add / remove a discovery root) ────────────────────────────────────
export const RootPathSchema = z.object({ path: nonEmpty });

// ── clone (url + destination parent under a scan root) ─────────────────────────────
export const CloneSchema = z.object({
  url: nonEmpty,
  parentPath: nonEmpty,
  name: z.string().trim().optional(),
  identityId: z.string().trim().nullish(),
});

// ── lore servers (registry + clone-from-server) ───────────────────────────────────
export const ServerAddSchema = z.object({ name: z.string().trim().optional(), url: nonEmpty });
export const ServerCloneSchema = z.object({
  url: nonEmpty,
  parentPath: nonEmpty,
  name: z.string().trim().optional(),
});

// ── Buzz (experimental Git Smart HTTP compatibility; public metadata only) ────────
export const BuzzSettingsSchema = z.object({ enabled: z.boolean() });
export const BuzzCommunitySchema = z.object({
  name: z.string().trim().max(100).optional(),
  url: z.string().trim().min(1).max(2048),
  gitUrl: z.string().trim().max(2048).optional(),
});
export const BuzzPreflightSchema = z.object({ communityId: z.string().trim().max(128).optional() });

export const ReorderSchema = z.object({ order: z.array(z.string()).max(10_000) });

export const CommitSchema = z.object({
  message: z.string().optional(), // NO_MESSAGE stays a domain check in the handler
  amend: z.boolean().optional(),
  /** Optional optimistic-concurrency guard used by remote collaboration commit+sync. */
  expectedFingerprint: z.string().min(20).max(256).optional(),
});

// ── branches ──────────────────────────────────────────────────────────────────────
export const CheckoutSchema = z.object({ branch: nonEmpty });
export const CreateBranchSchema = z.object({ name: nonEmpty, switch: z.boolean().optional() });
export const DeleteBranchSchema = z.object({ name: nonEmpty });

// ── stash ───────────────────────────────────────────────────────────────────────────
export const StashSaveSchema = z.object({ message: z.string().optional() });
export const StashRefSchema = z.object({ index: z.number().int().min(0).optional() });

// ── discard one file's working-tree changes ──────────────────────────────────────────
export const DiscardSchema = z.object({ path: nonEmpty });

// ── delete one file from disk outright (distinct from discard — no restore semantics) ─
// `recursive` is OPT-IN: a directory `path` is refused unless the caller explicitly sets it, so
// an older client (or a bug that forgets the flag) can never recurse into a folder by accident.
export const DeleteFileSchema = z.object({ path: nonEmpty, recursive: z.boolean().optional() });

// ── stage one file's working-tree change into the index ──────────────────────────────
export const StageSchema = z.object({ path: nonEmpty });

// ── add one path to the repo's .gitignore (the changes-tree "Add to .gitignore" action) ──
export const GitignoreAddSchema = z.object({ path: nonEmpty });

// ── remotes (set-url / remove; name defaults to "origin" in the handler) ──────────────
export const RemoteSetSchema = z.object({ url: nonEmpty, name: z.string().trim().optional() });
export const RemoteDeleteSchema = z.object({ name: z.string().trim().optional() });

// ── tag creation (annotated when a message is given; optional push to origin) ─────────
export const TagCreateSchema = z.object({
  name: nonEmpty,
  message: z.string().optional(),
  push: z.boolean().optional(),
});

// ── remote-access named tunnel (stable host + connector token) ────────────────────
// Both fields follow the write-only-secret convention: undefined = leave unchanged · "" = clear ·
// a value = set it. `hostname` must be a bare host like "app.repoyeti.com" (no scheme/path); the
// `token` is the opaque cloudflared connector secret (kept in the keychain, never echoed back).
export const TunnelSettingsSchema = z.object({
  hostname: z
    .string()
    .trim()
    .refine(
      (s) => s === "" || /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s),
      "must be a bare hostname, e.g. app.repoyeti.com",
    )
    .optional(),
  token: z.string().optional(),
});

// ── relay (a permanent forwarding URL for a rotating quick tunnel) ────────────────
// `url` must be an https ORIGIN — no path, no http. https is not politeness here: the announce
// carries a signature over our current address, and letting it go out in clear would hand anyone
// on the path both the address and the chance to strip the response. "" clears the field.
export const RelaySettingsSchema = z.object({
  enabled: z.boolean().optional(),
  url: z
    .string()
    .trim()
    .refine((s) => {
      if (s === "") return true;
      try {
        const u = new URL(s);
        return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash;
      } catch {
        return false;
      }
    }, "must be an https origin, e.g. https://go.example.com")
    .optional(),
});

// ── AI ──────────────────────────────────────────────────────────────────────────
export const ConnectSchema = z.object({
  apiKey: z.string().optional(), // NO_KEY stays in handler
  /** Used only by the generic OpenAI-compatible provider. */
  baseUrl: z.string().max(2048).optional(),
  /** Manual fallback because compatible endpoints do not have to implement GET /models. */
  model: z.string().max(512).optional(),
});

export const AiSettingsSchema = z.object({
  style: z.enum(["conventional", "concise", "detailed"]).optional(),
  diffDetail: z.enum(["lean", "balanced", "thorough"]).optional(), // how much of each file the planner reads
  defaultProvider: z.string().nullish(), // provider validity → NOT_CONFIGURED in the handler
  yolo: z.boolean().optional(), // smart-commit: skip the review editor and commit the AI plan
  commitEnabled: z.boolean().optional(), // whether the AI commit buttons are shown at all
  conflictEnabled: z.boolean().optional(), // whether "Resolve with AI" appears on conflicts
});

export const ProviderUpdateSchema = z.object({
  model: z.string().max(512).nullish(),
  makeDefault: z.boolean().optional(),
});

/** Extra rotation-pool keys for an already-connected provider (see src/ai/credential-pool.ts).
 *  Replaces the whole extras list - the handler dedupes and drops the primary key if resubmitted.
 *  Capped well under any realistic owner-managed count; this is a few free-tier accounts, not a
 *  bulk credential dump. */
export const AiKeyPoolSchema = z.object({
  apiKeys: z.array(z.string().min(1).max(2048)).max(8),
});

export const CommitMessageSchema = z.object({
  provider: z.string().optional(),
  // When present, draft the message from ONLY these paths (smart-commit per-group regenerate).
  paths: z.array(nonEmpty).max(MAX_PLAN_PATHS).optional(),
});

// ── AI conflict resolution ───────────────────────────────────────────────────────
// Ask the model to propose a resolution for one conflicted file. Read-only: this route
// writes nothing, and the proposal only reaches disk through ConflictApplySchema below.
export const ConflictResolveSchema = z.object({
  path: nonEmpty,
  provider: z.string().optional(),
});

/**
 * Apply reviewed resolutions to one conflicted file.
 *
 * `content` is sent by the CLIENT rather than looked up from a server-side proposal, which is
 * what lets the owner edit the model's suggestion before accepting it — the common case, since
 * a proposal that is 90% right is still worth taking. The route validates every region
 * regardless of origin, so a hand-written resolution and a model's get identical treatment.
 *
 * `hash` is the staleness token from the read/resolve call. Without it, a proposal generated
 * before an editor saved the file would splice into bytes nobody reviewed.
 */
export const ConflictApplySchema = z.object({
  path: nonEmpty,
  hash: z.string().min(8).max(128),
  // Bounds mirror the engine's own limits (src/ai/conflict-resolve.ts): a file with more than
  // MAX_CONFLICT_HUNKS (40) regions is refused before it ever gets here, and a resolvable file is
  // at most MAX_CONFLICT_FILE_BYTES (512 KB), so one region can never legitimately exceed that.
  // Sized to the real ceiling rather than "generously": these two numbers multiply into the
  // request body the daemon will buffer, and the route pairs them with a bodyLimit to match.
  accepted: z
    .array(
      z.object({
        index: z.number().int().min(1).max(40),
        content: z.string().max(512_000),
      }),
    )
    .min(1)
    .max(40),
});

/** Ceiling for a conflict-apply body: every region at its cap, plus JSON escaping overhead.
 *  Enforced as middleware so an oversized body is rejected before it is buffered or parsed. */
export const CONFLICT_APPLY_BODY_LIMIT = 2_000_000;

/**
 * Default ceiling for ANY /api/* request body (src/http/app.ts). A backstop, not a policy: it
 * exists so no route can silently inherit Bun's ~128 MB default and buffer + JSON.parse that much
 * before its schema gets a say. Sized above the largest legitimate body — a 2 MB file write or
 * conflict resolution, plus JSON escaping — so routes with an exact bound still declare it
 * themselves.
 */
export const API_BODY_LIMIT = 8_000_000;

// ── smart commit (AI multi-commit splitter) ──────────────────────────────────────
// Plan generation reuses the message-route shape (optional provider override). `paths`, when
// present and non-empty, scopes the plan to the owner's checked selection in the changed-files
// tree; omitted/empty means "nothing checked" → plan the whole working tree (see planCommitInput).
export const CommitPlanSchema = z.object({
  provider: z.string().optional(),
  paths: z.array(nonEmpty).max(MAX_PLAN_PATHS).optional(),
});

// Execute an (owner-edited) plan: each entry is a final message + the paths to stage for it.
// Domain checks (paths in the live changed set, disjoint, complete) stay in the service layer
// so they can return their specific codes (PLAN_STALE / PLAN_PATHS_INVALID) against fresh state.
export const SmartCommitSchema = z.object({
  commits: z
    .array(
      z.object({
        message: nonEmpty,
        paths: z.array(nonEmpty).min(1).max(MAX_PLAN_PATHS),
      }),
    )
    .min(1)
    .max(MAX_PLAN_GROUPS),
  sync: z.boolean().optional(),
});

// ── per-file (selected) staging for a single ordinary commit ──────────────────────
// Stage + commit ONLY these paths (a rename's old path is auto-added in the service); any other
// pending change stays in the working tree. `message` is optional here so NO_MESSAGE stays a
// domain check in the handler (mirrors CommitSchema).
export const CommitSelectedSchema = z.object({
  message: z.string().optional(),
  paths: z.array(nonEmpty).min(1).max(MAX_PLAN_PATHS),
});

// ── share links ───────────────────────────────────────────────────────────────────
// Minting a link. `duration` is a preset (see share/index.ts SHARE_DURATIONS) rather than a raw
// timestamp so the API can't be handed a past/absurd expiry, and so "a week" means the same thing
// in the UI, the tests, and the audit trail. The perm enum is closed for the same reason the gate
// default-denies: a typo must fail loudly, not degrade to something permissive.
export const ShareCreateSchema = z.object({
  label: z.string().trim().min(1).max(80),
  perm: z.enum(["view", "control"]),
  /** Permit the holder to pair a second RepoYeti and publish an encrypted working-tree view. */
  collaborative: z.boolean().default(true),
  duration: z.enum(["hour", "day", "week", "month", "year", "never"]),
  /** Every repo, including ones discovered later. Mutually exclusive with a repoIds list. */
  scopeAll: z.boolean().default(false),
  repoIds: z.array(nonEmpty).default([]),
});

/**
 * Edit an existing share. Every field optional — an omitted one is left as it was.
 *
 * `duration` re-bases the expiry from NOW, which is the only reading that isn't surprising:
 * "make this last another week" should mean a week from today, not a week from whenever it was
 * first minted (which for an already-expired link would leave it still expired).
 */
export const ShareUpdateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  perm: z.enum(["view", "control"]).optional(),
  collaborative: z.boolean().optional(),
  duration: z.enum(["hour", "day", "week", "month", "year", "never"]).optional(),
  scopeAll: z.boolean().optional(),
  repoIds: z.array(nonEmpty).optional(),
});

// ── peer collaboration ─────────────────────────────────────────────────────────
export const CollaborationInspectSchema = z.object({
  inviteUrl: z.string().url(),
});

export const CollaborationJoinSchema = z.object({
  inviteUrl: z.string().url(),
  localRepoId: nonEmpty,
  remoteRepoId: nonEmpty,
});

export const CollaborationCommitSyncSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
});
