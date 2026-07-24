/**
 * RepoYeti relay — a stable front door for a daemon whose address keeps moving.
 *
 * WHAT PROBLEM THIS SOLVES
 * A zero-config `cloudflared` quick tunnel hands out a fresh random
 * `*.trycloudflare.com` hostname on every start. Share links embed whatever the address was when
 * they were minted, so restarting the daemon silently kills every link already sent — the
 * recipient gets a DNS failure that reads as "your link is wrong". This gives each daemon one
 * permanent URL that forwards to wherever it currently lives.
 *
 * WHAT THIS IS NOT
 * It is NOT a tunnel and NOT a proxy. No repository data passes through it. It stores one row per
 * daemon — an id, a public key, and the current origin — and answers with a redirect. That is the
 * entire product, and it is deliberately the smallest thing that fixes the problem: proxying
 * everyone's traffic would make the operator of this Worker the custodian of other people's source
 * code, which is the opposite of what RepoYeti promises.
 *
 * WHY THE SHARE TOKEN NEVER REACHES THIS SERVICE
 * A share URL is `https://<relay>/r/<daemonId>#/s/<token>`. Everything after `#` is a URL FRAGMENT,
 * which browsers do not transmit — it never appears in a request line, a log, or a KV value. The
 * relay answers with a tiny page that reads the fragment client-side and re-navigates to
 * `<currentOrigin>/s/<token>`. So the relay learns that someone opened *a* link for a daemon, and
 * cannot learn the secret or redeem it. That property is structural, not a promise about logging.
 *
 * TRUST MODEL — trust on first use, then signatures.
 * The first `/announce` for an id registers its Ed25519 public key. Every later announce for that
 * id must carry a signature verifiable against the stored key, so only the daemon holding the
 * private key can move its own address. Without this, anyone could repoint someone else's link at
 * their own server, which turns a convenience feature into a phishing kit. Ids are 128-bit random,
 * so squatting an id you don't own is not a practical attack.
 *
 * DEPLOY: see relay/README.md. Needs one KV namespace bound as RELAY.
 */

const ID_RE = /^[a-z0-9]{16,64}$/i;
/** Reject an announce whose timestamp is far from ours — a captured one can't be replayed later. */
const MAX_SKEW_MS = 5 * 60 * 1000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Canonical bytes that get signed. Field order is fixed here and in the daemon; a mismatch just
 *  fails verification, which is the safe direction. */
function signedPayload({ id, origin, ts }) {
  return new TextEncoder().encode(`${id}\n${origin}\n${ts}`);
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

async function verify(publicKeyB64, signatureB64, payload) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64urlToBytes(publicKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, b64urlToBytes(signatureB64), payload);
  } catch {
    return false;
  }
}

/** Only ever redirect to a real https origin — never a path, never javascript:, never http. */
function safeOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The forwarding page. Deliberately server-rendered HTML with the origin baked in, rather than a
 * 302: a 302 would drop the fragment handling into the browser's hands before we can read it, and
 * we want the token to stay client-side. `replace` keeps the relay out of the back-button history.
 */
function forwardPage(origin) {
  const safe = origin.replace(/[<>"']/g, "");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening…</title>
<body style="margin:0;background:#0e0e12;color:#e6e6ea;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<div style="text-align:center;padding:24px">
<p style="color:#9a9aa6;font-size:14px">Opening…</p>
<noscript><p style="color:#9a9aa6;font-size:13px">This link needs JavaScript to finish opening.</p></noscript>
</div>
<script>
  // The part after '#' never left this browser. Re-attach it to the daemon's current address.
  var target = ${JSON.stringify(safe)};
  var rest = location.hash ? location.hash.slice(1) : "/";
  if (rest.charAt(0) !== "/") rest = "/" + rest;   // only ever a path on the target
  location.replace(target + rest);
</script>
</body>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── the daemon publishes where it currently lives ──────────────────────────
    if (url.pathname === "/announce" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "bad json" }, 400);
      }
      const { id, origin, ts, publicKey } = body ?? {};
      if (!ID_RE.test(String(id ?? ""))) return json({ ok: false, error: "bad id" }, 400);

      const cleanOrigin = safeOrigin(String(origin ?? ""));
      if (!cleanOrigin) return json({ ok: false, error: "origin must be an https URL" }, 400);

      const when = Number(ts);
      if (!Number.isFinite(when) || Math.abs(Date.now() - when) > MAX_SKEW_MS) {
        return json({ ok: false, error: "stale timestamp" }, 400);
      }

      const signature = request.headers.get("x-signature") ?? "";
      if (!signature) return json({ ok: false, error: "missing signature" }, 401);

      const existingRaw = await env.RELAY.get(`d:${id}`);
      const existing = existingRaw ? JSON.parse(existingRaw) : null;
      // First announce registers the key; after that the stored one is authoritative, so a later
      // caller cannot hand us a key of their own choosing and take over the id.
      const key = existing?.publicKey ?? String(publicKey ?? "");
      if (!key) return json({ ok: false, error: "first announce must include publicKey" }, 400);

      if (!(await verify(key, signature, signedPayload({ id, origin: cleanOrigin, ts: when })))) {
        return json({ ok: false, error: "bad signature" }, 401);
      }

      await env.RELAY.put(
        `d:${id}`,
        JSON.stringify({ publicKey: key, origin: cleanOrigin, updatedAt: Date.now() }),
      );
      return json({ ok: true, url: `${url.origin}/r/${id}` });
    }

    // ── resolve a daemon for another RepoYeti installation ─────────────────────
    // The normal /r/:id page necessarily reveals this origin to the visitor's browser. This JSON
    // form exposes nothing additional; it lets a peer daemon redeem the same invitation without
    // executing the fragment-forwarding page.
    if (url.pathname.startsWith("/resolve/") && request.method === "GET") {
      const id = url.pathname.split("/")[2] ?? "";
      if (!ID_RE.test(id)) return json({ ok: false, error: "not found" }, 404);
      const raw = await env.RELAY.get(`d:${id}`);
      if (!raw) return json({ ok: false, error: "not found" }, 404);
      const target = safeOrigin(JSON.parse(raw).origin);
      if (!target) return json({ ok: false, error: "not found" }, 404);
      return json({ ok: true, origin: target });
    }

    // ── someone opens a link ──────────────────────────────────────────────────
    if (url.pathname.startsWith("/r/")) {
      const [, , id, ...rest] = url.pathname.split("/");
      if (!ID_RE.test(id ?? "")) return new Response("Not found", { status: 404 });

      const raw = await env.RELAY.get(`d:${id}`);
      if (!raw) return new Response(unknownPage(), { status: 404, headers: html() });
      const { origin } = JSON.parse(raw);
      const target = safeOrigin(origin);
      if (!target) return new Response(unknownPage(), { status: 404, headers: html() });

      // A path after the id (no fragment involved) is a plain redirect — used for "just open my
      // dashboard" links, which carry no secret.
      if (rest.length > 0 && rest.join("/") !== "") {
        return Response.redirect(`${target}/${rest.join("/")}${url.search}`, 302);
      }
      return new Response(forwardPage(target), { headers: html() });
    }

    if (url.pathname === "/health") return json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
};

const html = () => ({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });

function unknownPage() {
  return `<!doctype html><meta charset="utf-8"><title>RepoYeti — link unavailable</title>
<body style="margin:0;background:#0e0e12;color:#e6e6ea;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<div style="max-width:340px;text-align:center;padding:24px">
<div style="font-size:40px">🔗</div>
<h2 style="margin:12px 0 8px">This link isn't available</h2>
<p style="color:#9a9aa6;font-size:14px;line-height:1.5">The computer it points at hasn't checked in. Ask whoever shared it to open RepoYeti and try again.</p>
</div></body>`;
}
