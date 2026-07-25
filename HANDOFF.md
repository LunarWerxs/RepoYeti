# RepoYeti History and Pull-Safety Handoff

Date: July 25, 2026

## Current state

The requested product work is implemented, built, and running locally:

- Repo-specific History activity cards and chart.
- Hourly, Daily, and Monthly ranges.
- Added/removed bars, commit line, and color-coded tooltips.
- Persistent per-repository/per-commit statistics cache.
- Smooth stale-while-refresh transitions for cards, contributors, charts, and History rows.
- Optional branch graph and visual change bars.
- History-row context menu and centered column headings.
- Clickable “Commits by person” chips that apply an exact, pagination-safe author filter to
  History, with a pressed state, clear banner, author-specific empty state, and keyboard labels.
- Atomic retained-History refreshes of up to 500 commits.
- Pull preview aligned with the actual `git pull --ff-only` behavior.
- Destructive red/disabled Pull state for divergence, conflicts, unsafe working trees, and unknown results.
- Exact preview freshness using HEAD, upstream, worktree, and staged-blob identities.
- A vendor-neutral OpenAI-compatible AI provider with owner-supplied base URL, manual-model
  fallback, Hugging Face/DashScope URL presets, and keyless loopback support.

The daemon was restarted with the latest build. Final browser verification showed 49 repositories,
live updates connected, and no console errors. The temporary conflict-test repository was removed,
and the History change-display preference was restored to **Numbers**.

## Validation already completed

Before the final external-ref watcher change:

- Backend: 878 passed, 1 intentional skip, 0 failed.
- Frontend: 196 passed, 0 failed.
- Root checks, lint, boundaries, error-code checks, typechecks, i18n, production/PWA build, and
  `git diff --check` passed.

After the final watcher/ref changes:

- Root and web typechecks passed.
- Focused backend tests: 21 passed.
- Focused frontend tests: 38 passed.
- Fast production build passed.
- `git diff --check` passed.
- Live browser reload passed with no console output.

## External Git-ref watcher hardening — resolved

The final watcher pass is complete:

- One recursive descriptor covers the entire common Git directory's `refs` tree; nested
  branch/tag namespaces do not add descriptors or trigger directory rescans.
- The common-directory descriptor covers root-level ref-store changes such as `packed-refs` and
  reftable files, including linked worktrees resolved through `commondir`.
- Any required watcher installation failure falls back to the existing jittered 30–40 second
  poll. A required watcher that fails later marks the handle unhealthy, tears down the remaining
  native descriptors, and activates that same fallback exactly once.
- `historyRefsHash` covers ref name, object ID, and symbolic target across local branches, remote
  refs, and tags, whether refs are loose or packed.
- A watcher-driven ref-only refresh emits `repo_state_changed`; the client treats a changed
  `historyRefsHash` as a History revision and refreshes an open History view.

Focused validation after the hardening:

- Watcher/status/service backend tests: 29 passed.
- Client History-revision tests: 7 passed.
- Root and web typechecks passed.
- Root checks and `git diff --check` passed.

At the point this watcher pass landed, the earlier full backend/frontend suites remained its
regression baseline; no product code outside this focused watcher path was changed by the
hardening pass. The provider follow-up below records the newer full-suite run.

## OpenAI-compatible provider follow-up — resolved

The AI Pass fork/PR was not merged or cherry-picked. It is a broad proprietary OAuth, wallet, and
billing integration in the contributor's own fork rather than a focused upstream contribution.
RepoYeti instead gained one provider-neutral seam:

- The owner can supply any OpenAI-compatible API root plus an exact model ID.
- Hugging Face Router and DashScope presets only fill the URL; they are not special integrations
  or partnerships.
- Off-device endpoints require HTTPS and an API key. HTTP(S) loopback endpoints may omit the key,
  and keyless requests omit the Authorization header entirely.
- Redirects are blocked so keys and diffs cannot be forwarded to another origin.
- Model discovery is best-effort; the manually entered model remains usable when `/models` is
  absent.
- API keys stay in the existing OS-secret path. Switching to a keyless local endpoint purges any
  stale compatible-provider key, including across restart.
- Provider configuration remains owner-only. Share guests receive only a usable/not-usable
  capability projection, and provider failures are stripped of provider, URL, model, key, and raw
  upstream text.

Provider-specific validation:

- Security review found and resolved stale-key rehydration, guest-error redaction, and unbounded
  model-update input.
- Full backend regression suite: 897 passed, 1 intentional Lore-parity skip, 0 failed.
- AI, secret-storage, and share-gate focused tests: 85 passed.
- Frontend compatible-provider tests: 9 passed.
- Full frontend regression suite: 207 passed.
- Root and web typechecks, root checks/lint, i18n, production build, and `git diff --check` passed.
- Live browser QA covered presets, destination disclosure, keyless-loopback enablement,
  remote-without-key blocking, cancellation, and layout. No provider was saved during QA.

## History author filtering — resolved

- Contributor chips now filter the actual server-side History query rather than hiding whichever
  rows the browser already happened to load.
- Email is the exact, case-insensitive identity when available; name is used only when email is
  absent. Canonical `%aN`/`%aE` values keep `.mailmap` aliases aligned with the activity cards.
- Matching happens before `skip` and `limit`, so infinite pagination remains correct even when
  other authors' commits sit between matching commits.
- The activity cards and chart stay repository-wide, so another contributor remains selectable.
- The active chip is visibly pressed and can toggle itself off. A persistent “Showing commits by”
  banner provides a second clear path.
- Filtered History hides the synthetic uncommitted row and branch lanes because neither has an
  honest representation in a sparse author-only commit list.
- The filter survives Hourly/Daily/Monthly and branch-scope changes, but resets if the card is
  rebound to another repository.

Validation after this follow-up:

- Full backend regression suite: 902 passed, 1 intentional Lore-parity skip, 0 failed.
- Full frontend regression suite: 212 passed, 0 failed.
- Author-filter focused suites: 17 backend and 48 frontend tests passed.
- Root/web typechecks, architecture/error-code/lib checks, lint, i18n, production/PWA build, and
  `git diff --check` passed.
- The tray-supervised daemon restarted successfully on port 7171.
- Live browser QA covered selection, exact visible authors, pressed/clear states, range retention,
  graph/worktree suppression and restoration, and the Daily preference restore. No console errors.

## Closure

- This handoff is closed by the RepoYeti 0.14.0 release work.
- The AI Pass-specific pull request was declined in favor of the provider-neutral implementation.
- Expected Git warnings concern CRLF-to-LF normalization in a handful of tracked files.
- Expected backend-test console fixtures include `a warning`, `boom`, and `Error: kaboom`.
