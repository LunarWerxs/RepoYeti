import type { Context, Hono } from "hono";
import type { BlankEnv } from "hono/types";
import { bodyLimit } from "hono/body-limit";
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

/**
 * Collaborator → owner presence ingress. This deliberately sits outside /api/*: it is
 * authenticated by the live collaborative share token, while every /api/collaborations route
 * below remains owner-only. No repo mutation is reachable from this endpoint.
 */
async function postCollaborationSnapshot(c: Context<BlankEnv, "/c/:channel/:participant">) {
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
}

/** Live peer snapshots for the owner's dashboard. The relay failure mode is an empty list. */
function getCollaborations(c: Context) {
  const snapshots = readCollaborationSnapshots();
  return c.json({ snapshots });
}

/** Pairing step one: inspect a pasted invitation and return its scoped remote repo choices. */
async function postCollaborationsInspect(c: Context) {
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
}

/** Pairing step two: persist the local↔remote repo mapping and publish immediately. */
async function postCollaborations(c: Context, cfg: Deps["cfg"]) {
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
}

function getCollaborationLinks(c: Context) {
  return c.json({ links: listCollaborationLinks().map(publicLink) });
}

/** Opaque activity digest used by an accepted peer's ten-minute MCP safety check. */
async function getCollaborationFingerprint(
  c: Context<BlankEnv, "/api/repos/:id/collaboration-fingerprint">,
  cfg: Deps["cfg"],
) {
  const share = effectiveGuest(c, cfg);
  if (share && !share.collaborative) {
    return jsonError(c, "FORBIDDEN", "live collaboration is disabled for this link", 403);
  }
  try {
    return c.json(await collaborationFingerprint(c.req.param("id")));
  } catch (e) {
    return jsonError(c, "BAD_REQUEST", e instanceof Error ? e.message : "could not fingerprint collaboration");
  }
}

/** Read the sharer's mapped checkout using the retained invitation without exposing its token. */
async function getCollaborationLinkStatus(c: Context<BlankEnv, "/api/collaboration-links/:id/status">) {
  try {
    return c.json(await readAcceptedCollaborationStatus(c.req.param("id")));
  } catch (e) {
    return jsonError(c, "BAD_REQUEST", e instanceof Error ? e.message : "could not read collaboration");
  }
}

async function getCollaborationLinkDiff(c: Context<BlankEnv, "/api/collaboration-links/:id/diff">) {
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
}

/**
 * MCP-oriented remote commit+sync. Owner-only locally, control-tier remotely, and additionally
 * guarded by the ten-minute unchanged-state rule inside collaboration.ts.
 */
async function postCollaborationLinkCommitSync(c: Context<BlankEnv, "/api/collaboration-links/:id/commit-sync">) {
  const p = await parseBody(c, CollaborationCommitSyncSchema);
  if (!p.ok) return p.res;
  try {
    return c.json(
      await commitAndSyncAcceptedCollaboration(c.req.param("id"), p.data.message),
    );
  } catch (e) {
    return jsonError(c, "BAD_REQUEST", e instanceof Error ? e.message : "could not commit collaboration");
  }
}

async function postCollaborationsPublish(c: Context) {
  await publishAllCollaborations();
  return c.json({ ok: true });
}

function deleteCollaboration(c: Context<BlankEnv, "/api/collaborations/:id">) {
  if (!deleteCollaborationLink(c.req.param("id"))) {
    return jsonError(c, "NOT_FOUND", "no such collaboration");
  }
  return c.json({ ok: true });
}

export function register(app: Hono, { cfg }: Deps): void {
  app.post(
    "/c/:channel/:participant",
    bodyLimit({
      maxSize: 360_000,
      onError: (c) => c.json({ ok: false }, 413),
    }),
    postCollaborationSnapshot,
  );

  app.get("/api/collaborations", getCollaborations);
  app.post("/api/collaborations/inspect", postCollaborationsInspect);
  app.post("/api/collaborations", (c) => postCollaborations(c, cfg));
  app.get("/api/collaboration-links", getCollaborationLinks);
  app.get("/api/repos/:id/collaboration-fingerprint", (c) => getCollaborationFingerprint(c, cfg));
  app.get("/api/collaboration-links/:id/status", getCollaborationLinkStatus);
  app.get("/api/collaboration-links/:id/diff", getCollaborationLinkDiff);
  app.post("/api/collaboration-links/:id/commit-sync", postCollaborationLinkCommitSync);
  app.post("/api/collaborations/publish", postCollaborationsPublish);
  app.delete("/api/collaborations/:id", deleteCollaboration);
}
