# AI Architecture & Implementation Brief (v2): System-Wide Remote Git Manager

## 0. Role & Output Contract

You are an elite principal systems architect and full-stack engineer. I want you to design and scaffold a self-contained, lightweight, system-wide remote Git orchestrator. Several architectural decisions below are **already made** — they are constraints, not open questions. Do not re-litigate them; build on them. Where I explicitly mark something **OPEN**, evaluate the tradeoffs and recommend.

For every layer, give: (a) your concrete recommendation, (b) a one-paragraph justification, and (c) the specific failure mode you are guarding against. Then produce the deliverables in Section 9.

---

## 1. Objective

Design a background service (daemon) that runs on a local dev machine (Mac, Windows, Linux), recursively tracks the state of all Git repositories across specified directories, and securely exposes a high-density, mobile-first web interface via a secure remote URL — with **first-run device pairing** and **no manual router/port-forwarding setup** (the Plex/AnyDesk model).

Distribution is two unified channels sharing 100% of core logic:
1. A global CLI tool (`npm install -g` / Bun-compiled binary).
2. A lightweight native desktop installer (Windows/Mac) living silently in the menu bar / system tray.

---

## 2. NON-NEGOTIABLE: Security & Access Control (Cross-Cutting)

This is the layer the original brief omitted, and it governs every other decision. **The tunnel is transport security, not access control.** A `*.trycloudflare.com` URL is public and merely unguessable; if it leaks (logs, browser history, referrer headers), an attacker reaches a daemon holding every SSH key, PAT, and signing identity I own.

**Required, already decided:**

* **App-layer auth is mandatory and independent of the tunnel.** The daemon must be unusable over the network until a device is paired, regardless of which tunnel is active.
* **First-run pairing is required friction.** On first launch the daemon generates a pairing secret and prints it locally (terminal QR + tray "Pair device" action). The phone pairs once; the daemon issues a long-lived signed session credential stored on the device. This explicitly resolves the "zero-config vs. secure" tension: launch is one command, but the *first* network access always requires a local pairing step. Treat this as a feature, not overhead.
* **Secrets never live in app state.** SSH keys, PATs, and tokens are stored in the OS keychain (macOS Keychain / Windows Credential Manager / libsecret), referenced by handle from SQLite. A tunnel compromise must not yield raw credentials.
* **Optional second factor (TOTP)** gating sensitive operations (push, identity assignment, repo creation).

**Your task (OPEN):** Design the pairing handshake and session model (token format, rotation, revocation, "sign out all devices"). Specify exactly what an attacker who has the live tunnel URL but no paired session can and cannot do.

---

## 3. Layer A — Discovery, Manual Targeting, Initialization

* **Crawler:** recursively locate hidden `.git` directories across configured roots.
* **"Point to Folder":** register an existing directory by absolute path.
* **"Create New":** create a directory and `git init` it programmatically from the mobile UI.

**Already decided:**
* **SQLite, not JSON state.** There are concurrent writers (file watcher + API + git operations); JSON files corrupt under that load. One `repos` table with a `source` enum (`auto` | `pinned` | `created`) so the engine tracks all three uniformly.
* **Event-driven freshness, not polling.** Do **not** run `git status` on a timer across every repo — it thrashes disk and battery. Use native filesystem watchers (FSEvents / inotify / ReadDirectoryChangesW). Watch repo roots plus `.git/HEAD` and `.git/index` rather than entire working trees, and respect Linux inotify per-user watch limits (don't naively watch large trees).

**Your task:** Produce the full schema (repos, workspaces, identities, sessions, watch-state) and the watcher-to-state reconciliation logic.

---

## 4. Layer B — Multi-Account Identity & Scoped Swapping

* **Global identity storage:** usernames, emails, SSH key handles, and credential handles for multiple distinct profiles (Personal GitHub, Work GitLab, Client Bitbucket).
* **Workspaces:** group repos into logical sets ("Side Hustles", "Company Corp"), each with a default identity auto-applied to member repos.
* **Real-time switching:** from the phone, override a repo's profile; the daemon uses the correct identity for fetch/pull/push.

**Already decided (this prevents desktop-shell corruption and race conditions):**
* **Per-operation `GIT_SSH_COMMAND`** for auth, never global SSH config mutation. Keep this instinct from v1.
* **Per-operation identity injection via `git -c user.name=… -c user.email=…`** for commits the daemon itself makes. Do **not** mutate the repo's persisted `git config` on every switch — the user may be working in that same repo at their desk. Only persist to repo config when the user *explicitly* assigns an identity to that repo.
* **Secrets resolved from the keychain at call time**, never read into long-lived process memory or written to SQLite.

**Your task (OPEN):** Design the isolated-SSH strategy (per-identity key handling, host aliasing, agent vs. no-agent) so swapping on the phone never disrupts the desktop shell config.

---

## 5. Layer C — Secure Tunnel / NAT Traversal

Outbound, zero-config tunnel bundled in the app. **Reminder: this provides HTTPS transport only; access control is Section 2's job.**

**Your task (OPEN) — evaluate three options, not two:**
1. **Quick Cloudflare Tunnel (`trycloudflare`):** instant, no infra, but URLs rotate, it's rate-limited, and Cloudflare's ToS marks it not-for-production. Fine for demos, weak as a shipped default.
2. **Named Cloudflare Tunnel (recommended middle path to evaluate):** requires a CF account + my own domain, but gives stable hostnames, free, still no VPS, still no router config.
3. **Self-hosted `frp`/`bore`/`chisel` + VPS + wildcard domain:** stable URLs and full control, but now I operate multi-tenant infrastructure — which directly contradicts "self-contained and lightweight." Name that tension explicitly in your recommendation.

Give pros/cons, security implications, and implementation complexity for each, then recommend a default with a fallback.

---

## 6. Layer D — Packaging & Cross-Platform Distribution

100% shared core between CLI and native installers.

**Already decided:**
* **Tauri over headless Electron.** Headless Electron still ships the full Chromium runtime (~100MB+ and its memory overhead) even with zero windows. Tauri's Rust tray + JS daemon as a sidecar is the right footprint.
* **Bun `--compile`** to produce the daemon as a single self-contained binary (cleaner than `pkg`; nothing in `node_modules` to ship).

**Your task (OPEN):** Decide whether the tray app *embeds* the daemon or whether **the daemon is the primary artifact and the tray is a thin spawn/monitor controller.** Argue for one. (The decoupled version is what makes the "shared core across CLI + tray" goal fall out naturally — show how.)

---

## 7. Layer E — High-Density Mobile Web UI

* Mobile-first dashboard; **PWA manifest** for standalone "Add to Home Screen" execution (no browser chrome).
* **Design language:** high-density layout, explicit spatial grouping, clean typography, hyper-clean dark terminal theme (refined "Notion Dark" / material palette).

**Already decided (sync protocol):**
* **SSE + REST hybrid, not polling and not WebSockets.** Git state changes are server→phone and event-driven — SSE's exact sweet spot (simpler than WS, auto-reconnect, works over plain HTTP through the tunnel). Drive the SSE stream off the Layer A file watcher so you push only on real change. Use REST for the phone→daemon command direction (switch identity, pull, push, init). Justify the split and define the event payload shapes.

**Your task:** Specify the event schema, reconnection/resume behavior, and how the UI avoids layout shift on incremental updates.

---

## 8. NON-NEGOTIABLE: Failure & Conflict Handling

Remote git operations fail in ways a phone user can't easily recover from. Design for this explicitly:
* **The daemon refuses any operation that would create a conflicted/half-merged state.** A rejected push, auth failure, or potential merge conflict is surfaced as a clear status ("resolve at your desk") — the daemon never leaves a repo mid-merge from a remote tap.
* Define the UI states for: push rejected (non-fast-forward), auth/credential failure, detached HEAD, dirty working tree blocking a pull, and network/tunnel drop.

---

## 9. Deliverables

Provide final architectural decisions per layer with justifications, then output:

1. **A threat model** (≥1 tight section): what happens if the tunnel URL leaks; trust boundaries; what a paired vs. unpaired actor can do; where secrets live and how they're reached.
2. **Production-ready monorepo structure.**
3. **Backend entry-point boilerplate** (Bun/Node): file crawling, watcher-driven change tracking, repo init — **with the pairing/session auth middleware in place from the start.**
4. **Identity-router boilerplate:** maps distinct git configs to repos via per-operation `git -c` + `GIT_SSH_COMMAND` injection, resolving secrets from the keychain.
5. **The packaging manifest JSON** (Tauri sidecar + Bun-compiled daemon).
6. **The core reactive dashboard view:** high-density responsive utility-class layout showing workspace groups and identity selectors, consuming the SSE stream.

For each code artifact, include inline comments at the security-sensitive seams (auth checks, secret resolution, config injection) so the boundaries are obvious.
