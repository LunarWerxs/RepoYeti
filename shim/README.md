# RepoYeti OAuth redirect shim — ⚠️ RETIRED (dead reference code)

> **This shim is no longer used and is not deployed.** Once RepoYeti moved to a stable domain
> (`app.repoyeti.com` via a named Cloudflare tunnel), the rotating-URL problem this Worker solved
> went away. Login now uses the daemon's **own** `<origin>/oauth/callback` directly — see
> [`src/auth.ts`](../src/auth.ts) and [`docs/REMOTE_ACCESS.md`](../docs/REMOTE_ACCESS.md). The old
> `gitmob-auth`/`repoyeti-auth` Workers were deleted from Cloudflare. This directory is kept only as
> historical reference for the rotating-tunnel pattern below; nothing in the running product calls it.

A ~50-line Cloudflare Worker that *was* the **stable OAuth redirect URL** for "Sign in
with Connections", so the daemon could stay on a free, rotating quick-tunnel URL.

It received `GET /cb?code&state`, read the daemon's current origin out of the signed
`state`, validated it against an allowed host list, and `302`d the login back to
`<daemon-origin>/oauth/finish`. The `code` is PKCE-bound and single-use, so the shim
never saw a usable credential.

## Deploy (free)

```sh
cd shim
bunx wrangler login          # one-time
bunx wrangler deploy         # → https://repoyeti-auth.<your-account>.workers.dev
```

Then, in the RepoYeti app you register at `studio.connections.icu`:

- **Redirect URI** → `https://repoyeti-auth.<your-account>.workers.dev/cb`

And in the daemon's `~/.repoyeti/config.json`:

```jsonc
"oauth": {
  "issuer": "https://accounts.connections.icu",
  "clientId": "<your app client id>",
  "redirectUri": "https://repoyeti-auth.<your-account>.workers.dev/cb",
  "ownerSub": "<your Connections sub>"   // or "ownerEmail": "you@example.com"
}
```

## Allowing a named tunnel

`wrangler.toml` now allows both `*.trycloudflare.com` (quick tunnel) and `*.repoyeti.com`
(the named tunnel's stable host, e.g. `app.repoyeti.com`) — so after a `bunx wrangler deploy`
the shim will bounce logins to either. To allow a different named-tunnel domain, add its host
suffix to `ALLOWED_SUFFIXES` and redeploy:

```sh
bunx wrangler deploy --var ALLOWED_SUFFIXES:".trycloudflare.com,.repoyeti.com,.your-domain.com"
```

Configure the named tunnel on the daemon side via `~/.repoyeti/config.json`:

```jsonc
"tunnel": {
  "hostname": "app.repoyeti.com",   // the Cloudflare tunnel's public hostname
  "token": "<cloudflared connector token>"   // kept in the OS keychain, stripped from disk
}
```

The token may instead be supplied via the `CF_TUNNEL_TOKEN` env var (never written to disk).

## Not Cloudflare?

The same ~50 lines work as a Cloudflare **Pages Function** or any tiny static host with
a redirect — the contract is just: read `state` → validate origin → 302 to
`<origin>/oauth/finish?code&state`.
