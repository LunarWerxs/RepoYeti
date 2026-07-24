import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import {
  CollaborationCommitSyncSchema,
  CollaborationInspectSchema,
  CollaborationJoinSchema,
  parseBody,
} from "../../schemas.ts";
import {
  collaborationFingerprint,
  commitAndSyncAcceptedCollaboration,
  deleteCollaborationLink,
  inspectCollaborationInvitation,
  joinCollaboration,
  listCollaborationLinks,
  publishAllCollaborations,
  readAcceptedCollaborationDiff,
  readAcceptedCollaborationStatus,
  readCollaborationSnapshots,
  receiveCollaborationSnapshot,
} from "../../collaboration.ts";
import { getRepo } from "../../db.ts";
import { effectiveGuest } from "../../auth.ts";

function publicLink(link: ReturnType<typeof listCollaborationLinks>[number]) {
  const repo = getRepo(link.localRepoId);
  return {
    id: link.id,
    localRepoId: link.localRepoId,
    localRepoName: repo?.displayName ?? repo?.name ?? "Missing repository",
    remoteRepoId: link.remoteRepoId,
    label: link.label,
    createdAt: link.createdAt,
    enabled: link.enabled,
  };
}

export function register(app: Hono, { cfg }: Deps): void {
  /**
   * Collaborator → owner presence ingress. This deliberately sits outside /api/*: it is
   * authenticated by the live collaborative share token, while every /api/collaborations route
   * below remains owner-only. No repo mutation is reachable from this endpoint.
   */
  app.post("/c/:channel/:participant", async (c) => {
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 360_000) {
      return c.json({ ok: false }, 413);
    }
    let data = "";
    try {
      const raw = await c.req.text();
      if (raw.length > 360_000) return c.json({ ok: false }, 413);
      const body = JSON.parse(raw) as { data?: unknown };
      data = typeof body.data === "string" ? body.data : "";
    } catch {
      return c.json({ ok: false }, 400);
    }
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (
      !receiveCollaborationSnapshot(
        token,
        c.req.param("channel"),
        c.req.param("participant"),
        data,
      )
    ) {
      return c.json({ ok: false }, 403);
    }
    return c.json({ ok: true });
  });

  /** Live peer snapshots for the owner's dashboard. The relay failure mode is an empty list. */
  app.get("/api/collaborations", (c) => {
    const snapshots = readCollaborationSnapshots();
    return c.json({ snapshots });
  });

  /** Pairing step one: inspect a pasted invitation and return its scoped remote repo choices. */
  app.post("/api/collaborations/inspect", async (c) => {
    const p = await parseBody(c, CollaborationInspectSchema);
    if (!p.ok) return p.res;
    try {
      const invite = await inspectCollaborationInvitation(p.data.inviteUrl);
      return c.json({
        invite: {
          share: invite.share,
          repos: invite.repos,
        },
      });
    } catch (e) {
      return jsonError(c, "BAD_REQUEST", e instanceof Error ? e.message : "invalid collaboration invitation");
    }
  });

  /** Pairing step two: persist the local↔remote repo mapping and publish immediately. */
  app.post("/api/collaborations", async (c) => {
    const p = await parseBody(c, CollaborationJoinSchema);
    if (!p.ok) return p.res;
    if (!cfg.oauth?.ownerSub && !cfg.oauth?.ownerEmail) {
      return jsonError(c, "NEEDS_OWNER", "sign in with Connections before joining a collaboration");
    }
    try {
      const link = await joinCollaboration(
        cfg,
        p.data.inviteUrl,
        p.data.localRepoId,
        p.data.remoteRepoId,
      );
      return c.json({ ok: true, link: publicLink(link) });
    } catch (e) {
      return jsonError(c, "BAD_REQUEST", e instanceof Error ? e.message : "could not join collaboration");
    }
  });

  app.get("/api/collaboration-links", (c) => {
    return c.json({ links: listCollaborationLinks().map(publicLink) });
  });

  /** Opaque activity digest used by an accepted peer's ten-minute MCP safety check. */
  app.get("/api/repos/:id/collaboration-fingerprint", async (c) => {
    const share = effectiveGuest(c, cfg);
    if (share && !share.collaborative) {
      return jsonError(c, "FORBIDDEN", "live collaboration is disabled for this link", 403);
    }
    try {
      return c.json(await collaborationFingerprint(c.req.param("id")));
    } catch (e) {
      return jsonError(c, "BAD_REQUEST", e instanceof Error ? e.message : "could not fingerprint collaboration");
    }
  });

  /** Read the sharer's mapped checkout using the retained invitation without exposing its token. */
  app.get("/api/collaboration-links/:id/status", async (c) => {
    try {
      return c.json(await readAcceptedCollaborationStatus(c.req.param("id")));
    } catch (e) {
      return jsonError(c, "BAD_REQUEST", e instanceof Error ? e.message : "could not read collaboration");
    }
  });

  app.get("/api/collaboration-links/:id/diff", async (c) => {
    try {
      return c.json(
        await readAcceptedCollaborationDiff(
          c.req.param("id"),
          c.req.query("path") ?? "",
        ),
      );
    } catch (e) {
      return jsonError(c, "BAD_REQUEST", e instanceof Error ? e.message : "could not read collaboration diff");
    }
  });

  /**
   * MCP-oriented remote commit+sync. Owner-only locally, control-tier remotely, and additionally
   * guarded by the ten-minute unchanged-state rule inside collaboration.ts.
   */
  app.post("/api/collaboration-links/:id/commit-sync", async (c) => {
    const p = await parseBody(c, CollaborationCommitSyncSchema);
    if (!p.ok) return p.res;
    try {
      return c.json(
        await commitAndSyncAcceptedCollaboration(c.req.param("id"), p.data.message),
      );
    } catch (e) {
      return jsonError(c, "BAD_REQUEST", e instanceof Error ? e.message : "could not commit collaboration");
    }
  });

  app.post("/api/collaborations/publish", async (c) => {
    await publishAllCollaborations();
    return c.json({ ok: true });
  });

  app.delete("/api/collaborations/:id", (c) => {
    if (!deleteCollaborationLink(c.req.param("id"))) {
      return jsonError(c, "NOT_FOUND", "no such collaboration");
    }
    return c.json({ ok: true });
  });
}
