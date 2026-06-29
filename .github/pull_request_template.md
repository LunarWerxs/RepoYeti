<!-- Thanks for contributing to RepoYeti! Keep this short and honest. -->

## What & why

<!-- What does this change do, and why? Link any related issue (e.g. Closes #123). -->

## How I verified it

<!-- Runtime evidence, not just "it compiles". Which of these did you run? -->

- [ ] `bun run typecheck`
- [ ] `bun test` (and added/updated tests for the change)
- [ ] `cd web && bun run build` (if the web UI changed)
- [ ] Exercised it against a real repo / in the running daemon (describe below)

## Notes for reviewers

<!-- Anything non-obvious: trade-offs, follow-ups, areas you're unsure about. -->

## Checklist

- [ ] Respects the safety invariant — never leaves a repo in an unsafe / half-merged state.
- [ ] New error paths use a first-class code (`src/contract.ts`) mirrored in `web/src/types.ts`.
- [ ] User-facing strings go through i18n (`bun run i18n:check` passes).
- [ ] No secrets, keys, or personal infrastructure URLs added.
