# Verified GitMob Action List

Consolidates `dry_gpt.md`, `slow_gpt.md`, `despoke_gpt.md`, `delete_gpt.md`, and `deviant_gpt.md`.

Criteria used: keep only items that still match the current codebase, have clear product/security/maintenance ROI, and are not just aesthetic cleanup. Duplicate findings are merged. P1 is highest priority.

## Verification Snapshot

- `bun run typecheck` passes.
- `bun test` passes: 47 tests, 0 failures.
- `bun run --cwd web build` passes; only dependency pure-annotation Rollup warnings were emitted.
- The committed Groq API key path is removed. `rg "BUILTIN_AI|gsk_|built-in free key|Free built-in key|isBuiltinProvider|isBuiltin\\(" src tests web` now only finds the Groq key placeholder text in Settings.

## Completed In This Pass

- [x] **P1 - Strip ambient `PAGER` from git subprocesses.**
  - Verified real: `safeGitEnv()` removed `GIT_PAGER` but not `PAGER`, and this shell's `PAGER=cat` broke git status/diff tests.
  - Done: `src/git.ts` now deletes `PAGER`; regression coverage added in `tests/git-actions.test.ts`.

- [x] **P1 - Remove the source-resident built-in Groq key and no-setup AI default.**
  - Verified real: `src/config.ts` embedded a `gsk_...` key and made Groq the effective default, enabling diff upload without explicit setup.
  - Done: built-in key/default behavior removed; BYOK starts unconfigured; tests updated in `tests/ai.test.ts` and `tests/ai-routes.test.ts`.

- [x] **P1 - Refuse public tunnel startup until an owner is configured.**
  - Verified real: `--tunnel` allowed first remote sign-in to claim ownership if OAuth was configured but owner was unset.
  - Done: `tunnelStartProblem()` blocks missing auth or missing owner; coverage added in `tests/auth.test.ts`.

- [x] **P1 - Put changed-file reads behind the per-repo operation queue.**
  - Verified real: `/api/repos/:id/changes` bypassed `enqueue()`.
  - Done: `getChanges()` now serializes through the repo queue and returns typed errors; coverage added in `tests/service.test.ts`.

- [x] **P2 - Preserve `fetchedAt` across ordinary refreshes and mark successful pulls as fetch-fresh.**
  - Verified real: non-fetch refreshes cleared the timestamp explaining how fresh `behind` was.
  - Done: `refreshRepo()` carries previous `fetchedAt`; `pullRepo()` marks successful pulls as fetched; coverage added.

- [x] **P2 - Fix manual `.git` file semantics and explicit repo source conflicts.**
  - Verified real: discovery marked `.git` files as submodule/worktree pointers, but manual registration always stored `isSubmodule=false`; `upsertRepo()` ignored explicit `source` on conflict.
  - Done: manual registration preserves `.git` file semantics; `upsertRepo()` upgrades `auto` to `pinned`/`created` and refreshes `updated_at`; coverage added.

- [x] **P2 - Resolve bundled `cloudflared` before `PATH`.**
  - Verified real: build copied `vendor/cloudflared`, but runtime spawned `cloudflared` from `PATH`.
  - Done: resolver prefers `dist/vendor/...`, falls back to executable name; coverage added in `tests/tunnel.test.ts`.

- [x] **P2 - Add OIDC network timeouts.**
  - Verified real: discovery and token exchange used plain `fetch` while AI already used request timeouts.
  - Done: auth fetches now use a 15s timeout.

- [x] **P2 - Bound SSE per-client backlog.**
  - Verified real: each SSE connection had an unbounded array and drained it with `shift()`.
  - Done: queue is capped and drained in batches.

- [x] **P3 - Harden `core.sshCommand` key-path handling.**
  - Verified real: identity `sshKeyPath` was interpolated into a shell command string.
  - Done: key paths now expand `~`, reject shell-sensitive characters, require an existing file, and normalize safely; coverage added.

- [x] **P3 - Make config writes atomic.**
  - Verified real: config was written directly to `config.json`.
  - Done: `saveConfig()` now writes a temp file and renames it into place.

- [x] **P4 - Consolidate small frontend duplications.**
  - Verified real: identity initials/tints and locked sheet-side behavior were duplicated.
  - Done: added `web/src/lib/identity-display.ts` and `web/src/lib/use-locked-sheet-side.ts`; reused from `RepoCard.vue`, `IdentityManager.vue`, and `Settings.vue`.

## Completed (2026-06-28 follow-up)

> Tree state after this follow-up: `bun test` → 78 pass / 0 fail, `bun run typecheck` → clean,
> `bun run --cwd web build` → green (PWA precache fix for the Monaco worker chunks landed via the
> parallel Monaco/file-viewer effort). The five `*_gpt.md` files in this dir are the historical
> audit inputs; **this file is the live tracker** — update here, not there.

- [x] **P1 - Bound global git subprocess concurrency + coalesce refreshes + progressive boot.**
  - Done: new `src/gitgate.ts` — `readGate` (8, env `GITMOB_GIT_READ_CONCURRENCY`) wraps `readStatus`/`readChanges`; `netGate` (4, env `GITMOB_GIT_NET_CONCURRENCY`) wraps fetch/pull/push in `git-actions.ts`. Each gate is held around a single git call only, and a remote op's preflight read releases `readGate` before taking `netGate`, so the two pools never nest → deadlock-free. `service.ts` `coalescedRefresh` collapses watcher/poll bursts to ≤1 in-flight + 1 trailing pass (user paths `runAction`/`forceRefresh` still await `refreshRepo` exactly). `src/index.ts` now watches → serves → hydrates in the BACKGROUND (`hydrateInitialStatuses`) so a slow/hung repo can't block boot. Tests in `tests/gitgate.test.ts`; smoke-booted a real daemon (served repos immediately, hydrated statuses progressively).

- [x] **P2 - Add watcher health and fallback polling.**
  - Done: `src/watcher.ts` `WatchHandle.watching` reports whether the `.git` watch actually installed; `src/service.ts` `startPollFallback` + `watcherHealth()` — a repo whose `fs.watch` fails falls back to ~30s jittered polling and logs a warning. Tests in `tests/watcher.test.ts` + `tests/service.test.ts`.

- [~] **P2 - Cap changed-file responses (SERVER side done; client display still TODO).**
  - Done: `getChanges` caps at `MAX_CHANGED_FILES=2000` with `total`/`truncated`, forwarded by `/api/repos/:id/changes`. Test in `tests/service.test.ts`.
  - Remaining (still in Keep: Do Next): `Map`-backed tree builder + virtual/capped client display + a "showing N of M" notice (needs a new i18n key across all 5 `web/src/locales/*` or `i18n-check.mjs` fails the build).

- [~] **P3 - Reduce redundant status/remote lookups (remote-URL caching done).**
  - Done: `src/status.ts` `resolveRemote` caches the origin URL keyed on `.git/config` mtime+size, skipping a `git remote -v` subprocess per status read. Test in `tests/status.test.ts`.
  - Remaining (low value, mostly N/A): reusing a preflight status across an action's pre/post reads.

## Completed (2026-06-28 second follow-up)

> Tree state after this pass: `bun test` → 158 pass / 0 fail, `bun run typecheck` → clean,
> `bun run --cwd web build` → green. New files: `src/contract.ts`, `src/secrets.ts`,
> `tests/contract.test.ts`, `tests/auth-protocol.test.ts`, `tests/auth-oidc-verify.test.ts`,
> `tests/secrets.test.ts`.

- [x] **P1 - Centralize API result/error contracts.**
  - Done: new `src/contract.ts` is the single source of truth — `ApiErrorCode`/`ApiCode` union,
    `statusForCode()` (one HTTP-status map, replacing the duplicate `httpStatusFor` + `aiHttpStatus`
    in `daemon.ts`), and a `jsonError(c, code, message?, status?)` helper. Every `daemon.ts` route
    now emits the same `{ ok, code, message }` envelope (the bare `{ error }` bodies are gone), and
    `git-actions.ts` `ActionCode` is the shared union. Fixed the concrete drift bug: a git action on
    a missing repo now returns **404 `NOT_FOUND`** (was a 500 `ERROR`), and submodules return
    `SUBMODULE_NOT_ACTIONABLE`. `web/src/types.ts` mirrors the code union (was `code: string`).
    Coverage in `tests/contract.test.ts`.

- [x] **P2 - Stream or pre-limit AI diff collection.**
  - Done: `collectCommitDiff` (`src/git-actions.ts`) now collects status + diff through a streaming
    `boundedGit()` (Bun.spawn) that reads at most N bytes then **kills the child** — a generated file
    or 100k-line change is no longer fully buffered before the 24 KB cap. 30s kill-timer; same safe
    git env; read-only. Existing `tests/ai.test.ts` cases (small diff + huge-diff truncation) stay green.

- [x] **P3 - Heavily test bespoke OIDC protocol code** (focused tests; client-swap still optional).
  - Done: `tests/auth-protocol.test.ts` covers forged/tampered signed `state` (HMAC), expired login
    transactions, wrong-owner sub/email, and tampered/expired session cookies. `tests/auth-oidc-verify.test.ts`
    now ALSO covers `id_token` `iss`/`aud`/`exp` rejection + a valid-token positive control: `handleComplete`
    gained an optional `{ fetchImpl, jwksSet }` seam (defaults = production), and the tests mint tokens with an
    ephemeral RS256 keypair + a mock discovery/token fetch. Swapping to a maintained OIDC client stays optional.

- [x] **P1 - Move owner secrets to an OS keychain boundary.**
  - Done: chose **`Bun.secrets`** (built into the Bun runtime — Windows Credential Manager / macOS Keychain /
    libsecret), so NO `keytar` native addon and NO bespoke crypto (owner directive: simplest, lowest-maintenance).
    New `src/secrets.ts` boundary (`getSecret`/`setSecret`/`deleteSecret` + `keychainAvailable`). AI provider
    `apiKey`s + any OAuth `clientSecret` now live in the keychain; `config.json` keeps only the model. `config.ts`
    `hydrateSecrets()` (called at boot in `index.ts`) loads keys into the in-memory config and MIGRATES any legacy
    plaintext key out of `config.json`; `saveConfig()` strips secrets from disk. Daemon connect/delete routes write/
    delete keychain entries. Graceful fallback: if no OS secret service, secrets stay in `config.json` (0600) + a
    one-time warning — no key loss. Coverage in `tests/secrets.test.ts` (verified against Windows Credential Manager).

- [x] **P2 - Consolidate AI provider adapters (backend).**
  - Done: `src/ai.ts` is now one `AI_ADAPTERS` map keyed by provider (modelsUrl / generateUrl / headers / models /
    buildBody / extractCompletion), with a shared `openAiCompatible()` factory for openai·deepseek·groq·openrouter.
    The five parallel switch/if chains are gone; `parseModels`/`extractCompletion`/`listModels`/`generateCommitMessage`
    are unchanged thin delegators (all `tests/ai.test.ts` cases green). NOTE: the FRONTEND provider-metadata
    duplication (web/src/types.ts + Settings.vue) is NOT deduped yet — see "Keep: Do Next".

- [x] **P4 - Update stale docs wording.**
  - Done: corrected the retired "Naive UI" stack references in `README.md` and `MARCHING_ORDERS.md`
    to the real stack (reka-ui / Tailwind v4 / VueUse / vue-sonner). Narrow wording only; no doc deletion.

## Keep: Do Next

- [x] **P1 - Move owner secrets to an OS keychain boundary.** (DONE — see Completed 2026-06-28 second follow-up)
  - Done via `src/secrets.ts` (Bun.secrets — no native addon, no bespoke crypto) + `hydrateSecrets`/`saveConfig` strip.

- [x] **P1 - Centralize API result/error contracts.** (DONE — see Completed 2026-06-28 second follow-up)
  - Done via `src/contract.ts` (`ApiErrorCode`, `statusForCode`, `jsonError`) + `web/src/types.ts` mirror.

- [ ] **P2 - Add schema validation for request bodies and params.**
  - Verified real: route handlers repeatedly coerce `unknown` JSON by hand.
  - Suggested path: use a small shared schema layer, likely `zod` plus Hono validation, after the error contract is centralized.

- [x] **P2 - Consolidate AI provider metadata and local adapters.** (DONE — third pass 2026-06-28)
  - Done: single `AI_CATALOG` in `src/config.ts` (`AI_PROVIDERS` derived from it), exposed via `GET /api/ai/catalog`;
    `web/src/components/Settings.vue` consumes it (no more hardcoded provider rows). `AiProviderId` union kept type-only
    with a sync comment. Backend `AI_ADAPTERS` map landed in the second pass.

- [x] **P2 - Cap changed-file responses: optimize tree + client display.** (DONE — third pass 2026-06-28)
  - Done: `Map`-backed tree builder in `web/src/lib/util.ts` (was O(n²) on wide trees); `api.changes` now returns
    `total`/`truncated`; store exposes `changesMeta`; `RepoCard.vue` shows a "showing N of M" notice (en.json
    `repo.changes.truncated`). Full DOM virtualization deferred (collapse + the 2000-row server cap already bound it).

- [x] **P2 - Stream or pre-limit AI diff collection.** (DONE — see Completed 2026-06-28 second follow-up)
  - Done: `boundedGit()` streams + kills the child after the byte cap in `src/git-actions.ts`.

- [x] **P3 - Make discovery progressive and non-blocking.** (DONE — third pass 2026-06-28)
  - Done: `discoverStream()` (async, non-blocking) in `src/discovery.ts`; `index.ts` serves FIRST, then indexes/
    watches/status-reads each repo as found and broadcasts `repo_added` over SSE; `web/src/store.ts` appends live.
    Verified at runtime (daemon boots, "Discovery complete: N found", `/api/repos` populated). Bounded-concurrency
    parallel scan deferred (sequential-async already unblocks the event loop).

- [x] **EXTRA - English-only i18n (owner request).** (DONE — third pass 2026-06-28)
  - Done: dropped de/es/fr/zh-CN locales + the multi-locale plumbing in `i18n.ts` + the Settings language switcher;
    kept the `t()` layer (copy stays centralised in `en.json`); `i18n:check` stays green (English-only).

- [ ] **P3 - Reduce redundant status/remote lookups.** (remote-URL caching DONE — see Completed 2026-06-28; low-value remainder)
  - Remaining: reuse a preflight status snapshot across an action's pre/post reads where safe (different points in time, so mostly N/A — keep only if profiling shows it matters).

- [ ] **P3 - Add repo-state/status shared helpers.**
  - Verified real: clean/dirty/ahead/behind/error classification and changed-file metadata are duplicated across store, cards, filters, and CLI.
  - Suggested path: shared `RepoStatusKey`/`ChangedFileStatus` helpers used by UI and CLI.

- [~] **P3 - Replace or heavily test bespoke OIDC protocol code.** (tests added — see Completed 2026-06-28 second follow-up)
  - Done: `tests/auth-protocol.test.ts` covers tampered state, expired transactions, owner mismatch, tampered/expired session cookies.
  - Remaining: `id_token` `iss`/`aud`/`exp` checks need a fetch-injection seam in `handleComplete`; or adopt a maintained OIDC client.

- [ ] **P4 - Remove the tray's dev-only rebuild menu before shipping a tray.**
  - Verified real: the tray script exposes source rebuild behavior that does not belong in a public launcher.
  - Suggested path: delete the rebuild menu branch when the tray moves from deferred/dev to shipped.

- [x] **P4 - Update stale docs wording.** (DONE — see Completed 2026-06-28 second follow-up)
  - Done: retired "Naive UI" references in `README.md` + `MARCHING_ORDERS.md` corrected to the real stack.

## Dropped Or Deferred

- **Drop for now: prune the copied UI kit.** It is real unused surface in this app, but `web/UI_UNIFICATION.md` indicates the full kit is intentionally carried as a shared golden component set.
- **Drop for now: full Vercel AI SDK / official SDK rewrite.** Provider drift is real, but local adapters/catalog are higher ROI and lower churn.
- **Drop for now: remove `qrcode-terminal`.** It is a small untyped dependency, but terminal QR is product-useful and not a current bottleneck.
- **Defer: remove unused DB schema fields/tables.** The dead schema surface is real, but deletion needs migration planning for existing DBs.
- **Defer: broad root document deletion/archive.** Some docs are stale, but deleting handoff/history docs needs confirmation of canonical replacements.
- **Defer: replace discovery with a glob package.** The issue is startup blocking; fix progressive scanning first.
- **Defer: replace watcher implementation with a package.** Fix health reporting/fallback first, then reassess.
