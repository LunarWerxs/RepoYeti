# Changelog

All notable changes to RepoYeti are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-07-13

### Added

- **AI key health check at startup.** RepoYeti probes each configured AI provider once at boot and,
  if a key has been revoked, expired, or run out of quota, raises a dashboard notification instead of
  letting you discover it only when a commit-message generation fails. The result is recorded, so the
  alert still shows if you open the dashboard after the daemon booted (the usual headless case).
- **Right-click menus on changed files.** File rows in the changes tree and the activity log now have
  a context menu: open, open in your editor, reveal in the OS file manager, copy path, add to
  `.gitignore`, or discard.
- **Dirty-diff gutter in the file viewer.** The Content view marks added, changed, and removed lines
  in the gutter (VS Code style), so you can see what changed at a glance without switching to the diff.
- **"Add to .gitignore" action.** Send a changed file straight into the repo's `.gitignore` from its
  right-click menu; the pattern is anchored to the repo root and path-traversal-safe.
- **Reveal now selects the file.** "Reveal in file manager" highlights the exact file, not just its
  folder.
- **Optional auto-approve for agent actions.** Alongside the existing auto-deny timer, you can opt in
  to an auto-approve timer for pending agent (MCP) approval prompts. Off by default.
- **Dismiss and restore detected identities.** Git identities RepoYeti auto-detects can be dismissed
  from the list and restored later.

### Changed

- **AI is now fully bring-your-own-key.** The old built-in provider-key mechanism is gone (a key
  committed to a public repo gets revoked anyway, so it was never usable); add your own under
  Settings -> AI. Your key stays in your OS keychain and never leaves the daemon.
- **Smarter AI model handling.** Provider model lists now hide non-chat models (speech, embeddings,
  and the like) so a model that cannot write a commit message can never be auto-selected, and each
  provider suggests a sensible default model on connect.
- **AI commit buttons follow a toggle.** The Smart Commit and AI-message buttons appear whenever AI
  commit messages are enabled, with a clear prompt if a key still needs adding, rather than staying
  hidden until a key is present.
- **Settings reorganized.** The old Sync & Hotkeys section is split into a Background Sync section
  (under Automation) and an Updates & Hotkeys section (under General), notifications can jump straight
  to the relevant settings tab, and the scan-roots list is tucked behind a toggle to keep the panel tidy.

### Fixed

- **Pull no longer refuses a dirty working tree.** A fast-forward pull is safe on a dirty tree, so
  RepoYeti now lets `git pull --ff-only` run when the tree is dirty: it fast-forwards and keeps your
  uncommitted edits when the incoming commits don't touch the same files, and stops with a new
  `WOULD_OVERWRITE` code ("commit or stash first", both doable from the phone) only when they would
  be overwritten. Previously any uncommitted change blocked the pull outright with
  `DIRTY_WORKING_TREE`. Because a blocked pull never reached the network, the "behind … as of last
  fetch" timestamp also went stale (a pull that fails preflight can't refresh it); letting the pull
  actually run updates both the behind count and the last-fetch time.
- **Branch switch no longer refuses a dirty working tree.** Same reasoning as pull: `git switch`
  carries your uncommitted edits onto the target branch when they don't collide and stops with
  `WOULD_OVERWRITE` ("commit or stash first") only when a file the switch must change is dirty.
  Previously any uncommitted change blocked the switch, even though git could do it safely.
- **Background auto-pull ("keep in sync") now covers dirty repos.** The auto fast-forward no longer
  skips a repo just because its tree is dirty: it pulls when the incoming commits don't touch the
  uncommitted files and harmlessly leaves the repo flagged "behind" when they would (still skipping
  a genuinely mid-merge or mid-rebase/cherry-pick tree, which should never be auto-acted on).

## [0.3.0] - 2026-07-13

### Changed

- **Brand tray/taskbar icon regenerated** from the current yeti-medallion vector (the shipped
  `misc/RepoYeti.ico` had drifted to a generic placeholder). `misc/Make-Icon.ps1` rebuilds it
  from the committed `misc/RepoYeti-icon.png` master (re-rendered from `web/public/icon.svg`).
- **Settings split into tabs.** The settings sidebar now groups its ten sections under four tabs
  (General / Identities / Automation / Access) instead of one long scroll, landing on General so
  the everyday knobs come first and the power-user sections (Identity Firewall, Agent Safety
  Rail, AI providers, tunnel) stay one click away. The old combined identity-and-access section
  was split into `IdentitiesSection` and `AccessSection`.
- **Remote access asks, not redirects.** Flipping the Remote access toggle (Settings → Access,
  or the header Connection dialog) on an unclaimed daemon no longer bounces the page to the
  Connections OAuth login mid-toggle; it discloses an inline "Sign in with Connections" prompt
  instead. The Stable address (tunnel) block, "Sign out everywhere", and the
  editing-over-remote policy toggle are now hidden while remote access is off; they only
  apply when it is on.
- **Quieter search bar.** The repo filter box on the main page sits on a faint fill with no
  border until focused, so it reads as a utility instead of competing with the repo list.

### Fixed

- **Settings sidebar no longer opens with a tooltip already showing.** Opening the panel
  autofocuses its first control, and reka-ui discloses tooltips on focus, so the identities
  info-hint popped instantly. The shared kit's `InfoHint` now ignores non-keyboard focus
  (hover and keyboard Tab still disclose).

### Added

- **Portable window.** A Settings → Appearance toggle ("Portable window") that opens RepoYeti in
  a chromeless Chromium app window (`msedge`/`chrome --app=URL`, its own taskbar entry, no tabs
  or address bar) instead of a normal browser tab. Turning it on persists the setting and opens
  one immediately (`POST /api/portable-window`); the desktop tray launcher follows the same
  preference on every subsequent open, including a cold start before the daemon is up, by
  reading it off `runtime.json`. Off by default (a plain tab). Falls back to a normal tab/browser
  window when no Edge/Chrome install can be found. The window uses a dedicated Chromium profile
  (`~/.repoyeti/portable-profile`, shared by both the server route and the tray launcher) so it
  remembers its own size/position across launches instead of inheriting the main browser profile.

## [0.2.0] - 2026-07-09

A self-hosted remote git manager: a background daemon plus a mobile dashboard, packaged
as a single `bun --compile` binary. First feature release on top of the v0.1.0 initial tag.

### Release hardening

A pre-tag pass over the whole tree, focused on nothing shipping that shouldn't:

- Removed an internal engineering spec doc from the public tree and fixed every dangling
  reference to it; trimmed `docs/ARCHITECTURE.md` §16 down to the app-agnostic shared-kit
  story so it no longer names sibling projects.
- Scrubbed leftover codenames for sibling apps out of shared-kit file comments.
- One shared VS Code-style git-status color map now backs every place in the dashboard that
  colors a file by status, replacing four copies that had already drifted out of sync with
  each other.
- One shared identity-firewall glob matcher now backs both the daemon and the dashboard's
  display-only mirror of it, with new tests pinning down edge cases so the two can't
  silently diverge again.
- The self-updater now rolls back cleanly if a build fails partway through an update:
  on a failed install/build after pulling the new version, it restores the previous commit
  and reinstalls/rebuilds it, and reports honestly which step failed instead of leaving the
  install in a half-updated state. Covered by new tests that exercise the rollback against a
  real git repo.
- The optional Connections settings-sync and Lore VCS integrations are now both optional,
  lazy-loaded dependencies — a daemon that doesn't use either feature never pulls their SDKs
  into memory.
- Added last-resort process-level handlers for uncaught exceptions and unhandled promise
  rejections, so an unexpected error is logged instead of crashing the daemon silently.

### Added

- **Auto-commit timer.** An opt-in, daemon-wide scheduler that, for each repo you flag from its
  ⋯ menu, automatically runs the AI **Smart Commit** splitter over its uncommitted changes and —
  configurably — `pull --ff-only`s then pushes. Two schedules: **repeat on a timer** (every
  N minutes/hours, clamped [60s, 24h]) or **once a day** at a set local time. Pull and push are
  each independently toggleable (off = commit locally only). **Safety:** a repo with a merge
  conflict or that is mid-merge/rebase/cherry-pick is always **skipped** (never auto-committed) and
  surfaced via a warning toast; pull-before-push (and skipping the push if the pull fails) mirrors
  "commit & sync" so an unattended run can't publish over a diverged remote. Uses your configured AI
  provider to split the commits, falling back to a deterministic grouping when none is set. New
  daemon module `src/auto-commit.ts` (self-rescheduling timer, mirrors `remote-sync.ts`), a per-repo
  `auto_commit` column, `POST /api/repos/:id/auto-commit`, and the `autoCommit*` owner settings.
- **Tree ⇄ list view for a repo's changes.** A per-repo toggle in the changed-files toolbar (between
  "Search content" and Collapse All) flips the file view between the nested folder **tree** (default)
  and a flat **list** of full paths. Persisted per repo in `localStorage`, like the tree height and
  fold state; reuses the same rows so selection, discard, diff-stats, and keyboard nav are identical.
- **MCP server for AI agents.** A hand-rolled Model Context Protocol server (zero new deps —
  JSON-RPC 2.0 + MCP implemented directly) exposes RepoYeti's git operations to AI agents over
  two transports: **`repoyeti mcp`** (stdio — what an MCP client like Claude Desktop/Code or
  Cursor spawns) and **`POST /api/mcp`** (HTTP, auto-gated by the same `/api/*` auth). One
  transport-agnostic core drives **14 tools** — 8 read-only (`list_repos`, `repo_status`,
  `git_log`, `list_branches`, `git_diff`, `git_search`, `list_stashes`, `drift`) and 6 mutating
  (`git_commit`, `create_branch`, `git_checkout`, `git_push`, `git_pull`, `git_fetch`, each
  tagged `MUTATES`). The stdio server proxies to the local daemon over HTTP; the HTTP endpoint
  uses an in-process adapter. Either way every call runs behind the same op-queue and safety
  guards as the dashboard — the daemon never half-merges, no matter who asks.
- **CLI git verbs.** `repoyeti repos / status <repo> / log / branches / branch / checkout /
  commit / diff / drift / stash / push / pull / fetch` — real shell shortcuts (no `curl`) that
  drive the already-running daemon over its loopback HTTP API and pretty-print the result. They
  locate the live daemon and never start one or touch git in-process (single-instance respected).
  Honour `REPOYETI_BASE_URL` (override the daemon origin) and `REPOYETI_TOKEN` (Bearer auth for a
  remote daemon). Bare `status` stays the daemon-config summary; `status <repo>` is the git verb.
- **Opt-in API token (Bearer) for remote/headless agents.** An owner-minted token
  (`repoyeti token new` → `POST /api/auth/token`, value shown once; revoke/show too) lets a
  remote or headless agent authenticate over the tunnel with `Authorization: Bearer <token>` (or
  `REPOYETI_TOKEN` for the CLI/MCP) when there's no browser for the OIDC login. **Off by
  default** — when no token is set, auth is byte-for-byte the prior OIDC-only behavior. The token
  is a separate, local credential (constant-time compared, stored in the OS keychain), never
  touches connections.icu, and never weakens the default OIDC posture.
- **Machine-readable API surface.** `GET /api/openapi.json` serves an OpenAPI 3.1 document built
  by introspecting the live router against a curated metadata registry (per-route summary, tags,
  Zod request bodies, query params). It's the one `/api/*` path fetchable without sign-in, so
  agents and tooling can auto-discover the surface; a drift-guard test asserts every `/api` route
  appears in the doc.
- **Merge-commit detection.** The log/commit reads now capture parent hashes, so `LogEntry` and
  `CommitDetail` carry `parents: string[]` + `isMerge`, and `GET /api/repos/:id/log` accepts
  `?merges=only|exclude`. Surfaces in the CLI `log`, the MCP `git_log` tool, and OpenAPI. (Lore
  history is linear, so its backend reports `parents: []` / `isMerge: false`.)

### Changed

- **Maintainability reorg (structure-only, no behavior change).** The three god-files were split
  into layered directories: the read-only inspection layer moved to **`src/read/`**;
  `service.ts` (1075 lines) became **`src/service/`** (core / watch / actions / repo-mgmt / reads
  / files / guards + an `index.ts` barrel); `daemon.ts` (1159 lines) became **`src/http/`** (an
  `app.ts` composition root wiring per-domain `routes/*` behind the single `/api/*` auth
  middleware, plus `respond.ts` / `web.ts` / `openapi.ts`); and the CLI entry moved to
  **`src/cli/`** (a thin `main.ts` dispatcher + `lifecycle.ts`). `check-boundaries.ts` enforces
  the new layering (`read ⊥ service`, `cli ⊥ service/read/git`, MCP core ⊥ service/read/db).

- **Smart Commit (AI multi-commit splitter).** Turn a pile of unrelated working-tree changes into
  an ordered set of small, scoped commits. The daemon proposes a plan (`POST /api/repos/:id/commit-plan`
  → AI, with a deterministic heuristic fallback — nothing is committed), you review and edit it in a
  dedicated editor (rename subjects, move files between commits, reorder/merge), then execute
  (`POST /api/repos/:id/smart-commit`, which re-validates the edited plan against the live tree and
  commits each group in isolation, file-level only). A **YOLO mode** (Settings → AI) skips the review
  and commits the plan in one tap. Never auto-pushes.
- **VCS-agnostic backend.** Repos now carry a `vcs` kind behind a pluggable `VcsBackend` interface
  (`src/vcs/`). **git** is the default; **[Epic's Lore](https://dev.epicgames.com/documentation/en-us/lore)**
  is supported experimentally behind `REPOYETI_LORE=1`.
- **Server registry (API).** Register version-control servers and clone repos from them via
  `GET/POST/DELETE /api/servers` + `POST /api/servers/clone` (→ `cloneLoreRepo`). _Backend + routes
  only for now — the Settings → Servers UI is still pending._
- **Background remote-sync.** An optional periodic check (`src/remote-sync.ts`) keeps each repo's
  "behind" count fresh, with an opt-in **keep-in-sync** mode that auto fast-forwards safe (clean,
  non-diverged) repos. Cadence + toggles live in Settings (`syncCheck` / `syncIntervalSecs` / `keepInSync`).
- **Remote & tags management.** A per-repo "Remote & tags" dialog (repo card ⋮ menu) sets or
  updates the `origin` URL — a local config change, no network — so a repo you created with
  `git init` from the phone can finally be given a remote and pushed. The same dialog lists the
  repo's tags (newest first) and **creates a tag** (annotated when you add a message), optionally
  **pushing it to origin** — "tag a release from your phone." Backed by `POST`/`DELETE
  /api/repos/:id/remote` (URL-scheme validated), `GET /api/repos/:id/tags`, and
  `POST /api/repos/:id/tag` (git-only, ref-name validated).
- **Clone from URL.** The Add-repository dialog has a **Clone** mode: paste a git URL, pick a
  destination folder (must be inside a scan folder) and an optional identity, and RepoYeti clones
  it onto the machine — the new repo appears live. The URL scheme, target name, and destination
  are validated server-side before any git runs, and the chosen identity's SSH key is injected
  per-operation (same seam as fetch/pull/push).
- **Recent commit messages.** The commit box shows your last few commit subjects as one-tap
  chips — handy when typing on a phone.
- **Scan folders from the dashboard.** Add or remove discovery roots in **Settings → Scan
  folders** (no more CLI-only `repoyeti add-root`). Adding one scans it immediately and the repos
  stream in live; removing one drops the auto-discovered repos found under it (repos you added
  explicitly by path are kept). The empty state now offers "Add a scan folder" too.
- **Fetch all.** A header button fetches every repo that has a remote in one tap (bounded by the
  network gate), then reports a one-line summary of what succeeded / failed.
- **Sign out everywhere.** Settings → Access can invalidate the session on every device at once.
  Sessions are stateless signed cookies, so this rotates the daemon's signing key — every existing
  cookie stops verifying instantly.
- **Branches.** Each repo card now lists its local branches (with ahead/behind), lets you
  **switch** to one (refused on a dirty tree — "stash or resolve at your desk"), **create** a
  new branch (＋), and **safe-delete** a merged local branch (`-d` only; the current branch and
  protected `main`/`master`/`develop`/`trunk` are refused, and an unmerged branch surfaces
  `UNMERGED_BRANCH` rather than being force-deleted).
- **Commit history.** A lazy, paginated read-only log per repo (short hash · subject · author ·
  relative time; tap a hash to copy it), backed by `GET /api/repos/:id/log`.
- **Stash.** Stash all changes — including untracked — to escape the "dirty tree blocks pull"
  dead-end, then **pop** or **drop** from the phone. A conflicting pop keeps the stash entry and
  reports `STASH_CONFLICT` ("resolve at your desk") instead of leaving a silent half-merge.
- **Discard a file.** Revert one changed file to its last-committed state directly from the
  changes tree (confirm-gated) — the inverse of the in-app editor. Path-confined and behind the
  per-repo op-queue, like every other mutation.
- **In-app file viewer.** Click any changed file in a repo's tree to open its contents in an
  inline Monaco (VS Code) editor — a right-side push-drawer on desktop (the page slides left
  and stays centred; drag the left edge to resize) or a bottom sheet on mobile. Read-only,
  syntax-highlighted, theme-aware. A **Content / Diff** toggle (defaulting to Diff) switches
  between the whole file and a HEAD ↔ working-tree diff with GitHub-style collapsed unchanged
  regions, plus a **word-level highlight** toggle and a **split / unified** layout toggle (all
  persisted). Backed by read-only, path-confined `GET /api/repos/:id/file` and `/diff`
  endpoints (binary, deleted-file, and oversized cases handled). Monaco is lazy-loaded and
  excluded from the PWA precache so it never bloats the initial app.
- **Internationalisation scaffolding (i18n).** All UI copy runs through `vue-i18n` rather than
  hardcoded strings, so locales can be added later. **Only English (`en.json`) ships today** —
  the earlier machine-translated drafts and the language switcher were removed; `bun run i18n:check`
  keeps the codebase translation-ready (no untranslated literals, no missing keys).
- **`bun run i18n:check`** — a compliance script that fails CI on untranslated UI strings,
  missing translation keys, or locale key-parity drift (templates are parsed with the Vue
  compiler, not regex).
- **VS Code-style file-type icons** in the changed-files tree, using the `vscode-icons`
  set (real per-language glyphs and colours, bundled offline, tree-shaken).
- **Resizable changed-files view** — a per-repo drag grip (with keyboard ↑/↓ and
  double-click-to-reset) plus a global default size (Small / Medium / Tall) in Settings.
- **Bring-your-own-key AI commit messages** — generate a commit message from the repo's
  diff via a configurable provider (Groq / OpenRouter / Gemini / Claude / ChatGPT /
  DeepSeek). Keys live on the daemon only and never leave the machine.
- **Sponsor credit** footer.
- **Launcher guard tests** (`tests/launcher.test.ts`) — fail the build unless the one-click
  launcher is intact: the shortcut machinery (`Create-Shortcut.ps1`, `RepoYeti.vbs`,
  `RepoYeti-Tray.ps1`, `RepoYeti.ico`) exists, is **committed**, and is wired
  shortcut → wscript → vbs → tray → daemon + icon. On Windows it also runs the tray's new
  headless `-SelfTest` (bun on PATH + daemon entry + the icon actually loading into a
  `NotifyIcon`) and regenerates + resolves the root shortcut. Committing `misc/` (which was
  untracked) means a fresh clone always has a working shortcut + tray icon.

### Changed

- **Single instance + the launcher follows the real port.** The daemon already hopped past
  a busy port; now it records the port it ACTUALLY bound in `~/.repoyeti/runtime.json`, so the
  tray opens the right URL (validated with an auth-exempt `/api/health` probe) instead of
  blindly assuming the preferred port. A second launch detects the running daemon and exits
  rather than starting a rival on another port — across the tray, `bun run start`, and
  `bun run dev` (whose `--watch` reloads stay exempt so hot-reload still rebinds). The Vite
  dev proxy follows the same pointer.
- Web UI rebuilt on **reka-ui (shadcn-vue) + Tailwind v4** (replacing the earlier Naive UI
  prototype).
- **Filesystem-watch fallback polling.** A repo whose `.git` watch can't be installed (OS
  watch limits, unsupported filesystem) now falls back to low-frequency jittered polling and
  logs a warning, instead of silently going stale.

### Performance

- **Bounded git subprocess concurrency.** A daemon-wide read pool (status / changed-files)
  and a separate network pool (fetch / pull / push) cap how many `git` children run at once,
  so boot or a multi-client burst can't spawn hundreds and bog down the machine. Tune with
  `REPOYETI_GIT_READ_CONCURRENCY` / `REPOYETI_GIT_NET_CONCURRENCY`.
- **Progressive startup.** The daemon serves the dashboard immediately and hydrates repo
  statuses in the background (streaming each over SSE as it lands), so a slow or hung repo no
  longer delays the daemon from coming up.
- **Coalesced refreshes.** Bursts of watcher/poll events for one repo collapse into at most
  one in-flight read plus one trailing pass, instead of stacking a deep queue of soon-obsolete
  `git status` reads behind a slow operation.
- **Cached remote URLs.** The origin URL is cached per repo until `.git/config` changes,
  skipping a `git remote -v` subprocess on every status read.
- **Capped changed-file responses.** The changed-files API returns at most 2000 entries with a
  `truncated` / `total` marker, so a repo with tens of thousands of dirty files can't produce a
  multi-MB payload or freeze the tree view.

## [0.1.0] - 2026-07-06

Initial public tag of the daemon + dashboard, before the release-hardening pass.

## [0.0.1] — Initial

- Daemon core: repo discovery, `.git` watchers, SQLite state, per-repo status engine,
  serialized op-queue, REST + SSE.
- "Sign in with Connections" auth (config-gated OIDC) + redirect shim.
- Git identities (per-operation `core.sshCommand` / `user.*` injection) and guarded
  fetch / pull (fast-forward only) / push (no force) / commit.
- cloudflared tunnel (+ QR) and the Vue 3 PWA dashboard.

[Unreleased]: https://github.com/LunarWerxs/repoyeti/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/LunarWerxs/repoyeti/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LunarWerxs/repoyeti/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LunarWerxs/repoyeti/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LunarWerxs/repoyeti/releases/tag/v0.1.0
[0.0.1]: https://github.com/LunarWerxs/repoyeti/releases/tag/v0.0.1
