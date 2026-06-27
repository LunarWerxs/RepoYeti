# AI Architecture Opinion Prompt: System-Wide Remote Git Manager

You are an elite principal systems architect and full-stack software engineer.

I am designing a lightweight, system-wide remote Git manager.

The product runs as a background daemon on a local development machine across Mac, Windows, and Linux. It discovers and tracks Git repositories across selected folders, lets users manually register repos or create new ones, manages multiple Git identities, and exposes a secure mobile-first web dashboard through a zero-config remote URL.

Distribution will likely be through:

1. A global CLI tool installed with `npm install -g`
2. A lightweight native desktop tray/menu-bar app for Windows and Mac

I want your **opinionated architectural judgment**.

Do **not** give me boilerplate code.
Do **not** give me a folder structure.
Do **not** ask me a bunch of questions.
Do **not** turn this into a generic checklist.

Make decisions. Tell me what you would actually build, what you would avoid, and why.

## Product concept

The app should act like a local-first Git command center:

- Automatically discover local Git repositories
- Allow manual repo registration by absolute path
- Allow creating a new folder and running `git init`
- Show all repos in a dense mobile dashboard
- Show branch, dirty status, ahead/behind, remotes, and errors
- Allow safe Git actions from a phone
- Manage multiple Git identities across workspaces and repos
- Expose the dashboard through a secure remote URL without port forwarding

The goal is not to replace a full desktop Git client. The goal is to provide system-wide repo visibility, lightweight remote control, and safer identity management.

## Areas to evaluate

### 1. Local repo discovery and storage

Give me your final recommendation for:

- SQLite vs JSON vs another local store
- How repo discovery should work
- Whether scanning should be automatic, manual, scheduled, watcher-based, or hybrid
- How manual registration and repo creation should be handled
- What repo metadata should be stored locally

Be decisive.

### 2. Git identity management

The app needs to support multiple identities such as personal GitHub, work GitLab, and client Bitbucket.

Each identity may include:

- Git username
- Git email
- SSH key path
- Optional PAT/token
- Optional signing config

Repos can belong to Workspaces. A Workspace can have a default identity. A specific repo can override that identity.

Give me your final recommendation for:

- How identities should be stored
- Where secrets should be stored
- Whether repo-local Git config should be modified
- Whether global Git config should ever be modified
- How SSH keys should be selected per Git command
- How to avoid breaking the user’s normal terminal Git setup
- What edge cases are most dangerous

Be blunt.

### 3. Remote access and tunneling

The app needs to expose the local dashboard to a phone without port forwarding.

Compare these options and pick what you would actually use:

- Bundled Cloudflare Tunnel / `trycloudflare.com`
- Self-hosted relay using `frp`, `chisel`, or `bore`
- Something else

Give me your final recommendation for:

- MVP tunnel approach
- Production tunnel approach
- Authentication model
- Security risks
- Whether a tunnel is the right product decision at all

Do not hedge. Pick a path.

### 4. Packaging and distribution

The core logic should be shared between CLI and desktop versions.

Compare:

- CLI-first Node/TypeScript daemon
- Tauri tray app wrapping the daemon
- Headless Electron tray app
- Bun, Go, or Rust alternatives

Give me your final recommendation for:

- Core runtime
- CLI strategy
- Desktop packaging strategy
- Whether Tauri or Electron is better here
- What should be deferred

Be practical, not theoretical.

### 5. Mobile web dashboard

The dashboard should be mobile-first, high-density, dark-mode, and installable as a PWA.

It should show:

- Workspaces
- Repositories
- Current branch
- Dirty file count
- Ahead/behind
- Remote status
- Current identity
- Identity selector
- Fetch / pull / push actions
- Repo creation
- Manual repo registration

Give me your final recommendation for:

- REST polling vs WebSockets vs SSE vs hybrid
- UI layout
- Which Git actions should be allowed from mobile
- Which Git actions should be blocked or heavily gated
- How to make this feel useful instead of gimmicky

## Required response format

Respond in this exact structure:

1. **Blunt product opinion**
   - Is this worth building?
   - What is the real value?
   - What is the trap?
2. **My recommended architecture**
   - Give the stack you would choose.
   - Make concrete decisions.
   - Do not give code.
3. **Layer-by-layer decisions**
   - Discovery/storage
   - Identity management
   - Remote access
   - Packaging
   - Mobile UI/state sync
4. **MVP scope**
   - What should be in v1
   - What should not be in v1
5. **Security model**
   - Authentication
   - Secret storage
   - Git command safety
   - Remote tunnel safety
6. **Things I would avoid**
   - List the bad ideas and why they are bad.
7. **Phased build plan**
   - Phase 1: local daemon/dashboard
   - Phase 2: identity management
   - Phase 3: remote access
   - Phase 4: desktop wrapper
   - Phase 5: production hardening
8. **Final recommendation**
   - Summarize the architecture in one clear paragraph.

Important constraints:

- Do not provide boilerplate code.
- Do not provide a monorepo folder structure.
- Do not ask clarifying questions.
- Do not answer with more questions.
- Do not be neutral.
- Make the decisions yourself.
- Keep the answer practical, direct, and product-minded.