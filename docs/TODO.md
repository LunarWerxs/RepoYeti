# RepoYeti — Working TODO

> **The single list to work off of — ordered by urgency, not by topic.** It absorbed the two earlier
> planning docs (a release-readiness audit + a 5-lens feature gap analysis); this pass re-cut them by
> priority and removed the overlap, so each item appears exactly once.
>
> **Tiers.** 🔴 **Vital / do now** — blocks a public release, or is a real bug / active breakage (≈P0).
> 🟡 **Big deal** — needed for a polished public reputation (≈P1). 🟢 **Small deal** — polish /
> nice-to-have (≈P2). 🧑 **Needs you** — a decision or secret only the owner can supply (some of these
> also gate the release). 🤖 = an agent can do it. Each item keeps its original code (`A4`, `C1`, `D1`…)
> so older cross-references still resolve. Status verified against the tree on **2026-06-29**.

---

## ✅ Landed in the `0.1.0` burndown (2026-06-29 → 06-30, all on `main`)

All verified green at each step (276 daemon tests + web build, `tsc`, `check:codes`/`check:boundaries`, lint).

**🟡 Lore feature-parity port — DONE & verified end-to-end** against a live `loreserver` 0.8.4 (the
`lore` CLI is now installed at `~/bin`). AI commit-diff, smart-commit (plan input + group staging via
`lore stage`+`lore commit`), and content-search (JS scan) all routed through `VcsBackend` and re-enabled
in the Lore UI (`aiHere`). New gated `tests/lore-parity.test.ts`. **`F5` DONE** — `MARCHING_ORDERS.md`
promoted to `ARCHITECTURE.md`, all refs repointed.

**🔴 Vital — ALL DONE:** `C1` (registerRepo → `detectVcs`), `C2` (file diff + discard routed through
`VcsBackend` — `filePatch`/`discardFile` + `fileModels` capability), `E4` (PUT /api/mode toggle +
watcher→SSE delivery tests), `A6` (shim retired — docs corrected, no deploy needed; see finding below).

**🟡/🟢 also done:** `A4` (version cut `0.1.0` — **tag not pushed**, owner pulls that trigger), `A5`
(baked-in OAuth documented as intentional + override path), `F2` (CF-header auth comment + README proxy
note), `E5` (headless in-memory keychain stub + legacy-rehome coverage), `C5` (gate-nesting comment),
`D2` (`requireId()` collapses ~20 route guards), `D3` (CommitStyle drift guard), `D4` (centralize
`ok`/`fail`/`PATCH_CAP`), `D5` (drop `workspace_id`), `B4` (CI OS matrix + `bun audit`), `B5` (pre-commit
lint+typecheck), `B7` (pin `@types/bun`, Monaco chunk limit).

**Connections / A6 owner-step finding:** the `cnx_live_…` key is valid with `apps:write`, but the
RepoYeti app (`a790090c…`) is an **AEGIS-direct registration** with no Studio filing-queue row, so the
`studio.connections.icu` API can't see/PATCH it. Per `docs/REMOTE_ACCESS.md` the redirect URIs were
already set in AEGIS via the vault. No write was made; the only unproven step is a **live sign-in**
with the daemon running (owner step). (Key is now stored in gitignored `.env` as `CONNECTIONS_API_KEY`.)

**Frontend pass — in progress** (dev env stood up: daemon on `:7171` + Vite + `loreserver`, verified via
browser preview tools). **DONE & browser-verified:** toast-undo (hide/pin/star → Undo restores) ·
AI-style picker (Settings → AI; change → daemon persists `style`). Remaining: tunnel-URL UI, Lore servers
UI, `F6` a11y, then `D1` RepoCard split (biggest), + the UI halves of per-file staging & commit-detail diff.

**Still open:**
- **`E6`** frontend test infra (Vitest + Playwright) — adds dev-deps to the shared `bun.lock`.
- **PAT/HTTPS:** the network path can't be unit-verified without a real private repo + token (owner).
- **🧑 owner:** branch-protect `main`, confirm MIT, push the `v0.1.0` tag, the live sign-in.

**SDK migration — DONE (owner decided: do it now).** ALL text-scraped Lore reads — status, changed
files, branches, log — now go through `@lore-vcs/sdk` (a koffi native-FFI binding) in `src/vcs/lore-sdk.ts`,
returning structured/typed data (drift-proof; the `lore` CLI has **no** machine-readable output). Lazy-loaded
(a git-only daemon never touches the native lib) with the CLI parsers retained as fallback. Single binary
preserved: `build.ts` keeps the SDK + koffi EXTERNAL to `--compile` and bundles the native libs into
`dist/node_modules` (CLI fallback if absent); compiled `repoyeti.exe` boots clean. koffi in
`trustedDependencies`. Verified end-to-end vs a live `loreserver` 0.8.4 (`lore-parity.test.ts`). _Remaining
SDK-adjacent: the `lore diff`-based reads (file patch / AI diff) still use the CLI — left as-is since `lore
diff` is real unified-diff content, not drift-prone status labels._

---

## 🔴 Vital — do now (blocks a public release / real bugs / active breakage)

Agent-doable blockers first; `A6` needs you for two steps. The release **also** needs the owner-gated
items under **🧑 Needs you** (version cut `A4`, README infra decision `A5`, branch protection).

- [ ] **🧑+🤖 `A6` — deploy the renamed auth shim + re-register its redirect URI** *(the rename's only
  loose end — remote sign-in is broken until done; local-only mode is unaffected)*. The GitMob→RepoYeti
  rename repointed the OAuth shim to `repoyeti-auth.lunawerx.workers.dev`, but **that worker is not
  deployed** (confirmed 404) and the old `gitmob-auth` URL is still what's registered at `connections.icu`.
  Steps: **(1) 🧑** authenticate wrangler — `bunx wrangler login` (browser → Allow) *or* set
  `CLOUDFLARE_API_TOKEN`; an agent **cannot** log in for you. **(2) 🤖** `cd shim && bunx wrangler deploy`,
  then curl `…/cb` to confirm it's live. **(3) 🧑** in the `studio.connections.icu` developer app (clientId
  `a790090c…`, unchanged), set/add redirect URI `https://repoyeti-auth.lunawerx.workers.dev/cb` (scopes
  `openid profile email`) — **no API/connector exists**, it's a dashboard edit behind your login.
  **(4) 🤖** fix the README + `shim/README.md` "✅ Deployed" wording (aspirational until step 2), then
  delete the stale `gitmob-auth` worker. ⚠️ **Overlaps `A5`:** if `A5` chooses a neutral domain, deploy
  *that* instead of `repoyeti-auth`.
- [ ] **🤖 `C1` — `registerRepo` is git-only (real bug).** `service.ts` hardcodes an `existsSync('.git')`
  check, so "Point to Folder" silently rejects valid **Lore** repos. Fix: use `detectVcs(p)` (exists in
  `src/vcs/index.ts`); return `NOT_A_REPO` when null. *Real bug given the Lore pivot.*
- [ ] **🤖 `C2` — finish the `VcsBackend` abstraction.** `service.ts` imports `loreFilePatch`/
  `loreDiscardFile` directly from `vcs/lore.ts` and branches on `repo.vcs` in the viewer + `discardFile`.
  Add `filePatch()` + `discardFile()` to the `VcsBackend` interface, implement in `git.ts` + `lore.ts`,
  route through `backend.*`. (Also the cleanup half of the Lore feature-parity port below.)
- [ ] **🤖 `E4` — tunnel toggle + watcher→SSE pipeline (test gap).** The cloudflared *resolver*
  (`tunnel.test.ts`) and watcher *health* (`watcher.test.ts`) are covered, but the `PUT /api/mode`
  start/stop toggle and the watcher→`broadcast`→SSE wiring are not. Mock the tunnel factory; write a file
  and assert a `repo_state_changed` event reaches a subscriber. (`E1` detached-HEAD, `E2` push errors,
  `E3` SSE/bus are **done**.)

## 🟡 Big deal — before a polished public launch (P1)

- [ ] **🤖 `D1` — decompose `RepoCard.vue` (1,382 lines). The #1 maintainability win.** ~8 UI concerns in
  one file. Extract `BranchPanel` / `StashPanel` / `LogPanel` / `TagPanel` / `RemoteManager` /
  `FileViewerDrawer` siblings; `RepoCard` becomes a thin composer. Do incrementally, on its own branch.
- [ ] **🤖 `E5` — secrets without a keychain (test gap).** 2 of 3 `secrets.test.ts` cases
  `skipIf(!keychain)` → never run in CI. Add a stub so the migration path runs headlessly. **Also cover the
  new legacy keychain-service fallback** (`getSecret()` reads the old `"gitmob"` service and re-homes the
  value under `"repoyeti"` on first access — added by the rename, currently untested).
- [ ] **🤖 `E6` — frontend tests: currently zero.** Add **Vitest + @vue/test-utils** (pure-lib units, a
  store smoke test, a `SmartCommitPlan.vue` render) + one Playwright E2E of the SSE flow.
  ⛔ *Needs new dev-deps in the shared `bun.lock` — coordinate before adding.*
- [ ] **🤖 `F2` — document the Cloudflare-header auth assumption (security clarity).** `isRemoteRequest()`
  decides local-vs-remote purely from `cf-connecting-ip`/`x-forwarded-*`; behind a non-Cloudflare proxy
  that omits them, *remote could be treated as local*. Add a loud code comment + a README deployment note.
- [ ] **🤖 `F6` — accessibility / touch-target pass.** Card header is a `div` with `@click` (not a button);
  status chips lack `aria-label`; check 44pt/48dp targets. CSS/markup pass before a public, phone-first
  launch.
- [ ] **🤖 PAT / HTTPS auth.** Unblocks clone/fetch/push/tag-push for **private HTTPS** remotes (SSH-key
  auth doesn't help there). `pat_handle` column reserved; needs keychain + per-op `GIT_ASKPASS`. ⚠️ The
  network path can't be unit-verified without a real private repo + token — needs owner involvement to test.
- [ ] **🤖 Per-file (file-level) staging for a normal commit.** Only stage-all exists today. (Smart Commit
  already stages file-level internally; this exposes it for a single ordinary commit.)

### Lore (the pivot — experimental, behind `REPOYETI_LORE=1`) — *your current focus*

The core is done + verified (see ✅ Already done). To reach git-parity:

- [ ] **🤖 Port the remaining git-only features to Lore.** Diff + discard are ported (`lore diff` /
  `lore reset --purge`, verified); **AI commit-diff** (`collectRepoDiff`/`collectRepoPathsDiff`),
  **smart-commit** group staging, and **content-search** are still git-only and are **hidden in the Lore
  UI** (the web `aiHere` + capability gates). Map them to `lore diff` / `lore stage <paths>`+`lore commit`
  / a JS content scan over changed files, then re-enable the gates. (Shares the `C2` cleanup above.)
- [ ] **🤖 Lore servers web UI.** The backend is done + verified (`config.servers` +
  `GET/POST/DELETE /api/servers` + `POST /api/servers/clone` → `cloneLoreRepo`), but **nothing in
  `web/src` calls `/api/servers`** — there is no UI yet. Add a Settings → Servers panel (add/remove server
  URLs) + a "Clone from a Lore server" path in the Add-repo dialog. ⚠️ Prefer an **IP literal over
  `localhost`** in server URLs — a `localhost`→IPv6 QUIC handshake stalls ~30 s before IPv4 fallback (the
  Lore backend caps each op at 120 s via `LORE_TIMEOUT_MS`). *(The CHANGELOG "Server registry" entry is
  API-only until this lands.)*

## 🟢 Small deal — polish / nice-to-have (P2)

**Cleanup & dedup**
- [ ] **🤖 `C5` — gate nesting.** `collectRepoDiff` / `planCommitInput` call `readStatus` (takes `readGate`)
  *inside* an `enqueue` slot — no deadlock, but holds the op-queue while waiting on a read slot. Read before
  `enqueue`, or add a comment that it's intentional.
- [ ] **🤖 `D2` — `repoRoute()` wrapper.** `daemon.ts` repeats the id-parse/guard pattern ~19×. Extend the
  existing `action()`/`repoFromPath()` factory pattern.
- [ ] **🤖 `D3` — type duplication.** `CommitStyle` defined twice (config.ts + web types.ts);
  `CommitPlanGroup` (backend) vs `CommitGroup` (frontend) name drift. Align names; extend the
  `check-error-codes` drift guard to cover them.
- [ ] **🤖 `D4` — residual dedup.** Confirm/remove any remaining `ok()` / `PATCH_CAP` duplication between
  `git-actions.ts` and `vcs/lore.ts`; consider a shared `boundedDiffWithFallback()` (the unborn-HEAD diff
  fallback is copy-pasted in ~3 collectors). (`src/paths.ts` + `asResult()` dedup already done.)
- [ ] **🤖 `D5` — drop the dead `workspace_id` column.** The `repos` table still has `workspace_id` with no
  SQL against it (the `workspaces`/`sessions` tables were already removed).

**Tooling**
- [ ] **🤖 `B4` — CI completeness.** Add a cross-platform OS matrix (the compiled binary is per-OS) + a
  `bun audit` step. (Bun pinned + dep cache + the `check`/coverage/release workflows already in CI.)
- [ ] **🤖 `B5` — broaden the pre-commit hook** to run lint + typecheck, not just `i18n:check` (lint already
  runs in CI, so minor).
- [ ] **🤖 `B7` — misc hygiene:** pin `@types/bun` (currently `latest`); set `build.chunkSizeWarningLimit`
  for the Monaco chunk.

**Features (occasional / niche)**
- [ ] **🤖 Commit-detail diff from the log.** Tap a commit in History → see its changed files + diff
  (multi-file `git show`; add `readCommit` to `VcsBackend` so it's VCS-agnostic).
- [ ] **🤖 Toast "Undo" for hide / pin / star.** Pure frontend (vue-sonner action); zero server change.
- [ ] **🤖 Stable named-tunnel URL surface.** `CF_TUNNEL_TOKEN` is supported in config; add a Settings UI
  for it (no more re-scan on restart).
- [ ] **🤖 AI commit-style picker in the UI** (Conventional / concise / detailed; currently config.json-only).
- [ ] **🤖 Migrate Lore reads off CLI-scraping → `@lore-vcs/sdk`.** Status/branches/log are parsed from
  `lore` text output (fixture-locked in `tests/lore-parse.test.ts`); the SDK returns structured data that
  won't drift across Lore 0.x releases. Optional hardening.
- [ ] **🤖 Niche, someday:** git blame / per-file history · compare two refs · per-repo AI-provider override
  · cross-repo search · cross-repo activity feed · web-push notifications · commit signing (SSH/GPG).
- *Workspace/grouping UI is intentionally deferred — the `workspaces` table was removed.*

## 🧑 Needs you (decisions & secrets — collect answers, then an agent can act)

- [ ] **`A4` — cut version `0.1.0`** *(release-gating)*. Bump `package.json` (both) `0.0.1 → 0.1.0`, move
  CHANGELOG `[Unreleased]` into a dated `[0.1.0]` section, tag `v0.1.0`. You pick the number; the rest is
  mechanical.
- [ ] **`A5` — README personal-infra decision** *(release-gating)*. The README + `src/config.ts` hardcode a
  personal OAuth shim (`repoyeti-auth.lunawerx.workers.dev`) and a shared Connections `client_id`, and
  assume `connections.icu` access — a forker would hit *your* shim. Decide: keep baked-in / move to a
  neutral domain / require each deployer to register their own app. **Unblocked by your in-progress
  Connections-MCP/DNS work.** Then a 1-line README/config edit. *(Deploy/re-register mechanics live in
  `A6`; this is also the only remaining piece of `F4`.)*
- [ ] **Branch-protect `main` at launch** *(release-gating)*. Require PRs + green CI; no direct pushes — a
  GitHub settings step once the repo is public.
- [ ] **`F5` — relocate the root design doc.** `MARCHING_ORDERS.md` still sits at root; it holds durable
  spec (the §7 security model, secrets/identity protocol, §10 acceptance criteria) and is live-linked from
  `README.md`, `shim/README.md`, and `docs/SMART_COMMIT.md`. Promote its durable architecture into an
  `ARCHITECTURE.md`, **or** move it to `docs/archive/` and fix those three links. (The three input briefs —
  `gem.md`, `gpt.md`, `git-orchestrator-brief-v2.md` — were already deleted.)
- [ ] **Confirm the `MIT` license** is the intended one (package.json + `LICENSE` already say MIT).
- [ ] **Adopt "one branch/worktree per agent session"** (G) as the standing process (you run multiple
  agents on one tree; this avoids the cross-session contention seen this cycle).

## 🚫 Rejected by design (do **not** implement — don't re-litigate)

Interactive merge-conflict UI · rebase · `reset --hard` · `push --force`/`--force-with-lease` ·
WebSockets transport · self-hosted relay/tunnel infra · hunk-level partial staging. Each can strand the
repo in an unsafe state on a phone, or contradicts the zero-infra positioning.

## ✅ Already done / decided (so it isn't re-done)

- **`A1` — Groq key: DECIDED, do not rotate.** Owner directive (do not re-raise): the built-in `gsk_…` is a
  free-tier throwaway (6000 TPM, graceful heuristic fallback when exceeded) and **may be shipped publicly
  for the first few testers on purpose** — explicitly **not** a release blocker. Invariant: the real key
  stays in the gitignored `.env` as `GITMOB_BUILTIN_GROQ_KEY`; `src/config.ts` keeps only the placeholder.
- **`F4` — README accuracy pass** *(done 2026-06-29)*: feature list, status note, Smart-Commit/Lore/servers/
  remote-sync, `bun test` line, stale i18n claim, "Run (Phase 1)" heading all fixed. Only the owner-gated
  `A5` infra URLs remain (see 🧑 Needs you).
- **GitMob→RepoYeti rename** (commit `7fd3d39`, 2026-06-29): landed tree-wide and verified (bun test
  258/258, `tsc` clean, `check:codes`/`check:boundaries`, web build all green) — package + `bin` + CLI,
  `GITMOB_*`→`REPOYETI_*` env (incl. `REPOYETI_LORE`), `~/.gitmob`→`~/.repoyeti` & `gitmob.db`→`repoyeti.db`,
  keychain service + health/single-instance identity, the `misc/GitMob.*` files, and the **GitHub repo**
  `LunarWerxs/gitmob`→`LunarWerxs/repoyeti` (remote + package URLs repointed; old URL auto-redirects).
  Back-compat shipped: `config.ts migrateLegacyState()` (one-time dir + db move, default-home only) and
  `secrets.ts getSecret()` legacy-`"gitmob"`-keychain fallback (re-homes on first read). *The only remaining
  rename work is the owner-gated shim deploy + redirect-URI re-register — tracked as `A6` above.*
- **Guardrails:** Biome lint + `bun run check` + boundary guard + ApiErrorCode drift guard + 80% coverage
  gate, all in CI · `release.yml` (tag → cross-OS binary + GitHub Release) · pinned Bun + dep cache ·
  auto-enabled git hooks · `.editorconfig`.
- **Architecture:** `ActionResult`/`ActionCode` in `contract.ts`; `cloneLoreRepo` wired to a route;
  `src/paths.ts`/`asResult` dedup; `sessions`/`workspaces` tables removed.
- **Tests:** detached-HEAD (`E1`), push errors (`E2`), SSE/bus (`E3`).
- **Docs/community:** `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, issue/PR templates,
  `dependabot.yml`; `package.json` metadata (license/repo/author/keywords/engines); the three superseded
  root briefs deleted.
- **Lore (experimental, `REPOYETI_LORE=1`):** web card adapts to `repo.vcs` (a `lore` badge · hides
  fetch/stash/remotes/tags · relabels pull→"Sync"); **file diff + discard ported** (`lore diff` /
  `lore reset --purge`); **servers-registry backend + `cloneLoreRepo`**; **server round-trip
  (commit/push/sync) + clone-from-server verified** against a live local `loreserver`. The Lore CLI command
  surface + the status/branches/log output parsers were verified against **lore 0.8.4** (parsers
  fixture-locked in `tests/lore-parse.test.ts`); the ~30 s `localhost`-QUIC stall is dodged by using an IP
  literal in the server URL.
