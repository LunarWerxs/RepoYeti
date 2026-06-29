# Changelog

All notable changes to GitMob are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **In-app file viewer.** Click any changed file in a repo's tree to open its contents in an
  inline Monaco (VS Code) editor — a right-side push-drawer on desktop (the page slides left
  and stays centred; drag the left edge to resize) or a bottom sheet on mobile. Read-only,
  syntax-highlighted, theme-aware. A **Content / Diff** toggle (defaulting to Diff) switches
  between the whole file and a HEAD ↔ working-tree diff with GitHub-style collapsed unchanged
  regions, plus a **word-level highlight** toggle and a **split / unified** layout toggle (all
  persisted). Backed by read-only, path-confined `GET /api/repos/:id/file` and `/diff`
  endpoints (binary, deleted-file, and oversized cases handled). Monaco is lazy-loaded and
  excluded from the PWA precache so it never bloats the initial app.
- **Internationalisation (i18n).** The web UI is fully localised with `vue-i18n`. English
  is the base locale; Spanish, French, German, and Simplified Chinese ship as
  machine-translated drafts (pending human review), lazy-loaded on demand. A language
  switcher lives in **Settings → Appearance** and the choice is persisted.
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
  launcher is intact: the shortcut machinery (`Create-Shortcut.ps1`, `GitMob.vbs`,
  `GitMob-Tray.ps1`, `GitMob.ico`) exists, is **committed**, and is wired
  shortcut → wscript → vbs → tray → daemon + icon. On Windows it also runs the tray's new
  headless `-SelfTest` (bun on PATH + daemon entry + the icon actually loading into a
  `NotifyIcon`) and regenerates + resolves the root shortcut. Committing `misc/` (which was
  untracked) means a fresh clone always has a working shortcut + tray icon.

### Changed

- **Single instance + the launcher follows the real port.** The daemon already hopped past
  a busy port; now it records the port it ACTUALLY bound in `~/.gitmob/runtime.json`, so the
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
  `GITMOB_GIT_READ_CONCURRENCY` / `GITMOB_GIT_NET_CONCURRENCY`.
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

[Unreleased]: https://github.com/L0garithmic/GitMob/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/L0garithmic/GitMob/releases/tag/v0.0.1
