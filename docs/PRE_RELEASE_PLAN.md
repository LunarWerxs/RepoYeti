# RepoYeti — Pre-Public-Release Readiness Plan

> **Purpose.** A grounded, prioritized plan to take RepoYeti from "grew fast and unplanned" to
> "clean enough to open-source with pride." Produced from a **5-track codebase audit** (tooling/CI ·
> duplication/drift · architecture/boundaries · test coverage · release-readiness/security), each
> verified against the actual files — not generic advice.
>
> **Sequencing.** Do this **AFTER the Lore functionality is fully implemented** — several items
> (finishing the `VcsBackend` migration, `registerRepo` for Lore) depend on Lore being done, and you
> don't want to decompose files that are still actively changing.
>
> **How to read it.** Severity = **P0** (blocks any public push) · **P1** (blocks a polished
> reputation) · **P2** (polish). Effort = **S** (<1h) · **M** (~½ day) · **L** (1–2+ days).
> Owner = 🧑 needs you (secrets/decisions) · 🤖 I can do.

---

## 0. Where we actually stand (the good news first)

You were right to expect drift — but the foundation is **healthier than feared**:

- ✅ **Strict TypeScript everywhere** (`strict`, `noUnusedLocals`, `noUncheckedIndexedAccess`; web `strict` too).
- ✅ **CI already exists** (`.github/workflows/ci.yml`): runs `typecheck` + `bun test` (243 tests) + `i18n:check` + web `build` on every push/PR.
- ✅ **No secrets ever committed.** The live Groq key lives only in a gitignored `.env`; `git log -S` confirms it was never in history. Path-traversal is guarded; shell-injection isn't possible (array-argv `Bun.spawn`, validated branch names).
- ✅ **MIT LICENSE present.** **Zero** TODO/FIXME/HACK in the whole tree. **`CONTRIBUTING.md` + a committed pre-commit hook** (`.githooks/`, opt-in) already exist.
- ✅ **Test coverage is already ~90%** (`bun test --coverage` → 92% lines / 90% functions) — it just isn't *gated* in CI yet. (Lowest: `daemon.ts` 6.6% — integration entrypoint, by design; `runtime.ts` 35%; `auth.ts` 77%.)
- ✅ **Architecture mostly holds** — `daemon → service → git-actions` layering is respected; the op-queue invariant is documented and followed.

So this is a **cleanup + guardrails + docs** job, not a rescue. ~16,700 LOC across `src/` + `web/`.

**The honest weak spots** (what the audit found): a few **oversized files** (notably `RepoCard.vue` at 1,332 lines), **hand-mirrored types** that can drift, a **half-finished VCS abstraction**, **dead code**, **no linter/formatter**, **no coverage gate**, **no architectural enforcement**, **zero frontend tests**, and **missing community/security docs**.

---

## 0b. Progress log (live)

**✅ DONE (committed locally, 2026-06-29 — additive, conflict-free with the live Lore session):**
A2/A3 package.json metadata (license/repo/author/keywords/engines) · **B2** architectural boundary
guard + **B6** ApiErrorCode drift guard (`scripts/check-boundaries.ts` + `check-error-codes.ts` under
`bun run check`, in CI) · **B3** global coverage gate (`scripts/check-coverage.ts`, 80% floor, in CI) ·
**B4** CI hardening (Bun pinned + dep cache) + **B4b** `release.yml` (tag→binary) · **B5** auto-enable
`.githooks` via `prepare` · **B7** `.editorconfig` · **D4** `asResult()` dedup (store.ts) · **D5** dead
`sessions`/`workspaces` tables removed · **E1/E2** detached-HEAD + push-error tests · **E3** SSE/bus tests
(+ broadcast exception isolation) · **F1** SECURITY.md · **F3** community/issue/PR templates + dependabot.

**✅ ALSO DONE:** **C3** ActionResult/ActionCode moved to contract.ts (+ the `vcs/types ⊥ git-actions`
boundary is now enforced by the guard).

**↩ NOW UNBLOCKED (the parallel remote-sync session landed; tree is quiet):** C2 finish VCS abstraction ·
D2 daemon `repoRoute()` wrapper · D4 `src/paths.ts` (isUnder dedup) + `ok()`/`PATCH_CAP` share. ·
**C1 registerRepo-git-only** — left to the VCS-domain owner (it may be intentionally git-only; a separate
Lore-clone route exists). C4 (`cloneLoreRepo`) is moot — that session wired it into a route.

**⛔ BLOCKED — needs a new dependency** (shared `bun.lock`; can't add without coordinating): B1
linter+formatter (Biome) · E6 frontend tests (Vitest).

**⛔ BLOCKED — needs a quiet tree + a visual pass:** D1 decompose `RepoCard.vue` (1,332 lines).

**🧑 NEEDS YOUR DECISION:** A5 README personal-infra fix (is connections.icu public/internal?) · A4
version bump + CHANGELOG cut · F5 move `MARCHING_ORDERS.md` (your active spec).

**Deferred (heavier/flakier test infra):** E4 tunnel toggle · E5 watcher callback + secrets-without-keychain.

---

## 1. Workstream A — Release blockers (P0) · ~1–2 hrs total

These must be true before the repo goes public.

| # | Item | Action | Effort | Owner |
|---|---|---|---|---|
| A1 | **Rotate the Groq key** | The `.env` key was never committed, but rotate it at console.groq.com/keys as standard hygiene before going public; drop the new value in `.env`. No code change (placeholder in `config.ts` is already inert). | S | 🧑 |
| A2 | **`package.json` metadata** | Add `"license": "MIT"`, `"repository": {type,url}`, `"author"`, `"keywords"`, `"engines": {"bun": ">=1.1.0"}`. GitHub/npm read these; their absence reads as abandonware. | S | 🤖 |
| A3 | **`bin` points at `.ts` source** | `"bin": {"repoyeti": "./src/index.ts"}` breaks any `bun install -g`. Either document "Bun-only, install via the compiled binary" or repoint to `dist/`. At minimum add the `engines` field (A2). | S | 🤖 |
| A4 | **Cut a real version** | Bump `0.0.1 → 0.1.0`, move `CHANGELOG.md`'s `[Unreleased]` into a dated `[0.1.0]` section, tag `v0.1.0`. | S | 🤖+🧑 |
| A5 | **README: personal infra leaks** | README hardcodes your personal OAuth shim URL (`repoyeti-auth.lunawerx.workers.dev`) and assumes `connections.icu` access. A forker would hit *your* shim. Replace with a placeholder + "deploy your own shim" note, and state plainly whether connections.icu is public or LunarWerx-internal. | S | 🧑 (decision) |

---

## 2. Workstream B — Tooling & guardrails (your "checks & balances") · ~½–1 day

This is the heart of your concern: *automated* enforcement so drift can't creep back. Set this up
**first**, before the cleanup workstreams — then every subsequent change is auto-checked.

| # | Item | What exists | What to add | Effort |
|---|---|---|---|---|
| B1 | **Linter + formatter** | **Nothing** (no ESLint/Prettier/Biome). | Recommend **Biome** (one fast Rust tool = lint + format, Bun-native, near-zero config) for `src/` + `web/`. Add `lint`/`format` scripts + a CI step. (ESLint is the alternative if you want the bigger plugin ecosystem — but Biome fits the "low-maintenance" goal better.) | M |
| B2 | **Architectural boundary checks** | None. | Enforce the layering as code so it can't drift: **`eslint no-restricted-imports`** (or **dependency-cruiser**) with rules — `daemon.ts` must not import `git-actions/status/inspect`; `vcs/*` must not import `service.ts`; `vcs/types.ts` must not import `git-actions.ts`; no circular deps. (Exact rules in the architecture audit.) | M |
| B3 | **Coverage gate** | Coverage **already ~90%** but CI runs `bun test` **without `--coverage`** and there's **no threshold**. | Run `bun test --coverage` in CI; set a threshold in `bunfig.toml` (~**80% lines**, comfortably under today's 90% so it can't silently regress). | S |
| B4 | **CI completeness** | typecheck + test + i18n + web build, Ubuntu-only, no caching, Bun unpinned. | Add: the **lint step** (B1); **dependency caching** (`actions/cache` keyed on `bun.lock`); a **cross-platform matrix** (`ubuntu/macos/windows` — the compiled binary is OS-specific); **pin the Bun version** (`bun-version`); a **`bun audit`**/Dependabot check; (later) the frontend test job (E6). | M |
| B4b | **Release workflow (binary is the product)** | **No `release.yml`** — the compiled `repoyeti` binary is built only locally; no GitHub Release, no published artifact. **A genuine P0 for a binary-distributed tool.** | Add `.github/workflows/release.yml`: on `v*` tag, matrix over OSes, `bun run scripts/build.ts`, upload binaries + create the GitHub Release. | M |
| B5 | **Shared git hooks** | Hook is **committed** (`.githooks/pre-commit`) but **opt-in** (`git config core.hooksPath .githooks`) and only runs i18n-check. | Auto-enable via a `prepare`/postinstall script, and broaden the hook to **lint + typecheck** (not just i18n). **lefthook** is the low-maintenance option. | S |
| B7 | **Misc tooling hygiene** | `@types/bun: "latest"` (unpinned → non-reproducible); no `.editorconfig`; Monaco chunk emits Vite size warnings. | Pin `@types/bun`; add a root `.editorconfig` (2-space, LF, utf-8); set `build.chunkSizeWarningLimit` for the Monaco chunk. | S |
| B6 | **Type-drift guard** | `ApiErrorCode` is hand-mirrored backend↔frontend (47 strings). | A tiny CI script that imports both unions and fails on mismatch (until/unless you generate the frontend type from the backend). Cheap insurance. | S |

---

## 3. Workstream C — Architecture & boundaries · ~½ day

The layering is sound; these close the **half-migrated VCS abstraction** and one real bug.

| # | Item | Finding | Action | Sev | Effort |
|---|---|---|---|---|---|
| C1 | **`registerRepo` is git-only** | Hardcodes a `.git` check (`service.ts`), so "Point to Folder" silently rejects valid **Lore** repos — a real bug given the Lore pivot. | Use `detectVcs(p)`; return `NOT_A_REPO` when null. | P1 | S |
| C2 | **VCS abstraction leak** | `service.ts` imports `loreFilePatch`/`loreDiscardFile`/`loreClone` directly from `vcs/lore.ts`, bypassing the `VcsBackend` interface; `discardFile`/`readFileDiff` branch on `repo.vcs`. | Add `filePatch()` + `discardFile()` to `VcsBackend`; route through `backend.*`. Finishes the refactor the `src/vcs/` work started. | P1 | M |
| C3 | **Type ownership** | `vcs/types.ts` (the backend *contract*) imports `ActionResult` from `git-actions.ts` (the git *implementation*) — an upward dependency. | Move `ActionResult`/`ActionCode` to `contract.ts`; re-export for back-compat. | P2 | S |
| C4 | **Dead export** | `cloneLoreRepo` is exported with **zero callers** anywhere. | Remove it (or wire the Lore-clone route if that's pending the Lore work). | P2 | S |
| C5 | **Gate nesting** | `collectRepoDiff`/`planCommitInput` call `readStatus` (takes `readGate`) **inside** an `enqueue` slot — not a deadlock, but holds the op-queue while waiting on a read slot. | Read before entering `enqueue`, or document it explicitly. | P2 | S |

---

## 4. Workstream D — Duplication & decomposition · ~1–2 days (mostly incremental)

| # | Item | Evidence | Action | Sev | Effort |
|---|---|---|---|---|---|
| D1 | **`RepoCard.vue` = 1,332 lines** | ~8 UI concerns in one file (branches, stash, log, tags, remote, file-viewer, identity, pin/star). **The #1 maintainability win.** | Extract `BranchPanel`/`StashPanel`/`LogPanel`/`TagPanel`/`RemoteManager`/`FileViewerDrawer` into siblings; `RepoCard` becomes a thin composer. Do incrementally. | P1 | L |
| D2 | **`service.ts` (994) / `daemon.ts` (940)** | Many responsibilities per file; `daemon.ts` has `const id = c.req.param("id")` **×27** and the id-guard **×19**. | Split `service.ts` (watcher/file/clone services); add a `repoRoute(handler)` wrapper to DRY the id-guard (you already have `action()`/`repoFromPath()` factories — extend the pattern). | P2 | M |
| D3 | **Hand-mirrored types** | `ApiErrorCode` (47 strings) and `CommitStyle` (×3: config/schemas/types) duplicated backend↔frontend; `CommitPlanGroup` vs `CommitGroup` name drift. | Add the CI drift-guard (B6) now; longer-term generate the frontend types. Align the `CommitGroup` name. | P2 | S–M |
| D4 | **Copy-pasted utilities** | `isUnder`≡`isPathUnder` (path-confinement, **two files, byte-identical** — risky if Windows path logic changes); `ok()`/`PATCH_CAP` in both `git-actions.ts` & `vcs/lore.ts`; the unborn-HEAD `diff` fallback copy-pasted in 3 collectors; the `asResult()` helper bypassed by 3 inline copies in `store.ts`; the provider/key/model resolution block duplicated across 2 AI routes. | Extract `src/paths.ts`; share `ok`/`PATCH_CAP`; a `boundedDiffWithFallback()` helper; use `asResult()` everywhere; a `resolveProvider()` helper. All small, low-risk. | P2 | S each |
| D5 | **Dead code** | `sessions` table (auth is stateless cookies — its own comments say so) & `workspaces` table both have **zero SQL** against them; single-locale i18n machinery. | Drop both tables from the `CREATE TABLE` block (zero runtime impact — `IF NOT EXISTS`). Decide: keep i18n as "translation-ready" infra or inline strings for v1. | P2 | S |

---

## 5. Workstream E — Test coverage · ~1 day

Backend coverage is strong; these are the real holes + the **frontend gap**.

| # | Item | Sev | Action |
|---|---|---|---|
| E1 | **Detached-HEAD paths** | P0 | 5 actions guard `DETACHED_HEAD` with **no test**. Checkout a SHA, assert pull/commit/push/stash/smart-commit all return it. |
| E2 | **Push error paths** | P0 | `NON_FAST_FORWARD` / `SSH_AUTH_FAILED` are contract promises with no test. Use a diverged bare-repo pair. |
| E3 | **SSE `/api/events`** | P0 | The dashboard's live heartbeat is **untested** — a listener leak/crash would silently kill live updates. Open a streaming fetch, `broadcast()`, assert the event arrives + listener cleanup. |
| E4 | **Tunnel toggle + watcher→SSE** | P1 | `PUT /api/mode` (start/stop tunnel) and the watcher→broadcast→SSE pipeline are untested. Mock the tunnel factory; write a file and assert a `repo_state_changed` event. |
| E5 | **Secrets without keychain** | P1 | 2 of 3 `secrets.test` cases `skipIf(!keychain)` → never run in CI. Add a stub so the migration path is covered headlessly. |
| E6 | **Frontend: ZERO tests** | P1 | Add **Vitest + @vue/test-utils**: unit-test the pure libs (`lib/changes-tree.ts`), a store smoke test (mock `api.ts`), and a `SmartCommitPlan.vue` render test. Plus **one Playwright E2E** of the SSE flow (add repo → edit file → badge appears) — the only fully-untested path end-to-end. |

---

## 6. Workstream F — Docs & community files · ~½ day

| # | Item | Action | Sev |
|---|---|---|---|
| F1 | **`SECURITY.md`** | Add `.github/SECURITY.md` (disclosure email, response window). Especially expected for a git-over-tunnel tool. | P1 |
| F2 | **Document the Cloudflare-header auth assumption** | `isRemoteRequest()` decides local-vs-remote purely from `cf-connecting-ip`/`x-forwarded-*`. Behind a non-Cloudflare proxy that omits them, remote could be treated as local. Document it (code comment + README deployment note). | P1 |
| F3 | **Community files** | Add `CODE_OF_CONDUCT.md` (Contributor Covenant), issue/PR templates, `.github/dependabot.yml`. (`CONTRIBUTING.md` already exists ✅.) | P1–P2 |
| F4 | **README accuracy pass** | Beyond F1/A5: run an outsider read-through (or `/what-is`). Confirm no other stale claims (the locale-lie was already fixed). | P1 |
| F5 | **Stale internal docs at repo root** | `gem.md`, `gpt.md`, `git-orchestrator-brief-v2.md`, `MARCHING_ORDERS.md` are first-person AI-planning artifacts sitting at the **repo root** — confusing/unprofessional for outside contributors. Move them to `docs/archive/`; promote the architecture content to a clean `ARCHITECTURE.md`; rename `docs/FEATURE_GAP_ANALYSIS.md` → `ROADMAP.md` and link from README. | P1 |
| F6 | **Accessibility / touch-target pass** | The gap-analysis flags card header `div@click`, missing aria-labels, 44pt/48dp targets — known debt for a phone-first UI. Do a CSS/markup pass or log it in ROADMAP as known. | P1–P2 |

---

## 7. Workstream G — Repo & release-process management ("the management of this")

This is the *ongoing* process, not a one-time fix.

- **Two-sessions-on-one-tree (active right now).** You're running parallel agent sessions committing to the same working tree (smart-commit + Lore/remotes-tags). It's stayed green, but it's fragile — commits bundle each other's work (as ours did). **Recommendation:** for release prep, run **one workstream at a time**, or give each session its **own branch/worktree**. Before any push, `git log --oneline` to see what's bundled.
- **Branch protection (at public launch).** Protect `main`: require PRs + green CI; no direct pushes. Feature branches per workstream above.
- **Releases.** Tag `vX.Y.Z`, cut the CHANGELOG section, and have CI **build + attach the compiled binary** (`dist/repoyeti*` per-platform) to the GitHub Release — that compiled binary *is* the product, so it should be a first-class, CI-produced artifact, not a local build.
- **Dependency upkeep.** Dependabot (F3) + the CI `bun audit` (B4) keep deps honest with near-zero effort.

---

## 8. Recommended execution order (tomorrow-morning checklist)

Do guardrails **before** cleanup, so every cleanup is auto-checked:

1. **Phase 0 — P0 blockers (~1–2 hrs):** A1 rotate key 🧑 · A2/A3 package.json · A4 version+CHANGELOG · A5 README infra-leak decision 🧑.
2. **Phase 1 — Guardrails (~½–1 day):** B1 Biome · B2 boundary rules · B3 coverage · B5 hooks · B6 type-drift guard · wire all into CI (B4). *Now the net is up.*
3. **Phase 2 — Architecture correctness:** C1 (Lore registerRepo bug) · C2 (finish VCS migration) · C3/C4/C5.
4. **Phase 3 — Dedup quick wins:** D4 (paths.ts, asResult, repoRoute, helpers) · D5 (dead tables) · D3 (align names).
5. **Phase 4 — Decompose `RepoCard.vue` (D1).** The big one; do it on its own branch.
6. **Phase 5 — Test gaps (E1–E6)** incl. standing up frontend testing.
7. **Phase 6 — Docs & community (F1–F6).**
8. **Phase 7 — Tag `v0.1.0`, make `main` public.**

> Phases 2–6 are independent — parallelizable across branches if you want to move fast, *as long as*
> you heed Workstream G (one branch each, not one shared tree).

---

## 9. Definition of done (public-release gate)

- [ ] Groq key rotated; secret-scan clean (`git log -S` for `gsk_`/`sk-`/`client_secret` → empty).
- [ ] `package.json` complete (license, repo, author, engines); version `0.1.0`; CHANGELOG cut.
- [ ] Lint + format + typecheck + tests + **coverage ≥70%** + boundary checks + **binary build** all green in CI.
- [ ] No P0/P1 architecture or test gaps open (C1, C2, E1–E4 closed).
- [ ] `LICENSE` + `SECURITY.md` + `CODE_OF_CONDUCT.md` + `CONTRIBUTING.md` + issue/PR templates present.
- [ ] README accurate for an outsider; no personal infra URLs; Cloudflare-auth assumption documented.
- [ ] `main` branch-protected; release builds + attaches the compiled binary.

---

## 10. Effort & ownership summary

| Bucket | Rough effort | Notes |
|---|---|---|
| P0 blockers (A) | 1–2 hrs | A1 + A5 need **you** (key, infra decision); rest is mechanical. |
| Guardrails (B) | ½–1 day | One-time setup; pays back forever. **Do first.** |
| Architecture (C) | ½ day | C1 is a real Lore bug — do once Lore lands. |
| Dedup (D) | 1–2 days | D1 (RepoCard) dominates; the rest are S-sized quick wins. |
| Tests (E) | 1 day | E1–E3 are P0-ish; frontend testing is net-new infra. |
| Docs (F) | ½ day | Mostly boilerplate files + a README pass. |
| **Total** | **~4–6 focused days** | Comfortably parallelizable; nothing here is a rewrite. |

**Owner-only decisions (queue these for yourself):** rotate the Groq key · is `connections.icu` public or internal? · MIT confirmed? · final version number · "one branch per session" process.

---

*Audit basis: 5-track read-only audit (2026-06-29) cross-verified against the working tree. This plan
intentionally excludes the Lore work itself — finalize that first, then start at Phase 0.*
</content>
