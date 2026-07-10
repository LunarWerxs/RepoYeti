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

export const ReorderSchema = z.object({ order: z.array(z.string()).max(10_000) });

export const CommitSchema = z.object({
  message: z.string().optional(), // NO_MESSAGE stays a domain check in the handler
  amend: z.boolean().optional(),
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

// ── AI ──────────────────────────────────────────────────────────────────────────
export const ConnectSchema = z.object({ apiKey: z.string().optional() }); // NO_KEY stays in handler

export const AiSettingsSchema = z.object({
  style: z.enum(["conventional", "concise", "detailed"]).optional(),
  defaultProvider: z.string().nullish(), // provider validity → NOT_CONFIGURED in the handler
  yolo: z.boolean().optional(), // smart-commit: skip the review editor and commit the AI plan
});

export const ProviderUpdateSchema = z.object({
  model: z.string().nullish(),
  makeDefault: z.boolean().optional(),
});

export const CommitMessageSchema = z.object({
  provider: z.string().optional(),
  // When present, draft the message from ONLY these paths (smart-commit per-group regenerate).
  paths: z.array(nonEmpty).max(MAX_PLAN_PATHS).optional(),
});

// ── smart commit (AI multi-commit splitter) ──────────────────────────────────────
// Plan generation reuses the message-route shape (optional provider override).
export const CommitPlanSchema = z.object({ provider: z.string().optional() });

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
