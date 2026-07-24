# RepoYeti relay

A permanent front door for a daemon whose address keeps moving.

## The problem it solves

RepoYeti's zero-config remote access uses a Cloudflare **quick tunnel**, which is handed a fresh
random `*.trycloudflare.com` hostname every time it starts. Share links embed whatever the address
was when they were minted, so restarting the daemon silently kills every link already sent. The
person you sent it to gets a DNS failure that reads as *"your link is wrong"* rather than *"the
address moved"* — and you only find out when they tell you.

The relay gives each daemon one URL that never changes and forwards to wherever it currently lives.

## What it is not

**Not a tunnel, and not a proxy.** Dashboard and Git traffic still goes directly from the visitor
to the daemon's own tunnel. The stable-address path stores one row per daemon—an id, a public key,
and the current origin—and answers with a redirect.

This distinction is the whole design. Proxying everyone's traffic would make whoever runs this
Worker the custodian of other people's source code, which is the opposite of what RepoYeti promises
on its front page.

Optional collaboration presence does not use KV. The collaborator resolves the invitation once,
then sends authenticated AES-256-GCM snapshots straight to the owner's tunnel. If a quick tunnel
moves, `/resolve/:id` supplies its new origin. This keeps realtime updates out of the relay's
storage and request budget.

## Why the relay never sees a share token

A share URL looks like:

```
https://go.example.com/r/<daemonId>#/s/<token>
```

Everything after `#` is a **URL fragment**, which browsers do not transmit. It never appears in a
request line, an access log, or a KV value. The relay answers with a small page that reads the
fragment in the browser and re-navigates to `<currentOrigin>/s/<token>`.

So the relay can learn that *someone opened a link for daemon X*, and cannot learn the secret or
redeem it. That is structural, not a promise about log retention.

## Trust model

Trust on first use, then signatures.

- The **first** `/announce` for an id registers its Ed25519 public key.
- Every **later** announce must carry a signature verifiable against the stored key.

Without this, anyone could repoint someone else's link at their own server — turning a convenience
feature into a phishing kit. Ids are 128-bit random, so squatting an unused id is not a practical
attack. Announces also carry a timestamp and are rejected outside a five-minute window, so a
captured one cannot be replayed later.

Covered by `tests/relay-worker.test.ts`, which runs the real Worker against a fake KV — including
the case where an attacker signs correctly with their *own* key and offers a replacement public key.

## Deployed instance

`https://app.repoyeti.com` — LunarWerx account, free tier. Served by a Worker route on its proxied
DNS record in the `repoyeti.com` zone. The Worker-managed custom domain
`https://go.repoyeti.com` remains an alias for links issued by older RepoYeti versions. The Worker
(named `repoyeti`) also answers on its free
`repoyeti.lunawerx.workers.dev` hostname—same Worker and KV.

Self-hosting on your own domain? Change the `routes` entry in `wrangler.toml` to your hostname
(the zone must be on your account) and `wrangler deploy` — Cloudflare provisions the DNS record and
cert. A bare `workers.dev` hostname works too (`workers_dev = true`, no custom domain) — it's
already stable, which is the only property this service requires.

**If you own a domain, you probably don't want this at all.** Put the daemon on a NAMED TUNNEL
instead (`tunnel.hostname` + a connector token in the daemon config): your address is then stable
AND resolves on networks that block `trycloudflare.com`, because visitors never touch trycloudflare.
The relay only forwards to a quick tunnel, so it fixes rotation and not blocking. It exists for
people without a domain.

## Deploy

You need a Cloudflare account. No domain required — `workers.dev` is enough. The free tier (100k requests/day)
is far more than this needs: one write per daemon restart, one read per link opened.

```sh
npm i -g wrangler
wrangler login

# One KV namespace holds the id -> origin map.
wrangler kv namespace create RELAY
# Paste the returned id into wrangler.toml, then:

wrangler deploy
```

`wrangler.toml` is in this directory. Set `route` to the hostname you want (e.g.
`go.example.com/*`).

## Point RepoYeti at it

**Settings → Accounts → Access → RepoYeti address.** Selecting it adopts the deployed instance
above, mints this daemon's keypair, announces immediately, and shows the permanent URL to copy.

Equivalently, in `~/.repoyeti/config.json`:

```json
{
  "relay": {
    "enabled": true,
    "url": "https://go.example.com"
  }
}
```

Leave `identity` alone — the daemon mints its own keypair on first announce and writes it there.
Deleting it registers a NEW id next time, which breaks every link already handed out; turning the
relay off in Settings deliberately keeps it for that reason.

**Off by default, deliberately.** A self-hosted tool should not phone anywhere unless asked. When
enabled, the only thing that ever leaves the machine is `(id, origin, timestamp, signature)`: no
repository names, no paths, no tokens.

## Endpoints

| Method | Path            | Purpose                                                        |
| ------ | --------------- | -------------------------------------------------------------- |
| `POST` | `/announce`     | Daemon publishes its current origin (signed).                    |
| `GET`  | `/r/:id`        | Forwarding page; re-attaches the URL fragment client-side.       |
| `GET`  | `/r/:id/<path>` | Plain 302 for links that carry no secret (e.g. "open my board"). |
| `GET`  | `/health`       | Liveness.                                                        |

## Known limit

This fixes **addresses changing**. It does not fix `trycloudflare.com` being DNS-blocked on some
school and corporate networks, because the forward still lands there. For a link that resolves
everywhere, use a named tunnel on your own domain — RepoYeti supports that directly, and then you
do not need the relay at all.
