import type { Context, Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { saveConfig } from "../../config.ts";
import { parseBody, IdentityCreateSchema, IdentityUpdateSchema } from "../../schemas.ts";
import {
  listIdentities,
  getWatchableRepos,
  getIdentity,
  createIdentity,
  updateIdentity,
  deleteIdentity,
  IdentityValidationError,
} from "../../db.ts";
import { detectIdentities } from "../../identity-detect.ts";

function getIdentities(c: Context) {
  return c.json({ identities: listIdentities() });
}

// Detected suggestions from the machine (git config / SSH / gh), split into what's shown vs what
// the owner dismissed — detection re-reads live state, so the dismiss list is the only thing that
// makes a "deleted" suggestion stay gone. Returning the DISMISSED items (not just a count) lets
// the UI show them for review + per-item restore.
async function getDetectedIdentities(c: Context, cfg: Deps["cfg"]) {
  const dismissed = new Set(cfg.dismissedIdentities ?? []);
  const all = await detectIdentities(getWatchableRepos().map((r) => ({ name: r.name, absPath: r.absPath })));
  return c.json({
    detected: all.filter((d) => !dismissed.has(d.id)),
    dismissed: all.filter((d) => dismissed.has(d.id)),
  });
}

// Dismiss a detected suggestion (by its stable id) so it stops re-appearing on every refresh.
function postDismissDetected(c: Context<any, "/api/identities/detected/:id/dismiss">, cfg: Deps["cfg"]) {
  const id = c.req.param("id");
  if (!id) return jsonError(c, "BAD_REQUEST", "missing detected-identity id");
  const list = new Set(cfg.dismissedIdentities ?? []);
  list.add(id);
  cfg.dismissedIdentities = [...list];
  saveConfig(cfg);
  return c.json({ ok: true, dismissedCount: cfg.dismissedIdentities.length });
}

// Un-dismiss ONE suggestion (the temporary-undo path + per-item restore in the dismissed list).
function postRestoreDetected(c: Context<any, "/api/identities/detected/:id/restore">, cfg: Deps["cfg"]) {
  const id = c.req.param("id");
  if (!id) return jsonError(c, "BAD_REQUEST", "missing detected-identity id");
  if (cfg.dismissedIdentities?.length) {
    cfg.dismissedIdentities = cfg.dismissedIdentities.filter((d) => d !== id);
    saveConfig(cfg);
  }
  return c.json({ ok: true, dismissedCount: cfg.dismissedIdentities?.length ?? 0 });
}

// Un-dismiss everything — bring all previously-dismissed suggestions back.
function postRestoreAllDetected(c: Context, cfg: Deps["cfg"]) {
  cfg.dismissedIdentities = [];
  saveConfig(cfg);
  return c.json({ ok: true });
}

async function postIdentity(c: Context) {
  const p = await parseBody(c, IdentityCreateSchema);
  if (!p.ok) return p.res;
  const { displayName, gitUsername, gitEmail } = p.data;
  // createIdentity is idempotent by natural key (name + git username + git email, trimmed and
  // case-insensitive): a submission matching an existing identity returns that identity's id
  // instead of inserting a duplicate, so this route never needs to distinguish "created" from
  // "already existed" to the caller, it just always reflects the current row back as 201.
  try {
    const id = createIdentity({ displayName, gitUsername, gitEmail, sshKeyPath: p.data.sshKeyPath || null });
    return c.json({ identity: getIdentity(id) }, 201);
  } catch (e) {
    if (e instanceof IdentityValidationError) return jsonError(c, "VALIDATION", e.message);
    throw e;
  }
}

async function putIdentity(c: Context<any, "/api/identities/:id">) {
  const id = c.req.param("id");
  if (!getIdentity(id)) return jsonError(c, "NOT_FOUND", "identity not found");
  const p = await parseBody(c, IdentityUpdateSchema);
  if (!p.ok) return p.res;
  const b = p.data;
  try {
    const applied = updateIdentity(id, {
      displayName: b.displayName,
      gitUsername: b.gitUsername,
      gitEmail: b.gitEmail,
      // undefined = leave unchanged; null or "" = clear it.
      sshKeyPath: b.sshKeyPath === undefined ? undefined : b.sshKeyPath || null,
    });
    // The row exists (checked above), so `false` here means the edit collided with a DIFFERENT
    // identity's natural key: the friendly form of the identities_natkey unique-index backstop.
    if (!applied) return jsonError(c, "EXISTS", "another identity already has this name/username/email");
    return c.json({ identity: getIdentity(id) });
  } catch (e) {
    if (e instanceof IdentityValidationError) return jsonError(c, "VALIDATION", e.message);
    throw e;
  }
}

function deleteIdentityRoute(c: Context<any, "/api/identities/:id">) {
  const id = c.req.param("id");
  return deleteIdentity(id) ? c.json({ ok: true }) : jsonError(c, "NOT_FOUND", "identity not found");
}

export function register(app: Hono, { cfg }: Deps): void {
  // ── identities (CRUD) ──────────────────────────────────────────────────────
  app.get("/api/identities", getIdentities);
  app.get("/api/identities/detected", (c) => getDetectedIdentities(c, cfg));
  app.post("/api/identities/detected/:id/dismiss", (c) => postDismissDetected(c, cfg));
  app.post("/api/identities/detected/:id/restore", (c) => postRestoreDetected(c, cfg));
  app.post("/api/identities/detected/restore", (c) => postRestoreAllDetected(c, cfg));
  app.post("/api/identities", postIdentity);
  app.put("/api/identities/:id", putIdentity);
  app.delete("/api/identities/:id", deleteIdentityRoute);
}
