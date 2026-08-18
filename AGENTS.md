# AGENTS.md

Orientation for an AI agent (or a new human) about to change this repository. It is a map and a
list of traps, not a tutorial. The deep documents are [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
(what this is and why it is shaped this way) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)
(setup, i18n, test conventions, the git-safety rules). Read this first, then the one you need.

RepoYeti is openly AI-built, and issues are the working surface. If you are an agent reading this
because someone pointed you at a bug report, the report is usually the best spec in the room.

## The one thesis

A background daemon on the machine that owns the repositories, and a dashboard you reach from a
phone. Nothing is uploaded, nothing is mirrored, no server holds the code. Every design decision
follows from that; if a change would require code to leave the machine, it is the wrong change.

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | The daemon: git orchestration, HTTP API, auth, discovery, auto-update, CLI. Bun + TypeScript. |
| `web/` | The dashboard. **Its own package** with its own `package.json`, deps, and test runner. Vue 3 + reka-ui + Tailwind. |
| `tests/` | Daemon tests (`bun test`). |
| `web/test/` | Dashboard tests (Vitest + jsdom). |
| `scripts/` | Build, release, and the guardrail checks. `scripts/checks/` holds the standalone ones. |
| `relay/` | The Cloudflare Worker behind the permanent `app.repoyeti.com/r/<id>` address. Deployed separately. |
| `site/` | The static marketing site. Not part of the app. |
| `misc/` | Windows tray launch chain. **Partly kit-managed, see below.** |
| `docs/` | Architecture, contributing, the stable-address guide, the Buzz protocol. |

## Before you push

There are **two** package roots and **two** test runners. Running only one of them is the single
most common way to push something broken here.

```sh
# daemon
bun test
bun run typecheck
bun run check              # lint + every guardrail below
bun run check:coverage     # coverage floor

# dashboard
bun run --cwd web test     # Vitest
bun run --cwd web build    # runs i18n:check, then vue-tsc, then the bundle
```

`bun test` on its own from the repo root will glob the dashboard's Vitest files and report failures
that are not real. The `test` script is scoped to `tests/` for exactly that reason. Leave its
`--timeout 20000` alone; `docs/CONTRIBUTING.md` explains what happens if you don't.

Enable the pre-commit hook once per clone: `git config core.hooksPath .githooks`.

## Things that are enforced, so you cannot drift past them

`bun run check` runs each of these. Every one exists because the thing it prevents actually
happened, and each script's header says which incident. Read that header before you decide a check
is being pedantic.

- **Architectural boundaries** (`check:boundaries`). HTTP routes go through `service.ts` and never
  reach into `git-actions`/`status`/`inspect` directly. Read-only layers do not import the
  orchestration layer. VCS backends do not import `service.ts`. The contract type does not import
  the git implementation.
- **Error-code drift** (`check:codes`). Git operations return first-class codes such as
  `DIRTY_WORKING_TREE` and `NON_FAST_FORWARD`. They are API surface.
- **Popper nesting** (`check:popper`). A menu or popover whose trigger resolves to a *tooltip's*
  anchor context opens off-screen with perfect `aria` and no error. Four controls shipped dead for
  four releases this way. See the header of that script; it is the most surprising trap in the
  dashboard.
- **Subprocess tests without an explicit timeout** (`check:spawntimeout`).
- **Test scratch outside the helper** (`check:testscratch`). Never `mkdtemp` under the OS temp dir;
  use `tests/helpers/scratch.ts`. The daemon *refuses to import a repository* from the temp dir, so
  fixtures there are also the exact shape of the junk rows that refusal exists to prevent.
- **Changelog links** (`check:changelog`), **source byte hygiene** (`check:bytes`), **git env**
  (`check:gitenv`), **lib types** (`check:libtypes`).

Adding a guardrail is encouraged and is often the right end to a bug fix. Copy the shape of an
existing one in `scripts/checks/`: a long header explaining the incident, an `audit` export, a
standalone CLI block, and a `DELIBERATELY NOT FLAGGED` section. **Prove it goes red** on the broken
code before you wire it into `check`. A check that has never failed on purpose is a guess.

## Internationalisation is not optional

Every user-facing string goes through `web/src/locales/en.json`. `i18n:check` fails the build on a
hard-coded one, on a missing key, and on locale drift. This runs inside `web`'s build, so you
cannot ship past it.

## Kit-managed files: do not edit them here

Some files under `web/src/components/ui/`, `tests/server-lib/`, and `misc/` are synced byte-for-byte
from `lunarwerx-ui`, a private sibling repository shared by four apps. `bun run check:kit` compares
them, and the pre-commit hook rejects a local edit to one. Fix those upstream instead. A public
repository's CI cannot check out that sibling, which is why this runs as `check:local` on a
developer machine rather than in GitHub Actions.

Note that `misc/lunarwerx-tray.exe` is a compiled Rust artifact whose upstream copy is a local build
output, not a tracked file. If `check:kit` reports it as drifted, that usually means somebody
rebuilt the crate on this machine, not that this repository is stale. Do not sync a locally built
binary into a public release without knowing what changed in it.

## Traps that have actually cost a release

- **The daemon serves `web/dist` live.** Building in place leaves it empty or half-written for the
  whole build, which is a real 404 storm for anyone connected. The build writes `dist-next` and
  renames it over `dist` in one step. Do not "simplify" that away.
- **jsdom has no layout.** A dashboard test can prove an element exists and still tell you nothing
  about whether a user can see it. When something positions itself, assert the mechanism (the
  transform reka writes, the anchor it resolved) rather than a rect, and wait for Floating UI, which
  resolves asynchronously and reads as broken for a tick even when it is healthy.
- **Watch the fix work in a real browser before you claim it.** The popper bug above was "fixed"
  once, with a confident code comment naming the wrong cause, and three more components then copied
  that comment. A fix nobody watched is a hypothesis.
- **A local red may belong to another agent.** Several sessions run against this tree at once. Check
  `git status --short` and file mtimes before you "fix" a failure you did not cause.

## Changelog and releases

`CHANGELOG.md` entries are prose that explain the **cause**, not a list of verbs. Say what the user
saw, what was actually happening, and why it was not caught. Measurements beat adjectives. Put new
entries under `## [Unreleased]`.

Releases are the owner's call and the owner's timeline. **Do not bump a version or push a tag unless
you are asked to.** When asked: bump `package.json`, `web/package.json` and `src/config.ts`, turn
the `Unreleased` heading into the version with a date, add its comparison link at the bottom of the
changelog, commit as `release: x.y.z`, then tag `vx.y.z` and push the tag. The tag is what builds
and publishes the binaries.

## Style

Comments explain **why**, especially why an obvious-looking simplification is wrong. Several files
here carry long headers that read like incident reports, and that is deliberate: they are the only
thing standing between a future reader and repeating the incident. Match the density of the file you
are editing. Do not delete a comment you have not disproven.
