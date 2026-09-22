// Shared state for the read-only file viewer.
//
// One drawer/sheet instance lives at the app root (<FileViewer/> in AppShell). Any
// changed-file row opens it by calling openFile(); the drawer reads this module's
// reactive state. On desktop the viewer is a right-side push panel — the page reserves
// `pageShiftPx` of right padding so it slides left and stays centered (no overlay). On
// mobile it's an overlay bottom sheet, so there's no page shift.
import { reactive, ref, computed } from "vue";
import { useLocalStorage, useMediaQuery } from "@vueuse/core";
import { contributeContentInset } from "@/lib/content-inset";

/** A changed file the viewer can display (repo-relative path + its git status). */
export interface ViewerTarget {
  repoId: string;
  path: string;
  status?: string;
  staged?: boolean;
  /** When set, view the file's change AT this commit (first-parent ↔ commit), read-only,
   *  instead of the working-tree diff. Drives the history graph's "open a changed file". */
  commit?: string;
}

interface ViewerState {
  open: boolean;
  target: ViewerTarget | null;
}

const state = reactive<ViewerState>({ open: false, target: null });

/** Reactive viewer state (read-only intent; mutate via the helpers below). */
export const fileViewer = state;

/** True while the editor has unsaved edits — set by FileViewerInner; gates the guards below. */
export const editorDirty = ref(false);

// A pending discard confirmation. When set, the in-app dialog (ConfirmDiscardDialog, mounted in
// FileViewer) is shown and this resolver settles once the user chooses — an async, on-brand
// replacement for a blocking window.confirm that also behaves on mobile.
const pendingDiscard = ref<((ok: boolean) => void) | null>(null);

/** Two-way `open` for the discard dialog: closing it via overlay/Esc counts as "keep editing". */
export const discardDialogOpen = computed<boolean>({
  get: () => pendingDiscard.value !== null,
  set: (open) => {
    if (!open) resolveDiscard(false);
  },
});

/** Settle the open discard prompt — true = throw the edits away, false = keep editing. */
export function resolveDiscard(ok: boolean): void {
  const settle = pendingDiscard.value;
  pendingDiscard.value = null;
  settle?.(ok);
}

/** Resolves true when it's safe to drop edits: nothing dirty, or the user confirmed discard. */
export function confirmDiscardEdits(): Promise<boolean> {
  if (!editorDirty.value) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    pendingDiscard.value?.(false); // settle any prior prompt as "keep" before showing a new one
    pendingDiscard.value = resolve;
  });
}

export async function openFile(target: ViewerTarget): Promise<void> {
  const same =
    state.open &&
    state.target?.repoId === target.repoId &&
    state.target?.path === target.path &&
    state.target?.commit === target.commit;
  if (!same && !(await confirmDiscardEdits())) return; // unsaved edits — user kept them
  if (!same) editorDirty.value = false;
  state.target = target;
  state.open = true;
}

export async function closeFile(): Promise<void> {
  if (!(await confirmDiscardEdits())) return; // unsaved edits — user kept them
  editorDirty.value = false;
  state.open = false;
}

/**
 * Close the viewer because its repo went away, not because anyone asked.
 *
 * Two ways that happens: the owner removed the repo, or a share link's guest watched it leave their
 * scope (on an all-repos link the owner hiding a repo arrives as `repo_removed` — see
 * src/share/events.ts). Either way the card is already gone from the dashboard, and leaving the
 * drawer open over it is worse than closing: FileViewerInner's repo-name lookup blanks out and
 * every call it can still make (diff, content, save) is now scoped out and answers 404, so the
 * panel LOOKS live while nothing in it works.
 *
 * No discard prompt, deliberately. `closeFile` asks before dropping unsaved edits because the user
 * chose to close and can choose otherwise; here there is nothing to choose. The file cannot be
 * saved any more, so "keep editing" would only hold an editor open over a save that must fail.
 */
export function dismissViewerForRepo(repoId: string): void {
  if (state.target?.repoId !== repoId) return;
  // A guarded close/switch may have raised the discard prompt before the repo vanished. That
  // prompt lives outside `state` (pendingDiscard), so clearing open/target below would leave the
  // dialog up over the dashboard with no editor behind it — and its awaiting close/switch promise
  // would never settle. Settle it as "keep editing" (the edits can no longer be saved either way)
  // so the dialog closes with the viewer.
  resolveDiscard(false);
  editorDirty.value = false;
  state.open = false;
  state.target = null;
}

/** True when this exact file is the one currently shown (drives the row's active tint). */
export function isViewing(repoId: string, path: string, commit?: string): boolean {
  return (
    state.open &&
    state.target?.repoId === repoId &&
    state.target?.path === path &&
    state.target?.commit === commit
  );
}

/** Content (whole file) vs Diff (HEAD ↔ working tree). Persisted, so the tab sticks.
 *  Defaults to Diff — in a source-control panel the change is the interesting view. */
export type ViewerMode = "content" | "diff";
export const viewerMode = useLocalStorage<ViewerMode>("repoyeti:fileViewerMode", "diff");

/** Diff highlighting granularity: true = word/character-level (Monaco's default inner-change
 *  highlight), false = whole-line only. Persisted; toggled from the diff header. */
export const wordLevelDiff = useLocalStorage<boolean>("repoyeti:fileViewerWordDiff", true);

/** Soft-wrap long lines in the viewer/diff (Monaco wordWrap). Persisted; toggled from the ⋮ menu. */
export const wordWrap = useLocalStorage<boolean>("repoyeti:fileViewerWordWrap", false);

/** VS Code-style "dirty diff": highlight changed lines in the gutter of the CONTENT view (green
 *  added, blue modified, red-triangle deleted vs HEAD), even with the Diff tab off. Persisted;
 *  toggled from the ⋮ menu. Default on. */
export const dirtyDiffGutter = useLocalStorage<boolean>("repoyeti:fileViewerDirtyGutter", true);

/** Diff layout: true = split (side-by-side), false = unified (inline). Persisted; toggled
 *  from the diff header. Split still auto-folds to inline when the panel is too narrow. */
export const diffSplitView = useLocalStorage<boolean>("repoyeti:fileViewerSplitView", true);

// ── desktop push-panel geometry ───────────────────────────────────────────────
/** Desktop = right push-drawer; narrower = mobile bottom sheet. Matches the Settings sheet. */
export const DESKTOP_QUERY = "(min-width: 768px)";
export const isDesktopViewer = useMediaQuery(DESKTOP_QUERY);

export const MIN_VIEWER_PX = 380;
export const MAX_VIEWER_PX = 1200;

const clampWidth = (px: number): number =>
  Math.min(MAX_VIEWER_PX, Math.max(MIN_VIEWER_PX, Math.round(px)));

/** Persisted seed for the panel width (committed on drag release). */
const storedWidth = useLocalStorage<number>("repoyeti:fileViewerWidth", 680);
/** Live width — drives both the panel and the page shift; updated continuously while dragging. */
export const viewerWidth = ref(clampWidth(storedWidth.value));

/** Set the live width (during a drag); call commitViewerWidth to persist it. */
export function setViewerWidth(px: number): void {
  viewerWidth.value = clampWidth(px);
}
export function commitViewerWidth(px: number): void {
  setViewerWidth(px);
  storedWidth.value = viewerWidth.value;
}

/** Right padding the page reserves so it slides left of the desktop drawer (0 on mobile). */
export const pageShiftPx = computed(() =>
  state.open && isDesktopViewer.value ? viewerWidth.value : 0,
);

// The drawer covers the viewport's right edge — publish its width so centered dialogs
// re-center over the remaining content (kit lib/content-inset.ts). The page itself keeps
// its native scrollbar: this is a push panel, the content beside it must stay scrollable
// (the drawer's body scrolls independently via its own overflow-y-auto region).
contributeContentInset(pageShiftPx);
