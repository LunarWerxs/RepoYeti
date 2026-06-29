# Web UI Unification Standard

The shared UI contract for **GitMob** (`D:\PublicProjects\GitMob\web`) and
**DevWebUI** (`D:\PublicProjects\DevWebUI\devwebui\web`).

Both apps are Vue 3 + Vite + Tailwind v4 + reka-ui with a shadcn-vue–style
`src/components/ui/` folder. They share the same **structure, interaction model,
theming mechanism, component set, and "feel"** — but they are **not** literal
clones: each keeps its own domain (GitMob = repos/identities, DevWebUI =
projects/processes) and its own **accent color**.

This file is identical in both repos. Treat it as the source of truth; when the
two drift, this document wins.

---

## 1. Decisions (locked)

| Axis | Decision |
|---|---|
| **Overlays** | One rule, both apps (see §4). Settings + side panels = **Sheet**; forms = **Dialog**; confirms = **inline two-step**. |
| **Theme modes** | **Light + Dark + System** in both apps, via `useColorMode`, with a switcher in Settings. |
| **Accent** | **Per-app**: GitMob green `#3ddc84`, DevWebUI indigo. Everything else (token names, radius, components) shared. |
| **Settings save** | **Explicit Save / Cancel** footer in both. (Network actions like "connect API key" stay immediate — you can't stage a live validation.) |
| **Icons** | **`@lucide/vue`** everywhere. `lucide-vue-next` is retired. |
| **State** | **Pinia** (setup-store style) in both. |
| **API layer** | Pure typed fetch wrapper + `ApiError` class; state lives in the store, not in `api.ts`. |
| **Toasts** | **`vue-sonner`** in both (transient action feedback). |
| **Scope** | Full: feel + components + internals. |

---

## 2. Stack & dependencies (canonical)

Both `web/package.json` files converge on:

- `vue` ^3.5, `reka-ui` ^2.10, `tailwindcss` ^4.3 + `@tailwindcss/vite`, `tw-animate-css`
- `@lucide/vue` (NOT `lucide-vue-next`)
- `@vueuse/core` **^14** (GitMob upgrades from ^12; needed for `useColorMode`)
- `pinia` ^2.3
- `vue-sonner` ^2
- `class-variance-authority`, `clsx`, `tailwind-merge`
- `@formkit/auto-animate` (both). `@formkit/drag-and-drop` GitMob-only (repo reorder).
- `vite-plugin-pwa` GitMob-only.
- `typescript` **^5.7** (pin DevWebUI back from the TS6 pre-release until TS6 GA).
- Build script type-checks: `vue-tsc -b && vite build` (both).

`tsconfig` structure: the **three-file split** (`tsconfig.json` references hub +
`tsconfig.app.json` + `tsconfig.node.json`), `verbatimModuleSyntax: true`.

`components.json` present in both (shadcn-vue, `style: new-york`, `baseColor: zinc`,
`iconLibrary: lucide`).

---

## 3. Theming & tokens

### Mechanism
- `@vueuse/core` `useColorMode()` → toggles `<html class="dark">`, persists to
  `localStorage` key `vueuse-color-scheme`.
- A blocking inline script in `index.html` applies the stored class **before** Vue
  mounts (prevents FOUC). No hard-coded `class="dark"` on `<html>`.
- Surfaced in Settings as a `Select` (Light / Dark / System).

### Token contract (shared names, both `:root` light + `.dark` dark)
Standard shadcn surfaces **plus** the extras below. Every app defines the full set
in both light and dark:

```
--background --foreground --card --card-foreground --popover --popover-foreground
--primary --primary-foreground --secondary --secondary-foreground
--muted --muted-foreground --accent --accent-foreground
--destructive --destructive-foreground            /* shared: keep the -foreground pair */
--success --warning --info                         /* shared semantic status tokens */
--border --input --ring
--sidebar* (8) --chart-1..5                         /* shadcn extras, kept for parity */
--radius (+ sm/md/lg/xl calc steps) --font-mono
```

Bridged to Tailwind via `@theme inline`. `@custom-variant dark (&:where(.dark, .dark *))`
(the `:where` form — it also matches `.dark` placed directly on an element, which
reka-ui portals do).

### Per-app palette
- **GitMob**: green primary `#3ddc84`; tuned near-black "terminal" dark + a matching
  light palette. `--brand-glow` radial wash retained.
- **DevWebUI**: indigo primary; stock zinc light/dark.
- Color notation may differ (GitMob hex, DevWebUI OKLCH) — notation is not part of
  the contract; token **names**, **modes**, and **mechanism** are.

### Shared base layer + utilities (both `style.css`)
- `* { @apply border-border outline-ring/50; box-sizing: border-box }`
- `html,body,#app { height:100% }`, `body { @apply bg-background text-foreground antialiased; overscroll-behavior-y:none }`
- Utility classes: `.mono`, `.safe-top`, `.safe-bottom`, `.scroll-slim`, `.dragging`
- `collapsible-down`/`collapsible-up` keyframes + `--animate-collapsible-*`

---

## 4. Overlays — the one rule

| Surface | Component | Notes |
|---|---|---|
| Settings | **Sheet** | Right on desktop (`sm:max-w-md`), bottom-sheet on mobile (`rounded-t-2xl`, `max-h-[92vh]`). Side **locked at open time** so a mid-open resize can't break the slide. Opened by a **dedicated visible icon-button** in the header — never buried in a kebab. |
| Live-data panels (logs, errors, identities) | **Sheet** via shared `RightDrawer.vue` | One wrapper, `#header` slot, consistent scroll region. |
| Add / Edit forms | **Dialog** | `DialogScrollContent` for tall forms. |
| Confirm destructive | **inline two-step** | First click reveals a red confirm button + cancel ✕ in place. **No** native `confirm()`. |

- All overlays use `defineModel<boolean>('open')` (retire GitMob's `v-model:show`).
- Overlay backdrops: `bg-black/80` + `backdrop-blur-sm`.
- Sheet panel: `bg-card`. Dialog panel: `bg-card`. (Elevated vs page background.)

---

## 5. `components/ui/` golden set

Canonical = DevWebUI's modern set **+** GitMob's specific wins. Both apps ship the
same files. Full primitive list (both apps):

`alert, badge, button, card, collapsible, dialog, dropdown-menu, input, label,
select, separator, sheet, switch, textarea, tooltip` (GitMob adds the ones it lacks).

Conventions (from DevWebUI, applied to both):
- `data-slot` attribute on every root element.
- `defineOptions({ inheritAttrs: false })` + `v-bind="{ ...$attrs, ...forwarded }"`
  on portal-wrapping components (DropdownMenuContent, TooltipContent, DialogContent, SheetContent).
- `aria-invalid:*` styling on Input / Textarea / SelectTrigger / Button.
- Extracted `DialogOverlay.vue` / `SheetOverlay.vue`.
- `Dialog` has `showCloseButton` prop + `DialogScrollContent` variant.
- Full dropdown-menu sub-components (CheckboxItem, RadioGroup/Item, Sub*, Shortcut).
- `Input`: `text-base md:text-sm` (avoid iOS zoom) + file-input styling.

GitMob wins folded in (applied to both):
- **Badge** variant set: `default | primary | warning | info | destructive | outline`,
  tinted `bg-*/15 border-*/25`, `rounded-md` (not pill). Drives status chips.
- **Sheet**: `cva` `sheetVariants({ side })` in `sheet/index.ts` (4 sides) — not
  template conditionals.
- **CollapsibleContent**: `cn()` wrapper with `animate-collapsible-down/up`.
- **Overlays**: `backdrop-blur-sm`.
- **Dialog/Sheet panel**: `bg-card`.
- **DropdownMenuContent**: roomier — `rounded-xl`, `shadow-xl shadow-black/40`,
  `min-w-[11rem]`, `sideOffset: 6`.
- **DropdownMenuItem**: `variant` prop (`default | destructive`).

`lib/utils.ts` exports `cn(): string` (with JSDoc). `lib/` also holds `format.ts`
(time/duration) and `severity.ts` (status→class) per DevWebUI's layout.

---

## 6. Shell & header

- **App.vue** = providers only: `TooltipProvider` + `<Toaster>` (vue-sonner) wrapping `<AppShell />`.
- **AppShell.vue** = layout root + (GitMob) auth gate. DevWebUI gets a pass-through
  AppShell (auth stub that always passes) so the structure matches.
- **Header** (`AppHeader.vue` / `TopBar.vue`) — same anatomy: brand + count (left),
  live-status **pill** (animated dot + label), primary action button, **dedicated
  Settings icon-button**, and a kebab `DropdownMenu` only for genuine overflow.
- `min-h-dvh` (not `min-h-screen`). Sticky header `bg-background/80 backdrop-blur`,
  `.safe-top`. Shell applies `.safe-bottom`. iOS/PWA meta in `index.html` (both).
- Content column width stays per-app (GitMob `max-w-3xl` list; DevWebUI `max-w-7xl`
  panels) — width is domain-driven, not a "feel" divergence.

---

## 7. State, API, notifications

- **Pinia** setup-store; components use `storeToRefs`. (DevWebUI migrates its
  module-level refs in `api.ts` into a store.)
- **api.ts** = pure typed fetch wrapper grouped on one `api` object (nested
  namespaces ok), throws `ApiError { code, status, message }` on non-2xx. No
  reactive state in `api.ts`.
- **SSE** via `@vueuse/core` `useEventSource` (auto-reconnect, reactive `status`).
- **Toasts**: `vue-sonner` `<Toaster>` in App.vue; `toast.success/error` at call sites.
  Inline `<Alert variant="destructive">` still fine for in-form validation.

---

## 8. Status checklist

- [x] Comparison map + decisions
- [x] DevWebUI baselined under git
- [x] §3 Theming/tokens — DevWebUI (success/warning/info/destructive-foreground, font-mono, utilities, keyframes)
- [x] §3 Theming/tokens — GitMob (added light palette, dropped forced dark, FOUC script, dynamic Toaster)
- [x] §5 Golden `ui/` set — DevWebUI tweaks (badge set, sheet `cva`, collapsible anim, overlay blur, dialog `bg-card`, dropdown sizing)
- [x] §5 Golden `ui/` set — GitMob (copied identical golden tree + `@lucide/vue` migration, `lucide-vue-next` removed)
- [x] §4 Overlays — DevWebUI: Settings Dialog→**Sheet** + dedicated header Settings icon (`SettingsDialog.vue` → `Settings.vue`)
- [x] §3 Theme switcher (Light/Dark/System) in **both** apps' Settings
- [x] Both apps build (GitMob: `vue-tsc` + vite + PWA; DevWebUI: vite)
- [x] §4 Overlays — GitMob: migrated `v-model:show` → `defineModel('open')` (Settings, IdentityManager, AddRepo, AppShell)
- [x] §4 Overlays — DevWebUI: native `confirm()` replaced with inline two-step in ProcessForm **and** ProjectPanel
- [x] §6 Shell/header parity: live-status **pill** in GitMob; DevWebUI gained AppShell wrapper + iOS/PWA meta + `min-h-dvh` + `safe-top`/`safe-bottom`
- [x] §7 Internals — DevWebUI: Pinia store (setup-store), `ApiError` + pure `api.ts`, vue-sonner `<Toaster>` wired in App.vue/main.ts
- [x] §7 Internals — both: `verbatimModuleSyntax: true`; DevWebUI pinned off the TS6 pre-release (TS 5.x) + `vue-tsc -b` in its build; GitMob `util.ts` → `lib/util.ts`
- [x] Both apps build **and type-check** (GitMob & DevWebUI both run `vue-tsc -b && vite build`)

### Deliberate non-changes (with reasons)
- **GitMob Settings has no Save/Cancel footer.** GitMob's "Settings" is an action-based
  BYOK / API-key panel (connect/remove keys are live network actions you can't stage);
  instant-apply is the correct UX there. The theme switch is instant in both apps (a theme
  toggle should be). DevWebUI's *preference* Settings keeps the Save/Cancel footer.
- **GitMob keeps a single `tsconfig.json`** (works with `vue-tsc -b`); DevWebUI keeps the
  3-file split. Both type-check in their build now — the file-count difference is immaterial
  and not worth the churn/risk of restructuring GitMob's working config.
- **pinia**: GitMob `^2.3`, DevWebUI `^3.0`. Same setup-store API; not worth a forced bump.

### Verified
- [x] **Runtime/browser verified** — own isolated web dev servers proxying to the live
  daemons (DevWebUI :4010→:4000, GitMob :4319→:7171). Both apps mounted with **zero console
  errors**; the "live" status pill confirms Pinia store + SSE reactivity (DevWebUI) and the
  connection indicator (GitMob — 15 repos loaded from the daemon); Settings opens as a Sheet
  in both with a working Light/Dark/System switcher; GitMob renders coherently in **both**
  the dark palette and the new light palette.
- [x] **Adversarial correctness review** (2 agents). GitMob = SHIP (all invariants pass;
  only a harmless Tailwind-v4 `ring-offset-background` no-op noted). DevWebUI = 3 spots where
  the new `ApiError` (throws on non-2xx) could become an unhandled rejection were **fixed**:
  `AddProjectDialog` (×4 call sites → catch → dialog error), `Settings` load + save (→ catch
  → toast). Re-built + re-verified clean.
