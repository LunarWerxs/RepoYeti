# RepoYeti — Architecture & Build Spec

> _(Formerly `MARCHING_ORDERS.md` — promoted to the durable architecture doc; the §-numbered
> security model, secrets/identity protocol, and acceptance criteria below remain the source of truth.)_
>
> **What this file is.** The single, decisive build spec for the **smallest version that
> actually works end-to-end on a phone**. It distilled three earlier input briefs — a
> hard-constraints architecture brief, an opinion prompt, and a Gemini "winning stack"
> response — into one source of truth; those briefs were removed once their content was
> fully absorbed here. Decisions below are made, not surveyed. Where the briefs left
> something OPEN, it is now closed. Where they over-scoped, it is now cut.
>
> Method note: this spec was produced by running three independent minimal-MVP designs
> (speed lens / security-first lens / simplest-stack lens) and adversarially synthesizing them.
> Every "locked" decision below survived all three.

> **✅ Implementation status (built & verified).** Phases 1–5 are implemented in `src/` + `web/` and
> verified at runtime (see [README.md](README.md)). Two deliberate deviations from the plan below:
> (1) **stage-all + commit from the phone is now IN v1** (the §3 "OUT" deferral is lifted — it's atomic
> and can't create the half-merged state the guards prevent), and **register/create repo are built**;
> (2) **PAT/HTTPS-token auth + OS-keychain (keytar)** stay deferred (SSH-key injection covers the common
> case), and **Phase 6 (Tauri tray)** is deferred — the CLI binary + phone browser is the whole product.
> The only thing between "built" and a live remote login is a single owner-gated end-to-end sign-in.
>
> **⚠️ Update since v1 — the tunnel/shim design in §2 & §7 is SUPERSEDED.** RepoYeti now runs a
> **named Cloudflare tunnel** (`app.repoyeti.com`) and the daemon uses its **own**
> `<origin>/oauth/callback` — there is no shim (`shim/` is dead reference code). The shipped design
> and runbook are in **§15 (Remote access)**.

---

## 0. The one thesis

**RepoYeti is a single Bun-compiled daemon binary.** It discovers your git repos, watches them
cheaply, serves a mobile PWA, drives git operations with per-operation identity injection, and
exposes itself over a zero-config Cloudflare tunnel — gated by app-layer auth so the tunnel URL
alone is worthless. **The CLI binary + a phone browser is the entire product.** The Tauri tray,
named tunnels, TOTP, workspaces UI, and on-phone staging are all deferred — none of them are on
the path to a working demo, and the tray in particular can be added later **without touching a
single line of daemon code.**

The sharpest cut: **defer Tauri.** It is launch convenience, not functionality.

---

## 1. What we're building

A self-contained, lightweight, system-wide remote git manager. A background daemon on a dev
machine (Mac / Windows / Linux) that:

- recursively discovers all git repos under chosen root(s),
- tracks each repo's state (branch, dirty count, ahead / behind, remote, errors) **event-driven, not polled**,
- manages multiple git identities (personal / work / client — name + email + SSH key + optional PAT),
- exposes a high-density, dark, mobile-first **PWA dashboard** over a **secure zero-config remote URL**,
- and lets you trigger **safe** git actions (fetch / pull / push / assign-identity / register / create) from the phone.

It is **not** a mobile IDE. No diff viewer, no merge-conflict resolution, no rebase. The product
is *passive triage + identity-boundary protection*: know your repos' state from anywhere, and
never push with the wrong identity.

### The one success loop (this is "fully functional")

```
repoyeti start  →  phone (on LTE) opens the URL  →  "Sign in with Connections" once  →
see all repos live  →  assign an identity to a repo  →  pull/push with that identity  →
state updates on the phone within seconds
```

If that loop works over HTTPS from a cellular connection with no port forwarding, v1 is done.

---

## 2. Locked stack

| Layer | Decision | Why it won |
|---|---|---|
| **Runtime** | **Bun (LTS)** | `bun --compile` → single self-contained binary; built-in `bun:sqlite` kills the `better-sqlite3` native-addon build churn on Windows; built-in HTTP server + file watchers; TS-first, no `tsc` step. |
| **Git engine** | **`simple-git`** over the system `git` binary | Reuses the user's installed, optimized git. Its per-call `env` option maps *directly* onto `GIT_SSH_COMMAND` / `GIT_AUTHOR_*` injection. No JS git reimplementation to trust. |
| **HTTP framework** | **Hono** | Tiny, TS-native. Its middleware model makes auth **structural** — a single `app.use()` gates the whole router, so you *cannot* add an unauthenticated route by accident. |
| **Storage** | **`bun:sqlite`**, WAL mode, `synchronous=NORMAL` | Only store that survives concurrent writers (watcher + API + git ops). One file: `repoyeti.db`. Retry on `SQLITE_BUSY`; fall back to `journal_mode=DELETE` if WAL won't open (Windows AV). |
| **Tunnel** | **`cloudflared` quick tunnel** (free, rotating) **+ a fixed redirect shim** | Daemon stays zero-config on a free auto tunnel; a tiny **stable shim** (Cloudflare Worker `*.workers.dev` — recommended — or Pages / GitHub Pages) is the registered OAuth redirect and bounces login back to the daemon's current URL (§7). No domain, no ngrok. Tunnel client bundled as a pinned binary. A stable *dashboard* URL comes later, once you own a domain. |
| **Auth** | **"Sign in with Connections"** — public OIDC (AEGIS) at `accounts.connections.icu`; daemon verifies the login token and trusts one owner `sub` | Stand-alone relying party using connections.icu's **public** OAuth — like "Log in with Google." No shared secret, no Connections-repo coupling, no homegrown password/PIN. See §7. |
| **Transport / sync** | **SSE** daemon→phone, **REST** phone→daemon | v2 decided this. SSE auto-reconnects through cloudflared with no WebSocket upgrade; maps cleanly onto the event-driven watcher. Commands are request/response → REST. |
| **Frontend** | **Vue 3 + Vite**, PWA, **embedded in the binary**; **import pre-built libraries, minimal hand-written UI** | Static files bundled at `bun --compile` time; daemon serves them — no second server. **Owner directive: lean on smart pre-built libs, write minimal UI to maintain.** Stack: **reka-ui** (shadcn-vue–style component kit, `src/components/ui/`) · **Tailwind v4** (`@tailwindcss/vite`) · **@vueuse/core** (composables — `useEventSource` handles SSE+reconnect, `useColorMode`, `useLocalStorage`) · **@formkit/auto-animate** (zero-config list/card transitions — solves "no layout shift on SSE updates" for free) · **@lucide/vue** icons · **vue-sonner** toasts · **Pinia** state · **vite-plugin-pwa** (auto manifest + service worker). |
| **Secrets** | **OS keychain via `keytar`** | SSH key *paths* in SQLite (the daemon never reads key bytes — only passes the path to `ssh -i`). Git PATs, the owner's Connections OAuth tokens, and any confidential `client_secret` in keychain by handle, resolved at call time. |
| **Packaging** | `bun --compile` per platform, shipped via **npm** | `npm install -g repoyeti && repoyeti start`. ~25–35 MB incl. embedded frontend + bundled cloudflared. Tauri tray deferred to Phase 6. |

---

## 3. Scope

### IN (v1 — required for the success loop)

- **Discovery:** recursive BFS from **one** configured root, max depth 6, skip `node_modules`,
  nested `.git`, and common build dirs; cap at **200 repos** on Linux (inotify budget). `source=auto`.
- **Manual targeting:** `POST /api/repos/register` (existing absolute path, `source=pinned`) and
  `POST /api/repos/create` (`mkdir` + `git init`, `source=created`).
- **Watchers:** one watcher per repo on **`.git/HEAD` and `.git/index` only** — never the working
  tree. On event → recompute that repo's status → write SQLite → emit SSE.
- **Per-repo operation queue:** a `Map<repoId, Promise>` chain serializing *all* git ops on a repo.
  This is a **Phase 1 architectural primitive**, not a later optimization — it is what prevents the
  forbidden mid-merge race.
- **Status:** branch, dirty count, **ahead (local)**, **behind (from last fetch only, timestamped)**,
  remote URL — via `git status --porcelain`, `git rev-parse`, `git rev-list @{u}..HEAD`.
- **SSE:** `GET /api/events` streaming `repo_state_changed` + `daemon_status`; session-gated; client
  uses `EventSource` (auto-reconnect).
- **REST git actions:** fetch, **pull (fast-forward only, dirty-tree preflight)**, **push (no `--force`,
  non-FF guard)**. All behind the operation queue and the conflict guard.
- **Identity:** CRUD identities (name, email, SSH key path, optional PAT-by-handle); assign to repo;
  **per-operation injection** (see §7).
- **Auth:** "Sign in with Connections" (public OIDC, see §7); every route 401s until the caller has logged in as the trusted owner.
- **Tunnel:** cloudflared quick tunnel spawned as a child process; URL printed + emitted via SSE;
  **tunnel failure is non-fatal** (daemon keeps serving localhost).
- **PWA:** flat repo list sorted by name; per-repo card = branch badge + dirty count + ahead/behind
  (with fetch timestamp) + identity selector + fetch/pull/push buttons; dark terminal theme;
  Add-to-Home-Screen manifest.
- **CLI:** `repoyeti start | stop | status | add-root <path> | set-owner <sub|email>` (`set-owner` sets the trusted Connections identity; OAuth `client_id`/redirect come from config — see §13). _Since v1 the CLI has grown beyond lifecycle: it now also has **git verbs** (`repos`/`status <repo>`/`log`/`branches`/`branch`/`checkout`/`commit`/`diff`/`drift`/`stash`/`push`/`pull`/`fetch`) that drive the running daemon over its loopback HTTP API, plus **`repoyeti mcp`** (an MCP stdio server for AI agents) and **`repoyeti token`** (mint/revoke the optional API token). See the new "Agent & CLI surfaces" note under §4._
- **Robustness:** port-conflict auto-increment; 30s op timeout; structured error codes.

### OUT (explicitly deferred — do not build in v1)

| Deferred | When | Why it's safe to cut |
|---|---|---|
| Tauri system-tray app | Phase 6 | CLI binary delivers the full loop; tray is a thin sidecar launcher added with **zero daemon changes**. |
| **Stage / commit from phone** | Phase 5 patch | Highest-risk mobile UX surface. Pull/push of *pre-staged* commits covers ~90% of remote use. |
| Workspaces grouping UI | Phase 5 | `workspaces` table exists in schema (for future identity inheritance); v1 UI is a flat list. |
| Named Cloudflare tunnel (stable URL) | Phase 5 | One-flag config upgrade (`CF_TUNNEL_TOKEN`); quick tunnel is fine for the demo loop. |
| TOTP second factor | n/a | The connections.icu identity (Cognito, behind the owner's own MFA) already satisfies the auth non-negotiable. |
| PAT / HTTPS remote auth | Phase 5 | SSH-key injection covers GitHub/GitLab/Bitbucket; HTTPS-PAT via `GIT_ASKPASS` is a separate path. |
| Multi-root discovery | Phase 5 | One root (`~/code`, `~/Projects`) covers the common case. |
| Session-management UI / per-device revoke | Phase 5 | A "sign out everywhere" clears daemon sessions; the Connections login itself is governed by AEGIS. v1 has a single owner session. **Partly landed:** §17's Sharing panel is per-*link* listing + revoke. Per-*device* owner-session revoke is still just the "sign out everywhere" hammer. |
| Commit signing (GPG/SSH) | post-v1 | Schema slot reserved, not wired. |
| Diff viewer · merge-conflict UI · rebase · `reset --hard` · `push --force` | **never** | Out of scope by design. Daemon surfaces "resolve at your desk" and stops. |
| SVN / Mercurial · cloud-synced accounts · auto-updater · native installers | post-v1 | Not on the path. |
| WebSockets | **never** | SSE is strictly sufficient; enforce this against drift. |
| Self-hosted frp/bore/chisel relay | **never** | Converts "self-contained tool" into "infra operator" — contradicts the whole point. |

---

## 4. Architecture

```
┌──────────────────────── repoyeti daemon (single Bun binary) ────────────────────────┐
│                                                                                    │
│  Discovery (BFS, depth≤6)──┐                                                        │
│                            ▼                                                        │
│  Watchers (.git/HEAD, .git/index per repo) ──► Status engine (simple-git) ──┐      │
│                                                          │                   ▼      │
│                                                  per-repo OP QUEUE      bun:sqlite  │
│                                                  Map<repoId,Promise>    (WAL)       │
│                                                          │                   │      │
│  Hono HTTP server (127.0.0.1:PORT)                       │                   │      │
│   ├─ OIDC session middleware (Sign in with Connections; owner-sub check) ◄┘   │      │
│   ├─ REST: /api/repos, /api/identities, /api/repos/:id/{fetch,pull,push,…}  │      │
│   ├─ SSE:  /api/events  ◄─────────────── emits on status change ────────────┘      │
│   └─ static: embedded Vue 3 PWA                                                     │
│                            │                                                        │
│  Secrets ──► OS keychain (keytar): owner Connections tokens, PATs, client_secret?  │
│             (SSH key paths in DB)  ──► OAuth @ accounts.connections.icu (OIDC)      │
│                            │                                                        │
│  cloudflared child process ─────► https://xxxx.trycloudflare.com (HTTPS edge)      │
└────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                  📱 phone PWA (daemon session cookie after Connections login)
```

**Data flow, both directions:**
- *State (server→phone):* file change on `.git/index` → watcher fires → op-queue runs status read →
  SQLite updated → SSE `repo_state_changed` pushed → PWA patches that one card (no full re-render).
- *Commands (phone→daemon):* PWA `POST`s a REST action with `Authorization: Bearer <jwt>` → auth
  middleware verifies → op-queue serializes the git call → conflict guard preflights → `simple-git`
  runs with injected identity → result returned + SSE follow-up.

### Agent & CLI surfaces (one orchestration core, several front doors)

There are now **three** ways to reach the same git operations — the HTTP routes, the CLI verbs, and
the MCP tools — and they all funnel into the **one service orchestration layer** (`src/service/`),
so every guard (op-queue serialization, FF-only pull, no-force push, dirty-tree refusal, identity
injection) holds no matter which door a request comes through. The layering:

- **HTTP routes** (`src/http/routes/*`) — the canonical surface; the PWA and any external caller use it.
- **CLI verbs** (`src/cli/git.ts`) and **MCP-stdio** (`repoyeti mcp`) are **thin HTTP clients to the
  loopback daemon** — they never touch git or the service layer in-process; they locate the live
  daemon and call its `127.0.0.1` API (single-instance respected). A boundary check enforces that
  `cli/*` and the MCP core/tools import no service/read/git layer.
- **MCP-HTTP** (`POST /api/mcp`) uses an **in-process adapter** into the service layer and is gated
  by the same `/api/*` auth middleware as every other route. (MCP-stdio reuses the same tool catalog
  via an HTTP adapter, so both transports advertise the identical 14 tools.)
- The full HTTP surface is described machine-readably at `GET /api/openapi.json` (see §6).

---

## 5. Data model (SQLite, WAL mode)

Minimal schema. `workspaces` exists for future identity inheritance but is **not** surfaced in the v1 UI.

```sql
-- repos discovered or registered
CREATE TABLE repos (
  id            TEXT PRIMARY KEY,           -- ULID
  abs_path      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  source        TEXT NOT NULL,              -- 'auto' | 'pinned' | 'created'
  workspace_id  TEXT REFERENCES workspaces(id),
  identity_id   TEXT REFERENCES identities(id),  -- assigned identity (override)
  is_submodule  INTEGER NOT NULL DEFAULT 0,
  last_status   TEXT,                       -- JSON: {branch,dirty,ahead,behind,remote,error,fetched_at}
  updated_at    INTEGER NOT NULL
);

CREATE TABLE workspaces (                   -- schema-only in v1
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  default_identity_id TEXT REFERENCES identities(id)
);

CREATE TABLE identities (
  id              TEXT PRIMARY KEY,         -- ULID
  display_name    TEXT NOT NULL,            -- "Personal GitHub"
  git_username    TEXT NOT NULL,
  git_email       TEXT NOT NULL,
  ssh_key_path    TEXT,                     -- path ONLY; file never read by daemon
  pat_handle      TEXT,                     -- keychain handle, e.g. 'repoyeti/identity/<id>/pat' — NEVER the PAT
  signing_handle  TEXT                      -- reserved, unused in v1
);

-- Auth is "Sign in with Connections" (public OIDC, §7):
--   • the trusted owner identity (sub/email) lives in config + OS keychain ('repoyeti/owner-sub');
--   • the owner's Connections OAuth tokens live in the OS keychain, never in SQLite;
--   • a single 'sessions' row (or signed __Host- cookie) tracks the active daemon session;
--   • no password, PIN, or shared secret is ever stored.
CREATE TABLE sessions (                     -- the daemon's own RP session(s)
  id            TEXT PRIMARY KEY,           -- ULID
  owner_sub     TEXT NOT NULL,              -- verified Connections sub
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,           -- refreshed via the OAuth refresh token
  revoked       INTEGER NOT NULL DEFAULT 0
);
```

**Invariant:** no raw secret bytes ever land in SQLite — only key *paths* (SSH) and keychain
*handles*. The auth credential itself is issued and revoked by connections.icu, not by RepoYeti.

---

## 6. API surface (every route requires the trusted owner — or, since §17, a scoped share link)

| Method | Route | Purpose | Guards |
|---|---|---|---|
| `GET` | `/api/repos` | list repos + last status | — |
| `POST` | `/api/repos/register` | pin existing abs path | path exists + is a git repo |
| `POST` | `/api/repos/create` | `mkdir` + `git init` | path not exists |
| `POST` | `/api/repos/:id/fetch` | `git fetch` (updates behind) | op-queue |
| `POST` | `/api/repos/:id/pull` | FF-only pull | **409 `DIRTY_WORKING_TREE`** if dirty; FF-only |
| `POST` | `/api/repos/:id/push` | push current branch | **409 `NON_FAST_FORWARD`** if diverged; `--force` → **403** |
| `POST` | `/api/repos/:id/identity` | assign identity to repo | — |
| `GET` | `/api/identities` | list | — |
| `POST` `PUT` `DELETE` | `/api/identities[/:id]` | CRUD | PAT → keychain, never DB |
| `GET` | `/api/events` | SSE stream | session cookie |
| `GET` | `/oauth/login` | start "Sign in with Connections" (PKCE; `state` embeds daemon URL) | unauth → redirects to AEGIS via the shim |
| `GET` | `/oauth/finish` | shim bounces here: code → token → JWKS verify → set session | checks owner `sub` |
| `GET` | `/api/auth/me` | current session → `{ ok, sub, email }` | session cookie |
| `POST` | `/api/auth/logout` | clear daemon session | session cookie |

Auth is a single Hono middleware: every `/api/*` route requires a valid daemon session whose verified
`sub` equals the trusted owner; otherwise **401, empty body**. The only unauthenticated surface is the
static PWA shell + manifest, the two `/oauth/*` endpoints that run the login dance, and `GET /s/:token`
(share-link redemption, §17). See §7.

That same middleware is also where a **share-link guest** is admitted — always after every owner check
has failed, so it can only ever let in a caller who would otherwise have received a flat 401, and only
to the allowlisted routes in `src/share/policy.ts`, on repos their link covers. See §17.

Every git operation returns a **structured result**: `{ ok, code, message }`. Error codes are
first-class (`DIRTY_WORKING_TREE`, `NON_FAST_FORWARD`, `SSH_AUTH_FAILED`, `SSH_PASSPHRASE_REQUIRED`,
`DETACHED_HEAD`, `TUNNEL_DOWN`, `AUTH_WRONG_OWNER`, `OIDC_VERIFY_FAILED`) so the UI can render the
right state.

> **The surface has grown well past the table above** (60+ routes: branches, log, stash, tags,
> remotes, files/diff, AI/smart-commit, servers, settings, …). Rather than enumerate them all here,
> the live surface is published machine-readably at **`GET /api/openapi.json`** (OpenAPI 3.1, built
> by introspecting the router; the one `/api/*` path fetchable without sign-in). The **MCP** tool
> server is exposed at **`POST /api/mcp`** (same JSON-RPC, same auth gate). For **remote/headless
> agents** an optional, owner-minted **Bearer API token** sits alongside the OIDC session
> (`POST`/`DELETE`/`GET /api/auth/token`); it's off by default and never weakens the OIDC posture
> (see §7 and §15, Remote access).

---

## 7. Security model — "Sign in with Connections" (public OIDC), non-negotiable

> **Decision (owner directive):** RepoYeti is a **stand-alone codebase**. It uses connections.icu for
> **authentication only**, through the **public API** — never any internal/first-party mechanism. The
> earlier Studio-`introspection_secret` design is **dropped** (that's the internal first-party path).
> RepoYeti authenticates the owner via **"Sign in with Connections"**, connections.icu's public,
> standards-compliant **OpenID Connect** provider (AEGIS), exactly like any "Log in with Google" app.
> RepoYeti's only contact with connections.icu is calling its **public OAuth URLs**; it imports nothing
> from the Connections repo and shares no secret with it.

### The public provider (verbatim, public surface)

- **Issuer / IdP:** `https://accounts.connections.icu` (RS256 id_tokens, PKCE, refresh tokens)
- **Discovery:** `https://accounts.connections.icu/.well-known/openid-configuration`
- **Authorize:** `GET /oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=openid%20profile%20email&code_challenge=…&code_challenge_method=S256&state=…`
- **Token:** `POST /oauth/token` (Authorization Code + PKCE)
- **Userinfo:** `GET /oauth/userinfo` → `{ sub, email, name, … }`
- **Contract:** `https://studio.connections.icu/v1/openapi.json`; integration guide:
  `docs/architecture/auth/ACCAP_SIGN_IN_WITH_CONNECTIONS.md`; button:
  `docs/how-to/SIGN_IN_WITH_CONNECTIONS_BUTTON.md`.

RepoYeti is registered once as a **third-party OAuth app** (relying party) → it gets a public
`client_id` and registers its redirect URI(s). See §13.

### How auth works

1. The user taps **"Sign in with Connections"** → standard **Authorization Code + PKCE** dance against
   `accounts.connections.icu/oauth/authorize` (scopes `openid profile email`).
2. The daemon catches the redirect (`?code&state`), exchanges the code at `/oauth/token`, and gets an
   **RS256 `id_token`** + access token.
3. The daemon **verifies the `id_token`** against the provider's **public JWKS** (from the discovery
   doc) — checks signature, `iss`, `aud` (its `client_id`), expiry — and/or calls `/oauth/userinfo`.
   **No shared secret is involved; verification uses public keys only.**
4. The daemon accepts **only if** the verified `sub` (or `email`) equals the **single owner** this
   daemon is configured to trust → otherwise `AUTH_WRONG_OWNER`. It then runs an ordinary session for
   that browser/device (a `__Host-` cookie or short-lived token — standard relying-party behavior; the
   IdP authenticates, the app keeps the session). Refresh tokens keep it alive without re-login.

### Login return = a fixed redirect "shim" — **DECIDED** (keeps the daemon on the free tunnel)

> **⚠️ SUPERSEDED (kept for design history).** This shim squared a *rotating* tunnel URL with a fixed
> OAuth redirect. RepoYeti has since moved to a **named Cloudflare tunnel** with a stable host
> (`app.repoyeti.com`), so the daemon registers and uses its **own** `/oauth/callback` directly and
> the shim is retired. The shipped design + runbook is in **§15 (Remote access)**; the text below
> documents the original rotating-tunnel approach for reference.

The login page must return to a **registered, stable** redirect URI — but the daemon sits on a free,
**rotating** quick-tunnel URL (AEGIS is redirect-based PKCE; no device-code flow exists). Squaring this
**without buying a domain or running ngrok**: register a tiny **fixed redirect shim** (a free, stable
edge URL you already have) and have it **bounce the login back to the daemon's current address.**

Flow (daemon-side PKCE — the phone never handles tokens):
1. Phone opens the daemon, taps "Sign in with Connections" → `GET /oauth/login` on the daemon.
2. The daemon makes PKCE + a signed `state` that **embeds its own current tunnel URL**, and redirects
   the phone to `accounts.connections.icu/oauth/authorize?…&redirect_uri=<SHIM>&state=…`.
3. AEGIS authenticates the user → redirects the phone to the **shim** (`<SHIM>?code&state`).
4. The shim reads `state`, checks the embedded daemon URL matches an **allowed pattern**, and
   **302-redirects** the phone to `<daemon-current-url>/oauth/finish?code&state`.
5. The daemon (`/oauth/finish`) verifies `state` (HMAC + CSRF nonce), exchanges `code` + its PKCE
   `code_verifier` at `/oauth/token` (with `redirect_uri=<SHIM>`), verifies the `id_token` via the
   **public JWKS**, checks the owner `sub`, and sets a `__Host-` session. Done.

**The only thing that must be stable + registered is the shim** — pick a free one you already have:
- **Cloudflare Worker** (`https://repoyeti-auth.<account>.workers.dev`) — *recommended*: server-side 302,
  validates the target host, no client JS, free, stable, **no custom domain**. ~30 lines; I can deploy it.
- **Cloudflare Pages** (`https://<proj>.pages.dev`) or **GitHub Pages** (`https://<user>.github.io/…`) —
  same idea as a tiny static page that reads `state` and redirects in-browser.

**Security:** the `code` is **PKCE-bound** to the daemon's `code_verifier` (held server-side) and
single-use, so intercepting it at the shim is useless; `state` is HMAC-signed and CSRF-checked by the
daemon; the shim only forwards to daemon URLs matching an allowed pattern (no open redirect). The shim
sees a transient, unusable code and nothing else.

**Upgrade path:** once you own a domain, give the daemon a stable URL, register its own `/oauth/callback`
directly, and the shim disappears (the *dashboard* URL stops rotating too).

**Desktop fallback (Path B):** register `http://127.0.0.1:<port>/oauth/callback` and log in once at the
machine — no shim, no tunnel — after which the phone is trusted.

RepoYeti stays **stand-alone** throughout — it only ever calls the public `accounts.connections.icu/oauth/*`
URLs; the shim is a dumb bounce on a free host, not a coupling to Connections.

### What an attacker with only the tunnel URL can do

Hit any endpoint → **401, empty body** (no surface, no version, no repo data). To get further they
must complete a real **Sign-in-with-Connections** login **as the trusted owner** — i.e. pass the
owner's own Connections/Cognito login (and its MFA). A valid login by a *different* Connections user
is rejected (`AUTH_WRONG_OWNER`). The daemon holds only a public `client_id` and the user's own
tokens; there is **no shared secret** whose leak would matter. Tunnel compromise stays neutralized at
the application layer.

> **`GET /api/status` used to be the exception, and was fixed** (§17). It sat in the gate's public
> allowlist and returned the whole settings dump — tunnel config, MCP rails, auto-commit schedule,
> default editor, version — to anyone who knew the tunnel URL, flatly contradicting the paragraph
> above. Nothing needed it public (the PWA calls it only after the gate passes; the sign-in screen
> runs on `/api/auth/status` alone), so it is now gated like every other route. `/api/auth/status`
> and `/api/auth/me` remain public and are safe to be: both only echo the caller's *own* verified
> cookie, so an anonymous caller gets nulls, never the owner's identity.

### The one deliberate exception: share links (§17)

The claim above — *the only way in is an owner login* — is **no longer the whole truth**, by owner
decision. A **share link** is a second, strictly-lesser credential: a secret URL the owner mints and
hands to someone else, with a permission tier, a repo scope, and an expiry. Anyone holding the link
gets in without any Connections account, exactly like a Google Drive "anyone with the link" share.
That is the intent, not a weakness — but it means **the URL is now a credential**, and the
properties that keep it honest are enumerated in §17. If you are auditing this daemon, read §17 as
part of this section, not as a feature note.

### Secrets

- **OAuth `client_id`** is public; the daemon stores its OAuth config (issuer, client_id, redirect_uri)
  and the **trusted owner `sub`/`email`** in config + OS keychain (`repoyeti/owner-sub`); none of it is
  sensitive enough to leak access on its own. A confidential `client_secret`, **if** the app is
  registered as confidential, lives in the daemon keychain only (never shipped to the phone); a public
  PKCE client needs none.
- **The owner's Connections tokens** (access/refresh/id) live server-side on the **daemon** (keychain),
  refreshed as needed; the phone holds only the daemon's own session cookie, never the raw Connections
  tokens.
- **SSH keys:** the daemon **never reads key bytes** — it stores the *path* in SQLite and passes it
  to `ssh -i <path>`. Losing the DB does not leak keys.
- **Git PATs:** OS keychain by handle; resolved into a process env var **immediately before** the git
  subprocess call, never assigned to a module-level variable, logged, or serialized.
- **`keytar` fallback:** if keytar fails to load (common on Windows without build tools), encrypt the
  daemon-side secrets to an **AES-256-GCM** file in the config dir, key =
  `HKDF-SHA256(machineUUID ‖ username ‖ 'repoyeti-v1')`, perms `0600`, with a **loud, specific terminal
  warning**. Still external to SQLite, still not plaintext.

### Identity injection (never break the user's desk)

Per-operation only — **the global `~/.gitconfig` is never touched, and repo-local `.git/config` is
never mutated except on an explicit user "persist identity" action:**

```bash
GIT_SSH_COMMAND="ssh -i <ssh_key_path> -o IdentitiesOnly=yes -o BatchMode=yes" \
  git -c user.name="<name>" -c user.email="<email>" <pull|push|fetch>
```

- `IdentitiesOnly=yes` → SSH refuses any key not explicitly named (no wrong-agent-key fallback).
- `BatchMode=yes` → SSH **fails immediately** instead of hanging on a passphrase prompt.

### Action gating / failure handling

- **Pull preflight:** `git status --porcelain`; non-empty → **409 `DIRTY_WORKING_TREE`**, pull never runs.
- **Pull is fast-forward-only.** A non-FF pull would risk a merge the phone can't resolve → refuse.
- **Push:** non-FF → **409 `NON_FAST_FORWARD`**; `--force` → **403** unconditionally.
- **The daemon never leaves a repo mid-merge.** Every unsafe state surfaces as a clear status, not an action.
- Binds to **`127.0.0.1` only**; the *only* network path in is the authenticated tunnel.
- All git invocations use **parameterized argument arrays** via `simple-git` — never a shell string.

---

## 8. Known traps — engineer around these (surfaced by adversarial review)

These were not in the original briefs; they will bite if ignored.

1. **`keytar` × `bun --compile` native-addon compatibility is the #1 technical unknown.** Run a
   **Phase-1 spike** on Mac arm64, Windows x64, Linux x64 *before* committing. If it fails on a
   platform, the AES-256-GCM file becomes the *primary* there, not a fallback.
2. **SSH passphrase blocking.** Always pass `-o BatchMode=yes`; additionally put a **30s timeout** on
   every `simple-git` op and return **504 `SSH_PASSPHRASE_REQUIRED`** ("use ssh-agent or a
   passphrase-free key") if it hangs. Spec this as a first-class failure mode, not a footnote.
3. **"Behind" requires a network fetch.** **Never auto-fetch on a watch event.** "Behind" is
   stale-by-design (from last fetch); label it with a timestamp. Watch events only recompute
   local state (branch, dirty, ahead).
4. **Submodules.** During BFS, do not treat a submodule's `.git` (a file pointing to a worktree) as a
   top-level repo. Skip or mark `is_submodule=1` and exclude from the watcher budget.
5. **Windows WAL × antivirus** locks `-wal`/`-shm` files. Use `synchronous=NORMAL`, retry on
   `SQLITE_BUSY` (exp backoff, ≤5), and fall back to `journal_mode=DELETE` if WAL won't open.
6. **Bundle `cloudflared`** as a pinned per-platform binary inside the package — do **not** rely on a
   system install. Tunnel failure must be **non-fatal** (keep serving localhost + warn).
7. **Port conflict.** If the default port is taken, auto-increment to the next free port and print the
   actual port used.
8. **Per-repo op serialization** (the `Map<repoId,Promise>` queue) is what makes everything above
   safe under concurrency. Build it first, not last.

---

## 9. Build sequence (each phase is a demoable increment)

> Ordering is **non-negotiable**: auth lands *before* any network exposure. Shipping a tunnel before
> auth would directly violate the v2 non-negotiable.

- **Phase 1 — Core daemon skeleton + op queue (localhost only, no auth, no tunnel).**
  Discovery → watchers (`.git/HEAD`,`.git/index`) → status engine → `bun:sqlite` → `GET /api/repos`.
  Build the per-repo operation queue here. **Run the `keytar` + `bun --compile` spike on all 3 platforms.**
  *Done when:* `repoyeti start` locally; `GET /api/repos` returns accurate branch/dirty/ahead-behind
  within 1s of a local commit.

- **Phase 2 — "Sign in with Connections" (public OIDC).**
  `/oauth/login` (Authorization Code + PKCE → `accounts.connections.icu/oauth/authorize`,
  `scope=openid profile email`) + `/oauth/callback` (exchange at `/oauth/token`, verify the RS256
  `id_token` against the public JWKS from the discovery doc, confirm `sub`/`email` === trusted owner,
  set a `__Host-` session). Single Hono middleware gates every `/api/*` route. Reads OAuth config
  (issuer, `client_id`, redirect) + trusted owner from config/keychain (see §13).
  *Done when:* every `/api/*` route 401s until a Sign-in-with-Connections login as the owner completes;
  a login by a different Connections user → `AUTH_WRONG_OWNER`; URL-only attacker reads nothing.
  **(Builds against the public OIDC discovery doc; lights up once the owner registers the app + supplies
  `client_id` and trusted `sub` — §13.)**

- **Phase 3 — Identity management + safe git ops.**
  Identity CRUD (PAT → keychain); per-op `GIT_SSH_COMMAND` (`IdentitiesOnly`+`BatchMode`) + `git -c`;
  fetch/pull(FF-only, dirty preflight)/push(no-force, non-FF guard); 30s hang timeout.
  *Done when:* on the LAN, assign identity + tap Pull → daemon runs with that identity, result via SSE in ≤2s.

- **Phase 4 — cloudflared tunnel + mobile PWA.**
  Spawn cloudflared child; capture + print URL; emit `daemon_status` SSE. Embed Vue 3 PWA; wire SSE to
  watcher; flat repo cards + identity selector + action buttons; PWA manifest.
  *Done when:* `repoyeti start` → terminal prints the HTTPS URL (QR) → phone on LTE pastes its Connections
  key → full dashboard works. **← This is the v1 finish line (the success loop from §1).**

- **Phase 5 — Hardening + distribution.**
  Zod input validation; inotify-limit guard + 30s targeted-poll fallback; named-CF-tunnel upgrade path
  (`repoyeti.connections.icu` via Cloudflare, see §13); `bun --compile` for Win/Mac/Linux; `npm publish`;
  stage+commit-from-phone patch; workspace UI; multi-root; "sign out everywhere"; optional Path-A named tunnel.

- **Phase 6 — Tauri tray (explicitly deferred).**
  Thin Rust tray that spawns the **unchanged** daemon binary as a sidecar, monitors it, surfaces the
  dashboard URL + Sign-in status in the menu. Proves "100% shared core": CLI and tray run the identical binary.

---

## 10. Definition of Done (v1 acceptance criteria)

1. `repoyeti start` on a laptop with 3+ repos prints the tunnel URL, local URL, and a QR of the tunnel URL within 10s.
2. A phone **on LTE** (not the laptop's WiFi) opens the dashboard URL, taps **"Sign in with Connections"**,
   logs in as the owner, and reaches the dashboard — **no port forwarding, no router config**. (Path B: the
   owner completes the Connections login once at the laptop; the phone is then trusted.)
3. Dashboard shows every repo's branch, dirty count, and ahead count within 2s of load; behind count shows
   the last-fetch value with a timestamp label.
4. A local commit on the laptop updates the phone's dirty + ahead counts within 3s via SSE — **no reload**.
5. From the phone, selecting an identity and tapping Pull runs `git pull` with `GIT_SSH_COMMAND` pointing at
   that identity's key (`IdentitiesOnly=yes`); result (success or structured error) shows within 5s.
6. Pull is fast-forward-only and runs even on a dirty tree: it fast-forwards and preserves the local
   edits when the incoming commits don't touch the uncommitted files, and aborts atomically → **409
   `WOULD_OVERWRITE`** ("commit or stash first") only when they would be overwritten. A detached HEAD
   is still refused (**409 `DETACHED_HEAD`**).
7. Push on a diverged remote → **409 `NON_FAST_FORWARD`**; `--force` → **403** regardless of state.
8. Any `/api/*` request without an authenticated owner session → **401, empty body** (no version, no
   surface, no data); a Sign-in-with-Connections login by a *different* user → **401 `AUTH_WRONG_OWNER`**.
9. The `id_token` is verified against the provider's **public JWKS** (signature + `iss` + `aud` + expiry)
   before any session is issued; the owner's Connections tokens never appear in a client-facing payload.
10. `~/.gitconfig` and every repo's `.git/config` are **byte-identical** before and after a full
    fetch/pull/push cycle with identity injection (verify by checksum).
11. `npm install -g repoyeti && repoyeti start` works on Mac (arm64+x64), Linux x64, and Windows x64 with no
    extra runtime or dependency install.

---

## 11. Repo structure (minimal monorepo)

> **This grew past the flat tree in the original plan.** A maintainability reorg split the three
> god-files (`index.ts` / `daemon.ts` / `service.ts`) into layered directories. The layering is
> **structure, not behavior** — the same operations, just one public seam each.

```
repoyeti/
├─ package.json              # bun workspaces; bin: repoyeti (→ src/index.ts)
├─ src/
│  ├─ index.ts               # 2-line bin shim → cli/main.ts
│  ├─ cli/                   # the command-line front door
│  │  ├─ main.ts             #   dispatcher: start|add-root|status + git verbs + mcp + token
│  │  ├─ lifecycle.ts        #   daemon-lifecycle commands (start/add-root/status + boot helpers)
│  │  ├─ git.ts              #   git verbs (repos/log/branches/checkout/commit/diff/drift/stash/…)
│  │  ├─ client.ts           #   tiny HTTP client → loopback daemon (REPOYETI_BASE_URL/_TOKEN aware)
│  │  ├─ format.ts           #   zero-dep table / colour output
│  │  └─ token.ts            #   `repoyeti token new|revoke|show`
│  ├─ http/                  # the HTTP surface (Hono)
│  │  ├─ app.ts              #   composition root: wires routes/* behind the /api/* auth middleware
│  │  ├─ deps.ts             #   shared route deps (cfg, …)
│  │  ├─ respond.ts          #   structured {ok,code,message} response helpers
│  │  ├─ web.ts              #   static PWA mount (last, so /* doesn't shadow /api)
│  │  ├─ openapi.ts          #   builds the OpenAPI 3.1 doc by introspecting the router + META
│  │  └─ routes/             #   one module per domain (repos, branches, log, stash, tags, remote,
│  │     …                   #     files, ai, identities, roots, servers, git-ops, events, health,
│  │     …                   #     mode, repo-flags, auth, token, openapi, mcp)
│  ├─ service/              # the ONE orchestration layer (op-queue + guards live here)
│  │  ├─ core.ts             #   shared internals (op-queue access, repo lookup)
│  │  ├─ watch.ts            #   watcher → status-recompute → SSE wiring
│  │  ├─ actions.ts          #   fetch/pull/push/commit/checkout/branch/stash mutations
│  │  ├─ repo-mgmt.ts        #   register / create / clone / remove
│  │  ├─ reads.ts            #   status / log / branches / drift reads
│  │  ├─ files.ts            #   changed-files tree, file content/diff, search, discard, write
│  │  ├─ guards.ts           #   shared guardRepo() (NOT_FOUND / SUBMODULE)
│  │  └─ index.ts            #   barrel — the single public import surface for the service
│  ├─ read/                 # pure read-only inspection layer (no mutation, no service deps)
│  │  ├─ status.ts           #   simple-git status / branch / rev-list
│  │  ├─ inspect.ts          #   log + commit detail (parents/isMerge), changed-files
│  │  └─ diffstat.ts         #   per-file +/- diff stats (toggleable)
│  ├─ vcs/                  # pluggable VCS backend (VcsBackend interface)
│  │  ├─ index.ts · types.ts #   registry + interface
│  │  ├─ git.ts              #   git backend (default)
│  │  └─ lore.ts · lore-sdk.ts  # Epic's Lore (experimental, REPOYETI_LORE=1)
│  ├─ mcp/                  # hand-rolled MCP server (zero new deps; JSON-RPC 2.0 + MCP)
│  │  ├─ core.ts             #   transport-agnostic dispatch (initialize/ping/tools.list/tools.call)
│  │  ├─ tools.ts            #   the 14-tool catalog (readOnly vs MUTATES)
│  │  ├─ backend.ts          #   McpBackend interface the tools call
│  │  ├─ adapter-service.ts  #   in-process adapter (service/db) — behind POST /api/mcp
│  │  ├─ adapter-http.ts     #   HTTP adapter (cli/client) — behind `repoyeti mcp`
│  │  └─ stdio.ts            #   newline-delimited JSON stdio server; diagnostics → stderr
│  └─ (flat kernel)         # db.ts · discovery.ts · watcher.ts · opqueue.ts · git-actions.ts ·
│     …                      #   identity.ts · secrets.ts · auth.ts · tunnel.ts · runtime.ts ·
│     …                      #   instance.ts · config.ts · remote-sync.ts · ai.ts · bus.ts · …
├─ web/                      # Vue 3 + Vite + Tailwind PWA
│  ├─ src/ … (App, RepoCard, IdentitySelector, sse client)
│  └─ vite.config.ts         # build → embedded static assets
├─ shim/                     # OAuth redirect shim — now DEAD reference code (named tunnel + own /oauth/callback)
├─ vendor/cloudflared/       # pinned per-platform binaries
└─ scripts/build.ts          # vite build → bun --compile per target
```

The daemon is the **primary artifact**; `web/` builds into it; `vendor/cloudflared/` ships with it;
`shim/` is retired (the named tunnel + the daemon's own `/oauth/callback` replaced it — see
§15, Remote access); a future `tray/` (Tauri) would spawn the same binary unchanged.
`scripts/check-boundaries.ts` enforces the layering: `read ⊥ service`, `vcs ⊥ service`, `cli ⊥
service/read/git`, and the MCP core/tools/backend touch the service only through their adapters.

---

## 12. Decisions explicitly closed (so they aren't re-litigated)

- **SQLite, not JSON** — concurrent writers. (All three briefs agree.)
- **SSE, not WebSockets** — server-push, event-driven, auto-reconnect through cloudflared.
- **Auth = "Sign in with Connections" (public OIDC), not a homegrown credential and not the internal
  Studio path** — RepoYeti is a stand-alone relying party that only calls the public
  `accounts.connections.icu/oauth/*` URLs and verifies tokens via the public JWKS; it shares no secret
  with and imports nothing from the Connections repo. (Owner directive: public API, auth only, stand-alone.)
- **DECIDED: free quick tunnel + a fixed redirect shim** (§7). The daemon stays zero-config on the free
  rotating tunnel; a tiny stable shim (Cloudflare Worker `*.workers.dev`, recommended — or Pages/GitHub
  Pages) is the registered OAuth redirect and bounces login back to the daemon, so the **phone logs in
  directly** with no domain and no ngrok. PKCE + signed `state` keep the bounce safe. The *dashboard* URL
  still rotates until a real domain is bought (then the shim is dropped).
- **Bun, not Node** — single-binary compile + built-in SQLite kills the worst Windows packaging pain.
- **Tauri deferred to last** — the CLI binary + phone browser is the whole product.
- **"Behind" is intentionally stale** — never auto-fetch on watch events.

---

## 13. connections.icu integration — what the owner provisions

RepoYeti is a **stand-alone relying party** that uses connections.icu **only** for "Sign in with
Connections" (public OIDC). It imports nothing from the Connections repo. To light up auth end-to-end
(everything else builds without it), the owner provides — all via the **public developer console**
(`studio.connections.icu` → developer apps), not by editing the Connections monorepo:

1. **A registered RepoYeti OAuth app.** Create a "Sign in with Connections" app → yields a public
   **`client_id`** (and, if registered confidential, a `client_secret` that stays only on the daemon).
   Scopes: `openid profile email`.
2. **The redirect URI** = the fixed **shim** URL (§7), e.g. `https://repoyeti-auth.<account>.workers.dev/cb`
   (Cloudflare Worker, recommended) or a `*.pages.dev` / `*.github.io` page. **This is the only stable URL
   that gets registered;** the daemon itself stays on the free rotating tunnel. (Optionally also register
   `http://127.0.0.1:<port>/oauth/callback` for the Path-B desktop fallback.)
3. **The trusted owner identity** — the `sub` (or email) RepoYeti should accept. Get it from
   `/oauth/userinfo` after a test login, or from the owner's account record. → daemon config/keychain.
4. **The redirect shim (free; I can build + deploy it).** A ~30-line **Cloudflare Worker** (or static
   Pages/GitHub page) that reads `state`, validates the daemon URL against an allowed pattern, and 302s
   the login back to the daemon. Lives on a free `*.workers.dev` / `*.pages.dev` / `*.github.io` URL —
   **no custom domain, not connections.icu's zone.** I can write + deploy the Worker via the Cloudflare
   API. It's dropped entirely once you own a domain and the daemon registers its own callback.

That's it — no AWS Secrets Manager entry, no Connections-repo change, no shared M2M secret. Everything
the daemon needs (issuer, client_id, redirect, scopes) is public OIDC config; the only sensitive item
is an optional confidential `client_secret`, which lives in the daemon keychain.

**Build-order note:** Phases 1, 3, 4 (daemon core, git ops, tunnel+PWA) need none of this. Phase 2
(auth) is built against the **public OIDC contract** above using the discovery doc, and lights up the
moment the owner registers the app and supplies the `client_id` + trusted `sub`.

---

## 14. Smart Commit (AI multi-commit splitter)


> **Goal.** One tap turns a pile of uncommitted changes — the kind several AI agents
> produce when they edit a repo in parallel — into a set of small, logically-scoped,
> well-named commits instead of one giant dump. The AI reads the whole working tree,
> decides *what happened* as a whole and per file, proposes an ordered set of commits,
> and (after you review/edit) creates them. Optional one-tap sync afterward.
>
> This is an **opt-in button**, never the default. The normal "stage-all + commit" path
> is untouched.

---

### 1. The one decision that shapes everything: granularity

**v1 splits at the FILE level — whole files are grouped into commits; a file is never
split across two commits.**

Why not line/hunk level (the "even smarter" option)?

- RepoYeti's **central, non-negotiable invariant** (ARCHITECTURE.md §7, gap-analysis
  header): *"the daemon never leaves a repo in an unsafe / half-merged state."* Hunk-level
  staging means programmatically applying a **subset of a file's hunks** to the index
  (`git apply --cached` of a partial patch). That can fail/conflict and leave a file
  **partially staged** — exactly the stranded state the whole product is designed to avoid.
  The gap analysis already files hunk-level staging under **Tier 3 — rejected by design**.
- File-level staging is the opposite: **Tier 2 — planned** ("`git add <paths>` then commit
  without `-A`"). Every individual commit is atomic; if the sequence is interrupted, the
  result is "some commits made, the rest still uncommitted in the working tree" — a
  perfectly normal, safe, recoverable git state.
- It's not an intelligence limit. The model is plenty capable of per-file intent. The
  limiter is **execution safety on a phone with no undo**.
- **Prior art agrees.** GitKraken's shipping *AI Commit Composer* (Jan 2026) groups at
  **file level only** — you can't split one file's hunks across commits in its UI either.
  This is the proven, safe shape.

**Mixed-concern files** (one file with two unrelated changes) are handled the
industry-standard way at file granularity: the file is assigned to its **dominant**
commit and the secondary change is **noted in that commit's body**. We never create a
broken commit to chase purity.

> **Future, explicitly deferred:** a hunk-level "deep split" mode *can* be layered on later
> as an opt-in power-user toggle (see §10). The architecture below is built so that adding
> it is additive, not a rewrite. It stays off until/unless we decide to relax the invariant.

---

### 2. Prior art (what we borrowed)

| Source | What we take |
|---|---|
| **GitKraken AI Commit Composer** | The whole UX shape: AI proposes a set of commits → user reorders / edits messages / **moves files between commits** / regenerates → "Create commits". File-level only. |
| **llm-git "compose mode"** | (a) snapshot the change-set *once* before the AI call so live edits can't contaminate; (b) **topologically order** commits so prerequisites land first; (c) error loudly if execution would produce zero commits while changes remain. |
| **jj absorb / GitButler** | Principle: when attribution is ambiguous, **refuse to guess** rather than make a mess. Surfaces as our "leftovers" group. |
| **Atomizer / SmartCommit / ColaUntangle (academic)** | Pure-LLM grouping misfires on (a) over-grouping similar-but-distinct changes, (b) cross-file relationships, (c) cosmetic edits. We mitigate with an explicit prompt taxonomy + a deterministic fallback, and keep a human in the loop. |
| **Atomic-commit best practice** | Conventional-Commits taxonomy; co-change clustering (source+test+types+docs together); foundation-first ordering; lockfile-with-manifest; cosmetic isolation. Encoded in the prompt. |

---

### 3. Architecture: **Plan → Review → Execute**

Three clean stages, mapping onto RepoYeti's existing layering (read-only inspection vs.
op-queue mutation vs. routes vs. store/UI).

```
                 ┌── Plan (read-only, no mutation) ──────────────────────────┐
 [Smart Commit]  │ collect changed files + bounded per-file diffs            │
   button  ───►  │ → AI returns a structured JSON plan (groups + messages)   │
                 │ → validate / fall back → return plan to UI. NOTHING runs. │
                 └───────────────────────────────────────────────────────────┘
                                        │
                 ┌── Review (full editor, client-side) ──────────────────────┐
                 │ ordered commit cards: edit subject/body, move files        │
                 │ between groups, merge / split / reorder, switch message    │
                 │ style, regenerate plan or one message. Nothing committed.  │
                 └───────────────────────────────────────────────────────────┘
                                        │  "Commit all" (▾ picks sync)
                 ┌── Execute (one op-queue slot, atomic per commit) ─────────┐
                 │ re-validate plan vs CURRENT tree → for each group:         │
                 │   git add -- <paths> ; git -c user.* commit -m <msg>       │
                 │ → optional pull-ff + push → refresh → per-commit result.   │
                 └───────────────────────────────────────────────────────────┘
```

#### Why two endpoints (plan and execute are decoupled)
The AI plan is a *suggestion*. The user edits it freely in the browser. Execution takes
the **edited** plan, not the AI's original — so the server re-validates the submitted
groups against the live working tree before touching anything. This also means a flaky/slow
provider can never block or corrupt a commit: planning and committing are independent calls.

---

### 4. Data shapes

```ts
// A single proposed commit (shared daemon ⇄ web).
interface CommitGroup {
  type: string;        // conventional type: feat|fix|refactor|test|docs|chore|style|perf|build|ci
  scope?: string;      // optional lowercase subsystem, e.g. "auth", "web/settings"
  subject: string;     // imperative, ≤72 chars (the message subject line)
  body?: string;       // optional body (used for the "secondary change" note, etc.)
  files: string[];     // repo-relative paths assigned to this commit
  rationale?: string;  // one-line "why these belong together" — shown as a hint, not committed
}

interface CommitPlan {
  groups: CommitGroup[];
  // Files the AI couldn't confidently place. Surfaced as an editable "Unassigned" group;
  // execution refuses while anything is unassigned.
  leftovers?: string[];
  degraded?: boolean;  // true when this came from the deterministic fallback, not the AI
  truncated?: boolean; // true when the diff sent to the AI was capped (large change-set)
}

// What the daemon feeds the AI (built locally, bounded).
interface CommitPlanInput {
  files: Array<{ path: string; status: string; from?: string; additions: number; removals: number; binary: boolean }>;
  diff: string;        // per-file-delimited, bounded unified diff
  truncated: boolean;
}

// What the UI POSTs to execute (the EDITED plan).
interface SmartCommitRequest {
  commits: Array<{ message: string; paths: string[] }>;  // message = subject + optional body
  sync?: boolean;      // after all commits: pull --ff-only then push (mirrors CommitMode 'sync')
}
```

#### The final commit message
`message` is assembled client-side as `"<type>(<scope>): <subject>"` + (`\n\n` + body if
present). Conventional formatting is applied in the UI so the user sees and can edit the
exact final text, and the server commits it verbatim (same as the existing commit route).

---

### 5. AI layer (`src/ai.ts`)

Add a sibling to `generateCommitMessage` — **`generateCommitPlan`** — reusing the existing
adapter map, `requestJson`, and per-provider `buildBody`/`extractCompletion`. No adapter is
rewritten; we add **structured-JSON support** as an optional adapter capability.

- **Prompt.** A new system prompt that (a) states the file-level rule and the
  Conventional-Commits taxonomy, (b) gives the grouping heuristics (co-change:
  source+test+types+docs together; cosmetic isolated; lockfile with its manifest; new files
  before dependents), (c) demands **strict JSON only** matching the `CommitPlan` schema,
  (d) requires **every supplied path to appear in exactly one group** (or in `leftovers`
  only if genuinely ambiguous), (e) requires foundation-first ordering.
  The user message carries the `CommitPlanInput` (file list + numstat + bounded diff).
- **JSON mode (robustness).** Extend `AiAdapter` with an optional `jsonBody` builder:
  - OpenAI-compatible (openai/deepseek/groq/openrouter): add
    `response_format: { type: "json_object" }`.
  - Gemini: add `generationConfig.responseMimeType: "application/json"`.
  - Anthropic: no native flag needed — prompt-enforced JSON; we parse defensively.
  Bump `max_tokens` for this call (JSON is wordier → ~4096) and the request timeout (→ ~40s).
- **Parsing.** A dedicated parser: strip an accidental ```` ```json ```` fence, `JSON.parse`,
  then **validate with a zod schema**. Do **not** run `cleanCommitMessage` (it would corrupt
  JSON). On parse/validate failure: one retry with a terser "return ONLY JSON" reminder;
  still failing → throw `AiError("AI_ERROR", …)` so the route can fall back.
- **Validation (pure, unit-tested):** every input path appears exactly once across
  `groups[].files ∪ leftovers`; no unknown paths; subjects non-empty; types in the allowed
  set (unknown type → coerced to `chore`). Returns a normalized `CommitPlan`.

#### Deterministic fallback (no AI / AI failed / changeset too big)
A pure function `heuristicPlan(input)` groups files **without a model**:
- bucket by **top-level directory / module** (e.g. `src/`, `web/src/components/`, `tests/`,
  `docs/`), with new-vs-modified-vs-deleted as a secondary split, lockfiles pinned to their
  manifest's bucket;
- templated conventional subjects (`chore(<scope>): update N files`, `test(<scope>): …`,
  `docs: …`), `degraded: true`.
The UI shows a banner: *"AI couldn't structure this — here's a basic grouping. Edit before
committing."* This guarantees Smart Commit **always produces an editable plan**, even with
no key configured (though the button is gated on `aiEnabled` for the AI path).

---

### 6. Git layer (`src/git-actions.ts`)

#### Read: `collectCommitPlanInput(absPath): Promise<CommitPlanInput>`
Read-only, bounded, never mutates the index (same discipline as `collectCommitDiff`):
- `git status --porcelain=v1` → file list + statuses (+ rename `from→to` via `-M`/`status`).
- `git diff HEAD --numstat -M` → per-file additions/removals + binary detection (`-` rows).
- A **per-file-delimited** bounded diff with a **larger budget** than the message path
  (~40 KB total) and a **per-file cap** (so one huge file can't starve the rest). Files
  whose diff is omitted still carry path+status+numstat for grouping. Untracked files are
  included by name (their content counts as additions). Uses the same `boundedGit`
  streaming-with-early-kill helper.

#### Mutate: `gitCommitGroups(absPath, identity, commits): Promise<CommitGroupsResult>`
The heart of execution. **All of it runs inside a single op-queue slot** (the service
wrapper enqueues once — never per commit — and refreshes *after* the slot releases, per the
documented same-key-nesting deadlock rule).

```
preflight (readStatus): DETACHED_HEAD → fail; dirty === 0 → NOTHING_TO_COMMIT
git reset -q                       # MIXED reset: index → HEAD. Working tree UNTOUCHED.
                                   # (Safe; same family as discardFile's reset. NOT --hard.)
for (const c of commits) {
  git add -A -- <c.paths>          # stage exactly this group: mods, new files, deletions,
                                   #   and a rename's old+new path (we include `from`)
  git -c user.* commit -m c.message
  → record { ok, code?, message?, subject }
  if a commit fails (e.g. a pre-commit hook rejects): STOP, return partial result.
}
```
- After each commit the index returns to clean, so the next `add` stages only the next
  group. Disjoint+complete validation upstream guarantees no overlap.
- **Identity** is injected per commit exactly like `gitCommitAll` (`identityConfigArgs`),
  so global/repo config stays byte-identical (acceptance criterion #10).
- **Partial failure is a SAFE state**, reported honestly: "committed K of N; the remaining
  changes are still in your working tree." No half-merge, no rollback needed, nothing lost.
- **Renames:** the changed-file reader is enriched to expose `from` for `R` entries; a
  rename's group includes both `from` and `to` so the deletion of the old path is staged
  with the addition of the new one.

> Note on `git reset` (mixed): it only moves the index pointer back to HEAD — it **never
> touches the working tree** and is fully reversible (just re-stage). This is categorically
> different from the forbidden `reset --hard`. It guarantees each group's commit contains
> exactly that group's files regardless of any pre-existing staged state.

---

### 7. Service layer (`src/service/` — `reads.ts` + `actions.ts`)

- `planCommitInput(repoId)` — like `collectRepoDiff`: enqueue a `readStatus` (refuse
  submodule / `NOTHING_TO_COMMIT`), then `collectCommitPlanInput`. Read-only.
- `smartCommitRepo(repoId, commits, sync)` —
  1. Look up repo + identity; guard NOT_FOUND / submodule.
  2. **Re-validate** the submitted `commits` against a fresh `readChanges`: every path is
     currently changed, paths are disjoint across commits, and the union covers the changed
     set (extra/vanished paths → `PLAN_STALE`, prompting the UI to re-plan).
  3. `enqueue(repoId, () => gitCommitGroups(...))` — one slot for the whole sequence.
  4. If `sync` and all commits succeeded: reuse the existing pull-ff + push legs.
  5. `refreshRepo` **after** the slot releases.
  Returns `{ ok, committed: [...], remaining, synced?, code }`.

### 8. Contract + schemas + routes

- **`src/contract.ts`** — new codes (mirrored in `web/src/types.ts`):
  `PLAN_STALE` (409), `EMPTY_PLAN` (400), `PLAN_PATHS_INVALID` (400),
  `AI_PLAN_FAILED` (502, when AI structuring fails *and* fallback is disabled — normally we
  fall back instead). Reuse `AI_*`, `NOTHING_TO_COMMIT`, `DETACHED_HEAD`, `NO_*`.
- **`src/schemas.ts`** —
  `CommitPlanSchema = { provider?: string }` (mirror of `CommitMessageSchema`);
  `SmartCommitSchema = { commits: [{ message: nonEmpty, paths: string[].min(1) }].min(1), sync?: boolean }`.
- **HTTP routes (`src/http/routes/`)** — (the old monolithic `daemon.ts` is now split into per-domain route modules)
  - `ai.ts`: `POST /api/repos/:id/commit-plan` → resolve provider/key/model → `planCommitInput` →
    `generateCommitPlan` (fall back to `heuristicPlan` on AI failure) → `{ ok, plan }`.
    409 on `NOTHING_TO_COMMIT`.
  - `git-ops.ts`: `POST /api/repos/:id/smart-commit` → `parseBody(SmartCommitSchema)` → `smartCommitRepo`
    → map result via `statusForCode`.

### 9. Web (`web/`)

- **`api.ts`** — `ai.commitPlan(repoId, provider?)` and `smartCommit(repoId, commits, sync?)`.
- **`types.ts`** — `CommitGroup`, `CommitPlan`, the new codes.
- **`store.ts`** — `genCommitPlan(repoId)`, `smartCommit(repoId, commits, sync)`, and plan
  state (the in-progress plan per repo so the editor is reactive).
- **UI** — a new **`SmartCommitPlan.vue`** (a responsive Sheet/dialog, matching the existing
  shadcn-vue Sheet pattern used by Settings/Identity) opened from a **Smart Commit** button
  beside the existing commit box in `RepoCard.vue` (visible when `aiEnabled` and there are
  changes). The **full editor**:
  - ordered, drag-reorderable commit cards (reuse `@formkit/drag-and-drop`, already a dep);
  - per-card: type/scope badge + editable subject + expandable body + file chips;
  - **move a file** to another card (drag a chip, or a "move to…" menu);
  - **merge** two cards, **split** a card, **delete** a card (its files → Unassigned),
    **regenerate** the whole plan or one card's message;
  - a live preview of each final `type(scope): subject` line;
  - header: a **commit-message style** picker (conventional / concise / detailed) — the same
    owner setting as Settings → AI, surfaced here because this is where its effect shows;
    changing it saves and re-drafts the plan;
  - footer: a split **Commit all** button whose **▾** picks plain vs. **& sync** (mirrors the
    Commit/Auto split buttons on the card; the chevron is dropped when there's no remote), plus
    **Cancel** (discards the plan, no git change); a banner when `degraded`/`truncated`; an
    "Unassigned" group blocks commit.
- **`locales/en.json`** — all new strings (i18n scaffolding is retained even though the app
  ships English-only).

### 10. Safety analysis (invariant compliance)

| Risk | Mitigation |
|---|---|
| Half-staged / half-merged tree | File-level only; `git add -- <paths>` + `commit` per group; index normalized first; never `apply --cached` partial hunks. End state is always either fully committed or "some commits + clean remainder". |
| Interrupted mid-sequence | Each commit is atomic. Partial result reported; remaining changes sit safely in the working tree. No rollback needed, nothing lost. |
| Plan stale (tree changed between plan and execute) | Server re-validates submitted paths vs. live `readChanges`; mismatch → `PLAN_STALE`, UI re-plans. |
| Op-queue race / deadlock | Whole sequence in **one** `enqueue(repoId)` slot; `refreshRepo` only **after** it releases. |
| AI key leakage | Unchanged daemon-proxy model — the key never leaves the host; the browser only ever sees paths + messages. |
| Identity / config mutation | Per-commit `-c user.*` injection; global/repo config untouched. |
| Push divergence | `sync` reuses the existing pull-ff + non-force push guards (409/403). Splitting changes none of that. |
| Provider returns garbage | Strict zod validation + one retry + deterministic fallback. Never executes an unvalidated plan. |
| Reversibility from the phone | Commits are **local** until you choose `sync` — no worse than today's commit button. (Auto-branching for extra safety is a possible future, deliberately not in v1; it's off-pattern for RepoYeti.) |

### 11. Edge cases

- **Untracked / new files** — staged via `git add -- <path>`; counted as additions in stats.
- **Deletions** — `git add -- <deletedpath>` stages the removal (git ≥2.0).
- **Renames** — old+new path travel together in one group (reader exposes `from`).
- **Binary / large files** — flagged in the plan input (no textual diff sent); grouped by
  path/stat; can be isolated by the model or the user.
- **Lockfiles** — prompt rule pins them to their manifest's group; fallback buckets them with
  the manifest's directory.
- **>2000 changed files** — `getChanges` already caps at `MAX_CHANGED_FILES`; Smart Commit
  shows the same "N of M" truncation and operates on the visible set (banner warns).
- **Single logical change** — the AI may legitimately return one group; the UI still lets you
  "Commit all" (== a normal commit) so the button is never a dead end.

### 12. Implementation plan (build order)

1. **AI core** — `ai.ts`: `generateCommitPlan` + JSON-mode adapter capability + zod plan
   schema + `parseCommitPlan` + `heuristicPlan`. Unit-test parsing/validation/fallback.
2. **Git core** — `git-actions.ts`: `collectCommitPlanInput` + `gitCommitGroups`; enrich the
   changed-file reader with rename `from`. Test multi-commit execution on a real temp repo.
3. **Service + contract + schemas** — `planCommitInput`, `smartCommitRepo`, new codes/schemas.
4. **Daemon routes** — `commit-plan`, `smart-commit`. HTTP route tests (incl. `PLAN_STALE`).
5. **Web data layer** — `api.ts`, `types.ts`, `store.ts`.
6. **Web UI** — `SmartCommitPlan.vue` + `RepoCard.vue` button + `en.json`.
7. **Verify** — `bun test` green; `vue-tsc`/build green; runtime smoke test over HTTP.

### 12b. YOLO mode (shipped)

A global owner setting (`cfg.ai.yolo`, Settings → AI) flips the Smart Commit button from
**plan → review → execute** to **plan → execute** with no editor: it generates the plan and
commits it immediately. For an owner who trusts the AI and won't edit the plan. Guard rails
that stay on even in YOLO:
- **Never auto-pushes** — committing is local and undoable at the desk; pushing is outward-facing,
  so it's left to an explicit Push/Sync tap.
- **Nothing is silently dropped** — any planner `leftovers` are committed as a final
  `chore: miscellaneous changes` commit.
- Same server-side re-validation (`PLAN_STALE`/`PLAN_PATHS_INVALID`) and single-op-queue-slot
  execution as the reviewed path.
The button shows a small **YOLO** tag when the mode is on.

### 12c. Token efficiency (shipped)

The planner's diff is **token-trimmed** so more change-sets fit a provider's rate limit (the free
Groq tier is 6000 tokens/min) and every call is cheaper — without any external dependency or model:
- **Zero-context diffs** (`git diff -U0`) — just the changed lines, no surrounding context (grouping
  doesn't need it; *message* generation still uses full context).
- **Noise folding** (`isNoisyPath`) — the diff *bodies* of lockfiles, `*.min.js/.css`, `*.map`,
  `*.snap`, `*.lock` are dropped; the file **list** still carries them (with stat) so grouping a
  lockfile *with its manifest* still works. The model only needs to *know* they changed, not read
  thousands of generated lines.

Measured ~99.9% diff reduction on a lockfile-heavy change (136 KB → 151 chars), with the AI plan
still `degraded:false`. (Concept borrowed from claw-compactor's "diff folding"; implemented as ~40
lines in `collectCommitPlanInput`, kept in that one function so a future TS compressor can drop in.
A generic compressor like LLMLingua was rejected — it can corrupt code semantics and needs a bundled
model; the only diff-specific tool, claw-compactor, is Python and can't live in the Bun binary.)

### 13. Future (deferred, additive)

- **Hunk-level "deep split"** opt-in (would require an explicit decision to relax the
  invariant + a partial-patch apply path with conflict-safe fallback to whole-file).
- **Per-commit test gate** (`--compose-test-after-each`-style) before each commit.
- **Auto-branch** the plan for one-tap undo.
- **Topological auto-ordering** from import/symbol scanning (today ordering is the model's
  judgment + manual reorder).

---

## 15. Remote access — named Cloudflare tunnel (runbook)


> **TL;DR.** RepoYeti is reachable from a phone at **`https://app.repoyeti.com`** via a **named
> Cloudflare tunnel** (not the old rotating, DNS-blocked `*.trycloudflare.com` quick tunnel). The
> tunnel + DNS were provisioned **through the Connections vault** (no raw Cloudflare token ever
> touched this machine). Login is done **the right way** — the daemon registers and uses its **own**
> `/oauth/callback`, and the old redirect "shim" Worker is **deleted**. The Cloudflare layer is
> verified; the only thing not yet runtime-proven is a live end-to-end sign-in (needs the daemon
> running + one real login).

---

### Why we moved off trycloudflare
The quick tunnel gave a **rotating** `*.trycloudflare.com` URL, and that namespace is **widely
DNS-blocked** (it's abused for malware/phishing), so phones on filtered networks got
`DNS_PROBE_FINISHED_NXDOMAIN`. A **named tunnel on our own domain** is stable and resolves everywhere.

### The tunnel (live, verified at the Cloudflare layer)
| Thing | Value |
|---|---|
| Cloudflare account | **`36d7c731fd0352ef08ea7e46d2d20793`** (Lunawerx@gmail.com) — owns the `repoyeti.com` zone (`a71592246b44b2282bd071ae0e8ca095`) |
| Tunnel id | **`ce2ba43f-73f3-49d8-9e89-72d2e419d0bd`** (named `repoyeti`, remotely-managed) |
| Public hostname | `app.repoyeti.com` → `http://localhost:7171` (ingress configured in the tunnel) |
| DNS | proxied CNAME `app.repoyeti.com → ce2ba43f-…​.cfargotunnel.com` |
| Connector | `cloudflared` (2025.8.1, installed) running with the connector token |

**How it was provisioned:** entirely through the **Connections vault** — `connections_execute` against the
Cloudflare catalog endpoints (`cfd_tunnel` create/configure/token, `dns_records` create, `zones` lookup), with
the Cloudflare credential injected server-side, value-blind. See the Connections repo
`docs/architecture/mcp-catalog-executor.md` §7 for the exact mechanism (and the catalog bugs that had to be
fixed first to make it work at all).

**Verified:** the connector registers at Cloudflare's edge (4 QUIC connections) and a request to
`https://app.repoyeti.com` routes through the tunnel to `localhost:7171` (returns 502 only because the daemon
isn't currently listening — which itself proves the ingress is correct).

### Daemon side (code + config)
- **Named-tunnel support** (this was new — the quick tunnel was the only option before):
  `src/tunnel.ts` → `startNamedTunnel()` (`cloudflared tunnel run --token …`, advertises `https://<hostname>`
  on first edge connection); `src/config.ts` → `TunnelConfig` + `namedTunnel()` resolver (token is a keychain
  secret, env override `CF_TUNNEL_TOKEN`); `src/runtime.ts` → `startManagedTunnel(cfg)` picks named vs quick.
- **Config:** `~/.repoyeti/config.json` →
  `"tunnel": { "provider":"named", "hostname":"app.repoyeti.com", "token":"<connector token>" }`.
  The token moves to the OS keychain on boot and is stripped from disk.
- **UI:** the Remote-access modal overflow (long URL pushing the copy button off the card) was a CSS-grid
  `min-width:auto` trap — fixed with `min-w-0` on the link block in `web/src/components/RemoteAccess.vue`.

### Login — the right way (no shim)
The old design used a **rotating** tunnel URL, so OAuth (which needs a fixed registered redirect) used a tiny
"shim" Worker that bounced the login back to the daemon's current address. **With a stable domain that's
obsolete.** Now:
- **IdP registration** (Connections `developer_app_registrations`, a registered public `client_id`):
  `redirect_uris = [ https://app.repoyeti.com/oauth/callback , http://127.0.0.1:7171/oauth/callback ]`.
  (The previous entry was malformed — `…/cb%20and`, old `gitmob-auth` name — and would have failed login.)
- **Daemon** (`src/auth.ts`): `/oauth/login` sends `redirect_uri = <its own origin>/oauth/callback`;
  `/oauth/callback` exchanges with the same value, derived from the **HMAC-signed `state`** (so it can't be
  tampered). The IdP allow-list + the signed origin double-gate against open redirects.
- **Shim retired:** the `gitmob-auth` Worker (it was never re-deployed under the new name) was **deleted** from
  the Lunawerx Cloudflare account. `shim/` in this repo is now dead reference code.

### Headless agents — an optional Bearer API token (no browser needed)
A **remote or headless AI agent** can't complete the browser-based OIDC dance. For that case the
owner can mint an **optional API token** and the agent authenticates with a Bearer header:
- `repoyeti token new` mints + prints the token **once** (`POST /api/auth/token`); `repoyeti token
  revoke` deletes it; `repoyeti token show` reports only whether one is configured.
- Then send `Authorization: Bearer <token>` (or set `REPOYETI_TOKEN` for the CLI verbs and
  `repoyeti mcp`).
- It's a **separate, local credential** (constant-time compared, kept in the OS keychain) — it never
  touches connections.icu and exists only on this daemon.
- **Off by default, and it never weakens the default posture.** When no token is set, auth is
  byte-for-byte the OIDC-only behavior described above; a request over the tunnel still requires a
  signed-in owner *or* the explicit token. The token is purely additive, for the headless case.

### To bring it fully live
1. Run RepoYeti with **remote access on** (it reads `~/.repoyeti/config.json` and runs the named-tunnel
   connector itself; `cloudflared` is installed).
2. **Sign in once** over `app.repoyeti.com` to claim ownership (a request over the tunnel always requires the
   owner session — the security invariant). This is the one step not yet runtime-verified.

### Security notes
- A request arriving over the tunnel **always** requires a signed-in owner, in any mode (loopback can "continue
  local"). Enabling remote refuses until an owner is claimed (no stranger races TOFU on a fresh tunnel).
- The named-tunnel host is a normal `repoyeti.com` record — **not** on any trycloudflare blocklist.

### Open
- **Live sign-in not yet proven** (needs the daemon running). If the IdP rejects the redirect URI, it's an app-
  registration cache TTL — re-try shortly.
- **Google Cloud** (used elsewhere via the operator) still needs a re-connect for a fresh token — unrelated to
  this tunnel; see the Connections doc §8.
- Daemon code edits (`auth.ts`, `config.ts`, `tunnel.ts`, `runtime.ts`) are in the working tree.

---

## 16. Shared kit & cross-repo consolidation

RepoYeti's frontend is built on a shared design system: a set of common UI primitives, composables,
and server-side helper libraries that keep the codebase consistent and avoid reinventing common
plumbing.

### 16.1 What the shared kit provides

- **Web libs** (`web/src/lib/`, `web/src/components/ui/**`, `web/src/shell/**`): `relativeTime`,
  `httpClient` (the `ApiError` + fetch wrapper), `useSelfUpdate` (self-update composable + toast
  branching), `i18n-core` (the `createAppI18n` factory), and `theme` (`useTheme`), plus shadcn-style
  UI primitives and `styles/kit-*.css` design tokens (unified content width `--container-max: 800px`).
- **Server libs** (each app's `serverLib` dir): `mcp-stdio` (the zero-dep, Bun+Node JSON-RPC 2.0 / MCP
  dispatch + stdio loop — RepoYeti's `src/mcp/core.ts` + `stdio.ts` are thin adapters over it),
  `instance-pointer` (the `runtime.json` live-instance pointer), `updater-engine` (git check/apply
  self-update), and `find-free-port` (the bind-and-walk port picker `src/cli/lifecycle.ts` uses).

### 16.2 Conventions to preserve

- **Colours go through semantic tokens** (`success` / `warning` / `info` / `primary` / `destructive`),
  never raw Tailwind palette classes.
- **Deliberately bespoke, leave alone:** `web/src/components/FileViewer.vue` (resizable Monaco).
- **AI is bring-your-own-key** — no bundled key (Groq revokes any key committed to a public repo, so a
  shipped one is dead on arrival). Owners add their own in Settings → AI; Groq is the *suggested*
  provider (`AI_CATALOG` `suggested` flag). Keys live in the OS keychain, never in `config.json`.

### 16.3 A few pieces stay app-specific by design

The self-update **DTOs** (`UpdateStatus` / `UpdateApplyResult`) and the SSE event schema are specific
to RepoYeti's own server, even though the *logic* around them mirrors the shared pattern above. OIDC/PKCE
auth (`src/auth.ts`) is likewise RepoYeti's own implementation of the shared "Sign in with Connections"
pattern described in §13.

---

*Marching orders end. Phase 1 starts with the watcher→SQLite→HTTP loop and the keytar spike — prove
those two and the rest is wiring. Auth (Phase 2) is a standard "Sign in with Connections" OIDC relying
party (§7/§13) and lights up the moment the owner registers the RepoYeti OAuth app.*

---

## 17. Share links — the guest principal

> **Owner decision (2026-07-15).** Two people work the same codebase on opposite shifts, both leave
> AI agents running overnight, and each wants to see — and sometimes flush — the other's uncommitted
> work without waiting for them to wake up. So: a **share link**. A secret URL, like a Google Drive
> "anyone with the link" share, that opens the owner's dashboard for someone with **no Connections
> account and no sign-in**.

This is the only place a non-owner can reach the daemon, so it is written to be audited. §7's threat
model ("the only way in is an owner login") is amended by this section, not superseded by it: the
owner login is still the only way to become the **owner**. A share link is a different, lesser thing.

### What a link is

| | |
|---|---|
| **The credential** | 32 random bytes (`randomBytes`, base64url) in the URL: `https://<tunnel>/s/<token>`. Guessing is not a threat model at 256 bits — there is no rate limit and none is needed. |
| **At rest** | Only `sha256(token)`, in `shares.token_hash`. A stolen `repoyeti.db` yields hashes, not links. The plaintext exists **exactly once**, in the mint response; it cannot be recovered afterwards, by design — the owner revokes and re-mints instead. |
| **Tiers** | `view` — repos, uncommitted files, diffs, history. `control` — plus the sync loop (fetch/pull/push/stage/commit/commit-selected) and Smart Commit (which spends the **owner's** AI key — an explicit owner call). |
| **Scope** | Named repos, or "all repos" (which includes ones discovered later). A per-repo link never widens on its own. |
| **Expiry** | 1 hour / day / week / month / year / never. Enforced on every request, not just at redemption. |
| **Revocation** | One `UPDATE`; effective on the guest's **very next request**. |

### The five properties that make it safe

1. **Default-deny, enforced at the one chokepoint.** `src/share/policy.ts` is an *allowlist* keyed by
   route pattern; anything absent is owner-only. It is enforced in `authMiddleware` — the single
   `app.use("/api/*")` every request crosses — because there is **no deeper chokepoint**: `db.getRepo(id)`
   takes only an id and knows nothing about the caller, and routes reach it three inconsistent ways
   (respond.ts's helpers, a second lookup in the service layer, and two hand-rolled lookups in
   `tags.ts` / `files.ts` that bypass the helpers). Enforcing scope anywhere else would silently miss those.
2. **A new route is denied AND noticed.** `tests/share-policy.test.ts` walks the live Hono routing
   table and fails unless **every** route appears in exactly one of two lists (guest-allowed, or
   explicitly owner-only). Default-deny already makes an unclassified route safe; the guard is what
   makes it *visible*. It reads `app.routes`, **not** openapi.ts's `META` — `META` looks like the
   registry but isn't (buildOpenApiDoc emits a fallback for anything missing, so its own drift guard
   passes while `META` silently lacks ~11 real routes).
3. **Revocation is why there are rows.** Owner sessions are stateless signed cookies (`db.ts` says so:
   there is intentionally no `sessions` table). Share links are the deliberate exception: a guest
   cookie carries only a share id and **every request re-reads the row**, because "revoke this one
   link, now, without touching my own session" is exactly what a stateless token cannot do.
4. **The guest sees a projection, not the truth.** `GET /api/repos` is scope-filtered; `/api/status`
   returns display knobs only (never the tunnel/MCP/auto-commit/editor config); `/api/auth/status`
   carries no owner identity; SSE is filtered per-connection against both the share's scope **and** an
   event allowlist (`src/share/events.ts`) — the raw bus carries `settings_changed`, `daemon_status`,
   `scan_*` and `approval_pending`, none of which is a guest's business. Credentials embedded in a
   remote URL (`https://user:ghp_x@…`) are stripped from everything a guest sees.

   > Measured, not assumed. Owner and guest streams captured over one 12-second window while a scan
   > ran: the **owner** received 48 `repo_added` (each carrying a repo's absolute path), 51
   > `repo_state_changed`, `settings_changed`, `scan_started`, `scan_progress`. The **guest**, scoped
   > to one repo, received 2 `repo_state_changed` — its own — and nothing else. That's the shape of
   > the leak this filter exists to prevent.
5. **The audit trail exists because git can't answer.** A guest's commits are authored as the **owner**
   (their machine, their tree, their identity — the owner chose this), so git history genuinely cannot
   distinguish "my brother pushed this" from "I did". `share_events` can, and is written for every
   guest mutation, allowed or denied.

### Deliberately NOT granted to a control link

Each of these was considered and refused; they are listed in `OWNER_ONLY` in `src/share/policy.ts`:
working-tree edits (`PUT /file`) · `discard` (destroys the owner's uncommitted work) · `move` /
`gitignore` · branch `checkout`/create/delete · `stash` · `tag` · `remote` set/delete (a MITM
primitive, not a git op) · repo `identity`/`account` (chooses which credential authors and
authenticates) · `auto-commit` opt-in (arms an unattended push timer) · `fetch-all` (spans every
repo; not scopeable) · editors/`open` (launches processes on the owner's desktop) · MCP + approvals ·
all settings/roots/mode/tunnel/updates/shutdown · share administration itself (a guest minting a link
would be privilege escalation).

**`amend` is the one body-level exception.** Commit and amend are the same route, split only by a
flag, so the route-level policy cannot separate them — `routes/git-ops.ts` refuses `amend` for a
guest explicitly. Amend rewrites the previous commit, possibly the owner's own unrelated work; a
plain commit is additive and recoverable, an amend is neither.

### Operational notes

- A link is worthless without a tunnel (`mode: remote`). The Sharing panel says so rather than
  minting a link that can't be opened, and builds the URL against the tunnel origin — not the
  `localhost` the owner is probably reading it on.
- **Owner always wins.** A browser holding both an owner session and a guest cookie is the owner. The
  practical consequence: to preview what a guest sees, open the link in a private window.
- Rotating the signing key ("sign out everywhere") also invalidates every guest cookie — but not the
  links themselves, which are rows; the next `/s/<token>` open issues a fresh cookie. Revoke to kill
  a link.
- **`share_events` is capped at 500 rows per share**, pruned on write, because the table is written
  by the guest's own requests — without a bound the link-holder decides how big it gets. Pruned by
  `rowid`, deliberately: `at` is millisecond-resolution, so a hammering client's rows share one
  timestamp and an `at`-based prune would delete nothing in exactly the case the cap exists for.
  The cap is per-share, so a noisy link can't evict a quiet one's history.
- The daemon's own PWA must not fetch owner-only endpoints as a guest. Not a security rule — an
  audit-legibility one: each such fetch writes a "denied" row and buries the real entries. See the
  `isGuest` branches in the web store's `loadAll` and `AppShell.onMounted`.
