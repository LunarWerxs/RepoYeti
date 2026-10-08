# AGENTS.md

Distilled rules. The full text, with the reasons, is [docs/agents/RULES_FULL.md](docs/agents/RULES_FULL.md) and wins on any doubt; each heading links to its section. Deep docs: [ARCHITECTURE](docs/ARCHITECTURE.md), [CONTRIBUTING](docs/CONTRIBUTING.md) (setup, tests, git safety). Issues are the working surface: a bug report is usually the best spec.

## [Thesis](docs/agents/RULES_FULL.md#the-one-thesis)
- A background daemon on the machine that owns the repos, plus a dashboard reached from a phone. Nothing is uploaded or mirrored, no server holds the code. A change that needs code to leave the machine is the wrong change.

## [Layout](docs/agents/RULES_FULL.md#layout)
- `src/` daemon (Bun + TS), tests in `tests/`. `web/` dashboard (Vue 3) is **its own package** with its own deps and runner, tests in `web/test/` (Vitest + jsdom). `scripts/checks/` guardrails. `relay/` Worker, deployed separately. `site/` is not the app. `misc/` tray chain, partly kit-managed.

## [Before you push](docs/agents/RULES_FULL.md#before-you-push)
- Two package roots, two runners; running only one is how broken pushes happen. Run all: `bun test`, `bun run typecheck`, `bun run check` (lint + every guardrail), `bun run check:coverage`; then `bun run --cwd web test`, `bun run --cwd web build` (i18n:check, vue-tsc, bundle); then `bun run --cwd web test:gate` (needs that build, plus `bunx playwright install chromium` once).
- Bare `bun test` at the root would glob web's Vitest files (fake failures), so `bunfig.toml` ignores `web/**` and the `test` script is scoped to `tests/`.
- Every test file that spawns calls `useSuiteTimeout()` (`tests/helpers/timeouts.ts`), enforced by `check:spawntimeout`. Never move that timeout to the command line or `bunfig.toml` (both measured as false greens).
- Enable the pre-commit hook once per clone: `git config core.hooksPath .githooks`.

## [Enforced by `bun run check`](docs/agents/RULES_FULL.md#things-that-are-enforced-so-you-cannot-drift-past-them)
Each one's incident really happened; read the script header before calling a check pedantic.
- `check:boundaries`: HTTP routes go through `service.ts`, never straight to `git-actions`/`status`/`inspect`. Read-only layers never import the orchestration layer. VCS backends never import `service.ts`. The contract type never imports the git implementation.
- `check:codes`: git operations return first-class codes (`DIRTY_WORKING_TREE`, `NON_FAST_FORWARD`); they are API surface.
- `check:popper`: a menu or popover whose trigger resolves to a tooltip's anchor context opens off-screen with perfect `aria` and no error. Read that header.
- `check:testscratch`: never `mkdtemp` under the OS temp dir; use `tests/helpers/scratch.ts` (the daemon refuses to import a repo from there).
- Also `check:spawntimeout`, `check:changelog`, `check:bytes`, `check:gitenv`, `check:libtypes`.
- New guardrails are encouraged, often the right end to a bug fix. Copy a `scripts/checks/` shape (incident header, `audit` export, standalone CLI block, `DELIBERATELY NOT FLAGGED` section) and prove it goes red on the broken code before wiring it into `check`.

## [i18n](docs/agents/RULES_FULL.md#internationalisation-is-not-optional)
- Every user-facing string goes through `web/src/locales/en.json`. `i18n:check` in the web build fails on a hard-coded string, a missing key or locale drift.

## [Kit-managed files](docs/agents/RULES_FULL.md#kit-managed-files-do-not-edit-them-here)
- Some files under `web/src/components/ui/`, `tests/server-lib/` and `misc/` are synced byte-for-byte from the private sibling `lunarwerx-ui`. Never edit them here; fix upstream. `bun run check:kit` compares them (run as `check:local` on a dev machine, not in CI) and the pre-commit hook rejects a local edit.
- `misc/RepoYeti-Tray.exe` drifting in `check:kit` usually means a local rebuild, not a stale repo. Never sync a locally built binary into a public release without knowing what changed in it.

## [Traps that cost a release](docs/agents/RULES_FULL.md#traps-that-have-actually-cost-a-release)
- The daemon serves `web/dist` live, so the build writes `dist-next` and renames it over `dist` in one step. Never "simplify" that away.
- jsdom has no layout: for positioned elements assert the mechanism (reka's transform, the resolved anchor), not a rect, and wait for Floating UI, which resolves async.
- Watch a fix work in a real browser before claiming it. `bun run --cwd web test:gate` does that on an isolated daemon (touches nothing of yours) and gates the release in CI. The older `web/test/e2e` suite needs your live daemon plus `bun run dev`: run `bunx playwright test` from `web/`.
- A local red may belong to another agent editing this tree: check `git status --short` and file mtimes first.

## [Changelog and releases](docs/agents/RULES_FULL.md#changelog-and-releases)
- `CHANGELOG.md` entries are prose giving the cause: what the user saw, what was happening, why it was not caught. Measurements beat adjectives. New entries go under `## [Unreleased]`.
- Releases are the owner's call and timeline. Never bump a version or push a tag unless asked.
- When asked: bump `package.json`, `web/package.json` and `src/config.ts` (`tests/version-consistency.test.ts` fails if they disagree), turn `Unreleased` into the version with a date, add its comparison link at the bottom of the changelog, commit `release: x.y.z`, tag `vx.y.z`, push the tag (it builds and publishes the binaries). Run the gates AFTER the bump.
- The tag is not the last step: CI builds Windows assets UNSIGNED and they are signed afterwards on the workstation. Read [docs/RELEASING.md](docs/RELEASING.md) before tagging (two repack traps there silently break the auto-updater).

## [Style](docs/agents/RULES_FULL.md#style)
- Comments explain why, especially why an obvious-looking simplification is wrong; long incident-report headers are deliberate. Match the comment density of the file you edit. Never delete a comment you have not disproven.
