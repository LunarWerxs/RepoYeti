# RepoYeti

> Watches every local git repo on your machine and lets you pull, push, and review diffs from your phone.

<!-- odin:about HAND-OWNED above the GENERATED marker. Edit freely; `odin codex about --ingest` carries it back into Odin's Codex. -->

## What it is

RepoYeti is a self-hosted git dashboard: a single Bun-compiled daemon binary that recursively discovers every git repo on your machine, watches them cheaply (`.git/HEAD`/`.git/index` only), and serves a live status grid, commit graph, and real Monaco diff viewer to your phone or browser over a zero-config Cloudflare tunnel. It drives your real local git via `simple-git` with per-operation identity injection (no global gitconfig mutation), gates every remote action app-layer auth ('Sign in with Connections' OIDC) so the tunnel URL alone is worthless, and deliberately leaves out force-push/reset --hard/rebase because a phone is a bad place to rewrite history. Nothing runs in someone else's cloud; local state lives in `~/.repoyeti/`.

## Things not to forget

_The intricacies worth remembering: the gotchas, the half-built parts, the decisions whose
reason lives nowhere else. Odin never overwrites this section._

- Rebase, reset --hard, and force-push are deliberately left out forever, not just unimplemented - the architecture doc marks them 'never, out of scope by design' because a phone or remote session is the wrong place to rewrite history; do not add them as a convenience feature. anchors: `docs/ARCHITECTURE.md:135`
- Per-repo git identity (SSH key, email) is injected per-operation via a GIT_SSH_COMMAND env var and git -c config flags, never by writing to the user's global ~/.gitconfig - keep it that way when touching identity handling. anchors: `src/git.ts:14`
- When the OS keychain is unavailable, secrets silently fall back to plaintext in ~/.repoyeti/config.json with only a one-time console warning, and the doc itself notes 0600 permissions are a no-op on Windows NTFS, so that fallback file is effectively unprotected there. anchors: `docs/ARCHITECTURE.md:439`
- docs/ARCHITECTURE.md still claims 'no diff viewer, no merge-conflict resolution' and lists both as 'never' in its scope table, but a real Monaco diff viewer and an AI merge-conflict resolver both ship in the current code - the doc has rotted and should not be trusted over the code here. anchors: `docs/ARCHITECTURE.md:58`
- The Windows tray icon comes from a separate native Rust launcher process that spawns the daemon; since 1.0.2 the compiled exe carries that launcher inside the binary and starts it, so both downloads show the icon (before then, running repoyeti.exe by itself produced none, which read as a bug). anchors: `misc/tray-host-native/src/main.rs:802`
- The Lore VCS backend is dormant/unwired unless REPOYETI_LORE=1 is set - simple-git-backed git remains the only backend actually exercised in production, so bugs there won't surface without opting in. anchors: `src/vcs/lore.ts:10`
- MCP/agent-triggered mutating actions pass through a configurable approval gate (auto-approve, auto-deny, or manual-with-timeout) rather than executing directly, so an autonomous agent caller can be throttled to human-in-the-loop without code changes. anchors: `src/approvals.ts:153`

<!-- odin:about GENERATED BEGIN - rewritten by `odin codex about --publish`; edit the Codex, not this -->

## What Odin knows about this project

Everything from here down is generated from this project's Codex dossier
(`codex/projects/repoyeti.md` in the Odin clone) and is **rewritten on every publish** -
edit the dossier, not this block. Everything ABOVE the marker is yours.

### At a glance

- **Ships as:** CLI - single compiled daemon binary (`bun --compile`) distributed via GitHub Releases (one-file .exe/zip per platform, plus an optional Windows system-tray build) and npm (`npm install -g repoyeti`); the daemon embeds and serves a Vue 3 PWA dashboard over HTTP and, optionally, a Cloudflare quick/named tunnel
- **Live at:** https://repoyeti.com
- **Written in:** TypeScript (449 files), Vue (169 files), JavaScript (21 files), PowerShell (7 files)
- **Built with:** Hono, Playwright, Tailwind, TypeScript, Vite, Vitest, Vue
- **Package:** `repoyeti` 0.21.5
- **Entry points:** `bin`, `scripts`
- **Tests:** 212 test file(s)
- **CI:** `ci.yml`, `release.yml`
- **Domain:** git, self-hosted, remote-access, mobile-dashboard, cloudflare-tunnel, ai-commit-assist
- **Remote:** https://example.com/a.git

### Architecture

- `src/http/` - Hono HTTP server: route modules (repos, identities, shares, collaborations, buzz, mcp, auth, ...) behind one auth middleware, OpenAPI doc generation, static PWA mount
- `src/service/` - the one orchestration layer: per-repo op-queue serialization, git action guards (FF-only pull, no-force push, dirty-tree refusal), watcher-to-SSE wiring
- `src/read/` - pure read-only git inspection (status/log/branches/diffstat) with no mutation and no service-layer dependency, enforced by a boundary check
- `src/cli/` - the `repoyeti` command-line front door; git verbs and MCP-stdio are thin HTTP clients to the loopback daemon, never touching git in-process
- `src/mcp/` - hand-rolled MCP server (JSON-RPC 2.0): stdio (`repoyeti mcp`) and in-process HTTP (`POST /api/mcp`) adapters share one 14-tool catalog
- `src/ai/` - AI provider adapters plus Smart Commit plan generation, commit-message generation, and merge-conflict resolution proposals; bring-your-own-key
- `src/share/` - guest share-link auth: token mint/redeem, per-route permission policy, status redaction, and the guest SSE event feed
- `src/vcs/` - pluggable VCS backend interface; `git` (default, via simple-git) and an experimental `Lore` backend behind `REPOYETI_LORE=1`
- `web/src/` - Vue 3 + Tailwind PWA dashboard: repo grid, git-graph history view, Monaco diff/file editor, identity selector, SSE client
- `relay/` - separately-deployed Cloudflare Worker: stable-address redirects plus the Quick Tunnel OAuth callback resolver (never proxies dashboard traffic)
- `misc/tray-host-native/` - Rust native tray host (lunarwerx-tray) - optional sidecar launcher that spawns the unchanged daemon binary and draws the system-tray icon
- `scripts/` - build pipeline (vite build -> bun --compile per target) and the `check:*` guardrail scripts (boundaries, gitenv, bytes, changelog, ...)

### Features

31 recorded - 29 shipped, 2 partial, 0 planned. Each `path:line` is where the feature is DEFINED, checked by `odin codex check`.

**Shipped**

- **Live repo status grid** - Every discovered repo's branch, dirty count, and ahead/behind is watched event-driven and pushed to the dashboard within seconds of a local change. - `src/http/routes/repos.ts:22`, `src/http/routes/health.ts:127`
- **Git-graph commit history** - Lazily-paged commit graph with lanes, merges, and a per-commit files-and-lines delta, resizable to read more at once. - `src/http/routes/log.ts:12`
- **Bulk repo actions** - Select any number of repos and pin, star, hide, or remove them in one action; every action undoes. - `src/http/routes/repo-flags.ts:21`
- **Preview a pull before pulling** - See the incoming commits, the files they touch, and any conflicts they would cause before anything is fetched or merged. - `src/service/reads.ts:118`
- **Monaco diff and file viewer/editor** - The real VS Code editor component renders HEAD-to-tree diffs with syntax highlighting and lets you edit and save a file directly. - `src/http/routes/files.ts:213`, `web/src/lib/monaco-setup.ts:33`
- **Smart Commit (AI multi-commit splitter)** - One tap turns a messy working tree into an ordered set of small, logically-scoped commits at file granularity (never a split hunk), which you review/edit before they are created. - `src/ai/commit-plan.ts:347`
- **AI merge-conflict resolution assist** - Proposes a per-hunk merge resolution for a conflicted file with a confidence score, flags on dropped/invented lines, and rejects hunks it isn't sure about rather than guessing. - `src/ai/conflict-resolve.ts:587`
- **AI commit message generation** - Generates a Conventional-Commits-style subject/body from the staged diff using whichever bring-your-own-key provider is configured. - `src/ai/commit-message.ts:458`
- **Per-repo git identities** - CRUD identities (name/email/SSH key/optional PAT) with auto-detection of existing identities, assign one per repo, and every operation injects it via GIT_SSH_COMMAND + git -c without touching ~/.gitconfig. - `src/http/routes/identities.ts:18`, `src/http/routes/identities.ts:64`
- **Remote access via Cloudflare tunnel** - Spawns a cloudflared quick or named tunnel and prints a QR code so the dashboard is reachable from a phone on cellular data with no port forwarding; tunnel failure is non-fatal. - `src/http/routes/mode.ts:79`, `src/cli/lifecycle.ts:332`
- **Sign in with Connections (owner-only OIDC)** - Every /api/* route 401s until the caller completes Authorization Code + PKCE login against accounts.connections.icu and the verified sub matches the single configured owner. - `src/auth.ts:279`, `src/auth.ts:638`
- **Share links (guest access)** - The owner mints a scoped, expiring, revocable link (view or control permission, one or more repos) that lets a guest in without a Connections account, like a Drive 'anyone with the link' share. - `src/http/routes/shares.ts:264`, `src/share/policy.ts:360`
- **Collaboration links (peer working-tree pairing)** - Pairs two working trees so their diffs/status can be inspected against each other and a commit synced through the link. - `src/http/routes/collaborations.ts:184`
- **MCP server for AI agents** - `repoyeti mcp` (stdio) and POST /api/mcp (HTTP) both expose the same 14-tool catalog: local repos, accepted-collaboration status/diffs, and guarded remote commit+sync, gated by the normal auth middleware. - `src/http/routes/mcp.ts:17`, `src/mcp/tools.ts:71`
- **CLI git verbs** - repos/status/log/branches/checkout/commit/diff/drift/stash/push/pull/fetch, all as thin HTTP calls to the already-running loopback daemon. - `src/cli/main.ts:32`, `src/cli/git.ts:75`
- **REST API with machine-readable OpenAPI doc** - 60+ routes covering the full surface (branches, log, stash, tags, remotes, files/diff, AI, servers, settings, ...) introspected live into an OpenAPI 3.1 document at GET /api/openapi.json. - `src/http/openapi.ts:461`, `src/http/routes/openapi.ts:5`
- **Owner-minted API token** - An optional Bearer token (mint/revoke/show via `repoyeti token`) sits alongside the OIDC session for remote/headless agent callers, off by default and never weakening the OIDC posture. - `src/cli/token.ts:16`
- **Auto-updater** - Git-based self-update: periodic check/apply on an interval with relaunch, busy-retry backoff, and a bounded deferral count when git operations are in flight. - `src/auto-update.ts:144`, `src/auto-update.ts:331`
- **Scheduled auto-commit** - Optional per-repo scheduled commit (interval or daily-at) with optional pull-first/push-after and an AI-or-fallback commit message, skipping repos mid-operation or in conflict. - `src/auto-commit.ts:223`, `src/auto-commit.ts:442`
- **System-tray launcher (Windows)** - A separate native Rust launcher (lunarwerx-tray) draws the tray icon and spawns the unchanged daemon binary; since 1.0.2 the compiled exe embeds that launcher and starts it, so running repoyeti.exe alone produces the icon too. - `misc/tray-host-native/src/main.rs:802`
- **GitHub account sync** - Resolves each repo's writable GitHub account among the machine's signed-in gh accounts (by permissions.push) and uses that account's token for the git credential helper, scoped per-host, never cached. - `src/http/routes/accounts.ts:28`
- **Agent approval gate** - A configurable auto-approve / auto-deny / manual-with-timeout gate in front of MCP/agent-triggered mutating actions, with a pending-approvals list an operator can settle. - `src/approvals.ts:153`, `src/http/routes/approvals.ts:13`
- **On-demand repo scan + configurable scan roots** - Trigger a cancellable rescan of the whole machine or a single folder, and add/remove which root folders RepoYeti searches for git repos, with new repos streaming in live over SSE. - `src/http/routes/scan.ts:9`, `src/http/routes/roots.ts:10`
- **Clone, register, or create a repo from the dashboard** - Clone a remote by URL into a scan root, register an existing folder as a tracked repo, or create a brand-new one, each validated to stay inside a configured scan root before touching disk. - `src/http/routes/repos.ts:35`, `src/http/routes/repos.ts:43`
- **Open a repo or file in an external editor** - Detects installed local editors (VS Code and others) and launches one on a repo folder or a specific changed file directly from the dashboard; loopback-only so a remote/tunnel session can't spawn a window on the desktop. - `src/http/routes/editors.ts:8`
- **Identity Firewall (path-based required-identity rules)** - Owner-configured {pathPattern, requiredIdentityId} rules that block a commit or push under a matching path unless the assigned identity is the one performing it, enforced for both dashboard actions and MCP-triggered mutations. - `src/http/routes/identity-rules.ts:20`
- **Auto-commit incident ledger** - The owner can review a persisted log of auto-commit runs the unattended scheduler skipped, blocked, or failed, then acknowledge each incident to clear the review queue; owner-only, never exposed to a share-link guest. - `src/db/automation.ts:90`, `src/http/routes/auto-commit-incidents.ts:12`, `web/src/components/settings/AutoCommitSection.vue:122`
- **Grouped operational errors** - The owner sees every failed git action across all repos grouped by fingerprint with an occurrence count and last-seen time, and can mute a noisy group or dismiss it outright; owner-only, never exposed to a share-link guest. - `src/service/core.ts:107`, `src/http/routes/errors.ts:18`, `web/src/components/settings/OperationalErrorsSection.vue:37`
- **Per-provider AI key pool** - The owner can add a backup pool of API keys per AI provider that rotates past a rate-limited or failing key automatically, shown in settings as masked fingerprints only; owner-only, never exposed to a share-link guest. - `src/http/routes/ai.ts:746`, `src/ai/credential-pool.ts:173`, `src/share/policy.ts:132`

**Partial - exists but incomplete, gated off, or known broken**

- **Buzz: Git Smart HTTP compatibility (Advanced, opt-in)** - Experimental opt-in Smart-HTTP git-server compatibility with saved communities and daemon-safe preflight diagnostics; README labels it explicitly experimental/Advanced. - `src/http/routes/buzz.ts:108`, `src/http/routes/buzz.ts:92`
- **Pluggable VCS backend (Lore, experimental)** - A second VcsBackend implementation for Epic's Lore, enabled only behind REPOYETI_LORE=1; git via simple-git remains the default and only production backend. - `src/vcs/lore.ts:708`

### Where to add a new one

- **a new HTTP route** - add a routes/*.ts module exporting register(app, deps) and wire it in createApp(); it inherits the single auth middleware automatically anchors: `src/http/app.ts:91`, `src/http/routes/repos.ts:22`
- **a new CLI git verb** - add to GIT_VERBS and a *Verb function in src/cli/git.ts; it stays a thin HTTP client to the loopback daemon (boundary-checked against touching service/git directly) anchors: `src/cli/main.ts:32`, `src/cli/git.ts:75`
- **a new MCP tool** - add to the 14-tool catalog in src/mcp/tools.ts and its handler; both the stdio and HTTP adapters advertise the same catalog through core.ts dispatch anchors: `src/mcp/core.ts:56`, `src/mcp/core.ts:69`
- **a new VCS backend** - implement the VcsBackend interface (see src/vcs/lore.ts as the second real implementation) and register it beside the default git backend anchors: `src/vcs/lore.ts:18`
- **a new DB table or migration** - add a CREATE TABLE IF NOT EXISTS block in src/db.ts, run once at daemon boot (WAL mode, retry on SQLITE_BUSY) anchors: `src/db.ts:105`
- **a new AI provider adapter** - add an entry to AI_ADAPTERS in src/ai/adapters.ts (models/generate URLs, headers, body builder, completion extractor); Smart Commit/commit-message/conflict-resolve consume it uniformly anchors: `src/ai/adapters.ts:374`

### Gaps and wants

_Withheld: this repository is public, and the gap list is not published outside the private index._
_Read it with `python odin.py codex brief repoyeti` in the Odin clone._

---

_Generated by `odin codex about --publish repoyeti` on 2026-09-09 from a Codex dossier stamped 2026-09-05. Regenerate after the product moves; `odin codex about` reports drift._
<!-- odin:about GENERATED END sha=f621597e07bb -->
