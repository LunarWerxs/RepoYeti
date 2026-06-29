# Deviant Code Audit

## Intended purpose

GitMob is intended to be a local-first, system-wide remote Git manager: a Bun daemon discovers local repositories, tracks branch/dirty/ahead/behind state, serializes safe git actions, manages per-repo identities, and exposes a mobile PWA over a Cloudflare tunnel only when app-layer owner auth is configured. The design emphasizes no half-merged repos, no global/repo git config mutation, loopback-only local serving, owner-only remote access, and secret handling that does not leak raw credentials.

## Todo

### P1 - Strip plain `PAGER` from the git child environment

- Evidence: `src/git.ts:24-31` removes `GIT_PAGER` but leaves ambient `PAGER`; every git client is created through `gitFor()` at `src/git.ts:35-43`. With this workspace's `PAGER=cat`, `readStatus()` returns `Use of "PAGER" is not permitted without enabling allowUnsafePager`. A normal `bun test` failed the core guard/diff tests at `tests/git-actions.test.ts:24-42` and `tests/ai.test.ts:179-199`; running with `PAGER` cleared made all 38 tests pass.
- Risk/impact: Core status, pull preflight, commit, and AI diff collection can degrade to generic `ERROR` or empty diffs before the intended safety guards run. This directly undermines the README's "built and verified" git-action guard claim.
- Suggested fix: Delete `env.PAGER` alongside `GIT_PAGER` in `safeGitEnv()`. Add a regression test that sets `process.env.PAGER` before calling `readStatus()`, `gitPullFfOnly()`, and `collectCommitDiff()`. Consider not swallowing status/diff errors in `collectCommitDiff()` unless the fallback is distinguishable.

### P1 - Remove the hard-coded default Groq API key and no-setup AI provider

- Evidence: `src/config.ts:103-116` embeds a Groq bearer key in source; `src/config.ts:118-157` treats that built-in key as configured and makes it the effective default. `web/src/store.ts:40-42` enables AI when the default provider has a model, and `web/src/components/RepoCard.vue:129-133` sends the repo diff to that provider when Generate is clicked. Tests intentionally lock this in at `tests/ai.test.ts:42-70` and `tests/ai-routes.test.ts:14-22`.
- Risk/impact: The repo publishes a live credential and makes third-party diff upload available by default, contradicting the BYOK posture in `src/ai.ts:1-8` and the Settings copy at `web/src/components/Settings.vue:173-175`. It also creates shared-key abuse/rate-limit risk and a privacy surprise for local code changes.
- Suggested fix: Remove `BUILTIN_AI` from committed code. Require an owner-configured key or an explicit local opt-in such as `GITMOB_DEMO_GROQ_KEY`. Update UI copy and tests so "Generate" is disabled until the owner connects a provider.

### P2 - Do not allow public tunnel startup while ownership is unclaimed

- Evidence: `src/index.ts:105-113` allows `--tunnel` whenever OAuth issuer/client/redirect are present; `src/index.ts:147-149` only logs that ownership is unclaimed; `src/auth.ts:229-235` persists the first verified Connections sign-in as owner. The design promise says an attacker with only the tunnel URL must sign in as the trusted owner (`MARCHING_ORDERS.md:329-336`).
- Risk/impact: If the quick-tunnel URL leaks before the owner signs in, any Connections account that reaches it first can claim the daemon. That is not the same guarantee as "trusted owner only" and is especially risky for a daemon that can run git operations against local repos.
- Suggested fix: Refuse `gitmob start --tunnel` unless `ownerSub` or `ownerEmail` is already configured, or constrain first-use ownership to a local-only pairing flow that requires a terminal-displayed secret.

### P2 - Harden `core.sshCommand` construction from identity `sshKeyPath`

- Evidence: `src/daemon.ts:152-165` accepts `sshKeyPath` as an arbitrary string. `src/git.ts:53-55` interpolates it into `ssh -i "${norm}" ...` without escaping quotes/control characters, then `src/git.ts:67-72` passes that string through `-c core.sshCommand=...` with `allowUnsafeSshCommand` enabled at `src/git.ts:39-42`. The design says git invocations should use parameterized arrays, not shell strings (`MARCHING_ORDERS.md:375-377`). The README example uses `~/.ssh/id_ed25519`, but quoting the tilde may prevent expansion on common shells.
- Risk/impact: Normal users can hit puzzling SSH auth failures for `~` paths. A malicious or compromised authenticated client may be able to inject extra SSH options or shell metacharacters through the key path when fetch/pull/push runs.
- Suggested fix: Expand `~` server-side, reject quotes/newlines/control chars, and validate that the path is a file. Prefer a generated wrapper script or rigorous platform-specific escaping over interpolating raw user input into `core.sshCommand`.

### P3 - Move owner AI keys and OAuth client secrets out of plaintext config

- Evidence: `src/daemon.ts:265-273` validates and stores provider API keys directly in `cfg`; `src/config.ts:191-195` writes the whole config JSON to `~/.gitmob/config.json`. `src/config.ts:40-44` acknowledges AI keys are stored there, while `MARCHING_ORDERS.md:338-346` says confidential OAuth/client tokens belong in the daemon keychain.
- Risk/impact: A config file read leaks user provider keys and any confidential OAuth `clientSecret`. Mode `0600` helps on Unix-like systems but is not equivalent to OS keychain storage, and the code comments still imply a stronger secret model than implemented.
- Suggested fix: Store only keychain handles in config. Use `keytar` where available and an encrypted local fallback where not. Add migration code that lifts existing `ai.providers.*.apiKey` and `oauth.clientSecret` out of JSON.

### P3 - Put the changed-file endpoint behind the per-repo operation queue

- Evidence: `src/service.ts:141-145` calls `readChanges()` directly, outside `enqueue()`, even though the service comment at `src/service.ts:3-7` says everything touching a repo goes through the per-repo queue. `src/status.ts:21-35` also lets git errors throw through to the route.
- Risk/impact: Expanding a dirty repo in the UI can race an in-flight commit/pull/fetch and show transient or stale data. If a repo disappears or git errors, `/api/repos/:id/changes` can become an unstructured 500 instead of the app's first-class error style.
- Suggested fix: Implement `getChanges()` as `enqueue(repoId, () => readChanges(repo.absPath))`, catch and classify read errors, and add a test proving it waits behind a queued mutation.

### P3 - Preserve `fetchedAt` across non-fetch refreshes

- Evidence: `src/status.ts:61` always creates a status with `fetchedAt: null`; `src/service.ts:50-57` only stamps it when `markFetched` is true. Any later watch/force refresh, such as `src/service.ts:129-133`, persists a new status with `fetchedAt: null`. The UI only shows "as of last fetch" when this field exists at `web/src/components/RepoCard.vue:290-292`.
- Risk/impact: The dashboard loses the timestamp that explains how fresh `behind` is, even though README explicitly says behind is from the last fetch (`README.md:111-114`). Users can mistake stale remote-tracking data for a fresh check.
- Suggested fix: Carry the previous stored `fetchedAt` forward during ordinary refreshes, clear it only when upstream/remote context changes, and set it on successful fetch/pull operations that update remote-tracking refs.

### P3 - Use the bundled/pinned `cloudflared` instead of whatever is on `PATH`

- Evidence: `src/tunnel.ts:28-31` spawns `"cloudflared"` from `PATH`. `scripts/build.ts:33-36` copies `vendor/cloudflared` into `dist`, but runtime never resolves that copy. The design calls for a bundled pinned tunnel binary (`MARCHING_ORDERS.md:75`).
- Risk/impact: Packaged builds can fail unless the user has cloudflared installed globally, and a hostile earlier `PATH` entry can replace the tunnel executable.
- Suggested fix: Resolve `cloudflared` relative to `process.execPath`/`dist/vendor` first, verify executable name/checksum, and only fall back to `PATH` with a clear warning.

### P4 - Preserve `.git` file semantics when manually registering repos

- Evidence: discovery treats a `.git` file as a submodule/worktree pointer and records `isSubmodule` from `gitEntry.isFile()` at `src/discovery.ts:50-55`. Manual registration only checks `existsSync(join(p, ".git"))` and always writes `isSubmodule: false` at `src/service.ts:95-103`.
- Risk/impact: A repo added through the UI can be classified differently from the same repo found by discovery. Submodules may become actionable despite `runAction()` blocking discovered submodules at `src/service.ts:70-72`; worktrees may be watched at the pointer file instead of the real gitdir.
- Suggested fix: Use `lstatSync()` on `.git`, parse `gitdir:` files, distinguish submodules from worktrees, and store/watch the correct actionability state consistently across discovery and manual registration.

### P4 - Refresh repo `source` and timestamps on explicit register/create conflicts

- Evidence: `src/db.ts:144-149` handles `ON CONFLICT(abs_path)` by updating only `name` and `is_submodule`. Explicit flows pass meaningful sources in `src/service.ts:101` (`pinned`) and `src/service.ts:119` (`created`), but existing rows keep their old source and `updated_at`.
- Risk/impact: A user can "pin" or create/register an already indexed repo and still see stale metadata from auto-discovery. Future UI decisions based on source will be unreliable.
- Suggested fix: On explicit register/create, update `source` according to a precedence rule (`created`/`pinned` over `auto`) and update `updated_at`.

### P5 - Remove or wire the unused workspace/session/key-handle schema

- Evidence: `src/db.ts:98-118` creates `workspaces`, `sessions`, `pat_handle`, and `signing_handle`, but `rg` finds no operational use beyond schema creation. `src/identity.ts:4-6` still points to a future workspace default identity.
- Risk/impact: Stale schema suggests implemented capabilities that do not exist and increases migration/debug surface.
- Suggested fix: Either wire these fields into real behavior and tests, or move them to a future migration when the feature is actually implemented.
