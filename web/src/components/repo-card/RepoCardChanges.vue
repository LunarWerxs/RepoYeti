<script setup lang="ts">
// Repo working-state strip (path + remote presence, branch switcher, error line) and the
// changed-files tree (search/filter, collapse-all, drag-to-resize, per-file discard), extracted
// from RepoCard. Self-contained like BranchPanel/StashPanel/LogPanel: reads/derives from `repo`
// and the store, and runs its own git ops (discard) keyed by repo.id.
import { computed, ref, useTemplateRef, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, ChevronsDownUp, ChevronsUpDown, Cloud, CloudOff, EyeOff, FileSearch, FolderTree, GitCompareArrows, GripHorizontal, List, ListTree, ListX, Loader2, RefreshCw, Search, X } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { api, ApiError } from "../../api";
import { buildChangeTree } from "@/lib/util";
import { churn } from "@/lib/diffstat";
import { provideTreeCollapse } from "@/lib/changes-tree";
import { useTreeSelection } from "@/lib/changes-selection";
import { cn } from "@/lib/utils";
import { useRepoFeedback } from "@/lib/repo-feedback";
import {
  CHANGES_SIZE_PX,
  changesViewSize,
  changesTreeStyle,
  setChangesOverride,
  clearChangesOverride,
  hasChangesOverride,
  changesDisplayMode,
  setChangesDisplayMode,
  changesPanelMode,
  setChangesPanelMode,
  searchIgnoredFiles,
  MIN_CHANGES_PX,
} from "@/lib/changes-view";
import { provideFileBrowser } from "@/lib/file-browser";
import { shortcutsActive } from "@/lib/hotkeys";
import { releasedHeight, useGripDrag, useGripGlide } from "@/lib/grip-drag";
import { useTooltipConfig } from "@/lib/tooltip-config";
import ViewOptions, { type ViewOptionRow } from "@/components/ui/ViewOptions.vue";
import ChangesTree from "../ChangesTree.vue";
import RepoFileTree from "../RepoFileTree.vue";
import BranchPanel from "../BranchPanel.vue";
import RepoCardMenu from "./RepoCardMenu.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { Repo, RepoTreeEntry, TreeNode } from "../../types";

const props = defineProps<{ repo: Repo }>();
const store = useStore();
const { t } = useI18n();
const { toastResult } = useRepoFeedback();

const st = computed(() => props.repo.status);
const hasRemote = computed(() => !!st.value?.remote);

// Manual refresh (re-stat this repo) — moved here from RepoCardActions so it sits immediately
// left of the remote-presence cloud icon, right under the repo title.
const busyAction = computed(() => store.busy[props.repo.id]);
async function refresh(): Promise<void> {
  await store.doAction(props.repo.id, "refresh");
}

// The toolbar's icon-only buttons are Tooltip-labelled; when the app-wide "show tooltips"
// switch is off, reka suppresses those, so a native :title takes over as the only visible
// label (the same gated-title pattern as RepoCardHeader's dropdown triggers).
const { enabled: tooltipsEnabled } = useTooltipConfig();

// ── collapse + changed-files tree ─────────────────────────────────────────────
const changeTree = computed(() => buildChangeTree(store.changesByRepo[props.repo.id] ?? []));

// The scale every change bar in this card is drawn against ("visual bars" appearance option).
// Computed here, over the FLAT file list, because a recursion level of ChangesTree can only see
// its own subtree — scaling per subtree would make two sibling folders' bars mean different
// things. Deliberately not filtered by the search box: bar lengths that rescale as you type
// would make the same file look bigger just because you filtered the list.
const maxChurn = computed(() =>
  Math.max(
    1,
    ...(store.changesByRepo[props.repo.id] ?? []).map((f) =>
      churn(f.stat?.addedLines ?? 0, f.stat?.removedLines ?? 0),
    ),
  ),
);

// ── changed-files view options (the toolbar popover) ─────────────────────────
// Both are daemon settings (they follow the owner across devices), so flipping one round-trips and
// can fail — hence the toasts, unlike History's browser-local prefs. Disabled while diff
// statistics are off entirely: there are no numbers to style, and a switch that silently does
// nothing is worse than one that says why.
const viewOptionRows = computed<ViewOptionRow[]>(() => [
  {
    key: "statDisplay",
    label: t("repo.changes.optTotals"),
    hint: t("repo.changes.optTotalsHint"),
    kind: "choice",
    active: store.changesStatDisplay,
    choices: [
      { value: "numbers", label: t("common.numbers") },
      { value: "bars", label: t("common.visualBars") },
    ],
    disabled: !store.diffStatsEnabled,
    disabledHint: t("repo.changes.viewOptionsNeedStats"),
  },
  {
    key: "chars",
    label: t("repo.changes.optChars"),
    hint: t("repo.changes.optCharsHint"),
    kind: "toggle",
    on: store.changesCharsEnabled,
    // Bars draw one proportional bar from the LINE counts, so there is no character half to show.
    disabled: !store.diffStatsEnabled || store.changesStatDisplay === "bars",
    disabledHint: !store.diffStatsEnabled
      ? t("repo.changes.viewOptionsNeedStats")
      : t("repo.changes.viewOptionsCharsBars"),
  },
]);
async function onViewOption({ key, value }: { key: string; value: boolean | string }): Promise<void> {
  try {
    if (key === "statDisplay") await store.setChangesStatDisplay(value as "numbers" | "bars");
    else if (key === "chars") await store.setChangesChars(value as boolean);
  } catch {
    // Two literal t() calls rather than t(cond ? a : b): the i18n checker only sees a literal
    // first argument, so the ternary form reports both strings as dead and invites their deletion.
    if (key === "chars") toast.error(t("settings.changesCharsFailed"));
    else toast.error(t("settings.changesStatDisplayFailed"));
  }
}

// Per-folder collapse state, shared with the recursive ChangesTree via provide/inject
// (persisted per repo — see @/lib/changes-tree).
const treeCollapse = provideTreeCollapse(props.repo.id);

// The shared per-file selection RepoCard provides (the same one ChangesTree's checkboxes drive).
// Clearing it belongs HERE, beside the search controls, because this is where the selection is
// made — it used to sit in a strip under the commit box, a whole panel away from the checkboxes.
const treeSelection = useTreeSelection();

function collectDirPaths(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "dir") {
      acc.push(n.path);
      if (n.children) collectDirPaths(n.children, acc);
    }
  }
  return acc;
}
const dirPaths = computed(() => collectDirPaths(changeTree.value));
// True once every folder is collapsed → the button flips to "expand all".
const allCollapsed = computed(
  () => dirPaths.value.length > 0 && dirPaths.value.every((p) => treeCollapse.collapsed.has(p)),
);
// Collapse-all has nothing to act on in list view (no folders rendered), while a search is
// running (the tree is force-expanded), or in a repo whose changes are all at the root. The
// button stays in place and greys out in those states rather than unmounting — see the toolbar.
const collapseAllDisabled = computed(() => isList.value || searching.value || !dirPaths.value.length);
function toggleCollapseAll(): void {
  if (collapseAllDisabled.value) return;
  if (allCollapsed.value) treeCollapse.expandAll();
  else treeCollapse.collapseAll(dirPaths.value);
}

// ── tree ⇄ list view (per-repo, persisted; see @/lib/changes-view) ────────────
// Some people prefer a flat list of full paths over the nested folder tree. The toggle in the
// toolbar flips this per card; "tree" is the default so nothing changes for existing cards.
const displayMode = computed(() => changesDisplayMode(props.repo.id));
const isList = computed(() => displayMode.value === "list");
function toggleDisplayMode(): void {
  setChangesDisplayMode(props.repo.id, isList.value ? "tree" : "list");
}

// List view = every file leaf of the (already search-filtered) tree, flattened and sorted by
// full path. Reuses ChangesTree in `flat` mode, so selection / discard / open / diff-stats /
// keyboard nav all work identically — only folders and indentation drop away.
function flattenLeaves(nodes: TreeNode[], acc: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    if (n.type === "file") acc.push(n);
    else if (n.children) flattenLeaves(n.children, acc);
  }
  return acc;
}

// ── changes ⇄ all-files panel (per-repo, persisted; see @/lib/changes-view) ───
// "All files" swaps the changed-file list for a lazy browser over the whole working tree. It is
// deliberately NOT gated on the repo being dirty: a clean repo is exactly when you want to read
// the code, so its toggle sits in the always-visible header row rather than inside the
// dirty-gated changes section.
// Who may browse at all: never a share-link guest (both tree routes are owner-only), and not the
// owner's own REMOTE session once they've turned browsing over the tunnel off. `canContinueLocal`
// is the daemon's own "this request came from loopback" signal, so a local session is unaffected
// by that switch — the same shape FileViewerInner uses for the remote-editing gate.
const canBrowseFiles = computed(
  () => !store.isGuest && (store.canContinueLocal || store.remoteBrowse),
);
const panelMode = computed(() => changesPanelMode(props.repo.id));
// A persisted "all" must not strand someone in a panel they can no longer load — if browsing is
// revoked mid-session (or the preference followed them to a remote device), fall back to changes.
const isBrowsing = computed(() => canBrowseFiles.value && panelMode.value === "all");
const browser = provideFileBrowser(props.repo.id);
function togglePanelMode(): void {
  setChangesPanelMode(props.repo.id, isBrowsing.value ? "changes" : "all");
}
// The root listing is fetched on first switch, not on mount — a card that never browses never
// costs a request. Re-entering reuses whatever is already cached (reload is the toolbar's job).
watch(
  isBrowsing,
  (browsing) => {
    if (browsing && !browser.dirs.has("")) void browser.load("");
  },
  { immediate: true },
);
// Status letters for files that are ALSO changed, so browsing never loses that signal.
const changedByPath = computed(
  () => new Map((store.changesByRepo[props.repo.id] ?? []).map((f) => [f.path, f])),
);

// ── all-files search ─────────────────────────────────────────────────────────
// Server-side on purpose. Filtering only the folders already expanded would look like it
// searched the repository and quietly not have — and the whole tree is 200k+ paths, so it is
// never all in the client. Same debounce/abort/kill-timer shape as the changed-files content
// search above, because this one really does walk the disk.
const fileQuery = ref("");
const fileResults = ref<RepoTreeEntry[] | null>(null);
const fileSearchLoading = ref(false);
const fileSearchTruncated = ref(false);
// What the LAST result actually covered, which is not always what was asked (a repo with no git
// to ask can only be walked). Drives the notice under the results.
const fileSearchSawIgnored = ref(false);
const MIN_FILE_SEARCH = 2;
let fileSearchAbort: AbortController | null = null;
let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;

function runFileSearch(): void {
  const ctrl = new AbortController();
  fileSearchAbort = ctrl;
  const killTimer = setTimeout(() => ctrl.abort(), 10_000);
  api
    .treeSearch(
      props.repo.id,
      fileQuery.value.trim(),
      { includeIgnored: searchIgnoredFiles.value },
      ctrl.signal,
    )
    .then((res) => {
      if (ctrl.signal.aborted) return;
      fileResults.value = res.entries ?? [];
      fileSearchTruncated.value = res.truncated === true;
      fileSearchSawIgnored.value = res.ignoredIncluded === true;
    })
    .catch(() => {
      if (!ctrl.signal.aborted) {
        fileResults.value = [];
        fileSearchTruncated.value = false;
      }
    })
    .finally(() => {
      clearTimeout(killTimer);
      if (fileSearchAbort === ctrl) {
        fileSearchLoading.value = false;
        fileSearchAbort = null;
      }
    });
}

// Flipping the ignored switch re-runs the current query rather than making you retype it.
watch([fileQuery, searchIgnoredFiles], () => {
  if (fileSearchTimer) clearTimeout(fileSearchTimer);
  fileSearchAbort?.abort();
  fileSearchAbort = null;
  if (fileQuery.value.trim().length < MIN_FILE_SEARCH) {
    // Back to the tree — null (not []) is what tells RepoFileTree it is not in results mode.
    fileResults.value = null;
    fileSearchTruncated.value = false;
    fileSearchLoading.value = false;
    return;
  }
  fileSearchLoading.value = true;
  fileSearchTimer = setTimeout(runFileSearch, 220);
});

function clearFileSearch(): void {
  fileQuery.value = "";
}

/** A folder result: drop the query and open the tree down to it. */
async function goToFolder(entry: RepoTreeEntry): Promise<void> {
  clearFileSearch();
  await browser.revealPath(entry.path, entry.type);
}

onBeforeUnmount(() => {
  if (fileSearchTimer) clearTimeout(fileSearchTimer);
  fileSearchAbort?.abort();
});

// ── changed-files search ──────────────────────────────────────────────────────
// Filename filtering is instant + local. The "Search content" toggle additionally greps
// inside the changed files via the daemon — debounced, cancellable, and only at ≥3 chars.
// Lifted to RepoCard (v-model) rather than a plain local ref: RepoCardChanges lives inside
// <CollapsibleContent>, which unmounts its content on collapse (reka-ui's default
// unmountOnHide), so state owned here would otherwise reset every time the card is
// collapsed/re-expanded — RepoCard's own scope doesn't unmount, so it survives there.
const treeQuery = defineModel<string>("treeQuery", { required: true });
const searching = computed(() => treeQuery.value.trim().length > 0);

const contentMode = defineModel<boolean>("contentMode", { required: true });
const contentMatches = ref<Set<string>>(new Set());
const contentLoading = ref(false);
// Server-owned threshold (from /api/status) so the UI gate can't drift from the daemon's.
const minContentChars = computed(() => store.contentSearchMin);
let searchAbort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function runContentSearch(): void {
  const ctrl = new AbortController();
  searchAbort = ctrl;
  // Safety net: never let a hung/slow daemon strand the spinner. boundedGit already kills
  // its git child at 30s; this is the independent client-side cap on the whole round-trip.
  const killTimer = setTimeout(() => ctrl.abort(), 10_000);
  api
    .searchContent(props.repo.id, treeQuery.value.trim(), ctrl.signal)
    .then((paths) => {
      if (!ctrl.signal.aborted) contentMatches.value = new Set(paths);
    })
    .catch(() => {
      if (!ctrl.signal.aborted) contentMatches.value = new Set();
    })
    .finally(() => {
      clearTimeout(killTimer);
      if (searchAbort === ctrl) {
        contentLoading.value = false;
        searchAbort = null;
      }
    });
}

// Each keystroke (or toggle) cancels any in-flight request and drops stale matches, then
// re-arms the debounce. Below the threshold (or with content mode off) we don't hit git.
watch([treeQuery, contentMode], () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchAbort?.abort();
  searchAbort = null;
  contentMatches.value = new Set();
  if (!contentMode.value || treeQuery.value.trim().length < minContentChars.value) {
    contentLoading.value = false;
    return;
  }
  contentLoading.value = true; // show the spinner immediately, even during the debounce
  searchTimer = setTimeout(runContentSearch, 180);
});

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  searchAbort?.abort();
});

// A file is kept when its path matches the query, or — in content mode at ≥3 chars — when
// its content matched. A folder is kept when its own name matches (then it shows all its
// contents) or it has a kept descendant. The tree is force-expanded while searching.
function filterTreeBy(nodes: TreeNode[], keep: (n: TreeNode) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === "dir") {
      if (keep(n)) {
        out.push(n); // folder itself matches → show it with all its contents
      } else {
        const kids = n.children ? filterTreeBy(n.children, keep) : [];
        if (kids.length) out.push({ ...n, children: kids });
      }
    } else if (keep(n)) {
      out.push(n);
    }
  }
  return out;
}
const filteredTree = computed(() => {
  const q = treeQuery.value.trim().toLowerCase();
  if (!q) return changeTree.value;
  const useContent = contentMode.value && q.length >= minContentChars.value;
  const matches = contentMatches.value;
  return filterTreeBy(
    changeTree.value,
    (n) => n.path.toLowerCase().includes(q) || (useContent && n.type === "file" && matches.has(n.path)),
  );
});
// The flat file list for list view — leaves of the filtered tree, sorted by full path.
const flatFiles = computed(() =>
  flattenLeaves(filteredTree.value).sort((a, b) => a.path.localeCompare(b.path)),
);

// ── drag-to-resize the changed-files tree ─────────────────────────────────────
// The grip below the tree pins an explicit height (persisted per repo); double-click
// it (or press Delete) to fall back to the global Settings preset. See @/lib/changes-view.
const treeScroll = useTemplateRef<HTMLElement>("treeScroll");
const treeContent = useTemplateRef<HTMLElement>("treeContent");
// Live px while a drag is in flight; persisted once on release so we don't thrash
// localStorage (the deep useLocalStorage watcher serialises on every mutation).
const dragHeight = ref<number | null>(null);
const glide = useGripGlide();
const resized = computed(() => hasChangesOverride(props.repo.id));
// In automatic mode, explicitly mirror the rendered content height. CSS `height:auto` normally
// does this, but a capped overflow viewport can occasionally keep its former smaller used height
// when a live tree gains rows. Observing the inner content makes both directions deterministic.
const autoContentHeight = ref<number | null>(null);
const treeStyle = computed(() => {
  // A live drag is a bare height: the preset must NOT come along as a max-height, or the grip
  // would refuse to travel past it on a card that has no override yet.
  if (dragHeight.value != null) return { height: `${dragHeight.value}px` };
  const base = changesTreeStyle(props.repo.id);
  // A reset glide is the opposite: the override is already released, so the preset cap it is
  // handing back to belongs on the element for the whole animation — then releasing the held
  // height changes nothing but the height itself. The glide never targets above the cap.
  if (glide.height.value != null) return { ...base, height: `${glide.height.value}px` };
  if (resized.value || autoContentHeight.value == null) return base;
  const presetMax = CHANGES_SIZE_PX[changesViewSize.value];
  return {
    ...base,
    height: `${Math.min(autoContentHeight.value, presetMax)}px`,
  };
});

let contentResizeObserver: ResizeObserver | null = null;
function measureTreeContent(): void {
  const content = treeContent.value;
  if (!content) return;
  // scrollHeight includes the 10px end gap and top padding on the inner wrapper. The bounding
  // height is a useful fallback for engines that round scrollHeight during a layout update.
  const height = Math.ceil(
    Math.max(content.scrollHeight, content.getBoundingClientRect().height),
  );
  if (height > 0) autoContentHeight.value = height;
}
watch(
  treeContent,
  (content) => {
    contentResizeObserver?.disconnect();
    contentResizeObserver = null;
    autoContentHeight.value = null;
    if (!content) return;
    measureTreeContent();
    if (typeof ResizeObserver === "undefined") return;
    contentResizeObserver = new ResizeObserver(measureTreeContent);
    contentResizeObserver.observe(content);
  },
  { flush: "post", immediate: true },
);
onBeforeUnmount(() => contentResizeObserver?.disconnect());

const clampPx = (px: number): number => Math.max(MIN_CHANGES_PX, Math.round(px));
let dragStartY = 0;
let dragStartH = 0;

// All the release/stuck-drag handling (button filtering, capture loss, swallowed pointerup,
// blur, unmount) lives in useGripDrag — see @/lib/grip-drag.
const onGripDown = useGripDrag({
  onStart: (e) => {
    if (!treeScroll.value) return false;
    dragStartY = e.clientY;
    dragStartH = treeScroll.value.clientHeight;
    dragHeight.value = dragStartH; // pin before cancelling, so no frame renders the untouched style
    glide.cancel();
  },
  onMove: (e) => {
    // A manual resize is an exact workspace height, not another content cap. Let the grip move
    // past a short tree's scrollHeight; the empty room is intentional and persists on release.
    dragHeight.value = clampPx(dragStartH + (e.clientY - dragStartY));
  },
  onEnd: () => {
    if (dragHeight.value != null) {
      setChangesOverride(props.repo.id, dragHeight.value); // commit the final height
      dragHeight.value = null;
    }
  },
});
function resetTreeHeight(): void {
  const el = treeScroll.value;
  dragHeight.value = null;
  // Where the released tree will settle: the preset is a content-fitting cap, so it lands on the
  // content height unless that overflows. autoContentHeight is that number already measured;
  // releasedHeight derives it from the DOM when the observer hasn't reported yet.
  const presetMax = CHANGES_SIZE_PX[changesViewSize.value];
  const target =
    autoContentHeight.value != null
      ? Math.min(autoContentHeight.value, presetMax)
      : releasedHeight(el, presetMax);
  glide.glideTo(el?.clientHeight, target, () => clearChangesOverride(props.repo.id));
}
// Keyboard: ↑/↓ nudge the height in 24px steps from the current rendered size.
function nudgeHeight(delta: number): void {
  const base = treeScroll.value?.clientHeight;
  if (base) setChangesOverride(props.repo.id, base + delta);
}

// The changed-files grip's keyboard resize (↑/↓/Del) only fires when shortcuts are on.
function gripKey(action: () => void): void {
  if (shortcutsActive()) action();
}

// ── discard one file's working-tree changes (confirm-gated) ───────────────────
const discardTarget = ref<string | null>(null);
const discardOpen = computed({
  get: () => discardTarget.value !== null,
  set: (v: boolean) => {
    if (!v) discardTarget.value = null;
  },
});
function askDiscard(path: string): void {
  discardTarget.value = path;
}
async function confirmDiscard(): Promise<void> {
  const path = discardTarget.value;
  discardTarget.value = null;
  if (!path) return;
  // Serialize with the other per-repo git ops (matches BranchPanel/StashPanel): a rapid second
  // discard while one is still in flight would otherwise fire two concurrent discardFile ops.
  if (store.gitOpBusy[props.repo.id]) return;
  toastResult(await store.discardFile(props.repo.id, path), t("repo.discard.discarded"));
}

// ── delete one file from disk (confirm-gated) ─────────────────────────────────
// Distinct from discard, which restores a file to its committed state — for a TRACKED file that
// puts it straight back, which is the opposite of what "delete this" means. This removes it and
// stages the deletion. Same confirm-then-serialize shape as discard above.
const deleteTarget = ref<string | null>(null);
const deleteOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (v: boolean) => {
    if (!v) deleteTarget.value = null;
  },
});
function askDelete(path: string): void {
  deleteTarget.value = path;
}
async function confirmDelete(): Promise<void> {
  const path = deleteTarget.value;
  deleteTarget.value = null;
  if (!path) return;
  if (store.gitOpBusy[props.repo.id]) return;
  toastResult(await store.deleteFile(props.repo.id, path), t("repo.deleteFile.deleted"));
}

// ── delete a whole folder (confirm-gated, and the confirm counts first) ───────
// Recursive delete is the one action here where "how much am I about to lose?" is not obvious
// from the row you right-clicked — a collapsed folder can hide fifty files. So the confirm says
// the number, counted from the same changed-file list the tree is built from.
const deleteFolderTarget = ref<string | null>(null);
const deleteFolderOpen = computed({
  get: () => deleteFolderTarget.value !== null,
  set: (v: boolean) => {
    if (!v) deleteFolderTarget.value = null;
  },
});
/** CHANGED files under the folder. Deliberately named as such in the copy: the daemon deletes
 *  every file in the folder, including clean ones this list never mentions, so promising an
 *  exact total here would be a lie the UI cannot back up. */
const deleteFolderCount = computed(() => {
  const dir = deleteFolderTarget.value;
  if (!dir) return 0;
  const prefix = `${dir}/`;
  return (store.changesByRepo[props.repo.id] ?? []).filter((f) => f.path.startsWith(prefix)).length;
});
function askDeleteFolder(path: string): void {
  deleteFolderTarget.value = path;
}
async function confirmDeleteFolder(): Promise<void> {
  const path = deleteFolderTarget.value;
  deleteFolderTarget.value = null;
  if (!path) return;
  if (store.gitOpBusy[props.repo.id]) return;
  toastResult(await store.deleteFile(props.repo.id, path, true), t("repo.deleteFile.deletedFolder"));
}

// ── drag-to-move: a file row dropped on a folder row moves it there (bubbled from ChangesTree) ──
async function onMove(payload: { from: string; toDir: string }): Promise<void> {
  // Serialize with the other per-repo git ops (matches discard): don't fire a move while one is
  // already in flight for this repo.
  if (store.gitOpBusy[props.repo.id]) return;
  toastResult(await store.moveFile(props.repo.id, payload.from, payload.toDir), t("repo.changes.moved"));
}

// ── stage one file into the index (non-destructive; GitHub-Desktop-style, no confirm needed) ──
async function onStage(path: string): Promise<void> {
  // Serialize with the other per-repo git ops (matches discard/move): don't fire a stage while
  // one is already in flight for this repo.
  if (store.gitOpBusy[props.repo.id]) return;
  toastResult(await store.stageFile(props.repo.id, path), t("repo.changes.staged"));
}

// ── reveal a changed file in the OS file manager (selects the file — see systemRevealArgv;
// loopback-only, so a failure here is expected remotely) ──
async function onReveal(path: string): Promise<void> {
  try {
    await store.openInEditor(props.repo.id, { editor: "system", path });
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("repo.openFailed"));
  }
}

// ── open a changed file in the owner's default external editor (no `editor` ⇒ effective default;
// loopback-only, like reveal) ──
async function onEditor(path: string): Promise<void> {
  try {
    await store.openInEditor(props.repo.id, { path });
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("repo.openFailed"));
  }
}

// ── add a changed file's path to the repo's .gitignore (idempotent; from the row context menu) ──
async function onGitignore(path: string): Promise<void> {
  if (store.gitOpBusy[props.repo.id]) return;
  const r = await store.addToGitignore(props.repo.id, path);
  if (r.ok) toast.success(r.alreadyIgnored ? t("repo.changes.alreadyIgnored") : t("repo.changes.gitignored"));
  else toast.error(t("repo.changes.gitignoreFailed"));
}

// ── copy a changed file's repo-relative path to the clipboard (from the row context menu) ──
async function onCopyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success(t("repo.changes.copiedPath"));
  } catch {
    toast.error(t("repo.changes.copyPathFailed"));
  }
}
</script>

<template>
  <!-- path (location) + remote-presence cloud, kept on one line -->
  <div class="flex items-center gap-2">
    <div
      class="mono min-w-0 flex-1 truncate text-left text-[11.5px] text-muted-foreground"
      dir="rtl"
      :title="repo.absPath"
    >
      {{ repo.absPath }}
    </div>
    <!-- changes ⇄ all-files. Lives HERE, in the always-rendered header row, rather than in the
         changed-files toolbar below: that toolbar only exists while the repo is dirty, and a
         clean repo is precisely when you want to browse the code. Shows the icon of the mode
         you'd switch TO, matching the tree ⇄ list button's convention.

         Owner-only, matching the route: GET /api/repos/:id/tree is in policy.ts's OWNER_ONLY
         list because enumerating a working tree (ignored paths included) is a bigger capability
         than reading one named file. Rendering the button for a guest would only offer them a
         403 — and the same goes for the owner's own REMOTE session once they've turned browsing
         over the tunnel off (Settings → Remote access). -->
    <Tooltip v-if="canBrowseFiles">
      <TooltipTrigger as-child>
        <button
          type="button"
          role="switch"
          :aria-checked="isBrowsing"
          class="flex size-6 shrink-0 items-center justify-center rounded outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
          :class="isBrowsing ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
          :aria-label="isBrowsing ? $t('repo.files.showChanges') : $t('repo.files.showAll')"
          :title="tooltipsEnabled ? undefined : (isBrowsing ? $t('repo.files.showChanges') : $t('repo.files.showAll'))"
          @click="togglePanelMode"
        >
          <component :is="isBrowsing ? GitCompareArrows : FolderTree" :size="14" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {{ isBrowsing ? $t("repo.files.showChanges") : $t("repo.files.showAll") }}
      </TooltipContent>
    </Tooltip>
    <!-- manual refresh (re-stat this repo) — immediately left of the remote-presence cloud icon -->
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"
          :aria-label="$t('repo.actions.refresh')"
          :disabled="!!busyAction"
          @click="refresh"
        >
          <RefreshCw :size="14" :class="busyAction === 'refresh' && 'animate-spin'" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{{ $t("repo.actions.refresh") }}</TooltipContent>
    </Tooltip>
    <Tooltip>
      <!-- touch="tap": this icon is pure signal — nothing here or above it responds to a click, so
           a tap can safely BE the disclosure, the way it is for an InfoHint. The status pills in
           RepoCardHeader look like the same case and are NOT: they sit inside the header row that
           expands the card, and eating that tap would cost more than the tooltip is worth. -->
      <TooltipTrigger as-child touch="tap">
        <span :class="cn('inline-flex shrink-0', hasRemote ? 'text-info/80' : 'text-muted-foreground/50')">
          <Cloud v-if="hasRemote" :size="16" />
          <CloudOff v-else :size="16" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{{ hasRemote ? st?.remote : $t("repo.badge.noRemote") }}</TooltipContent>
    </Tooltip>
    <!-- overflow (⋮) menu — moved here from the fetch/pull/push row so the card's per-repo
         management actions sit with refresh + the remote indicator. Owner-only. -->
    <RepoCardMenu v-if="!store.isGuest" :repo="repo" />
  </div>

  <!-- branch switcher + inline create form — see BranchPanel.vue -->
  <BranchPanel
    v-if="!st?.error && !store.isGuest"
    :repo-id="repo.id"
    :branch="st?.branch ?? null"
    :detached="st?.detached ?? false"
  />

  <!-- error line -->
  <div
    v-if="st?.error"
    class="flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-2 text-[12.5px] text-destructive"
  >
    <AlertTriangle :size="14" class="shrink-0" />
    <span class="min-w-0 break-words">{{ st.error }}</span>
  </div>

  <!-- ALL FILES: the whole working tree, ignored paths included, one folder fetched per open.
       Reuses the changed-file panel's chrome (same border, same scroll viewport, same height
       preset) so switching modes doesn't move the card around under the pointer. -->
  <ExpandTransition :open="isBrowsing">
    <div class="overflow-hidden rounded-md border border-border bg-background/40">
      <div class="flex items-center gap-1.5 border-b border-border/40 px-1.5 py-1">
        <div class="relative min-w-0 flex-1">
          <Search
            class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            v-model="fileQuery"
            type="text"
            :placeholder="$t('repo.files.searchPlaceholder')"
            :aria-label="$t('repo.files.searchPlaceholder')"
            class="h-6 w-full rounded bg-transparent pr-8 pl-7 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:bg-accent/30 focus-visible:ring-1 focus-visible:ring-ring/40"
          />
          <div class="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
            <Loader2 v-if="fileSearchLoading" :size="13" class="mr-1 animate-spin text-muted-foreground" />
            <Tooltip v-else-if="fileQuery">
              <TooltipTrigger as-child>
                <button
                  type="button"
                  :aria-label="$t('repo.changes.searchClear')"
                  :title="tooltipsEnabled ? undefined : $t('repo.changes.searchClear')"
                  class="flex size-6 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                  @click="clearFileSearch"
                >
                  <X :size="12" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{{ $t("repo.changes.searchClear") }}</TooltipContent>
            </Tooltip>
            <!-- Include gitignored paths. Off by default: the TREE can afford to show
                 node_modules because a folder costs nothing until you open it, but a search has
                 no such protection. Same right-cluster toggle shape as the changed-files
                 "search inside files" button above. -->
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  type="button"
                  role="checkbox"
                  :aria-checked="searchIgnoredFiles"
                  :aria-label="$t('repo.files.searchIgnored')"
                  :title="tooltipsEnabled ? undefined : $t('repo.files.searchIgnored')"
                  class="flex size-6 items-center justify-center rounded outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
                  :class="searchIgnoredFiles ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
                  @click="searchIgnoredFiles = !searchIgnoredFiles"
                >
                  <EyeOff :size="13" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{{ $t("repo.files.searchIgnoredHint") }}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              :aria-label="$t('repo.files.reload')"
              :title="tooltipsEnabled ? undefined : $t('repo.files.reload')"
              @click="browser.reset()"
            >
              <RefreshCw :size="13" :class="browser.busy() && 'animate-spin'" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{{ $t("repo.files.reload") }}</TooltipContent>
        </Tooltip>
      </div>
      <div class="changes-tree-viewport scroll-slim overflow-y-auto" :style="changesTreeStyle(repo.id)">
        <div class="px-1 pt-0.5 pb-2.5">
          <!-- A search that found nothing is its own state: the tree below would otherwise render
               an empty list that reads like a broken panel. -->
          <div
            v-if="fileResults && !fileResults.length && !fileSearchLoading"
            class="px-2.5 py-2 text-[12px] text-muted-foreground"
          >
            {{ $t("repo.files.searchNoMatch") }}
            <!-- The likeliest reason a search came back empty here: the thing you wanted is
                 gitignored, and the default does not look there. Say so instead of leaving the
                 switch to be discovered. -->
            <span v-if="!fileSearchSawIgnored">{{ $t("repo.files.searchNoMatchIgnoredHint") }}</span>
          </div>
          <RepoFileTree
            v-else
            :repo-id="repo.id"
            :is-guest="store.isGuest"
            :changed="changedByPath"
            :results="fileResults"
            @reveal="onReveal"
            @editor="onEditor"
            @copy-path="onCopyPath"
            @go-to-folder="goToFolder"
          />
          <!-- The walk is capped and time-budgeted (see src/service/tree.ts), so say when the
               answer is a head rather than letting it look complete. -->
          <div
            v-if="fileSearchTruncated"
            class="px-2.5 py-1.5 text-[11.5px] text-warning/80"
          >
            {{ $t("repo.files.searchTruncated", { shown: fileResults?.length ?? 0 }) }}
          </div>
        </div>
      </div>
    </div>
  </ExpandTransition>

  <!-- changed-files tree (height from Settings preset; drag the grip to resize) -->
  <ExpandTransition :open="!!(st && st.dirty > 0 && !isBrowsing)">
  <div
    class="overflow-hidden rounded-md border border-border bg-background/40"
  >
    <!-- tree toolbar: filter the changed files + collapse-all ⇄ expand-all -->
    <div class="flex items-center gap-1.5 border-b border-border/40 px-1.5 py-1">
      <div class="relative min-w-0 flex-1">
        <Search
          class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          v-model="treeQuery"
          type="text"
          :placeholder="$t('repo.changes.searchPlaceholder')"
          :aria-label="$t('repo.changes.searchPlaceholder')"
          class="h-6 w-full rounded bg-transparent pr-20 pl-7 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:bg-accent/30 focus-visible:ring-1 focus-visible:ring-ring/40"
        />
        <!-- right cluster: clear (only with a query) + the "search inside files" toggle -->
        <div class="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
          <Tooltip v-if="treeQuery">
            <TooltipTrigger as-child>
              <button
                type="button"
                :aria-label="$t('repo.changes.searchClear')"
                :title="tooltipsEnabled ? undefined : $t('repo.changes.searchClear')"
                class="flex size-6 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                @click="treeQuery = ''"
              >
                <X :size="12" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ $t("repo.changes.searchClear") }}</TooltipContent>
          </Tooltip>
          <!-- clear the per-file selection. Only present while something IS selected, and tinted
               toward destructive so it reads as "this throws something away" rather than as one
               more neutral toolbar icon — it is next to two icons that only filter. -->
          <Tooltip v-if="treeSelection.count.value > 0">
            <TooltipTrigger as-child>
              <button
                type="button"
                :aria-label="$t('repo.commit.clearSelection')"
                :title="tooltipsEnabled ? undefined : $t('repo.commit.clearSelection')"
                class="flex size-6 items-center justify-center rounded bg-destructive/10 text-destructive/85 outline-none transition-colors hover:bg-destructive/20 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40"
                @click="treeSelection.clear()"
              >
                <ListX :size="13" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {{ $t("repo.changes.clearSelectionCount", { n: treeSelection.count.value }) }}
            </TooltipContent>
          </Tooltip>
          <!-- greps inside the changed files (fires at ≥ min chars); highlighted while on,
               spinner while a search is in flight. Tooltip replaces the old text label. -->
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                type="button"
                role="checkbox"
                :aria-checked="contentMode"
                :aria-label="$t('repo.changes.searchContent')"
                :title="tooltipsEnabled ? undefined : $t('repo.changes.searchContent')"
                class="flex size-6 items-center justify-center rounded outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
                :class="contentMode ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
                @click="contentMode = !contentMode"
              >
                <Loader2 v-if="contentLoading" :size="13" class="animate-spin" />
                <FileSearch v-else :size="13" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ $t("repo.changes.searchContent") }}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <!-- tree ⇄ list view toggle (per-repo, persisted). Shows the icon of the mode you'd switch TO. -->
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            role="switch"
            :aria-checked="isList"
            class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            :aria-label="isList ? $t('repo.changes.viewAsTree') : $t('repo.changes.viewAsList')"
            :title="tooltipsEnabled ? undefined : (isList ? $t('repo.changes.viewAsTree') : $t('repo.changes.viewAsList'))"
            @click="toggleDisplayMode"
          >
            <component :is="isList ? ListTree : List" :size="14" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ isList ? $t("repo.changes.viewAsTree") : $t("repo.changes.viewAsList") }}</TooltipContent>
      </Tooltip>
      <!-- Collapse-all is ALWAYS rendered, just disabled when it can't do anything (list view has
           no folders; a search force-expands the tree; a flat repo has no folders to collapse).
           It used to be v-if'd away, which changed the toolbar's button count and shifted the
           other controls around under the pointer. -->
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
            :class="
              collapseAllDisabled
                ? 'cursor-default opacity-40'
                : 'hover:bg-accent hover:text-foreground'
            "
            :aria-disabled="collapseAllDisabled"
            :aria-label="allCollapsed ? $t('repo.changes.expandAll') : $t('repo.changes.collapseAll')"
            :title="tooltipsEnabled ? undefined : (allCollapsed ? $t('repo.changes.expandAll') : $t('repo.changes.collapseAll'))"
            @click="toggleCollapseAll"
          >
            <component :is="allCollapsed ? ChevronsUpDown : ChevronsDownUp" :size="14" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {{
            collapseAllDisabled
              ? $t("repo.changes.collapseAllUnavailable")
              : allCollapsed
                ? $t("repo.changes.expandAll")
                : $t("repo.changes.collapseAll")
          }}
        </TooltipContent>
      </Tooltip>
      <!-- How this list looks, in the list's own toolbar. Moved out of Settings → Appearance for
           the same reason as History's: a display choice about the changed files is undiscoverable
           from anywhere but here. The tree ⇄ list button above stays a first-class control (it is
           the one people reach for constantly) rather than being folded in here. -->
      <ViewOptions
        :label="$t('repo.changes.viewOptions')"
        :tooltips="tooltipsEnabled"
        :rows="viewOptionRows"
        @change="onViewOption"
      />
    </div>
    <div
      ref="treeScroll"
      class="changes-tree-viewport scroll-slim overflow-y-auto"
      :class="dragHeight != null && 'changes-tree-viewport--dragging'"
      :style="treeStyle"
    >
      <!-- The measured inner wrapper lets automatic mode follow rows added or removed. Its 10px
           bottom padding also keeps the resize bar from reading like it hides one more item. -->
      <div ref="treeContent" class="changes-tree-content px-1 pt-0.5 pb-2.5">
      <!-- Spinner only before the FIRST load: changesLoading also flips on every background
           refresh, and swapping the whole (possibly huge) tree for a spinner and back would
           unmount/remount thousands of rows on each refresh. Once data exists, the old tree
           stays up and patches in place when the new list lands. -->
      <div
        v-if="store.changesLoading[repo.id] && !store.changesByRepo[repo.id]"
        class="flex items-center gap-2 px-2.5 py-2 text-[12.5px] text-muted-foreground"
      >
        <Loader2 :size="14" class="animate-spin" /> {{ $t("repo.changes.loading") }}
      </div>
      <div
        v-else-if="searching && !filteredTree.length && !contentLoading"
        class="px-2.5 py-2 text-[12px] text-muted-foreground"
      >
        {{ $t("repo.changes.searchNoMatch") }}
      </div>
      <ChangesTree
        v-else
        :nodes="isList ? flatFiles : filteredTree"
        :repo-id="repo.id"
        :flat="isList"
        :force-expand="searching && !isList"
        :can-control="store.canControl"
        :is-guest="store.isGuest"
        :show-stats="store.diffStatsEnabled"
        :show-chars="store.changesCharsEnabled"
        :stat-display="store.changesStatDisplay"
        :max-churn="maxChurn"
        @discard="askDiscard"
        @stage="onStage"
        @reveal="onReveal"
        @move="onMove"
        @editor="onEditor"
        @gitignore="onGitignore"
        @copy-path="onCopyPath"
        @delete-file="askDelete"
        @delete-folder="askDeleteFolder"
      />
      <!-- Server capped an oversized changed-file list (MAX_CHANGED_FILES) — say so, and offer
           the way through. A repo-wide codemod really does dirty 13,000 files, and a notice with
           no escape reads as "the rest is unreachable". The button re-reads with the cap lifted
           and then stays lifted for this repo, so the refresh after a commit does not snap the
           list back to the first 2000. -->
      <div
        v-if="store.changesMeta[repo.id]?.truncated"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-[11.5px] text-warning/80"
      >
        <span>
          {{
            $t("repo.changes.truncated", {
              shown: store.changesByRepo[repo.id]?.length ?? 0,
              total: store.changesMeta[repo.id]?.total,
            })
          }}
        </span>
        <button
          v-if="!store.changesShowAll[repo.id]"
          type="button"
          class="underline underline-offset-2 hover:text-warning focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-warning/60 rounded-sm"
          :disabled="store.changesLoading[repo.id]"
          :title="$t('repo.changes.truncatedViewAllHint', { total: store.changesMeta[repo.id]?.total })"
          @click="store.loadChanges(repo.id, { all: true })"
        >
          {{
            store.changesLoading[repo.id]
              ? $t("repo.changes.truncatedLoadingAll", { total: store.changesMeta[repo.id]?.total })
              : $t("repo.changes.truncatedViewAll")
          }}
        </button>
      </div>
      </div>
    </div>
    <!-- resize grip: drag (or ↑/↓) to set an explicit height; double-click / Delete to reset -->
    <button
      type="button"
      :aria-label="resized ? $t('repo.changes.gripAriaResized') : $t('repo.changes.gripAria')"
      :title="resized ? $t('repo.changes.gripTitleResized') : $t('repo.changes.gripTitle')"
      class="group/grip flex h-5 w-full cursor-ns-resize touch-none items-center justify-center border-t border-border/40 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/40"
      @pointerdown="onGripDown"
      @dblclick="resetTreeHeight"
      @keydown.up.prevent="gripKey(() => nudgeHeight(-24))"
      @keydown.down.prevent="gripKey(() => nudgeHeight(24))"
      @keydown.delete.prevent="gripKey(resetTreeHeight)"
      @keydown.backspace.prevent="gripKey(resetTreeHeight)"
    >
      <GripHorizontal
        :size="14"
        :class="
          cn(
            'text-muted-foreground/40 transition-colors group-hover/grip:text-muted-foreground',
            resized && 'text-primary/50',
          )
        "
      />
    </button>
  </div>
  </ExpandTransition>

  <!-- empty state: a clean working tree used to just collapse to nothing (felt broken/empty). Show
       a small "No changes" line instead. Complementary condition to the tree above, so exactly one
       shows; hidden while status is unknown or in an error state. -->
  <ExpandTransition :open="!!(st && !st.error && st.dirty === 0 && !isBrowsing)">
    <div
      class="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-2 text-[12.5px] text-muted-foreground"
    >
      <Check :size="14" class="shrink-0 text-success/80" />
      <span>{{ $t("repo.changes.clean") }}</span>
    </div>
  </ExpandTransition>

  <!-- confirm before discarding a file's working-tree changes (destructive) -->
  <Dialog v-model:open="discardOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.discard.title") }}</DialogTitle>
        <DialogDescription>{{ $t("repo.discard.body", { file: discardTarget ?? "" }) }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button variant="secondary" @click="discardOpen = false">{{ $t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDiscard">{{ $t("repo.discard.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- confirm before deleting a file from disk (destructive, and unlike discard there is no
       committed copy to fall back on for an untracked file) -->
  <Dialog v-model:open="deleteOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.deleteFile.title") }}</DialogTitle>
        <DialogDescription>{{ $t("repo.deleteFile.body", { file: deleteTarget ?? "" }) }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button variant="secondary" @click="deleteOpen = false">{{ $t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDelete">{{ $t("repo.deleteFile.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- confirm before deleting a FOLDER and everything under it. Says how many changed files it
       holds, because a collapsed folder gives no clue how much is about to go. -->
  <Dialog v-model:open="deleteFolderOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.deleteFile.titleFolder") }}</DialogTitle>
        <DialogDescription>
          {{
            $t(
              "repo.deleteFile.bodyFolder",
              { folder: deleteFolderTarget ?? "", count: deleteFolderCount },
              deleteFolderCount,
            )
          }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button variant="secondary" @click="deleteFolderOpen = false">{{ $t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDeleteFolder">{{ $t("repo.deleteFile.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* Quick ease-out: enough motion to make file-driven height changes legible without a soft,
   floaty finish. Pointer dragging stays 1:1 with the hand, and accessibility wins outright. */
.changes-tree-viewport {
  transition: height 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.changes-tree-viewport--dragging {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .changes-tree-viewport {
    transition: none;
  }
}
</style>
