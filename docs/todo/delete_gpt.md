# GitMob deletion and consolidation audit

## P1 - Delete the source-resident built-in AI key path

- Evidence: `src/config.ts:103-116` defines `BUILTIN_AI` and embeds a Groq-looking `gsk_...` key; `src/config.ts:118-130` makes `resolveApiKey`, `resolveModel`, and `isBuiltinProvider` fall back to it; `src/config.ts:143-157` exposes the built-in provider as configured; `web/src/components/Settings.vue:252-257` renders "Free built-in key"; `tests/ai.test.ts:42-69` and `tests/ai-routes.test.ts:14-21` assert this behavior.
- Risk/impact: Shipping a third-party API key in source/binaries invites abuse, rate-limit burn, accidental credential rotation work, and a hidden network-capable feature before the owner explicitly configures AI. It also keeps tests coupled to a credential-like constant.
- Suggested deletion path: Remove `BUILTIN_AI` and `isBuiltinProvider`; make AI unavailable until the owner supplies a key (or use an optional local env var such as `GITMOB_DEMO_GROQ_KEY` that is never committed). Update the redacted settings shape/UI to drop the `builtin` branch, and replace the built-in-key tests with "starts unconfigured" and BYOK override tests. Verify with `rg -n "BUILTIN_AI|gsk_|built-in free key|builtin" src tests web`.

## P2 - Remove the tray's dev-only rebuild branch before any shipped launcher

- Evidence: `misc/GitMob-Tray.ps1:107-114` explicitly says the "Rebuild & Restart" menu is dev-only and should be removed before public distribution; the rebuild handler lives at `misc/GitMob-Tray.ps1:118-124`, the menu entry is added at `misc/GitMob-Tray.ps1:128`, and `misc/Rebuild.bat:2-4` already documents the standalone replacement.
- Risk/impact: A shipped tray that rebuilds from source assumes Bun, source files, and writable project directories on an end-user machine. It is an unnecessary runtime branch and can leave the served `web/dist` out of sync with the binary.
- Suggested deletion path: Delete `Rebuild-Ui`, `$rebuildItem`, its click handler, and the menu insertion from `misc/GitMob-Tray.ps1`; keep only Open, Restart, and Quit. Keep `misc/Rebuild.bat` as a developer-only helper, or move all tray dev helpers under a clearly non-shipped path if the tray remains deferred.

## P3 - Finalize removal of legacy web files already deleted in the worktree

- Evidence: `web/src/theme.ts` is deleted in the current worktree, but the tracked HEAD copy imports `naive-ui` at line 1 and defines `themeOverrides` for the old Naive UI stack. Current `web/package.json:13-23` has no `naive-ui`; current `web/src/App.vue:3-5` uses VueUse, `vue-sonner`, and the new tooltip provider. `web/src/util.ts` is also deleted in the worktree; its old `fromNow` helper is superseded by `web/src/lib/util.ts:55-63`, and active code imports from `@/lib/util` at `web/src/components/RepoCard.vue:26`.
- Risk/impact: Reintroducing these tracked legacy files would pull the repo back toward a removed UI stack or create two utility locations for the same helper.
- Suggested deletion path: Keep both deletions in the final cleanup commit. Remove stale Naive/lucide-vue-next references from active docs at `README.md:17` and `MARCHING_ORDERS.md:78`, or archive those docs if they are no longer meant to drive implementation.

## P3 - Prune the copied UI component kit to components GitMob actually uses

- Evidence: Active imports only use `button`, `tooltip`, `input`, `dropdown-menu`, `sheet`, `collapsible`, `dialog`, and `select` (`web/src/App.vue:5`, `web/src/AppShell.vue:5`, `web/src/components/AppHeader.vue:3-4`, `web/src/components/AddRepo.vue:8-16`, `web/src/components/IdentityManager.vue:8-10`, `web/src/components/RepoCard.vue:29-40`, `web/src/components/RepoFilters.vue:6-16`, `web/src/components/Settings.vue:9-18`). Entire unused component families are exported from `web/src/components/ui/alert/index.ts:4-8`, `web/src/components/ui/badge/index.ts:4-9`, `web/src/components/ui/card/index.ts:1-7`, `web/src/components/ui/label/index.ts:1`, `web/src/components/ui/separator/index.ts:1`, `web/src/components/ui/switch/index.ts:1`, and `web/src/components/ui/textarea/index.ts:1`.
- Risk/impact: The repo is carrying a generated/golden component tree rather than just the app surface. Even if Vite tree-shakes runtime code, every extra component is maintenance, typecheck, and future-drift surface.
- Suggested deletion path: Delete unused families if GitMob is not intended to host a shared design-system catalogue. Also prune unused subcomponent exports/files such as dropdown radio/sub/shortcut/group entries at `web/src/components/ui/dropdown-menu/index.ts:5,8-14`, `DialogTrigger`/`DialogScrollContent`/local `DialogClose` at `web/src/components/ui/dialog/index.ts:2,8,10`, `SheetClose`/`SheetFooter`/`SheetTrigger` at `web/src/components/ui/sheet/index.ts:4,7,10`, and `SelectGroup`/`SelectLabel`/`SelectSeparator` at `web/src/components/ui/select/index.ts:3,6,9`. Keep internally used pieces like `DialogOverlay`, `SheetOverlay`, `SelectItemText`, and select scroll buttons.

## P3 - Collapse duplicated AI provider metadata into one non-secret source

- Evidence: Provider IDs are declared in the backend at `src/config.ts:46-64`, duplicated in web types at `web/src/types.ts:62-69`, and duplicated again as UI metadata in `web/src/components/Settings.vue:37-45`. The backend route validation uses `AI_PROVIDERS` at `src/daemon.ts:226-229`.
- Risk/impact: Adding, removing, or renaming a provider requires coordinated edits in three places. A mismatch can make the UI render a provider the daemon rejects, or hide one the daemon supports.
- Suggested deletion path: After deleting the built-in key, introduce one sanitized provider catalogue (for example a shared JSON file or `GET /api/ai/providers` response with id/name/url/placeholder/free metadata). Delete the frontend-only union/list duplication and generate/import types from that source. Do not import `src/config.ts` into the browser while it contains server-only config.

## P3 - Remove schema-only database surface for deferred features from fresh installs

- Evidence: `src/db.ts:91` creates `workspace_id`; `src/db.ts:98-102` creates `workspaces`; `src/db.ts:109-110` creates unused `pat_handle` and `signing_handle`; `src/db.ts:112-118` creates `sessions`. Runtime references are absent outside schema/comments: auth currently uses a signed cookie plus `session.key` in `src/auth.ts:43-56` and reads sessions from cookies at `src/auth.ts:137-147`.
- Risk/impact: Fresh databases advertise tables/columns for workspaces, PAT storage, signing, and DB-backed session revocation that the app does not implement. That increases migration debt and makes the stored model look more capable than the product.
- Suggested deletion path: For new DBs, create only the columns used by current code. Add explicit migrations when workspaces, PAT/keychain handles, signing, or DB-backed session revocation actually ship. For existing user DBs, leave old columns until a deliberate migration can safely drop or ignore them.

## P4 - Archive or delete superseded root planning/handoff documents

- Evidence: `README.md:8` says `MARCHING_ORDERS.md` is the single source of truth. `MARCHING_ORDERS.md:3-8` says `git-orchestrator-brief-v2.md`, `gpt.md`, and `gem.md` were distilled into one decisive spec and over-scoped parts were cut. `AEGIS_OAUTH_REPAIR.md:3-9` says it is a convenience copy for the Connections repo, and `AEGIS_OAUTH_REPAIR.md:149-152` explicitly marks the GitMob daemon out of scope.
- Risk/impact: Keeping old prompts/briefs and an off-repo AEGIS handoff at repo root makes search results noisy and can send future agents toward stale stack/scope decisions.
- Suggested deletion path: Delete the superseded root briefs if `MARCHING_ORDERS.md` has fully absorbed them, or move them under an archive path with a clear "historical only" label. Move/delete the AEGIS repair note after confirming the canonical Connections-repo copy exists.

## P5 - Keep ignored generated artifacts out of handoffs and release inputs

- Evidence: `.gitignore:2-4` ignores `node_modules/`, `dist/`, and `*.tsbuildinfo`; `.gitignore:22` ignores `GitMob.lnk`. `scripts/build.ts:19-31` recreates `dist/` and `dist/web/dist` from source. Current ignored local outputs include `dist/`, `web/dist/`, `node_modules/`, `web/node_modules/`, `web/tsconfig.tsbuildinfo`, and a local `GitMob.lnk`; `dist/gitmob.exe` is about 98 MB.
- Risk/impact: These are not tracked today, but they can pollute zip handoffs, local audits, and manual release packaging. Stale binaries/assets are especially easy to run by accident.
- Suggested deletion path: Keep the ignore rules, add an explicit `clean` script for generated outputs, and make release scripts build from a clean tree. Before handoffs, remove local `dist/`, `web/dist/`, tsbuildinfo, and machine-local shortcuts rather than copying them with the source tree.

## Verification notes

- `bun run typecheck` passed.
- `bun run --cwd web build:fast --emptyOutDir=false` passed, with only Rollup pure-annotation warnings from dependencies.
- `bun test` currently fails 5 git/diff tests in `tests/ai.test.ts` and `tests/git-actions.test.ts`; those failures look unrelated to the deletion candidates above, but they should be fixed before using the suite as a cleanup safety net.
