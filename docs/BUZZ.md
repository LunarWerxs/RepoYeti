# Buzz support

**Status:** implemented as an **Advanced, experimental** integration.

Buzz support belongs beside Lore in **Settings → Advanced → Experimental servers**. It is opt-in
and off by default, so owners who only use ordinary Git remotes never see additional setup or
behavior.

## Product decision

Buzz is not a third RepoYeti VCS backend. Buzz repositories use standard Git Smart HTTP, so they
must continue through RepoYeti's existing `git` backend and its existing safety rules. Do **not**
add `"buzz"` to `VcsKind` or duplicate status, diff, commit, pull, or push logic.

The integration has two distinct layers:

1. **Buzz Git compatibility (first):** recognize, clone, fetch, pull, and push Buzz-hosted Git
   repositories through the system Git client.
2. **Buzz collaboration (later):** optionally publish RepoYeti commit/diff/status events to a
   selected Buzz channel.

## Phase 1 — Advanced Buzz Git support

The Advanced settings section groups Lore and Buzz in one Experimental servers card:

- Clean **Enable Lore support** and **Enable Buzz support** rows, each with an independent switch.
- A small diagnostic/preflight card showing:
  - system Git is version 2.46 or newer;
  - `git-credential-nostr` is installed and available to Git;
  - `credential.useHttpPath=true` is configured;
  - the configured Buzz community/relay is reachable;
  - authentication succeeds without an interactive prompt.
- Optional saved Buzz communities for clone UX. Store only a display name and public URL(s).
- An Advanced-only **From Buzz** path in Add Repository, or accept a pasted Buzz clone URL and
  identify it automatically.

All repository operations continue through `gitBackend`. RepoYeti's existing prohibitions on
force-push, hard reset, rebase, unsafe merge behavior, and interactive credential prompts remain
unchanged.

### Setup in RepoYeti

1. Configure system Git as described by Buzz: Git 2.46+, `credential.helper=nostr`, and
   `credential.useHttpPath=true`.
2. Open **Settings → Advanced → Experimental servers** and enable Buzz support.
3. Save the community/relay URL. Optionally save a real repository clone URL so the authentication
   check can complete Buzz's NIP-98 challenge; without one, that check reports **Skipped** rather
   than guessing from local key-file state.
4. Run the preflight, then use **Add Repository → From Buzz**. The owner/repository input becomes
   the standard `https://relay.example.com/git/owner/repository.git` URL and is passed to the
   ordinary Git clone path.

The owner API is `GET/PUT /api/buzz`, `POST/DELETE /api/buzz/communities`, and
`POST /api/buzz/preflight`. These routes are owner-only. They return public URLs and diagnostic
states only; command output that could resemble an authorization value or private key is redacted.

### Authentication boundary

Authentication is delegated to the system Git credential-helper chain, just as Lore delegates
authentication to the Lore CLI. RepoYeti must not:

- ask for or store a Nostr `nsec` in `config.json`;
- inject a private key into Git command arguments;
- replace the user's Buzz credential helper with a RepoYeti-owned helper;
- log signed auth events, authorization headers, or private-key material.

If authentication is missing, fail closed with an actionable preflight message. Never fall back
to an interactive prompt in the daemon.

## Phase 2 — Optional one-way collaboration

After Git compatibility is proven, the Advanced section may allow a repository to be linked to a
Buzz channel. The first collaboration feature should be outbound only:

- post a completed Smart Commit summary;
- post an annotated diff and commit hash;
- post fetch/pull/push success or failure when explicitly enabled for that repository.

Prefer Buzz's supported JSON CLI/API surface behind a small `src/buzz.ts` adapter. Keep the
integration feature-gated, bounded by timeouts, and non-blocking: a Buzz notification failure must
not turn a successful local commit into a failed commit.

Inbound Buzz messages, agent mentions, workflow triggers, and chat-driven Git mutations are
deliberately out of scope for the first implementation. Those require a separate authorization,
replay/idempotency, approval, and prompt-injection threat model.

## Implemented seams

- `src/config.ts` — non-secret `BuzzConfig` and saved-community metadata.
- `src/buzz.ts` — discovery, preflight, and eventual outbound collaboration adapter.
- `src/http/routes/buzz.ts` and `src/http/openapi.ts` — owner-only diagnostics/configuration API.
- `web/src/components/settings/ExperimentalServersSection.vue` — shared Lore/Buzz Advanced card.
- `web/src/components/settings/BuzzIntegrationSection.vue` — expandable Buzz controls.
- `web/src/components/Settings.vue` — lazy-load the experimental-server card.
- `web/src/api.ts`, store/types, and `web/src/locales/en.json` — UI contract and copy.
- `web/src/components/AddRepo.vue` — optional Buzz clone entry point.
- Focused daemon and component tests; live relay coverage remains opt-in behind an environment
  flag so normal CI never needs Buzz infrastructure or a Nostr key.

## Acceptance criteria

- With Buzz disabled, RepoYeti behavior and startup cost are unchanged.
- A Buzz repository works through the normal Git backend; ordinary Git remotes are unaffected.
- Preflight clearly distinguishes missing Git version, missing helper, unreachable relay, and
  rejected authentication.
- No Nostr private key or signed credential is persisted or exposed through logs/API responses.
- Authentication probes cannot target a different origin from the saved Buzz community, and relay
  health checks do not follow redirects.
- All current RepoYeti Git safety invariants still apply.
- Windows, macOS, and Linux resolve the system Git credential helper without shell-specific
  command construction.
- Outbound collaboration, when added, is explicit per repository and cannot block Git operations.

## Upstream references

- Buzz: <https://github.com/block/buzz>
- Git credential helper:
  <https://github.com/block/buzz/blob/main/crates/git-credential-nostr/README.md>
- Agent-oriented Buzz CLI:
  <https://github.com/block/buzz/blob/main/crates/buzz-cli/README.md>
- ACP harness and inbound authorization model:
  <https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md>
