/**
 * Share links: the owner's admin API, plus the public redemption endpoint.
 *
 * `/api/shares/*` sits under `/api/*`, so the auth middleware owner-gates it for free — and
 * share/policy.ts additionally names every route here as owner-only, because a guest who could
 * mint a link would be a privilege-escalation path straight out of their own sandbox.
 *
 * `GET /s/:token` is the one exception in the whole daemon: a route that must be reachable with no
 * session at all, because redeeming the link is how a guest gets a credential in the first place.
 * It is mounted OUTSIDE `/api/*` (so the gate never sees it) and BEFORE the static PWA catch-all
 * (so `/s/...` isn't swallowed by the SPA fallback).
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import type { RepoYetiConfig } from "../../config.ts";
import { jsonError } from "../../contract.ts";
import { publicShareOrigin, shareLinkFor } from "../../runtime.ts";
import { parseBody, ShareCreateSchema, ShareUpdateSchema } from "../../schemas.ts";
import {
  createShare,
  updateShare,
  rotateShareToken,
  listShares,
  revokeShare,
  getShare,
  shareRepoIds,
  listShareEvents,
  getRepo,
  type Share,
} from "../../db.ts";
import {
  mintToken,
  hashToken,
  redeemToken,
  setGuestCookie,
  shareIsLive,
  expiryFor,
  isStaleOrigin,
} from "../../share/index.ts";

/**
 * A share as the owner's Sharing panel sees it.
 *
 * It now carries `url`, which it deliberately did not before: the plaintext used to be
 * unrecoverable (only its sha256 was stored), so the panel could show a link exactly once, at
 * creation, and had nothing to offer afterwards but "re-key and re-send". Links minted from now on
 * retain their secret (see Share.token in src/db.ts for what that costs), so the panel can just
 * hand the owner their link back. This route is owner-only, both via the auth middleware and by
 * name in share/policy.ts, so the field is never reachable by a guest.
 */
interface ShareDto {
  id: string;
  label: string;
  perm: "view" | "control";
  /** The holder may pair another RepoYeti and publish an encrypted peer working-tree view. */
  collaborative: boolean;
  scopeAll: boolean;
  repoIds: string[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  /** False once expired — the panel greys these out and offers cleanup. */
  live: boolean;
  /** The public origin this link was handed out on, or null if it predates the record. */
  origin: string | null;
  /**
   * True when this link's URL points at an origin the daemon is no longer reachable at — i.e.
   * the recipient now gets a DNS failure. Computed here rather than in the client so there is
   * one definition of "stale", and only when we actually know our current origin (with no tunnel
   * up we cannot tell the difference between "moved" and "not published yet").
   *
   * Compared against publicShareOrigin(), NOT the raw tunnel URL: with the relay on, links are
   * handed out on a permanent address that a tunnel restart does not move, so measuring them
   * against the rotating hostname would flag every healthy link as broken. Links minted before
   * the relay was switched on still compare unequal — and those genuinely are dead.
   */
  stale: boolean;
  /**
   * The link itself, ready to copy, or null for one minted before the secret was retained (and for
   * any revoked link, whose secret is cleared).
   *
   * Assembled against the CURRENT address rather than reproducing the URL as it was handed out.
   * That is the useful answer, and it is what makes `stale` actionable instead of merely sad: for a
   * link whose origin moved, the copy is a WORKING url the owner can re-send, while `stale` stays
   * true to say the one already in the recipient's inbox is dead.
   */
  url: string | null;
}

function toDto(cfg: RepoYetiConfig, s: Share, fallbackOrigin: string): ShareDto {
  const liveOrigin = publicShareOrigin(cfg);
  return {
    id: s.id,
    label: s.label,
    perm: s.perm,
    collaborative: s.collaborative,
    scopeAll: s.scopeAll,
    repoIds: s.scopeAll ? [] : shareRepoIds(s.id),
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    lastUsedAt: s.lastUsedAt,
    useCount: s.useCount,
    live: shareIsLive(s),
    origin: s.origin,
    stale: isStaleOrigin(s.origin, liveOrigin),
    url: s.token ? shareLinkFor(cfg, s.token, fallbackOrigin) : null,
  };
}

/** The "this link is no longer valid" page. Deliberately says nothing about WHY. */
function deadLinkPage(): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RepoYeti — link unavailable</title>
<body style="margin:0;background:#0e0e12;color:#e6e6ea;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<div style="max-width:340px;text-align:center;padding:24px">
<div style="font-size:40px">🔗</div>
<h2 style="margin:12px 0 8px">This link isn't available</h2>
<p style="color:#9a9aa6;font-size:14px;line-height:1.5">It may have expired or been turned off. Ask whoever shared it for a new one.</p>
</div></body>`;
}

export function register(app: Hono, { cfg }: Deps): void {
  // ── owner: list / create / revoke ────────────────────────────────────────────
  app.get("/api/shares", (c) => {
    // The panel gets each link back, ready to copy. Assembling it needs an origin to fall back
    // on when no tunnel/relay address is published, and the request we are answering IS that
    // address: this route is owner-only and in practice reached on loopback.
    const origin = new URL(c.req.url).origin;
    return c.json({ shares: listShares().map((s) => toDto(cfg, s, origin)) });
  });

  app.post("/api/shares", async (c) => {
    const p = await parseBody(c, ShareCreateSchema);
    if (!p.ok) return p.res;
    const { label, perm, collaborative, duration, scopeAll, repoIds } = p.data;

    // A scoped link naming no repos would grant nothing and read as broken; refuse it loudly
    // rather than mint a dead link. (scopeAll is the way to say "everything".)
    if (!scopeAll && repoIds.length === 0) {
      return jsonError(c, "BAD_REQUEST", "pick at least one repository, or share all of them");
    }
    // Never mint a grant for a repo that doesn't exist — it would be silently inert, and the
    // owner would think they'd shared something they hadn't.
    const unknown = scopeAll ? [] : repoIds.filter((id) => !getRepo(id));
    if (unknown.length > 0) return jsonError(c, "NOT_FOUND", "unknown repository in the share list");

    const token = mintToken();
    const share = createShare(hashToken(token), {
      label,
      perm,
      collaborative,
      scopeAll,
      repoIds,
      expiresAt: expiryFor(duration),
      // Remember where this link will be handed out, so we can tell later that the address moved.
      origin: publicShareOrigin(cfg),
      // ...and the secret itself, so the panel can offer Copy link on this row later instead of
      // only in the one-shot panel below. See Share.token in src/db.ts.
      token,
    });
    // `url` is assembled server-side because the relay form puts the token in the URL fragment
    // rather than the path (see shareLinkFor) — a distinction the browser should not have to
    // re-derive, since getting it wrong would send the secret to the relay.
    return c.json({
      ok: true,
      share: toDto(cfg, share, new URL(c.req.url).origin),
      token,
      url: shareLinkFor(cfg, token, new URL(c.req.url).origin),
    });
  });

  // Edit a live grant WITHOUT touching its secret: the link already in someone's inbox keeps
  // working and just means something different. Narrowing repos or shortening an expiry should
  // never force the owner to revoke and re-send.
  app.patch("/api/shares/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "NOT_FOUND", "no such share link");
    const p = await parseBody(c, ShareUpdateSchema);
    if (!p.ok) return p.res;
    const { label, perm, collaborative, duration, scopeAll, repoIds } = p.data;

    const current = getShare(id);
    if (!current || current.revokedAt !== null) {
      return jsonError(c, "NOT_FOUND", "no such share link");
    }

    // Same two guards the create path uses, against the state this edit would RESULT in — a
    // patch that only flips scopeAll off must not leave a link granting nothing.
    const nextScopeAll = scopeAll ?? current.scopeAll;
    const nextRepoIds = repoIds ?? (nextScopeAll ? [] : shareRepoIds(id));
    if (!nextScopeAll && nextRepoIds.length === 0) {
      return jsonError(c, "BAD_REQUEST", "pick at least one repository, or share all of them");
    }
    const unknown = nextScopeAll ? [] : nextRepoIds.filter((rid) => !getRepo(rid));
    if (unknown.length > 0) return jsonError(c, "NOT_FOUND", "unknown repository in the share list");

    const updated = updateShare(id, {
      ...(label === undefined ? {} : { label }),
      ...(perm === undefined ? {} : { perm }),
      ...(collaborative === undefined ? {} : { collaborative }),
      scopeAll: nextScopeAll,
      repoIds: nextRepoIds,
      // Only re-base the expiry when the caller actually said something about duration.
      ...(duration === undefined ? {} : { expiresAt: expiryFor(duration) }),
    });
    if (!updated) return jsonError(c, "NOT_FOUND", "no such share link");
    return c.json({ ok: true, share: toDto(cfg, updated, new URL(c.req.url).origin) });
  });

  // Mint a NEW secret for an existing grant. This is a deliberate re-key, and for legacy rows
  // whose plaintext predates retention it is also the only way to gain a copyable URL. Either way
  // it kills the previous URL, which the UI states before it happens.
  app.post("/api/shares/:id/rotate", (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "NOT_FOUND", "no such share link");
    const token = mintToken();
    const share = rotateShareToken(id, {
      tokenHash: hashToken(token),
      token,
      origin: publicShareOrigin(cfg),
    });
    if (!share) return jsonError(c, "NOT_FOUND", "no such share link");
    // Re-keying is also how a pre-existing link (minted before secrets were retained, so with no
    // Copy button) gains one: the row comes back carrying the new secret.
    return c.json({
      ok: true,
      share: toDto(cfg, share, new URL(c.req.url).origin),
      token,
      url: shareLinkFor(cfg, token, new URL(c.req.url).origin),
    });
  });

  app.delete("/api/shares/:id", (c) => {
    const id = c.req.param("id");
    if (!id || !revokeShare(id)) return jsonError(c, "NOT_FOUND", "no such share link");
    return c.json({ ok: true });
  });

  // The audit trail: what this link's holder actually did. The only place that can answer it —
  // a guest's commits are authored as the owner, so git history cannot.
  app.get("/api/shares/:id/events", (c) => {
    const id = c.req.param("id");
    if (!id || !getShare(id)) return jsonError(c, "NOT_FOUND", "no such share link");
    return c.json({ events: listShareEvents(id) });
  });

  // ── guest: redeem ────────────────────────────────────────────────────────────
  // Mounted outside /api/* (the auth gate never sees it) — this IS the way in.
  app.get("/s/:token", (c) => {
    const share = redeemToken(c.req.param("token") ?? "");
    // Unknown, revoked, and expired are one answer on purpose: distinguishing them would confirm
    // to a stranger that a given link once existed.
    if (!share) return c.html(deadLinkPage(), 404);
    // Secure only over https — a loopback redemption (http://127.0.0.1) must still set a cookie.
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ?? new URL(c.req.url).protocol.replace(":", "");
    setGuestCookie(c, share, proto === "https");
    // Redirect so the secret leaves the address bar immediately: from here on the signed cookie
    // is the credential, and the token never rides another request (Referer, logs, history).
    return c.redirect("/");
  });
}
