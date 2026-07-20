# Contributing to RepoYeti

Thanks for hacking on RepoYeti. This is a Bun daemon + a Vue 3 PWA; the daemon is the primary
artifact and the web app is served from `web/dist`.

## Local setup

```sh
bun install                          # daemon deps
bun run src/index.ts add-root <dir>  # register a folder to scan
bun run src/index.ts start           # boot the daemon on :7171

cd web && bun install && bun run dev # web dev server on :4319 (proxies /api → :7171)
```

## Before you push

```sh
# daemon
bun test
bun run typecheck
bun run check            # lint + code/boundary checks
bun run check:coverage   # coverage gate

# web
cd web
bun run i18n:check   # i18n compliance (see below)
bun run build        # runs i18n:check, then vue-tsc type-check + production build
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push / PR. For a fast local
gate, enable the bundled pre-commit hook (runs `i18n:check` before each commit):

```sh
git config core.hooksPath .githooks   # one-time, per clone
```

Bypass a single commit with `git commit --no-verify`; disable with `git config --unset core.hooksPath`.

Please keep the git-action safety guards intact — operations return first-class error codes
(`DIRTY_WORKING_TREE`, `NON_FAST_FORWARD`, `DETACHED_HEAD`, `SSH_AUTH_FAILED`, …) and never
force-push, auto-merge, or mutate global/repo git config. Identity is injected per operation.

## Internationalisation

All user-facing UI text must go through `vue-i18n`, never hardcoded:

- **Templates:** `{{ $t('namespace.key') }}` (or `:aria-label="$t('…')"`). `$t` is globally
  injected — no import needed.
- **Script (`<script setup>`):** `const { t } = useI18n();` then `t('namespace.key')`. For plain
  helpers outside a component, import `t` from `@/i18n`.
- **Interpolation:** named params — `t('settings.connected', { name, count })`.
- **Plurals:** `$t('header.repoCount', { count: n }, n)` with a `"… | …"` message.

`bun run i18n:check` enforces this: it fails on hardcoded strings, references to missing keys,
and any locale that has drifted out of key-parity with `en.json`.

### Adding a language

RepoYeti currently ships **English only**. The `vue-i18n` layer above exists so locales *can*
be added later, but there is no locale switcher yet — adding a language means building that,
not just registering it somewhere. In short:

1. Create `web/src/locales/<code>.json` with full key parity with `en.json` (same keys, the
   same `{tokens}`, and the same `|` plural separators).
2. Build a locale switcher (there isn't one today) and wire the new locale into
   `createI18n({ messages })` in `web/src/i18n.ts`.
3. Run `bun run i18n:check` to confirm the new locale is complete and in parity.

## Writing tests that create repos

`upsertRepo(absPath, ...)` in `src/db.ts` deliberately refuses to import certain paths and
returns `string | null` instead of throwing. `null` means the import was refused, for one of two
reasons:

1. **The path is under the OS temp directory.** `isUnderTempDir()` (`src/paths.ts`) checks
   `os.tmpdir()` plus the `TEMP`/`TMP`/`TMPDIR` env vars, boundary-aware (so `C:\Temperature` is
   not treated as temp). This exists to stop temp-folder scratch repos from ever polluting a
   real database.
2. **The path was previously removed by the user.** `forgetRepo(id, ignore=true)` tombstones a
   path in the `ignored_paths` table, and `upsertRepo` refuses tombstoned paths at the same
   check, so a rescan can't silently resurrect something the user explicitly removed. Undo via
   `unignorePath` / `POST /api/repos/ignored/restore`.

**When writing a test that creates a repo, always use `mkScratchDir` (and `scratchRoot()`) from
`tests/helpers/scratch.ts`.** It creates scratch directories under a repo-local, gitignored
`.testtmp/` root, which is not under the OS temp dir and so is never refused. Never call
`mkdtempSync(tmpdir())` directly in a test, it will make `upsertRepo` return `null` and the test
will fail with a confusing "upsertRepo refused" error rather than a real assertion failure. For
the ~90 call sites across the suite that expect success, use `mustUpsertRepo` from
`tests/helpers/upsert.ts`, which asserts the return value is non-null for you.

This also means **any checkout used to reproduce CI locally must live outside the OS temp dir**,
not just individual scratch dirs. `mkScratchDir` creates `.testtmp/` *inside* the checkout, so if
the checkout itself is under `%TEMP%` (for example a worktree placed under a session scratchpad
directory), every scratch dir under it inherits "under OS temp" and `upsertRepo` refuses all of
them, a mass "upsertRepo refused" failure across the suite. Real CI is unaffected (runners check
out to paths like `D:\a\repoyeti\repoyeti` or `/home/runner/work/...`, outside temp). If you see
a wave of `upsertRepo refused` failures, check whether `isUnderTempDir(process.cwd())` is true
before assuming it's a real regression.

## Live-verifying AI features

RepoYeti's AI commit-message features talk to a real provider (currently Groq). To test against
the real provider without handling the API key directly, drive the app's own code path: call
`loadConfig()` then `await hydrateSecrets(cfg)` (both in `src/config.ts`). `hydrateSecrets` pulls
the key from the OS keychain into `cfg.ai.providers[id].apiKey`; nothing in your script needs to
read or print the key itself. Ad-hoc verification scripts belong in the gitignored `tmp/`
directory so their imports resolve as `../src/...`.

**Groq quota shape.** There are two separate limits, both enforced pre-flight against
`input + max_tokens`:

- **TPM 12,000** (`x-ratelimit-limit-tokens`), per key.
- **TPD 100,000**, enforced **per organization, not per key**. A second API key from the same
  Groq account shares the same exhausted daily budget and reports the same `org_...` id, so
  rotating keys within one org does not extend the daily cap. If you need more daily headroom,
  use a key from a different Groq organization.

Model access is also tier-gated: some accounts get `AI_AUTH_FAILED` for models like
`openai/gpt-oss-120b` and `qwen/qwen3-32b` even though `/models` lists them as available.

## Benchmarking against a worktree

When comparing old-vs-new behavior (for example, benchmarking a code change), use `git worktree`
rather than `git stash`. The main tree is often shared with other concurrent work, so stashing it
can clobber in-flight changes that aren't yours.

Two things to watch for:

- **Place the worktree outside the repo, not under a subdirectory like `tmp/`.** A worktree
  nested inside the repo puts a second copy of `tests/` where the test runner will find it, so a
  run can silently double (files get collected from both copies) and the two copies collide over
  shared state.
- **Never `rm -rf` a directory that contains a Windows junction** (created via `mklink /J`, for
  example to link `node_modules` into a worktree for speed). `rm -rf` recurses *through* a
  junction and deletes the target it points to, not just the link. Removing a worktree that way
  has destroyed the real `node_modules` in the main checkout for every session using it, not just
  the worktree's own copy. Prefer copying instead of junctioning, or remove the junction itself
  first with `cmd /c rmdir` (a plain `rmdir` on the junction path, not `-Recurse`/`-Force`, so it
  removes only the link) before deleting the rest of the directory tree.

## License

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
