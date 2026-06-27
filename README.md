# GitMob

A self-contained, **system-wide remote git manager**. A background daemon discovers all your
git repos, tracks their state (branch / dirty / ahead / behind) event-driven, manages multiple
git identities, and serves a mobile dashboard over a secure remote URL so you can safely
fetch/pull/push from your phone.

> Full design + build plan: **[MARCHING_ORDERS.md](MARCHING_ORDERS.md)** — the single source of truth.

## Status

| Phase | What | State |
|---|---|---|
| **1 — daemon core** | discovery · `.git` watchers · SQLite · status engine · op-queue · REST + SSE | ✅ built & verified |
| **2 — auth** | "Sign in with Connections" (public OIDC, config-gated) + redirect shim | ✅ built & verified¹ |
| **3 — identity + safe git ops** | identity CRUD · per-op `-c core.sshCommand`/`user.*` · fetch/pull(FF-only)/push(no-force)/commit guards | ✅ built & verified |
| **4 — tunnel + PWA** | cloudflared (+QR) · Vue 3 dashboard (Naive UI / VueUse / auto-animate) | ✅ built & verified |
| **5 — hardening + dist** | `bun --compile` single binary · register/create repo · stage-all+commit · port/timeout guards | ✅ built & verified² |
| 6 — Tauri tray | thin sidecar around the unchanged daemon binary | ⏳ deferred (the CLI binary + phone browser is the whole product) |

¹ Auth gating, the login redirect (built from live connections.icu discovery), and the sign-in UI are
verified; the redirect shim is **deployed** (`gitmob-auth.lunawerx.workers.dev`). The only remaining
step for a live login round-trip is registering a "Sign in with Connections" app (client id) — see
[shim/README.md](shim/README.md) and MARCHING_ORDERS §13.
² PAT/HTTPS-token auth + OS-keychain (keytar) remain intentionally deferred (SSH-key injection covers
the common case); the named-tunnel stable-URL upgrade is documented.

## Stack

Bun · `bun:sqlite` (WAL) · `simple-git` · Hono · SSE down / REST up · Vue 3 PWA (Phase 4).
The daemon is the primary artifact; the CLI is its launcher; a future Tauri tray wraps the same binary.

## Run (Phase 1)

```sh
bun install
bun run src/index.ts add-root /path/to/your/code     # register a directory to scan
bun run src/index.ts start                            # boot the daemon (127.0.0.1:7171)
bun run src/index.ts status                           # print configured roots + indexed repos
```

Then:

```sh
curl http://127.0.0.1:7171/api/repos              # live repo state (branch/dirty/ahead/behind)
curl -N http://127.0.0.1:7171/api/events          # SSE stream — pushes on real .git changes

# manual targeting
curl -XPOST :7171/api/repos/register -d '{"path":"/abs/path/to/existing-repo"}'  # "Point to folder"
curl -XPOST :7171/api/repos/create   -d '{"path":"/abs/path/to/new-repo"}'       # "Create new" (git init)

# identities + safe git actions
curl -XPOST :7171/api/identities -d '{"displayName":"Personal","gitUsername":"Me","gitEmail":"me@ex.com","sshKeyPath":"~/.ssh/id_ed25519"}'
curl -XPOST :7171/api/repos/<id>/identity -d '{"identityId":"<iid>"}'   # assign
curl -XPOST :7171/api/repos/<id>/fetch                                  # fetch  (updates behind)
curl -XPOST :7171/api/repos/<id>/pull                                   # pull   (fast-forward only; 409 if dirty/diverged)
curl -XPOST :7171/api/repos/<id>/push                                   # push   (never --force; 409 if non-fast-forward)
curl -XPOST :7171/api/repos/<id>/commit -d '{"message":"wip"}'          # stage-all + commit (identity-attributed)
curl -XPOST :7171/api/repos/<id>/refresh                                # force a fresh status read
```

## Remote access (over the internet)

```sh
gitmob start --tunnel    # requires "oauth" configured in ~/.gitmob/config.json (Sign in with Connections)
```

Prints a `*.trycloudflare.com` URL + a QR to scan. The daemon refuses to open a tunnel unless auth is
configured, so the public URL is useless to anyone but the signed-in owner.

### Finishing "Sign in with Connections" (one-time)

The redirect **shim is already deployed**: `https://gitmob-auth.lunawerx.workers.dev` (Cloudflare Worker;
source in [shim/](shim/)). To light up login you only need to:

1. Register a **"Sign in with Connections"** app at `studio.connections.icu` (developer apps) with
   **redirect URI** `https://gitmob-auth.lunawerx.workers.dev/cb` and scopes `openid profile email`.
   This yields a `client_id` (and, if confidential, a `client_secret`).
2. Add the `oauth` block to `~/.gitmob/config.json`:

   ```jsonc
   {
     "roots": ["/your/code"],
     "oauth": {
       "issuer": "https://accounts.connections.icu",
       "clientId": "<your client id>",
       "redirectUri": "https://gitmob-auth.lunawerx.workers.dev/cb",
       "ownerSub": "<your Connections sub>"   // or "ownerEmail": "you@example.com"
     }
   }
   ```

Then `gitmob start --tunnel` → scan the QR → Sign in with Connections → dashboard, from anywhere.

## Testing

```sh
bun test        # 19 tests: discovery, op-queue, git-action guards, auth gating, redirect shim
bun run typecheck
```

Safety guards return first-class error codes: `DIRTY_WORKING_TREE`, `NON_FAST_FORWARD`, `DETACHED_HEAD`,
`SSH_AUTH_FAILED`, `SSH_PASSPHRASE_REQUIRED`, `NO_UPSTREAM`, `NO_REMOTE` — the daemon never leaves a repo
half-merged. Identity is injected **per operation** (`-c core.sshCommand` + `-c user.*`); global/repo git
config is never mutated.

Local state lives under `~/.gitmob/` (`config.json`, `gitmob.db`). Nothing is written into your repos.

## Notes for hackers

- Watches only `.git/` + `.git/logs/` per repo (never the working tree) — light on inotify/CPU.
- Read commands run with `GIT_OPTIONAL_LOCKS=0` so status never rewrites `.git/index` (no watch loop).
- Per-repo operation queue serializes all git ops on a repo — the primitive that prevents half-merged state.
- `behind` is from the last fetch only; the daemon never auto-fetches on a watch event.
