# Add "Sync my settings with Connections" to this app

A portable spec for adding an **optional, one-click settings-sync** feature to a web app,
backed by [Connections](https://connections.icu) as the identity + storage provider.

> **Hand-off note:** This file is self-contained. Give it to an AI agent or a developer
> working on any codebase (a Vue/React/Svelte SPA, an Electron app, or an app with its own
> Node/Bun/Go backend). It tells you exactly what to build and what the owner must set up once.
> Everything in the "Verified facts" section was probed live against the Connections API and is
> accurate as of 2026-07-03.

---

## 1. What we're building (the user-facing goal)

A small, **opt-in** control on the Settings page — an icon or a "Sync settings" button, nothing
more. When the user clicks it:

1. They're asked to **sign in with their Connections account** (or create one). This is a
   standard OAuth/OIDC redirect to `accounts.connections.icu`.
2. After they come back signed in, the app **pushes their current settings to the cloud** and,
   from then on, **pulls them on every device/app** where they sign in with the same account.
3. If they never click it, nothing changes — settings stay local. Sync is purely additive.

The magic: the **same Connections account produces the same user id (`sub`) in every app**, so
one person's theme/accent/layout/preferences follow them across this app, its sibling apps, and
any future app that adopts this same spec.

---

## 2. Architecture in one picture

```
  ┌─────────────┐   1. OIDC login (Authorization Code + PKCE, public client, NO secret)
  │   The App    │ ───────────────────────────────────────────────► accounts.connections.icu
  │  (browser)   │ ◄─────────────── id_token + access_token ───────  (Connections identity)
  └──────┬──────┘        (contains a stable `sub` for this user)
         │
         │   2. GET/PUT the user's settings blob, authorized by that token
         ▼
  ┌──────────────────────────┐   validates the token against Connections' JWKS,
  │  Settings store (KV)      │   extracts `sub`, reads/writes one row per (sub, appId)
  │  keyed by (sub, appId)    │
  └──────────────────────────┘
```

Two independent layers. **Do not conflate them:**

| Layer | What it does | Who provides it | Build effort |
|-------|--------------|-----------------|--------------|
| **Identity** | "Sign in with Connections", gives you a stable per-user `sub` | Connections (ready, live) | ~none — standard OIDC |
| **Storage** | Stores/returns the per-user settings JSON | **You** (a tiny KV endpoint) | ~1 small service (~100 lines) |

Connections is a full OIDC provider, but it has **no generic per-user key-value / "app-data"
store** exposed to third-party apps (its writable per-user objects are semantic ones — contacts,
events, forms, a MyConnect profile page). So the settings blob needs a home. See §5.

---

## 3. Verified facts about Connections (probe results)

**Identity provider (OpenID Connect):** discovery doc at
`https://accounts.connections.icu/.well-known/openid-configuration`

| Field | Value |
|-------|-------|
| `issuer` | `https://accounts.connections.icu` |
| `authorization_endpoint` | `https://accounts.connections.icu/oauth/authorize` |
| `token_endpoint` | `https://accounts.connections.icu/oauth/token` |
| `userinfo_endpoint` | `https://accounts.connections.icu/oauth/userinfo` |
| `jwks_uri` | `https://accounts.connections.icu/oauth/jwks` (1 key, `RS256`) |
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `authorization_code`, `refresh_token`, `device_code`, `client_credentials` |
| `code_challenge_methods_supported` | `["S256"]` → **PKCE supported** |
| `token_endpoint_auth_methods_supported` | `["none", "client_secret_post", "client_secret_basic"]` → **`none` = public SPA clients supported, no secret needed** |
| `subject_types_supported` | `["public"]` → **same `sub` for a given user across ALL apps** (the cross-app sync key) |
| `id_token_signing_alg_values_supported` | `["RS256"]` |
| `claims_supported` | `sub`, `name`, `given_name`, `family_name`, `picture`, `email`, `email_verified`, `entitlements`, `is_paid`, `custom_answers` |

**Identity consent scopes you should request:** `openid profile email` (add `photo` if you want the
avatar). That's all the sync feature needs. Full catalog: `GET https://studio.connections.icu/v1/oauth-scopes`.

**Registering the "Sign in with Connections" app (owner does this once):**
```
POST https://studio.connections.icu/v1/oauth-apps
Authorization: Bearer <OWNER_DEV_KEY>          # cnx_live_… — OWNER ONLY, never shipped to clients
Content-Type: application/json

{
  "name": "RepoYeti / DevWebUI / <your app>",
  "redirectUris": [
    "https://app.example.com/connections/callback",
    "http://localhost:5173/connections/callback"     // add each dev/self-host origin you need
  ],
  "homepageUrl": "https://example.com",
  "scopes": ["openid", "profile", "email"]
}
→ { "client_id": "...", "client_secret": "...(shown once)..." }
```
- One app registration can carry **many redirect URIs** — you can share a single `client_id`
  across all sibling apps, or register one per app. Sharing one is simpler and still gives the
  same `sub`.
- For a **public SPA client** you use only the `client_id` (+ PKCE). You can ignore the
  `client_secret`. Keep the secret **only** if you run the robust BFF variant (§4b).
- Edit URIs later without re-registering: `PATCH /v1/oauth-apps/{id}`.

---

## 4. The login flow (identity layer)

Pick **4a** (simplest) unless you want tokens to never touch JavaScript, then pick **4b**.

### 4a. SPA-only, public client + PKCE (recommended default — no backend for login)

Standard OAuth 2.0 Authorization Code + PKCE. In the browser:

1. **Start:** generate a random `code_verifier`, derive `code_challenge = S256(code_verifier)`,
   store `code_verifier` + a random `state` in `sessionStorage`, then redirect to:
   ```
   https://accounts.connections.icu/oauth/authorize
     ?response_type=code
     &client_id=<CLIENT_ID>
     &redirect_uri=<THIS_APP_CALLBACK_URL>
     &scope=openid%20profile%20email
     &code_challenge=<CHALLENGE>
     &code_challenge_method=S256
     &state=<STATE>
   ```
2. **Callback:** at your `redirect_uri`, verify `state`, then exchange the `code`:
   ```
   POST https://accounts.connections.icu/oauth/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=authorization_code
   &code=<CODE>
   &redirect_uri=<SAME_CALLBACK_URL>
   &client_id=<CLIENT_ID>
   &code_verifier=<VERIFIER>
   ```
   → `{ access_token, id_token, refresh_token?, expires_in, token_type }`
3. **Identify:** decode the `id_token` (JWT) or call `GET /oauth/userinfo` with
   `Authorization: Bearer <access_token>`. Keep the `sub` — that's the sync key. Keep `email` /
   `name` / `picture` to show "Synced as you@example.com".
4. **Refresh:** when `access_token` nears expiry, POST `grant_type=refresh_token&refresh_token=…&client_id=…`.

> **One thing to verify at integration time:** that the browser's `POST /oauth/token` isn't blocked
> by CORS. Public-client (`none`) support strongly implies browser token exchange is allowed. If a
> given deployment's CORS blocks it, route just the token exchange through your storage service
> (§5) — it's already there — which turns this into the 4b pattern.

**Don't hand-roll PKCE if you can avoid it.** Use a small, audited OIDC client library
(e.g. `oidc-client-ts` for browser SPAs, or your framework's OAuth plugin). Point it at the
discovery URL above; it handles PKCE, state, token refresh, and JWT validation.

### 4b. BFF variant (most secure — tokens never touch JS)

If you're already standing up the storage service (§5) and want maximum security, make that
service a **Backend-for-Frontend**: it performs the code→token exchange (as a confidential client
using the `client_secret`), keeps the `refresh_token` server-side, and hands the browser an
**httpOnly, Secure session cookie** instead of tokens. The SPA then calls the storage endpoints
with the cookie. This is the OAuth-for-SPAs best practice and eliminates token theft via XSS.
Choose this when the app already has a server (many do) — the marginal cost is small.

### 4c. If your app is a local daemon (localhost server + browser UI) — prefer BFF

Many dev tools are a **single-user local daemon**: a small server bound to `127.0.0.1` that
serves a Vue/React SPA to a browser tab (optionally exposed remotely via a tunnel). If that's your
app, the daemon **is** your BFF — use it. The flow:

- The daemon runs the OIDC login (§4a) and, crucially, **retains the `refresh_token`** in a
  secure server-side spot (OS keychain if available, else a `0600` JSON file under the app's
  config dir — the same place the app already keeps other secrets).
- To sync, the **daemon** (not the browser) calls the settings store (§5) server-to-server, minting
  a fresh access token from the refresh token as needed. No browser CORS, no tokens in JS.
- The SPA just calls a local daemon route (e.g. `GET/PUT /api/settings/sync`) behind the daemon's
  existing session/auth. The daemon translates that into the cloud call.
- Because these tools are single-user, "the owner's `sub`" from login is the only identity you
  need — the settings row is keyed by that one `sub` (per `appId`). Cross-machine sync happens
  because the same person signs into the daemon on machine B with the same account → same `sub`.

---

## 5. The settings store (storage layer) — the only real thing to build

You need a per-user JSON blob addressed by `(sub, appId)`. Two ways to provide it; **Option A is
recommended.**

### Option A — a tiny KV endpoint keyed by the token's `sub` (recommended)

A minimal HTTP service with exactly two routes. It **validates the incoming Connections token**
(verify the JWT signature against `https://accounts.connections.icu/oauth/jwks`, check `iss` =
`https://accounts.connections.icu` and `aud` = your `client_id`), pulls `sub` out of it, and
reads/writes one row. The app **never** sends the owner key — only the end-user's own token.

```
GET  /app-data/{appId}          Authorization: Bearer <user access_token or id_token>
     → 200 { "settings": {...}, "updatedAt": "2026-07-03T12:00:00Z", "version": 7 }
     → 404 if the user has nothing stored yet

PUT  /app-data/{appId}          Authorization: Bearer <user token>
     body: { "settings": {...}, "baseVersion": 7 }
     → 200 { "updatedAt": "...", "version": 8 }
     → 409 if baseVersion is stale (another device wrote first) — return current for merge
```

- **Storage:** any KV/row store keyed by `(sub, appId)` — a single DB table, DynamoDB, Redis,
  Cloudflare KV, even a JSON file per user for a self-hosted single-tenant app.
- **`appId`** namespaces each app (`"repoyeti"`, `"devwebui"`, …) so sibling apps don't collide,
  while still sharing the identity. Apps that *want* to share a subset can agree on a common
  namespace (e.g. `"shared-appearance"`) for just those keys — see §6.
- **Concurrency:** the `version` / `baseVersion` guard turns a blind overwrite into a detectable
  conflict. Cheap and worth it.
- **Where it lives:** the owner controls Connections' own backend, so the cleanest long-term home
  is a first-class `/v1/app-data/{appId}` route added to Connections Studio itself (it's designed
  to be extended). Equivalent and faster to start: a standalone Cloudflare Worker / AWS Lambda /
  tiny Node service. **Same contract either way — the app code doesn't change if you migrate.**

### Option B — no new infra, store inside the user's MyConnect object (fallback)

If standing up any service is a hard no, request `myconnect:read myconnect:write` in the OAuth
scopes and stash a namespaced settings blob inside the user's MyConnect profile
(`GET/PATCH https://studio.connections.icu/...my-connect`). **Downsides, know them going in:**
it's a single shared object (all apps + the user's real profile share it → collision/clobber
risk), it's semantically a public-ish profile page (wrong place for dev-tool prefs), and it
requires broader consent. Use only as a stopgap; migrate to Option A when you can.

---

## 6. Client integration steps (do these in the app)

1. **Config.** Add the OIDC discovery URL, `client_id`, `appId`, and storage base URL to app
   config/env. No secrets in the client (unless BFF, where the secret lives only on the server).
2. **Find the settings choke-point.** Locate the single module that loads and saves settings
   today (a store, a `useSettings()` composable, a `settings.json` reader). All sync hooks in
   there so you touch persistence logic in exactly one place.
3. **Add a `SyncClient` module** with: `login()`, `logout()`, `isSignedIn()`, `currentUser()`,
   `pull(): Settings | null`, `push(settings, baseVersion)`. Back it with the OIDC library (§4)
   and the storage endpoints (§5).
4. **Wire the choke-point:**
   - **On save** (settings change) — if signed in, debounce and `push()` the new blob.
   - **On login / app start when signed in** — `pull()`; if remote exists, apply it (see merge
     policy below); if remote is empty, `push()` the current local settings as the initial seed.
   - Keep writing to **local storage too** — the cloud is a sync layer over the local source of
     truth, so the app still works offline / signed out.
5. **Merge / conflict policy.** Keep it simple and predictable:
   - Default: **last-write-wins by `updatedAt`**, but on a `409` (stale `baseVersion`) fetch the
     current remote and either (a) prefer remote and re-apply locally, or (b) shallow-merge
     key-by-key with remote winning on conflict. Whichever you pick, surface it ("Settings
     updated from another device").
   - Decide **which keys are syncable.** Sync portable prefs (theme, accent, layout, feature
     toggles). **Do not** sync machine-specific or secret values (absolute file paths, local
     tokens, window geometry, per-machine credentials). Maintain an explicit allowlist of synced
     keys — never blindly sync the whole settings object.
6. **The UI (small, opt-in).** A single control in Settings with these states:
   - *Signed out:* an icon/button — "Sync settings with Connections". Click → `login()`.
   - *Signing in:* spinner during redirect/callback.
   - *Signed in:* a compact row — avatar/email + "Synced ✓" + a "Stop syncing / Sign out" action.
   - *Error:* inline, non-blocking ("Couldn't reach sync — using local settings").
   Nothing about this should be load-bearing; if the user ignores it, the app is unchanged.
7. **Privacy copy.** One line near the button: what syncs, where it goes (their Connections
   account), and that it's optional. Let them **disconnect** (sign out + optionally delete the
   remote blob via a `DELETE /app-data/{appId}` you can add to §5).

---

## 7. Security rules (non-negotiable)

- **Never put the owner `cnx_live_…` key in any client, bundle, repo, or browser.** It's a
  god-key (billing, revenue, key-minting, every user's data). Clients only ever hold the
  **end-user's own** token, obtained via the user's own login.
- **Request least privilege:** `openid profile email` for identity; a storage scope only if you
  chose Option B. Don't request contacts/events/pay/etc. — the sync feature doesn't need them.
- **Validate tokens server-side** in the storage service: verify JWT signature against JWKS,
  check `iss`, `aud`, and `exp`. Never trust a `sub` the client claims — derive it from the
  verified token.
- **Prefer BFF (§4b) when a backend exists** so tokens never live in JS (XSS-resistant). If
  tokens must live in the browser, keep them in memory, refresh via the refresh token, and never
  in `localStorage`.
- **CORS:** lock the storage service's CORS to your app origins.

---

## 8. One-time owner setup checklist

- [ ] Register the OAuth app → get `client_id` (§3). Add every redirect URI (prod + each
      dev/self-host origin).
- [ ] Stand up the settings KV service (Option A) OR decide on Option B.
- [ ] Hand the integrating app(s): the discovery URL, `client_id`, `appId`, storage base URL,
      and (only if BFF) the `client_secret` **to the server side only**.

## 9. Per-app implementation checklist (for the integrating agent/dev)

- [ ] Add OIDC client + config; implement the login/callback/refresh (§4).
- [ ] Implement `SyncClient` (`pull`/`push`) against the storage contract (§5).
- [ ] Hook the settings choke-point for load/seed/save + define the syncable-key allowlist (§6).
- [ ] Add the small opt-in Settings control with its four states (§6.6).
- [ ] Test: sign in on app A → change theme → sign in on app B (or app A on a second machine) →
      theme follows. Confirm signed-out behavior is unchanged. Confirm a mid-flight conflict
      (edit on two devices) resolves per your policy without data loss surprises.

---

## 10. Feasibility summary

**Yes — this is feasible and the identity half is essentially free.** Connections is a standard,
live OIDC provider with public-client PKCE and a stable cross-app `sub`, so "Sign in with
Connections" needs no custom identity work and no backend. The only thing to build is a small
per-user settings KV endpoint (Option A, ~100 lines) plus a thin client sync layer hooked into
each app's existing settings module. The design is portable: any additional app adopts it by
reusing the same `client_id` + storage contract and adding its own `appId` namespace.
