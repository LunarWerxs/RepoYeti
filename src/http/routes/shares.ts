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
import { jsonError } from "../../contract.ts";
import { parseBody, ShareCreateSchema } from "../../schemas.ts";
import {
  createShare,
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
} from "../../share/index.ts";

/**
 * A share as the owner's Sharing panel sees it. There is no token field, at any point after mint —
 * the plaintext is unrecoverable by design (only its sha256 was stored), so the panel shows a link
 * exactly once, at creation, and offers "revoke + make a new one" forever after.
 */
interface ShareDto {
  id: string;
  label: string;
  perm: "view" | "control";
  scopeAll: boolean;
  repoIds: string[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  /** False once expired — the panel greys these out and offers cleanup. */
  live: boolean;
}

function toDto(s: Share): ShareDto {
  return {
    id: s.id,
    label: s.label,
    perm: s.perm,
    scopeAll: s.scopeAll,
    repoIds: s.scopeAll ? [] : shareRepoIds(s.id),
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    lastUsedAt: s.lastUsedAt,
    useCount: s.useCount,
    live: shareIsLive(s),
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

export function register(app: Hono, _deps: Deps): void {
  // ── owner: list / create / revoke ────────────────────────────────────────────
  app.get("/api/shares", (c) => c.json({ shares: listShares().map(toDto) }));

  app.post("/api/shares", async (c) => {
    const p = await parseBody(c, ShareCreateSchema);
    if (!p.ok) return p.res;
    const { label, perm, duration, scopeAll, repoIds } = p.data;

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
      scopeAll,
      repoIds,
      expiresAt: expiryFor(duration),
    });
    // The ONLY response that ever carries the token. Everything else returns the DTO.
    return c.json({ ok: true, share: toDto(share), token });
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
