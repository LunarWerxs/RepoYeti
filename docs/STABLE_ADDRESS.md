# Choose your RepoYeti address

Remote access starts a Cloudflare tunnel to the RepoYeti daemon. Settings → Accounts → Access
offers three explicit address choices.

## RepoYeti address (default)

This is the zero-input option. RepoYeti registers the current quick-tunnel destination behind one
stable URL:

```text
https://app.repoyeti.com/r/<your-daemon-id>
```

The URL survives daemon restarts even though Cloudflare changes the underlying
`*.trycloudflare.com` hostname. The hosted service redirects visitors; it does not proxy dashboard
traffic. Share secrets remain in the URL fragment, which browsers do not send to the redirect
service.

The older `https://go.repoyeti.com` hostname remains active for links issued by earlier releases.

## Cloudflare address

This exposes the generated quick-tunnel URL directly:

```text
https://random-words.trycloudflare.com
```

It needs no account or domain, but it changes when RepoYeti restarts. Existing share links and
bookmarks that contain the old address then stop working. Choose this when you specifically prefer
Cloudflare's temporary address over RepoYeti's stable front door.

This choice changes the address shown to visitors, not the OAuth registration. RepoYeti still
announces the current tunnel to `app.repoyeti.com` once at startup so the registered callback can
return `code` and `state` to `/oauth/finish`. The hosted service does not proxy the dashboard or
implicitly enable the stable RepoYeti address.

If the startup announcement is rejected temporarily—for example because the host clock has just
been corrected—RepoYeti retries after 1, 3, and 10 seconds. The sign-in page remains unavailable
during those retries and recommends restarting only if every attempt fails.

## Custom domain

If you own a domain on Cloudflare, a named tunnel serves RepoYeti at a hostname you control, such
as `yeti.example.com`. This is stable and skips RepoYeti's hosted redirect.

1. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com/), open **Networks → Tunnels** and
   create a Cloudflared tunnel.
2. Copy the connector token from its setup instructions. RepoYeti runs the connector, so do not
   install it as a separate service.
3. Add a **Public Hostname** to the tunnel. Point it to HTTP on `localhost:7171`, or the port shown
   by your RepoYeti installation.
4. In RepoYeti, choose **Your domain**, enter the hostname and connector token, and save.

The connector token is write-only in the UI. The daemon reports only whether a token is present.
Switching back to the RepoYeti or Cloudflare address clears the named-tunnel configuration.

## Comparison

| Choice | Setup | Stable after restart | Public address |
| --- | --- | --- | --- |
| RepoYeti address | None | Yes | `app.repoyeti.com/r/<id>` |
| Cloudflare address | None | No | `*.trycloudflare.com` |
| Your domain | Cloudflare domain + token | Yes | Hostname you choose |

The relay implementation and its trust model are documented in
[relay/README.md](../relay/README.md).
