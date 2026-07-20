# Your stable address

When remote access is on, RepoYeti serves your dashboard over a Cloudflare **quick tunnel** — a
random `*.trycloudflare.com` hostname that changes every time the daemon restarts. Anything that
embeds your address (share links, a phone bookmark, a QR code you printed) would quietly break on
every restart.

The **stable address** solves that. You have two options, and the first one needs zero setup.

## Option 1 — the built-in forwarding address (default)

Out of the box, RepoYeti registers with a small hosted relay and gets one URL per daemon that
never changes:

```
https://go.repoyeti.com/r/<your-daemon-id>
```

That URL forwards visitors to wherever your daemon currently lives. It is **not a proxy**: no
repository data passes through it, and share tokens travel in the URL fragment, which browsers
never transmit — the relay can't see or redeem your links (see [relay/README.md](../relay/README.md)
for the full design and trust model). The only thing published is your daemon's current tunnel
address.

There is nothing to configure. Settings → Accounts → Access shows the address with a copy button.

If you'd rather run your own relay (it's a single Cloudflare Worker), deploy it per
[relay/README.md](../relay/README.md) and point "Use a different relay" at it.

## Option 2 — a custom address (your own domain)

If you own a domain on Cloudflare, you can skip the relay entirely and serve RepoYeti at a
hostname you control (like `app.example.com`). This uses a Cloudflare **named tunnel**: your
daemon holds a connector token, Cloudflare routes the hostname to it, and the address resolves on
any network — including ones that block `trycloudflare.com`.

You'll need: a domain added to Cloudflare (the free plan is fine).

1. **Create the tunnel.** In the [Cloudflare dashboard](https://one.dash.cloudflare.com/), go to
   **Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared type). Name it anything
   (e.g. `repoyeti`).
2. **Copy the connector token.** The setup page shows install commands containing a long token
   (the string after `cloudflared service install …`). Copy that token — RepoYeti runs the
   connector for you, so you do **not** need to install cloudflared or run those commands.
3. **Route your hostname.** Still in the tunnel's settings, add a **Public Hostname**:
   pick the subdomain + domain you want (e.g. `app.example.com`), type **HTTP**, and URL
   `localhost:7171` (or whatever port your daemon runs on — shown in Settings and on startup).
4. **Tell RepoYeti.** Settings → Accounts → Access → turn on **Custom address**, enter the
   hostname and paste the connector token, then Save. The status line shows
   `Stable address active: app.example.com` once the tunnel connects.

That's it. Share links and the phone QR now use your domain, and the built-in forwarding address
steps aside automatically (a custom domain makes the relay hop pointless).

**Removing it later:** flip Custom address off and confirm — RepoYeti falls back to the built-in
forwarding address. Note that links minted on your domain die when the domain stops routing.

## Which one should I use?

| | Built-in (default) | Custom domain |
| --- | --- | --- |
| Setup | none | ~5 minutes, needs a Cloudflare domain |
| Link looks like | `go.repoyeti.com/r/<id>` | `app.your-domain.com` |
| Survives restarts | yes | yes |
| Works where trycloudflare is blocked | no (the destination is still a quick tunnel) | yes |
| Third party involved | the relay (sees only your current address) | none beyond Cloudflare itself |
