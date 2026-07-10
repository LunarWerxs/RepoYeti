import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { parseBody, IdentityCreateSchema, IdentityUpdateSchema } from "../../schemas.ts";
import {
  listIdentities,
  getWatchableRepos,
  getIdentity,
  createIdentity,
  updateIdentity,
  deleteIdentity,
} from "../../db.ts";
import { detectIdentities } from "../../identity-detect.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── identities (CRUD) ──────────────────────────────────────────────────────
  app.get("/api/identities", (c) => c.json({ identities: listIdentities() }));
  app.get("/api/identities/detected", async (c) =>
    c.json({
      detected: await detectIdentities(getWatchableRepos().map((r) => ({ name: r.name, absPath: r.absPath }))),
    }),
  );

  app.post("/api/identities", async (c) => {
    const p = await parseBody(c, IdentityCreateSchema);
    if (!p.ok) return p.res;
    const { displayName, gitUsername, gitEmail } = p.data;
    const id = createIdentity({ displayName, gitUsername, gitEmail, sshKeyPath: p.data.sshKeyPath || null });
    return c.json({ identity: getIdentity(id) }, 201);
  });

  app.put("/api/identities/:id", async (c) => {
    const id = c.req.param("id");
    if (!getIdentity(id)) return jsonError(c, "NOT_FOUND", "identity not found");
    const p = await parseBody(c, IdentityUpdateSchema);
    if (!p.ok) return p.res;
    const b = p.data;
    updateIdentity(id, {
      displayName: b.displayName,
      gitUsername: b.gitUsername,
      gitEmail: b.gitEmail,
      // undefined = leave unchanged; null or "" = clear it.
      sshKeyPath: b.sshKeyPath === undefined ? undefined : b.sshKeyPath || null,
    });
    return c.json({ identity: getIdentity(id) });
  });

  app.delete("/api/identities/:id", (c) => {
    const id = c.req.param("id");
    return deleteIdentity(id) ? c.json({ ok: true }) : jsonError(c, "NOT_FOUND", "identity not found");
  });
}
