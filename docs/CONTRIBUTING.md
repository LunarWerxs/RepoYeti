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

## License

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
