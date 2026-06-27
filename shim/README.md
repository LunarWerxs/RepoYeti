# GitMob OAuth redirect shim

A ~50-line Cloudflare Worker that is the **stable OAuth redirect URL** for "Sign in
with Connections", so the daemon can stay on a free, rotating quick-tunnel URL.

It receives `GET /cb?code&state`, reads the daemon's current origin out of the signed
`state`, validates it against an allowed host list, and `302`s the login back to
`<daemon-origin>/oauth/finish`. The `code` is PKCE-bound and single-use, so the shim
never sees a usable credential. See [`../MARCHING_ORDERS.md`](../MARCHING_ORDERS.md) §7.

## Deploy (free)

```sh
cd shim
bunx wrangler login          # one-time
bunx wrangler deploy         # → https://gitmob-auth.<your-account>.workers.dev
```

Then, in the GitMob app you register at `studio.connections.icu`:

- **Redirect URI** → `https://gitmob-auth.<your-account>.workers.dev/cb`

And in the daemon's `~/.gitmob/config.json`:

```jsonc
"oauth": {
  "issuer": "https://accounts.connections.icu",
  "clientId": "<your app client id>",
  "redirectUri": "https://gitmob-auth.<your-account>.workers.dev/cb",
  "ownerSub": "<your Connections sub>"   // or "ownerEmail": "you@example.com"
}
```

## Allowing a named tunnel

The default only bounces to `*.trycloudflare.com` (and loopback). If you move to a
stable/named tunnel later, add its host suffix:

```sh
bunx wrangler deploy --var ALLOWED_SUFFIXES:".trycloudflare.com,.your-domain.com"
```

## Not Cloudflare?

The same ~50 lines work as a Cloudflare **Pages Function** or any tiny static host with
a redirect — the contract is just: read `state` → validate origin → 302 to
`<origin>/oauth/finish?code&state`.
