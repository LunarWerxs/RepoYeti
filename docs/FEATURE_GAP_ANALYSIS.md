# RepoYeti — Feature & Functionality Rundown + Gap Analysis

> **What this is.** A rundown of what RepoYeti does today, and a prioritized analysis of features
> that comparable git tools have but RepoYeti is missing — focused on what's *obviously needed*,
> *frequently asked for*, or *commonly used*. Produced by a 5-lens adversarial review (desktop
> GUI clients · mobile/remote git apps · missing core git primitives · PWA/UX quality · a scope
> guardian that defends the design and promotes ready-but-deferred items).
>
> **The guard rail.** Every recommendation respects RepoYeti's central invariant: **the daemon never
> leaves a repo in an unsafe / half-merged state — it surfaces "resolve at your desk" and stops.**
> Anything that can strand the repo mid-operation on a phone is rejected by design (see Tier 3).

---

## 1. What RepoYeti does today (current feature inventory)

**Product.** A self-contained, system-wide **remote git manager**: a background Bun daemon discovers
your local git repos, tracks their state event-driven, and serves a mobile PWA (Vue 3) over a
Cloudflare tunnel — OIDC "Sign in with Connections" auth, single owner — so you can drive **safe**
git actions from your phone. Originally "passive triage + identity-boundary protection," it has since
grown a file viewer, file editing, content search, and AI commit messages — i.e. it is being grown
into a genuinely useful phone-driven git client, not just a read-only dashboard.

| Area | Implemented today |
|---|---|
| **Repo management** | Auto-discovery (recursive BFS, multi-root in config) · register an existing repo by path · create a new repo (`git init`) · hide / pin / star / drag-reorder. |
| **Status** | Per repo: branch, dirty count, ahead, behind (last-fetch, timestamped), remote URL, optional per-file/per-repo line+char diffstat. Pushed live over SSE; `.git` watchers + poll fallback; per-repo op-queue serializes all git ops. |
| **Git actions** | fetch (`--prune`) · pull (**fast-forward only**, refused on dirty / detached) · push (**never `--force`**, non-FF refused) · stage-all + commit (with `--amend`). All identity-attributed via per-op `-c core.sshCommand` + `-c user.*` (global/repo config never mutated). |
| **Files** | Changed-files tree (VS Code icons, resizable) · content search across changed files (`git grep`) · Monaco viewer (Content / Diff / word-level / split) · **file editing** (edit + save back to disk, path-confined). |
| **Identity** | CRUD identities (name, email, SSH key *path*) · assign per repo · per-op injection. |
| **AI** | Bring-your-own-key commit-message generation (6 providers + a free built-in Groq key). |
| **Auth / remote** | OIDC login · local/remote mode toggle · cloudflared tunnel + QR. |
| **Settings** | diffstats · remote-editing · diff-patch threshold · theme (light/dark/system) · changes-view size. UI is **English-only** (i18n scaffolding retained). |

---

## 2. The gaps — prioritized

### Tier 1 — Obviously needed & safe (implement)

These came back as **implement-now** across multiple lenses, are high-demand in every comparable tool,
and fit the safety invariant with straightforward guards. They turn RepoYeti from "sync + triage" into a
real phone git client.

| # | Feature | Why it matters | Demand | Effort | Guard |
|---|---|---|---|---|---|
| 1 | **Branch list + switch (checkout)** | The #1 missing primitive — you can see the current branch but can't change it, so pull/push are locked to whatever branch was active at your desk. | ubiquitous | M | Refuse on dirty tree (same as pull) / detached HEAD; switch to existing branches only. |
| 2 | **Create branch (+ optional switch)** | Start a feature/hotfix branch from the phone. Branch-create never touches the working tree → always safe. | common | S | Validate ref name; reject if it already exists. |
| 3 | **Delete branch (local, merged-only)** | Routine post-merge cleanup; stale branches clutter the picker. | common | S | `-d` only (never `-D`); refuse current + protected (`main`/`master`) without confirm. |
| 4 | **Commit history / log view** | The #2 primitive — "did my commit land?", "what did a teammate push?" Pure read, zero state risk. | ubiquitous | M | Read-only, paginated, bounded result set. |
| 5 | **Stash: save / list / pop / drop** | Converts the most common dead-end ("dirty tree → resolve at your desk") into "stash → pull → pop" from the phone. | common | M | Pop preflights a clean tree; on conflict it surfaces `STASH_CONFLICT` and leaves the entry intact (never a silent half-merge). Drop is confirm-gated. |
| 6 | **Discard / restore a working-tree file** | The inverse of the file editor (which can save but not revert). Recovers an accidental edit; another phone-side escape from a dirty tree. | ubiquitous | S | Path-confined like the editor; **destructive → explicit confirm**; refuse detached HEAD. |
| 7 | **README locale correctness fix** | The README advertises Spanish/French/German/Chinese + a language switcher; the app ships **English only**. A documentation lie that misleads contributors. | — | S | Doc-only. |

### Tier 2 — Worthwhile, do next (backlog)

Solid value, but either lower demand for the solo-owner target or needing more UX design. Several are
"promote the half-built" — the DB schema or CLI plumbing already exists.

| Feature | Why | Demand | Effort | Note |
|---|---|---|---|---|
| **Scan-root management in the dashboard** | Adding a scan root is CLI-only today; the empty-state literally tells a phone user to open a terminal — a dead end. `config.addRoot()` already exists. | common | S | Add `GET/POST/DELETE /api/roots` + a Settings section; fix the empty state. |
| **Bulk fetch-all / pull-all** | Tapping fetch per card is tedious with many repos. Op-queues already serialize. | common | S | Pull-all needs a per-repo result summary (some will be dirty/diverged). Push-all stays out. |
| **Toast "Undo" for hide / pin / star** | Accidental taps are common on a phone; vue-sonner already supports a toast action. | occasional | S | Zero server change. |
| **Session management / "sign out everywhere"** | The `sessions` table exists but auth never reads it — a stolen cookie can't be revoked. Real security gap, cheap to close. | occasional | S | Write a row on login, check `revoked` in `readSession`, add a revoke-all route. |
| **Stable named tunnel URL** | The rotating quick-tunnel URL means a re-scan on every restart. `CF_TUNNEL_TOKEN` is already supported. | common | S | Mostly docs + a Settings surface, not new code. |
| **Commit detail diff from the log** | "What changed in that commit?" — `git show <sha>` into the existing Monaco diff viewer. | common | S | Depends on the log view (Tier 1). |
| **Recent commit messages as commit suggestions** | Typing on a phone is the bottleneck; offer the last few subjects as one-tap chips. Complements AI generation. | common | S | Reuses the log endpoint. |
| **AI commit-style picker in the UI** | `style` is stored server-side but only editable via config.json. | niche | S | A Select wired to the existing settings route. |
| **Clone from URL** | Bootstrap a repo onto the machine from the phone — the natural companion to register/create. | common | M | Confine target to a scan root; run behind `netGate` with a long timeout; stream progress; clean up partials. Pairs well with PAT auth. |
| **Remote add / set-url / rename** | `git init`-from-phone repos have no remote; fixing a moved remote URL is impossible today. | occasional | S | URL-scheme validation. |
| **Tag list (+ optional annotated create)** | Orient history against releases; tag-to-deploy. | occasional | S | List is pure read; create + `push --tags` is safe (no half-merge). |
| **Per-file (file-level) staging** | Only stage-all exists; logically-coherent commits need file selection. Hunk-level is explicitly out (mobile-IDE territory). | common | M | Make the changes tree selectable; `git add <paths>` then commit without `-A`. |
| **git blame / file history** | "Who wrote this, is it mine before I edit?" Overlay on the Monaco view; `git log -- <path>` is the simpler first step. | common | M | Depends on log. |
| **Compare two refs** | Pre-PR "what's between main and my branch?" `git diff a..b` into Monaco. | occasional | M | Needs a ref picker. |
| **Workspace / grouping UI** | The `workspaces` table exists but is unused; valuable past ~20 repos. | occasional | M | Pure CRUD + filter; needs UX design first. |
| **Per-repo settings (e.g. AI provider override)** | Work vs personal accounts per repo. | niche | M | Small DB column + inline sheet. |
| **Cross-repo global search** | Find a string across all repos, not just one repo's changed files. | occasional | L | Hard-cap/paginate results; scope to changed files first. |
| **Cross-repo activity feed** | "What changed on my machine today?" across all repos — unique to RepoYeti. | occasional | M | Aggregate `git log` over starred/pinned first (cost on 200 repos). |
| **Web push notifications** | A phone-first tool that only updates when open misses its premise; push when a repo falls behind / a push fails. | occasional | L | VAPID + subscription store + SW push handler; opt-in per event; remote-mode only. |
| **Commit signing (SSH/GPG)** | Teams with required signing can't commit. `signing_handle` column already reserved. | niche | M | Inject `-c gpg.format=ssh -c user.signingKey -c commit.gpgsign=true`; guard the passphrase hang. |
| **PAT / HTTPS auth** | SSH-key auth is irrelevant for HTTPS remotes. `pat_handle` column reserved. | common | M | Keychain + per-op `GIT_ASKPASS`; never fall through to the system store. |
| **Accessibility + touch-target audit** | Card header is a `div` with `@click`; status chips lack aria-labels; 44pt/48dp targets. | common | S–L | A CSS/markup pass before any public launch. |

### Tier 3 — Rejected by design (do **not** implement)

Commonly requested in desktop GUIs, but each can strand the repo in an unsafe state on a phone (or is
explicitly mandated against). Listed so the decision isn't re-litigated.

| Feature | Why it stays out |
|---|---|
| **Interactive merge-conflict resolution UI** | The exact unsafe state the daemon exists to avoid; a three-way merge on a touch keyboard is error-prone with no undo. Surface "resolve at your desk" and stop. |
| **Rebase (interactive or not)** | Rewrites history; any step can conflict and leave a detached, mid-rebase `ORIG_HEAD` state. No guard makes it phone-safe. |
| **`reset --hard`** | Irreversibly destroys uncommitted work; a mis-tap wipes hours. Discard/stash cover the safe subset. |
| **`push --force` / `--force-with-lease`** | Can overwrite a teammate's commits; a phone UI can't convey what's being overwritten. Hard 403 by design. |
| **WebSockets transport** | SSE is mandated and sufficient (auto-reconnects through cloudflared); switching adds protocol risk for no user benefit. |
| **Self-hosted relay / tunnel infra** | Turns a self-contained tool into an infra operator — contradicts the zero-infra positioning. |
| **Hunk-level partial staging** | A touch diff-selection editor is mobile-IDE scope creep the spec warns against. (File-level staging is in Tier 2.) |

---

## 3. Shipped so far

**Wave 1 — Tier 1 core** (the unanimous, design-safe primitives):

- **Branches** — list, switch/checkout (clean-tree guarded), create (+switch), delete (merged-only, protected-branch guarded).
- **Commit history / log** — read-only, paginated.
- **Stash** — save (incl. untracked), list, pop (conflict-safe), drop.
- **Discard file** — per-file restore to HEAD, path-confined, confirm-gated.
- **README locale fix** — correct the English-only reality.

New first-class error codes follow the existing `contract.ts` envelope (`{ ok, code, message }`):
`INVALID_REF_NAME`, `BRANCH_EXISTS`, `UNMERGED_BRANCH`, `CANNOT_DELETE_CURRENT`, `PROTECTED_BRANCH`,
`NOTHING_TO_STASH`, `STASH_CONFLICT`, `STASH_EMPTY`, `DISCARD_FAILED` — and dirty-tree/detached reuse
the existing `DIRTY_WORKING_TREE` / `DETACHED_HEAD`.

**Wave 2 — Tier 2 dead-ends + safety** (three promoted from the backlog above):

- **Scan-folder management** — `GET/POST/DELETE /api/roots` + a Settings → Scan folders card (add scans
  live over SSE; remove forgets the auto repos under it via a new `repo_removed` event). The empty
  state now offers "Add a scan folder" instead of a dead CLI hint.
- **Bulk fetch-all** — `POST /api/repos/fetch-all` (bounded by `netGate`) + a header button with a
  one-line success/partial summary.
- **Sign out everywhere** — `POST /api/auth/logout-all` rotates the daemon's HMAC signing key, instantly
  invalidating every device's session cookie (sessions are stateless, so there's no row to revoke).

**Wave 3 — onboarding + phone ergonomics:**

- **Clone from URL** — `POST /api/repos/clone` (URL scheme + target name + parent-under-root validated;
  per-op SSH-key injection; bounded by `netGate` with a long clone timeout) + a **Clone** mode in the
  Add-repository dialog (URL · destination folder · optional name · identity). The clone lands and is
  indexed/watched live.
- **Recent commit-message chips** — the commit box offers your last few commit subjects as one-tap fills
  (reuses the log endpoint; kept separate from the History log so they don't clobber each other).

**Wave 5 — lifecycle completion:**

- **Remote management** — `POST`/`DELETE /api/repos/:id/remote` (add-or-update / remove `origin`, local
  config only, URL-scheme validated) so a `git init`-from-the-phone repo can be given a remote and pushed.
- **Tags** — read-only list (`GET /api/repos/:id/tags`) plus **create** (`POST /api/repos/:id/tag`,
  git-only, annotated when a message is given, optional push to origin). Both live in a self-contained
  `RepoManage.vue` dialog opened from the repo card's ⋮ menu.

**Next up (remaining Tier 2):** commit-detail diff from the log (multi-file `git show` → viewer) ·
PAT/HTTPS auth (for private-HTTPS remotes) · file-level staging · stable named-tunnel URL surface · workspace UI.
