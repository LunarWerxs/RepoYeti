# Despoke / Dependency Audit

Ordered by severity and likely maintenance/security ROI. P1 is highest.

## P1 - Replace the bespoke OIDC/PKCE/session flow with a maintained OIDC client

- Evidence: `src/auth.ts:58-71` hand-rolls signed state/session tokens; `src/auth.ts:76-89` implements OIDC discovery and JWKS caching; `src/auth.ts:93-98` creates PKCE values; `src/auth.ts:164-181` builds the authorization URL; `src/auth.ts:203-225` exchanges the code and verifies the ID token. The routes are the auth boundary for `/api/*` in `src/daemon.ts:79-107`.
- Risk/impact: the tunnel feature depends on this code being exactly right. State, callback, token, nonce, cookie, issuer, and audience handling are security-sensitive protocol details, and a subtle mismatch can turn into account confusion or unauthenticated remote access.
- Suggested fix: move protocol handling to `openid-client` or an equivalent maintained OIDC client. Let it perform discovery, PKCE, authorization URL generation, callback validation, and token-set validation. Keep GitMob's owner check as local policy after the validated claims are returned. Use a maintained signed/encrypted session-cookie helper (or Hono-compatible session middleware) rather than custom `sign`/`unsign`, then add tests for tampered state, expired transactions, issuer/audience mismatch, and owner mismatch.

## P1 - Move secrets out of source/plain JSON config and remove the built-in shared AI key

- Evidence: `src/config.ts:41-44` documents that AI keys are stored in `~/.gitmob/config.json`; `src/config.ts:66-70` models raw provider API keys in config; `src/config.ts:110-115` contains a literal built-in Groq key; `src/config.ts:191-195` persists the full config as JSON; `src/daemon.ts:263-273` accepts and saves user API keys; `src/auth.ts:48-53` persists the session signing key as a raw file.
- Risk/impact: the hard-coded provider key ships in the repo/binary and can be abused or rate-limited globally. User API keys and OAuth client secrets are also easy to leak through backups, support bundles, local malware, or platform permission quirks. `0600` helps on Unix but is not a complete cross-platform secret-storage story.
- Suggested fix: add a `secrets.ts` boundary backed by the OS credential store, for example `keytar` or another maintained Windows Credential Manager/macOS Keychain/libsecret wrapper, with a documented encrypted-file fallback only if native storage is unavailable. Store only secret handles in config. Remove and rotate the embedded Groq key; require BYOK or proxy free-tier access through a service that can enforce quotas and rotation.

## P2 - Replace hand-written multi-provider AI adapters with a maintained provider SDK layer

- Evidence: `src/config.ts:46-62` hard-codes the provider catalogue; `src/ai.ts:40-67` owns provider endpoints; `src/ai.ts:71-127` parses model lists; `src/ai.ts:177-190` builds provider auth headers; `src/ai.ts:200-230` implements timeout/error mapping; `src/ai.ts:262-283` shapes generation requests; `src/ai.ts:298-310` extracts completions from provider-specific response bodies.
- Risk/impact: provider APIs and model naming schemes change often. Keeping request bodies, auth headers, model filters, and response parsing in bespoke code means every provider drift becomes a GitMob bug, especially for OpenAI-compatible providers that are only mostly compatible.
- Suggested fix: evaluate Vercel AI SDK provider packages, official provider SDKs, or a small maintained OpenAI-compatible abstraction for generation. Keep only the GitMob-specific prompt construction and error vocabulary locally. If model discovery still needs provider-specific code, isolate it behind a small interface, cache responses, and cover each provider with contract fixtures.

## P2 - Add shared schema validation and typed API plumbing instead of ad hoc JSON parsing

- Evidence: `web/src/types.ts:1-88` manually mirrors daemon response shapes; `src/daemon.ts:113-124`, `src/daemon.ts:129-137`, `src/daemon.ts:144-166`, `src/daemon.ts:197-204`, `src/daemon.ts:240-255`, `src/daemon.ts:258-274`, `src/daemon.ts:293-306`, and `src/daemon.ts:321-350` parse/coerce request bodies by hand; `web/src/api.ts:23-35` parses JSON and casts to a generic `T`.
- Risk/impact: route contracts can drift silently between backend and frontend. Coercing `unknown` bodies with `String(...)` and local allowlists makes validation inconsistent, and the client trusts response shapes at compile time without runtime guarantees.
- Suggested fix: introduce shared `zod` schemas with `@hono/zod-validator` for request bodies, params, and important responses. Use Hono's typed client/RPC helpers or shared inferred types so the Vue client is generated from the server contract instead of maintaining `web/src/types.ts` by hand.

## P3 - Replace the custom `.git` watcher with a robust maintained watcher abstraction

- Evidence: `src/watcher.ts:2-10` intentionally watches only `.git` and `.git/logs`; `src/watcher.ts:30-36` uses `node:fs.watch` and silently degrades when a watch cannot be installed; `src/service.ts:125-132` notes that manual refresh is needed for working-tree edits the watcher intentionally misses.
- Risk/impact: `fs.watch` behavior varies by platform and filesystem. Silent watch failures leave the mobile UI stale, and Git state changes can happen through files outside the two watched directories, such as refs, packed refs, rebase/merge markers, and worktree indirection.
- Suggested fix: use `chokidar` or `@parcel/watcher` with a targeted Git-path watch set (`HEAD`, `index`, `logs/HEAD`, `refs/**`, `packed-refs`, merge/rebase marker files) plus a polling fallback and health telemetry. Keep the current debounce and per-repo operation queue.

## P3 - Use Hono/Bun static-file serving APIs instead of maintaining a custom SPA server

- Evidence: `src/daemon.ts:406-441` resolves `web/dist`, implements SPA fallback, decodes paths, checks traversal, special-cases `.webmanifest`, and returns `Bun.file` responses manually.
- Risk/impact: static serving accumulates edge cases: malformed percent-encoding, MIME types, cache headers, conditional requests, range requests, and traversal checks. This is low product value code sitting on every non-API request.
- Suggested fix: mount Hono's Bun `serveStatic` middleware for built assets and keep a small explicit `index.html` fallback for SPA routes. Add immutable cache headers for hashed assets and preserve the existing 503 when `web/dist/index.html` is missing.

## P4 - Consider replacing recursive repo discovery with a maintained glob/scanner if roots get large

- Evidence: `src/discovery.ts:13-28` maintains a custom skip list; `src/discovery.ts:36-72` performs synchronous depth-limited BFS over every configured root.
- Risk/impact: scanning a home directory or large workspace can block daemon startup, and the skip list will keep growing as new build/cache directories are encountered. Symlink loops, permission errors, and platform-specific directory behavior are easy to miss in a custom scanner.
- Suggested fix: if discovery performance or edge cases become visible, switch to `fast-glob`/`tinyglobby` style scanning for `**/.git` with explicit ignores, depth limits, symlink handling, and concurrency. Keep the current semantics that a repo is a leaf and submodule/worktree pointers are flagged.

## P5 - Remove or replace the low-value `qrcode-terminal` dependency

- Evidence: `package.json:20` declares `qrcode-terminal`; `src/index.ts:13` imports it and `src/index.ts:157-160` uses it once to print the tunnel URL QR code; `src/types/qrcode-terminal.d.ts:1-5` exists solely to patch missing types.
- Risk/impact: this is an untyped dependency plus a local type shim for one convenience print path. It adds maintenance surface to the CLI build without affecting the daemon or PWA.
- Suggested fix: remove it and print the remote URL only, or replace it with a maintained typed QR package if terminal QR codes are still a must-have. Delete `src/types/qrcode-terminal.d.ts` if the dependency goes away.
