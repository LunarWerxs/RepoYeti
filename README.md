# RepoYeti

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
| **4 — tunnel + PWA** | cloudflared (+QR) · Vue 3 dashboard (reka-ui / Tailwind v4 / VueUse / vue-sonner / auto-animate) | ✅ built & verified |
| **5 — hardening + dist** | `bun --compile` single binary · register/create repo · stage-all+commit · port/timeout guards | ✅ built & verified² |
| 6 — Tauri tray | thin sidecar around the unchanged daemon binary | ⏳ deferred (the CLI binary + phone browser is the whole product) |

¹ Auth gating, the login redirect (built from live connections.icu discovery), and the sign-in UI are
verified; the redirect shim is **deployed** (`repoyeti-auth.lunawerx.workers.dev`). The only remaining
step for a live login round-trip is registering a "Sign in with Connections" app (client id) — see
[shim/README.md](shim/README.md) and MARCHING_ORDERS §13.
² PAT/HTTPS-token auth + OS-keychain (keytar) remain intentionally deferred (SSH-key injection covers
the common case); the named-tunnel stable-URL upgrade is documented.

## Stack

**Daemon:** Bun · `bun:sqlite` (WAL) · `simple-git` · Hono · SSE down / REST up.
**Web (PWA):** Vue 3 · Vite · Tailwind v4 · reka-ui (shadcn-vue) · vue-i18n · Pinia.
The daemon is the primary artifact; the CLI is its launcher; a future Tauri tray wraps the same binary.

## Dashboard features

- **Live repo grid** — branch / dirty / ahead / behind per repo, pushed over SSE; drag to reorder, filter by name / identity / sync state. **Fetch all** with one tap.
- **Safe git actions** — fetch / pull (fast-forward only) / push (no force) / stage-all + commit, each identity-attributed.
- **Self-service setup** — add or remove scan folders from Settings (no CLI needed), **clone a repo from a URL** onto the machine, and "sign out everywhere" to invalidate every device's session at once.
- **Branches** — list local branches with ahead/behind, switch (clean-tree guarded), create (＋), and safe-delete (`-d` only; protected branches and the current branch are refused).
- **Commit history** — a lazy, paginated read-only log per repo (hash · subject · author · relative time; tap a hash to copy).
- **Stash** — stash all changes (incl. untracked) to escape the "dirty tree blocks pull" dead-end, then pop / drop from the phone. A conflicting pop keeps the stash and says "resolve at your desk" — never a silent half-merge.
- **Discard a file** — revert one changed file to its last commit, straight from the changes tree (confirm-gated; the inverse of the in-app editor).
- **AI commit messages (BYOK)** — draft a message from the repo's diff via your own key (Groq · OpenRouter · Gemini · Claude · ChatGPT · DeepSeek). Keys stay on the daemon; nothing leaves the machine without an explicit generate.
- **VS Code-style changes tree** — real `vscode-icons` file-type glyphs, resizable per repo (drag / ↑↓ / double-click reset) with a Small / Medium / Tall default.
- **English UI** — copy runs through `vue-i18n` (the `t()` layer is kept so locales can be re-added), but only English ships today.

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
curl -XPOST :7171/api/repos/clone    -d '{"url":"git@github.com:org/repo.git","parentPath":"/your/code"}'  # clone (dest must be under a scan root)

# identities + safe git actions
curl -XPOST :7171/api/identities -d '{"displayName":"Personal","gitUsername":"Me","gitEmail":"me@ex.com","sshKeyPath":"~/.ssh/id_ed25519"}'
curl -XPOST :7171/api/repos/<id>/identity -d '{"identityId":"<iid>"}'   # assign
curl -XPOST :7171/api/repos/<id>/fetch                                  # fetch  (updates behind)
curl -XPOST :7171/api/repos/<id>/pull                                   # pull   (fast-forward only; 409 if dirty/diverged)
curl -XPOST :7171/api/repos/<id>/push                                   # push   (never --force; 409 if non-fast-forward)
curl -XPOST :7171/api/repos/<id>/commit -d '{"message":"wip"}'          # stage-all + commit (identity-attributed)
curl -XPOST :7171/api/repos/<id>/refresh                                # force a fresh status read

# branches / history / stash / discard
curl :7171/api/repos/<id>/branches                                      # list local branches (+ ahead/behind)
curl -XPOST :7171/api/repos/<id>/checkout -d '{"branch":"main"}'        # switch (409 if dirty)
curl -XPOST :7171/api/repos/<id>/branch   -d '{"name":"feature/x"}'     # create (+switch); 409 if it exists
curl -XPOST :7171/api/repos/<id>/stash    -d '{"message":"wip"}'        # stash all changes (incl. untracked)
curl -XPOST :7171/api/repos/<id>/stash/pop                              # pop (409 STASH_CONFLICT keeps the stash)
curl :7171/api/repos/<id>/log?limit=50                                  # read-only commit history
curl -XPOST :7171/api/repos/<id>/discard  -d '{"path":"src/a.ts"}'      # revert one file to HEAD
```

## Remote access (over the internet)

```sh
repoyeti start --tunnel    # requires "oauth" configured in ~/.repoyeti/config.json (Sign in with Connections)
```

Prints a `*.trycloudflare.com` URL + a QR to scan. The daemon refuses to open a tunnel unless auth is
configured, so the public URL is useless to anyone but the signed-in owner.

### Finishing "Sign in with Connections" (one-time)

The redirect **shim is already deployed**: `https://repoyeti-auth.lunawerx.workers.dev` (Cloudflare Worker;
source in [shim/](shim/)). To light up login you only need to:

1. Register a **"Sign in with Connections"** app at `studio.connections.icu` (developer apps) with
   **redirect URI** `https://repoyeti-auth.lunawerx.workers.dev/cb` and scopes `openid profile email`.
   This yields a `client_id` (and, if confidential, a `client_secret`).
2. Add the `oauth` block to `~/.repoyeti/config.json`:

   ```jsonc
   {
     "roots": ["/your/code"],
     "oauth": {
       "issuer": "https://accounts.connections.icu",
       "clientId": "<your client id>",
       "redirectUri": "https://repoyeti-auth.lunawerx.workers.dev/cb",
       "ownerSub": "<your Connections sub>"   // or "ownerEmail": "you@example.com"
     }
   }
   ```

Then `repoyeti start --tunnel` → scan the QR → Sign in with Connections → dashboard, from anywhere.

## Testing

```sh
bun test        # discovery, op-queue, git-action guards, branch/stash/discard, auth gating, redirect shim
bun run typecheck
```

The web dashboard lives in [`web/`](web/) (Vite proxies `/api` + `/oauth` to the daemon on `:7171`):

```sh
cd web
bun install
bun run dev          # dev server on :4319 (proxied to the running daemon)
bun run build        # type-check (vue-tsc) + production build → web/dist (served by the daemon)
bun run i18n:check   # fail on untranslated strings / missing keys / locale key-parity drift
```

Safety guards return first-class error codes: `DIRTY_WORKING_TREE`, `NON_FAST_FORWARD`, `DETACHED_HEAD`,
`SSH_AUTH_FAILED`, `SSH_PASSPHRASE_REQUIRED`, `NO_UPSTREAM`, `NO_REMOTE` — the daemon never leaves a repo
half-merged. Identity is injected **per operation** (`-c core.sshCommand` + `-c user.*`); global/repo git
config is never mutated.

Local state lives under `~/.repoyeti/` (`config.json`, `repoyeti.db`). Nothing is written into your repos.

## Notes for hackers

- Watches only `.git/` + `.git/logs/` per repo (never the working tree) — light on inotify/CPU.
- Read commands run with `GIT_OPTIONAL_LOCKS=0` so status never rewrites `.git/index` (no watch loop).
- Per-repo operation queue serializes all git ops on a repo — the primitive that prevents half-merged state.
- `behind` is from the last fetch only; the daemon never auto-fetches on a watch event.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — running locally, the test/typecheck/`i18n:check` gates,
and how to add a UI translation. Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © LunarWerx Studios. The bundled file-type icons are
[`vscode-icons`](https://github.com/vscode-icons/vscode-icons) (icon artwork under CC BY-SA).

> Built with support from **[LunarWerx Studios](https://lunarwerx.com/)**.
