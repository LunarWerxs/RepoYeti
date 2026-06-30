# Changelog

All notable changes to RepoYeti are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-06-29

### Added

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
  only for now — the Settings → Servers UI is still pending (see `docs/TODO.md` §6)._
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
- **Consolidated working backlog.** `docs/TODO.md` — the single prioritized list of remaining work
  (release-readiness + feature backlog + what stays out by design).
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

## [0.0.1] — Initial

- Daemon core: repo discovery, `.git` watchers, SQLite state, per-repo status engine,
  serialized op-queue, REST + SSE.
- "Sign in with Connections" auth (config-gated OIDC) + redirect shim.
- Git identities (per-operation `core.sshCommand` / `user.*` injection) and guarded
  fetch / pull (fast-forward only) / push (no force) / commit.
- cloudflared tunnel (+ QR) and the Vue 3 PWA dashboard.

[Unreleased]: https://github.com/L0garithmic/RepoYeti/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/L0garithmic/RepoYeti/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/L0garithmic/RepoYeti/releases/tag/v0.0.1
