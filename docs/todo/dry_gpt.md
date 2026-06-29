# DRY / Redundancy TODO

Static audit focused on duplicated logic, copy/paste structures, and contract drift across source, tests, scripts, and configs.

- [ ] P1 - Centralize API result/error contracts and HTTP status mapping.
  - Evidence: `src/git-actions.ts:15` defines `ActionCode`, but `web/src/types.ts:54` weakens action `code` to plain `string`. `src/service.ts:69` returns missing repos as `ERROR`, while `src/service.ts:162` returns `NOT_FOUND` for the AI diff path. `src/daemon.ts:56` maps only `ActionCode` to HTTP status, `src/daemon.ts:192` uses it for fetch/pull/push, and `src/daemon.ts:202` emits `NO_MESSAGE` outside the `ActionCode` union. Other repo routes return bare `{ error }` bodies at `src/daemon.ts:211` and `src/daemon.ts:218`.
  - Risk/impact: Normal conditions can surface as inconsistent payloads or wrong status codes, such as a missing repo becoming a 500 for repo actions but a 404 elsewhere. The web client cannot exhaustively handle codes, so new backend errors silently fall through to generic messages.
  - Suggested fix: Add a shared contract module for API DTOs and error codes, including `NOT_FOUND`, `SUBMODULE_NOT_ACTIONABLE`, `NO_MESSAGE`, and AI codes. Route all error responses through one `jsonError`/`statusForCode` helper and import the same type-only contracts into the web app.

- [ ] P2 - Collapse the duplicated AI provider catalog into one source of truth.
  - Evidence: Provider IDs live in `src/config.ts:46` and `src/config.ts:55`, endpoint data in `src/ai.ts:40`, validation in `src/daemon.ts:226`, mirrored type unions in `web/src/types.ts:62`, display metadata in `web/src/components/Settings.vue:38`, and per-provider row initialization in `web/src/components/Settings.vue:69`. Commit styles are also duplicated between `src/config.ts:64`, `src/daemon.ts:244`, `web/src/types.ts:69`, and `web/src/components/Settings.vue:47`.
  - Risk/impact: Adding, renaming, or removing a provider/style requires coordinated edits in several unrelated files. The UI can drift from what the daemon accepts, or the daemon can support a provider that never appears in Settings.
  - Suggested fix: Define a provider/style registry with IDs, labels, key placeholders, free/builtin flags, endpoints, and adapter kind. Either expose a redacted `/api/ai/catalog` endpoint or import shared type-only metadata into the web app.

- [ ] P2 - Refactor provider-specific AI request/response branching into adapters.
  - Evidence: `src/ai.ts` repeats provider grouping across `ENDPOINTS` at `src/ai.ts:40`, model parsing at `src/ai.ts:76`, auth headers at `src/ai.ts:177`, generation request construction at `src/ai.ts:249`, and completion extraction at `src/ai.ts:298`.
  - Risk/impact: OpenAI-compatible providers already require edits in multiple switches/branches. A future provider can be partially wired, causing model discovery to work while generation or response extraction fails.
  - Suggested fix: Replace the scattered branches with an `AI_ADAPTERS` map keyed by provider. Each adapter should own `listModelsUrl`, `generateUrl`, `headers`, `parseModels`, `buildBody`, and `extractCompletion`, with shared adapter factories for OpenAI-compatible providers.

- [ ] P2 - Share git operation preflight checks instead of repeating policy inline.
  - Evidence: `gitPullFfOnly` checks `readStatus`, errors, detached branch, and dirty tree at `src/git-actions.ts:95`; `gitCommitAll` repeats status/error/detached checks and adds dirty-empty logic at `src/git-actions.ts:122`; `gitPush` repeats status/error/detached checks at `src/git-actions.ts:171`. `collectRepoDiff` performs another repo/submodule/status/dirty gate at `src/service.ts:160`.
  - Risk/impact: Safety rules and user-facing messages can drift between pull, push, commit, and AI commit-message generation. Submodule handling already uses generic `ERROR` in both `src/service.ts:71` and `src/service.ts:163`, so the UI cannot distinguish that policy from an unexpected failure.
  - Suggested fix: Introduce a `preflightRepo(absPath, policy)` helper for branch-required, clean-required, dirty-required, and submodule/actionable checks. Return typed codes from the shared contract and keep action-specific messages in one table.

- [ ] P3 - Extract repeated Hono route parsing and guard boilerplate.
  - Evidence: JSON body fallback parsing is repeated at `src/daemon.ts:115`, `src/daemon.ts:131`, `src/daemon.ts:145`, `src/daemon.ts:160`, `src/daemon.ts:179`, `src/daemon.ts:200`, `src/daemon.ts:241`, `src/daemon.ts:262`, `src/daemon.ts:300`, and `src/daemon.ts:325`. Provider guard failures are repeated at `src/daemon.ts:261`, `src/daemon.ts:283`, `src/daemon.ts:296`, and `src/daemon.ts:312`. Missing repo-id checks are repeated at `src/daemon.ts:190`, `src/daemon.ts:199`, `src/daemon.ts:209`, `src/daemon.ts:216`, and `src/daemon.ts:324`.
  - Risk/impact: Validation behavior and response shapes will keep diverging route by route. Small changes, such as stricter JSON parsing or a different provider error body, require many edits.
  - Suggested fix: Add helpers such as `jsonBody(c)`, `requiredParam(c, "id")`, `withAiProvider(c, handler)`, and `withRepo(c, handler)`, or split repo/identity/AI routes into small modules with shared guard utilities.

- [ ] P3 - Consolidate repo status classification and changed-file status metadata.
  - Evidence: Clean/dirty/ahead/behind/error logic is implemented in `web/src/store.ts:61` and repeated for display in `web/src/components/RepoCard.vue:52`, `web/src/components/RepoCard.vue:200`, `web/src/components/RepoCard.vue:284`, and `src/index.ts:77`. Filter labels are separate in `web/src/components/RepoFilters.vue:20`. Changed-file status is typed as `string` in both `src/status.ts:16` and `web/src/types.ts:39`, while color handling is another open-ended map in `web/src/components/ChangesTree.vue:10`.
  - Risk/impact: Filters, badges, CLI output, and file-tree colors can disagree about what a repo state means. Because file status is not a union, adding or changing a status code has no exhaustive checks.
  - Suggested fix: Add shared `RepoStatusKey` and `ChangedFileStatus` unions plus helper functions like `repoStatusFlags(status)` and `changedFileMeta(status)`. Use those helpers in the store, RepoCard, RepoFilters, ChangesTree, and CLI summary.

- [ ] P4 - Move identity avatar initials and tint selection into a shared utility/component.
  - Evidence: `RepoCard.vue` defines `initials`, `AVATAR_TINTS`, and `tintFor` at `web/src/components/RepoCard.vue:65`, `web/src/components/RepoCard.vue:72`, and `web/src/components/RepoCard.vue:80`. `IdentityManager.vue` has the same concepts at `web/src/components/IdentityManager.vue:36`, `web/src/components/IdentityManager.vue:44`, and `web/src/components/IdentityManager.vue:49`.
  - Risk/impact: Identity colors or initials can render differently between the repo card dropdown and the identity manager after a one-sided tweak.
  - Suggested fix: Create `web/src/lib/identity-display.ts` or an `IdentityAvatar.vue` component that owns initials, deterministic tint, and sizing variants.

- [ ] P4 - Extract the locked responsive sheet-side behavior.
  - Evidence: `IdentityManager.vue` computes and locks `side` with `useMediaQuery` at `web/src/components/IdentityManager.vue:19`, while `Settings.vue` repeats the same pattern at `web/src/components/Settings.vue:28`.
  - Risk/impact: A drawer animation or breakpoint fix must be made twice, and one sheet can regress independently.
  - Suggested fix: Add a composable such as `useLockedSheetSide(open, "(min-width: 768px)")` and reuse it in both sheets.

- [ ] P4 - Share test fixtures for configs, temp repos, and fetch stubs.
  - Evidence: Default config values are copied in `tests/auth.test.ts:6`, `tests/ai.test.ts:18`, and `tests/ai-routes.test.ts:6` instead of reusing `src/config.ts:160`. Temporary repo setup is duplicated in `tests/git-actions.test.ts:17` and `tests/ai.test.ts:170`; temporary directory helpers appear in `tests/setup.ts:7` and `tests/discovery.test.ts:7`. `fakeFetch` is local to `tests/ai.test.ts:136`.
  - Risk/impact: Tests can drift from production defaults and from each other. New tests are likely to copy another slightly different fixture.
  - Suggested fix: Add `tests/helpers.ts` with `baseConfig()`, `withOAuthConfig()`, `makeTempDir()`, `makeSeededGitRepo()`, and `fakeJsonFetch()`. Keep production defaults exported or exposed through a factory so tests do not hard-code them.

- [ ] P5 - Factor the repeated repo registration/create post-processing.
  - Evidence: `registerRepo` resolves/checks a path, then upserts, watches, refreshes, and returns the repo at `src/service.ts:93`. `createRepo` performs its unique `git init`, then repeats the same upsert/watch/refresh/return sequence at `src/service.ts:105`.
  - Risk/impact: Future changes to repo insertion, initial status refresh, event emission, or returned payloads can land in one path but not the other.
  - Suggested fix: Extract `indexAndWatchRepo(absPath, source)` or `finishRepoMutation(absPath, source)` that does the shared `upsertRepo`, `watchOne`, `refreshRepo`, and `getRepo` work.
