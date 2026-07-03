<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import {
  GitBranch,
  ArrowUp,
  ArrowDown,
  Pencil,
  DownloadCloud,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  Cloud,
  CloudOff,
  AlertTriangle,
  Check,
  GitCommitHorizontal,
  Sparkles,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  GripVertical,
  GripHorizontal,
  User,
  AtSign,
  Loader2,
  MoreVertical,
  EyeOff,
  Eye,
  Pin,
  PinOff,
  Star,
  StarOff,
  Search,
  X,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { api, ApiError } from "../api";
import { fromNow, buildChangeTree } from "@/lib/util";
import { provideTreeCollapse } from "@/lib/changes-tree";
import { provideTreeSelection } from "@/lib/changes-selection";
import { cn } from "@/lib/utils";
import { useRepoFeedback } from "@/lib/repo-feedback";
import {
  changesTreeStyle,
  setChangesOverride,
  clearChangesOverride,
  hasChangesOverride,
  MIN_CHANGES_PX,
  MAX_CHANGES_PX,
} from "@/lib/changes-view";
import { identityInitials, identityTint } from "@/lib/identity-display";
import { shortcutsActive } from "@/lib/hotkeys";
import ChangesTree from "./ChangesTree.vue";
import BranchPanel from "./BranchPanel.vue";
import StashPanel from "./StashPanel.vue";
import LogPanel from "./LogPanel.vue";
import RepoManage from "./RepoManage.vue";
import SmartCommitPlan from "./SmartCommitPlan.vue";
import DiffStat from "./DiffStat.vue";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { VCS_CAPABILITIES } from "../types";
import type { Repo, TreeNode } from "../types";

const props = withDefaults(defineProps<{ repo: Repo; draggable?: boolean }>(), {
  draggable: true,
});
const store = useStore();
const { t } = useI18n();

const st = computed(() => props.repo.status);
const hasRemote = computed(() => !!st.value?.remote);
// Per-VCS capabilities (mirrors the daemon) drive which controls this card shows.
const caps = computed(() => VCS_CAPABILITIES[props.repo.vcs] ?? VCS_CAPABILITIES.git);
const isLore = computed(() => props.repo.vcs === "lore");
// Lore is centralized — it always has a server to push/sync to — so its remote ops don't
// hinge on a configured git remote the way git's do.
const hasUpstream = computed(() => isLore.value || hasRemote.value);
// "Pull" for git; "Sync" for a centralized backend (Lore), where pull maps to `lore sync`.
const pullLabel = computed(() => (caps.value.fetch ? t("repo.actions.pull") : t("repo.actions.sync")));
// AI commit message + smart-commit are now VCS-agnostic (the daemon's VcsBackend collects the
// diff / stages groups via `lore diff` / `lore stage`+`lore commit` for Lore), so they're shown
// whenever AI is enabled, on git and Lore alike.
const aiHere = computed(() => store.aiEnabled);
const busyAction = computed(() => store.busy[props.repo.id]);
const anyBusy = computed(() => !!busyAction.value);
const isClean = computed(
  () =>
    st.value &&
    !st.value.error &&
    st.value.ahead === 0 &&
    st.value.behind === 0 &&
    st.value.dirty === 0,
);

// ── status-pill morph ─────────────────────────────────────────────────────────
// The collapsed header and the expanded view share ONE set of status indicators
// instead of swapping two markups (which snaps). Collapsed they read as bare
// coloured "icon + count" text; expanded they fill into pills with a trailing word
// ("ahead" / "changed" / "clean"). Background, padding, and the word reveal all
// animate off `expanded`, so toggling grows the pill in/out smoothly.
type StatusTone = "success" | "info" | "warning" | "muted";
const STATUS_BG: Record<StatusTone, string> = {
  success: "bg-success/15",
  info: "bg-info/15",
  warning: "bg-warning/15",
  muted: "bg-secondary",
};
const STATUS_TEXT: Record<StatusTone, string> = {
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  muted: "text-muted-foreground",
};
function statusChip(tone: StatusTone): string {
  return cn(
    "inline-flex items-center rounded-md transition-all duration-200 ease-out",
    STATUS_TEXT[tone],
    expanded.value ? `${STATUS_BG[tone]} px-1.5 py-0.5` : "bg-transparent px-0 py-0",
  );
}
// Trailing word: width-0 + transparent when collapsed (and on mobile, where the pill
// stays count-only); on ≥sm screens it slides + fades in once expanded. max-width
// (not a grid 1fr track) keeps the reveal animatable on every browser we target.
const statusWord = computed(() =>
  cn(
    "overflow-hidden whitespace-nowrap opacity-0 max-w-0 transition-[max-width,opacity] duration-200 ease-out",
    expanded.value && "sm:max-w-[7rem] sm:opacity-100",
  ),
);

// ── identity (avatar dropdown) ────────────────────────────────────────────────
const identity = computed(() =>
  props.repo.identityId ? (store.identityById[props.repo.identityId] ?? null) : null,
);
function onIdentity(id: string | null): void {
  void store.assignIdentity(props.repo.id, id);
}

// ── sync account (which GitHub account this repo fetches/pulls/pushes as) ──────
function onAccount(a: { host: string; login: string } | null): void {
  void store.assignRepoAccount(props.repo.id, a?.host ?? null, a?.login ?? null);
}

// ── collapse + changed-files tree ─────────────────────────────────────────────
const expanded = ref(false);
const changeTree = computed(() => buildChangeTree(store.changesByRepo[props.repo.id] ?? []));

// Per-folder collapse state, shared with the recursive ChangesTree via provide/inject
// (persisted per repo — see @/lib/changes-tree).
const treeCollapse = provideTreeCollapse(props.repo.id);

// Per-file selection (the checkboxes in ChangesTree) → drives the "Commit selected (N)" bar.
// Shared with the recursive tree via provide/inject, persisted per repo (see @/lib/changes-selection).
const treeSelection = provideTreeSelection(props.repo.id);
const selectedCount = treeSelection.count; // a ComputedRef → auto-unwraps in template
// Keep the selection honest: once the changed-file list loads/updates, drop any selected path that's
// no longer pending (just committed, discarded, or vanished) so a stale path can't reach the backend
// (which would reject it as PLAN_STALE). Skip while the list is still unloaded (undefined).
watch(
  () => store.changesByRepo[props.repo.id],
  (files) => {
    if (files) treeSelection.prune(files.map((f) => f.path));
  },
);
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
function toggleCollapseAll(): void {
  if (allCollapsed.value) treeCollapse.expandAll();
  else treeCollapse.collapseAll(dirPaths.value);
}

// ── changed-files search ──────────────────────────────────────────────────────
// Filename filtering is instant + local. The "Search content" toggle additionally greps
// inside the changed files via the daemon — debounced, cancellable, and only at ≥3 chars.
const treeQuery = ref("");
const searching = computed(() => treeQuery.value.trim().length > 0);

const contentMode = ref(false);
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

function toggle(): void {
  expanded.value = !expanded.value;
  if (expanded.value) {
    if ((st.value?.dirty ?? 0) > 0) {
      void store.loadChanges(props.repo.id);
      void loadRecentMsgs();
    }
    void store.loadBranches(props.repo.id);
    if (caps.value.stash) void store.loadStashes(props.repo.id);
  }
}
watch(
  () => st.value?.dirty,
  () => {
    if (expanded.value && (st.value?.dirty ?? 0) > 0) {
      void store.loadChanges(props.repo.id);
      if (!recentMsgs.value.length) void loadRecentMsgs();
    }
  },
);

// ── drag-to-resize the changed-files tree ─────────────────────────────────────
// The grip below the tree pins an explicit height (persisted per repo); double-click
// it (or press Delete) to fall back to the global Settings preset. See @/lib/changes-view.
const treeScroll = ref<HTMLElement | null>(null);
// Live px while a drag is in flight; persisted once on release so we don't thrash
// localStorage (the deep useLocalStorage watcher serialises on every mutation).
const dragHeight = ref<number | null>(null);
const treeStyle = computed(() =>
  dragHeight.value != null ? { height: `${dragHeight.value}px` } : changesTreeStyle(props.repo.id),
);
const resized = computed(() => hasChangesOverride(props.repo.id));
const clampPx = (px: number): number =>
  Math.min(MAX_CHANGES_PX, Math.max(MIN_CHANGES_PX, Math.round(px)));
let dragStartY = 0;
let dragStartH = 0;

function onGripMove(e: PointerEvent): void {
  dragHeight.value = clampPx(dragStartH + (e.clientY - dragStartY));
}
function onGripUp(): void {
  window.removeEventListener("pointermove", onGripMove);
  window.removeEventListener("pointerup", onGripUp);
  if (dragHeight.value != null) {
    setChangesOverride(props.repo.id, dragHeight.value); // commit the final height
    dragHeight.value = null;
  }
}
function onGripDown(e: PointerEvent): void {
  if (!treeScroll.value) return;
  dragStartY = e.clientY;
  dragStartH = treeScroll.value.clientHeight;
  // Capture so the drag keeps tracking even if the pointer leaves the viewport.
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", onGripMove);
  window.addEventListener("pointerup", onGripUp);
  e.preventDefault();
}
function resetTreeHeight(): void {
  dragHeight.value = null;
  clearChangesOverride(props.repo.id);
}
// Keyboard: ↑/↓ nudge the height in 24px steps from the current rendered size.
function nudgeHeight(delta: number): void {
  const base = treeScroll.value?.clientHeight;
  if (base) setChangesOverride(props.repo.id, base + delta);
}
onBeforeUnmount(onGripUp);

// Error-code → friendly-sentence translation + the "toast this git result" helper, shared with
// the BranchPanel / StashPanel / LogPanel children (see @/lib/repo-feedback).
const { friendly, toastResult } = useRepoFeedback();

async function run(name: "fetch" | "pull" | "push" | "refresh"): Promise<void> {
  const r = await store.doAction(props.repo.id, name);
  if (r.ok) {
    if (name !== "refresh") toast.success(r.message || t("repo.actions.done", { action: name }));
  } else {
    toast.error(friendly(r.code) || r.message || t("repo.actions.failed", { action: name }));
  }
}

// ── commit (stage-all + commit, optional AI draft) ────────────────────────────
// The split button commits in one of four modes; `committing` spans the whole flow
// (commit + any follow-on pull/push) so the button stays busy throughout, not just
// for the commit leg.
type CommitMode = "commit" | "amend" | "push" | "sync";
const commitMsg = ref("");
const generating = ref(false);
const committing = ref(false);
// Smart-commit (AI multi-commit splitter) — opt-in plan editor in a modal, or YOLO mode
// (Settings) which generates the plan and commits it immediately with no review.
const smartOpen = ref(false);
const smartBusy = ref(false);
function onSmartCommitted(): void {
  void loadRecentMsgs(); // the last few subjects changed
}
/** The Smart Commit button: open the review editor, or run YOLO if the owner enabled it. */
function runSmart(): void {
  if (store.aiSettings.yolo) void runYolo();
  else smartOpen.value = true;
}
/** Compose a group's final commit message ("type(scope): subject" + optional body). */
function planLine(g: { type: string; scope?: string; subject: string; body?: string }): string {
  const subject = `${g.type}${g.scope ? `(${g.scope})` : ""}: ${g.subject}`;
  return g.body && g.body.trim() ? `${subject}\n\n${g.body.trim()}` : subject;
}
/** YOLO: plan + commit in one shot, no review. Leftovers (if any) become a final chore commit
 *  so nothing is left behind. Never auto-pushes — committing locally is safe/undoable. */
async function runYolo(): Promise<void> {
  if (smartBusy.value) return;
  smartBusy.value = true;
  try {
    const res = await store.genCommitPlan(props.repo.id);
    const commits = res.plan.groups.map((g) => ({ message: planLine(g), paths: [...g.files] }));
    if (res.plan.leftovers.length) commits.push({ message: "chore: miscellaneous changes", paths: [...res.plan.leftovers] });
    if (!commits.length) {
      toast.error(t("repo.smartCommit.failed"));
      return;
    }
    const r = await store.smartCommit(props.repo.id, commits, false);
    if (!r.ok) {
      toast.error(t("repo.smartCommit.execFailed", { message: r.message }));
      return;
    }
    void loadRecentMsgs();
    toast.success(t("repo.smartCommit.done"));
  } catch (e) {
    toast.error(e instanceof ApiError ? friendly(e.code) || e.message : t("repo.smartCommit.failed"));
  } finally {
    smartBusy.value = false;
  }
}

// Recent commit subjects as one-tap fill suggestions (typing on a phone is the bottleneck).
// Loaded lazily and kept separate from the History log so the two never clobber each other.
const recentMsgs = ref<string[]>([]);
async function loadRecentMsgs(): Promise<void> {
  try {
    const r = await api.log(props.repo.id, 5, 0);
    recentMsgs.value = r.commits.map((cm) => cm.subject).filter((s) => s.length > 0);
  } catch {
    /* non-critical — chips just won't show */
  }
}

async function generate(): Promise<void> {
  generating.value = true;
  try {
    commitMsg.value = await store.genCommitMessage(props.repo.id);
  } catch (e) {
    const msg = e instanceof ApiError ? (friendly(e.code) || e.message) : t("repo.commit.generateFailed");
    toast.error(msg);
  } finally {
    generating.value = false;
  }
}

async function doCommit(mode: CommitMode = "commit"): Promise<void> {
  const msg = commitMsg.value.trim();
  if (!msg || committing.value) return;
  committing.value = true;
  try {
    const r = await store.commit(props.repo.id, msg, mode === "amend");
    if (!r.ok) {
      toast.error(friendly(r.code) || r.message || t("repo.commit.failed"));
      return;
    }
    commitMsg.value = "";
    // Commit & Sync fast-forward-pulls before pushing so a diverged remote surfaces
    // as NON_FAST_FORWARD instead of a failed push.
    if (mode === "sync") {
      const pull = await store.doAction(props.repo.id, "pull");
      if (!pull.ok) {
        toast.error(friendly(pull.code) || pull.message || t("repo.actions.failed", { action: "pull" }));
        return;
      }
    }
    if (mode === "push" || mode === "sync") {
      const push = await store.doAction(props.repo.id, "push");
      if (!push.ok) {
        toast.error(friendly(push.code) || push.message || t("repo.actions.failed", { action: "push" }));
        return;
      }
    }
    // Static t() calls (not a computed key) so the i18n parity check sees them used.
    toast.success(
      {
        commit: t("repo.commit.success"),
        amend: t("repo.commit.amended"),
        push: t("repo.commit.pushed"),
        sync: t("repo.commit.synced"),
      }[mode],
    );
    void loadRecentMsgs(); // the commit history changed — refresh the one-tap "recent" chips (matches doCommitSelected / smart-commit)
  } finally {
    committing.value = false;
  }
}

// Per-file staging: commit ONLY the checked files (the rest stay pending). Shares the same message
// box as the normal commit; the store reloads the changed-file list afterward, and the prune watch
// above drops the just-committed paths from the selection. A stale path comes back as PLAN_STALE.
async function doCommitSelected(): Promise<void> {
  const msg = commitMsg.value.trim();
  const paths = [...treeSelection.selected];
  if (!msg || !paths.length || committing.value) return;
  committing.value = true;
  try {
    const r = await store.commitSelected(props.repo.id, msg, paths);
    if (!r.ok) {
      toast.error(friendly(r.code) || r.message || t("repo.commit.failed"));
      return;
    }
    commitMsg.value = "";
    treeSelection.clear();
    void loadRecentMsgs();
    toast.success(t("repo.commit.selectedSuccess", { n: paths.length }));
  } finally {
    committing.value = false;
  }
}

// Power-user shortcut: Ctrl/⌘+Enter commits from the message box (plain Enter is a
// newline). Gated by Settings → Keyboard shortcuts (master + power-user toggles).
function onCommitKey(e: KeyboardEvent): void {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && shortcutsActive(true)) {
    e.preventDefault();
    void doCommit("commit");
  }
}

// The changed-files grip's keyboard resize (↑/↓/Del) only fires when shortcuts are on.
function gripKey(action: () => void): void {
  if (shortcutsActive()) action();
}

// A success toast carrying an "Undo" action that calls `revert` (re-applies the previous value).
// Used by the hide/pin/star toggles so a mis-tap is one tap to reverse.
function undoableToast(message: string, revert: () => Promise<unknown>): void {
  toast.success(message, {
    action: {
      label: t("repo.undo"),
      onClick: () => {
        void revert();
      },
    },
  });
}

// ── hide / unhide from the dashboard ──────────────────────────────────────────
async function toggleHidden(): Promise<void> {
  const next = !props.repo.hidden;
  try {
    await store.setHidden(props.repo.id, next);
    undoableToast(next ? t("repo.toastHidden") : t("repo.toastShown"), () => store.setHidden(props.repo.id, !next));
  } catch {
    toast.error(t("repo.toastHideFailed"));
  }
}

// ── pin / star into the Pinned / Starred sections ─────────────────────────────
async function togglePinned(): Promise<void> {
  const next = !props.repo.pinned;
  try {
    await store.setPinned(props.repo.id, next);
    undoableToast(next ? t("repo.toastPinned") : t("repo.toastUnpinned"), () => store.setPinned(props.repo.id, !next));
  } catch {
    toast.error(t("repo.toastFavFailed"));
  }
}
async function toggleStarred(): Promise<void> {
  const next = !props.repo.starred;
  try {
    await store.setStarred(props.repo.id, next);
    undoableToast(next ? t("repo.toastStarred") : t("repo.toastUnstarred"), () => store.setStarred(props.repo.id, !next));
  } catch {
    toast.error(t("repo.toastFavFailed"));
  }
}

// ── branches → BranchPanel.vue · commit history → LogPanel.vue · stash → StashPanel.vue ──
// All self-contained children keyed by repoId; RepoCard still triggers loadBranches/loadStashes
// on expand (see toggle()) and the panels read the result from the store reactively.

// ── remote & tags management (self-contained dialog) ─────────────────────────
const manageOpen = ref(false);

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
</script>

<template>
  <Collapsible
    :open="expanded"
    :class="
      cn(
        'overflow-hidden rounded-md border border-border bg-card transition-colors',
        expanded && 'border-border/80 bg-card/90 ring-1 ring-white/5',
        repo.hidden && 'opacity-60',
      )
    "
  >
    <!-- ── collapsed header row — the whole row toggles + highlights on hover ── -->
    <div
      role="button"
      tabindex="0"
      :aria-expanded="expanded"
      :aria-label="expanded ? $t('repo.collapse') : $t('repo.expand')"
      class="flex cursor-pointer items-center gap-1.5 rounded-md p-2 outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40 sm:gap-2 sm:p-2.5"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <!-- drag handle (hidden in filtered view, where reordering is disabled) -->
      <button
        v-if="draggable"
        class="drag-handle flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/60 outline-none transition-colors hover:bg-accent hover:text-muted-foreground active:bg-accent/70 active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring/40"
        :aria-label="$t('repo.dragToReorder')"
        @click.stop
      >
        <GripVertical :size="16" />
      </button>

      <!-- name + branch -->
      <div class="flex min-w-0 flex-1 items-center gap-2 px-0.5">
        <span class="truncate text-[15px] leading-tight font-semibold text-foreground">
          {{ repo.name }}
        </span>
        <span
          v-if="st?.branch"
          :class="
            cn(
              'mono hidden shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] sm:inline-flex',
              st.detached ? 'bg-warning/15 text-warning' : 'bg-secondary text-muted-foreground',
            )
          "
        >
          <GitBranch :size="11" />{{ st.detached ? "detached" : st.branch }}
        </span>
        <span
          v-if="repo.vcs !== 'git'"
          class="mono flex shrink-0 items-center rounded-md bg-info/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-info uppercase"
        >
          {{ repo.vcs }}
        </span>
        <span
          v-if="repo.pinned"
          class="flex shrink-0 items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-primary"
          :title="$t('repo.badge.pinned')"
          :aria-label="$t('repo.badge.pinned')"
        >
          <Pin :size="11" />
        </span>
        <span
          v-if="repo.starred"
          class="flex shrink-0 items-center rounded-md bg-amber-400/15 px-1.5 py-0.5 text-amber-400"
          :title="$t('repo.badge.starred')"
          :aria-label="$t('repo.badge.starred')"
        >
          <Star :size="11" class="fill-current" />
        </span>
        <span
          v-if="repo.hidden"
          class="flex shrink-0 items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground"
          :title="$t('repo.badge.hidden')"
          :aria-label="$t('repo.badge.hidden')"
        >
          <EyeOff :size="11" />
        </span>
      </div>

      <!-- status indicators — ONE set that morphs between bare "icon + count" text
           (collapsed) and filled pills with a trailing word (expanded); see statusChip
           / statusWord. Order mirrors the pull→push flow: behind, ahead, dirty, clean. -->
      <div class="flex shrink-0 items-center gap-1.5 text-[12px] font-medium">
        <!-- aggregate line delta (left of ahead/changed); chars + breakdown on hover.
             Shown only when the diff-stats setting is on and the tree is dirty. -->
        <Tooltip v-if="store.diffStatsEnabled && st?.diff && st.dirty > 0">
          <TooltipTrigger as-child>
            <span class="inline-flex items-center"><DiffStat :stat="st?.diff" show="lines" /></span>
          </TooltipTrigger>
          <TooltipContent>
            {{ $t("repo.diffStat.lines", { added: st?.diff?.addedLines ?? 0, removed: st?.diff?.removedLines ?? 0 }) }}
            ·
            {{ $t("repo.diffStat.chars", { added: (st?.diff?.addedChars ?? 0).toLocaleString(), removed: (st?.diff?.removedChars ?? 0).toLocaleString() }) }}
          </TooltipContent>
        </Tooltip>
        <Tooltip v-if="st && st.behind > 0">
          <TooltipTrigger as-child>
            <span :class="statusChip('warning')" :aria-label="$t('repo.badge.behindLabel', { count: st.behind })">
              <ArrowDown :size="12" /><span class="ml-0.5">{{ st.behind }}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {{ $t("repo.badge.behindTooltip", { count: st.behind }) }}{{ st.fetchedAt ? ` · ${fromNow(st.fetchedAt)}` : "" }}
          </TooltipContent>
        </Tooltip>
        <span
          v-if="st && st.ahead > 0"
          :class="statusChip('success')"
          :title="$t('repo.badge.aheadLabel', { count: st.ahead })"
          :aria-label="$t('repo.badge.aheadLabel', { count: st.ahead })"
        >
          <ArrowUp :size="12" /><span class="ml-0.5">{{ st.ahead }}</span
          ><span :class="statusWord">&nbsp;{{ $t("repo.badge.ahead") }}</span>
        </span>
        <span
          v-if="st && st.dirty > 0"
          :class="statusChip('warning')"
          :title="$t('repo.badge.changedLabel', { count: st.dirty })"
          :aria-label="$t('repo.badge.changedLabel', { count: st.dirty })"
        >
          <Pencil :size="12" /><span class="ml-0.5">{{ st.dirty }}</span
          ><span :class="statusWord">&nbsp;{{ $t("repo.badge.changed") }}</span>
        </span>
        <span v-if="isClean" :class="statusChip('muted')" :title="$t('repo.badge.clean')" :aria-label="$t('repo.badge.clean')">
          <Check :size="12" /><span :class="statusWord">&nbsp;{{ $t("repo.badge.clean") }}</span>
        </span>
        <AlertTriangle v-if="st?.error" :size="14" class="text-destructive" />
      </div>

      <!-- identity avatar → dropdown picker (stops row toggle; no Tooltip wrapper —
           stacking two as-child triggers on one element breaks reka's popper anchor) -->
      <DropdownMenu>
        <DropdownMenuTrigger
          :title="identity ? `${identity.displayName} · ${identity.gitEmail}` : $t('repo.identity.setTitle')"
          :class="
            cn(
              'flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold outline-none transition hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/50',
              identity ? identityTint(identity.id) : 'bg-secondary text-muted-foreground hover:bg-accent',
            )
          "
          :aria-label="$t('repo.identity.setTitle')"
          @click.stop
        >
          <span v-if="identity">{{ identityInitials(identity.displayName) }}</span>
          <User v-else :size="15" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-64">
          <DropdownMenuLabel>{{ $t("repo.identity.dropdownLabel") }}</DropdownMenuLabel>
          <DropdownMenuItem class="text-muted-foreground" @select="onIdentity(null)">
            <User :size="15" />
            <span>{{ $t("repo.identity.noIdentity") }}</span>
            <Check v-if="!repo.identityId" :size="15" class="ml-auto text-primary" />
          </DropdownMenuItem>
          <template v-if="store.identities.length">
            <DropdownMenuSeparator />
            <DropdownMenuItem
              v-for="i in store.identities"
              :key="i.id"
              @select="onIdentity(i.id)"
            >
              <span
                :class="
                  cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                    identityTint(i.id),
                  )
                "
                >{{ identityInitials(i.displayName) }}</span
              >
              <div class="min-w-0 flex-1">
                <div class="truncate text-[13px]">{{ i.displayName }}</div>
                <div class="mono truncate text-[11px] text-muted-foreground">{{ i.gitEmail }}</div>
              </div>
              <Check v-if="repo.identityId === i.id" :size="15" class="ml-1 shrink-0 text-primary" />
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- expand chevron (keyboard/AT toggle; .stop so the row handler doesn't double-fire) -->
      <button
        class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-all hover:bg-accent hover:text-foreground active:scale-90 active:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/40"
        :aria-label="expanded ? $t('repo.collapse') : $t('repo.expand')"
        :aria-expanded="expanded"
        @click.stop="toggle"
      >
        <ChevronDown :size="17" :class="cn('transition-transform duration-200', expanded && 'rotate-180')" />
      </button>
    </div>

    <!-- ── expanded body ───────────────────────────────────────────────────── -->
    <CollapsibleContent>
      <div class="flex flex-col gap-3 border-t border-border/60 px-3 pt-3 pb-3.5">
        <!-- path (location) + remote-presence cloud, kept on one line -->
        <div class="flex items-center gap-2">
          <div
            class="mono min-w-0 flex-1 truncate text-left text-[11.5px] text-muted-foreground"
            dir="rtl"
            :title="repo.absPath"
          >
            {{ repo.absPath }}
          </div>
          <Tooltip>
            <TooltipTrigger as-child>
              <span :class="cn('inline-flex shrink-0', hasRemote ? 'text-info/80' : 'text-muted-foreground/50')">
                <Cloud v-if="hasRemote" :size="16" />
                <CloudOff v-else :size="16" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{{ hasRemote ? st?.remote : $t("repo.badge.noRemote") }}</TooltipContent>
          </Tooltip>
        </div>

        <!-- sync account: the GitHub account this repo fetches/pulls/pushes as (auto-switched on sync) -->
        <div v-if="store.ghAccounts.length" class="flex items-center gap-2">
          <AtSign :size="14" class="shrink-0 text-muted-foreground" />
          <span class="shrink-0 text-[11.5px] text-muted-foreground">{{ $t("repo.syncAccount.label") }}</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              class="flex min-w-0 items-center gap-1 rounded-md border border-border/60 bg-secondary/40 px-2 py-1 text-[12px] outline-none transition hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
              @click.stop
            >
              <span class="truncate">{{ repo.syncAccountLogin || $t("repo.syncAccount.machineDefault") }}</span>
              <ChevronDown :size="13" class="shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-60">
              <DropdownMenuLabel>{{ $t("repo.syncAccount.dropdownLabel") }}</DropdownMenuLabel>
              <DropdownMenuItem class="text-muted-foreground" @select="onAccount(null)">
                <span class="flex-1">{{ $t("repo.syncAccount.machineDefault") }}</span>
                <Check v-if="!repo.syncAccountLogin" :size="15" class="text-primary" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                v-for="a in store.ghAccounts"
                :key="`${a.host}/${a.login}`"
                @select="onAccount(a)"
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate text-[13px]">{{ a.login }}</div>
                  <div class="mono truncate text-[11px] text-muted-foreground">{{ a.host }}</div>
                </div>
                <Check
                  v-if="repo.syncAccountLogin === a.login && (repo.syncAccountHost || 'github.com') === a.host"
                  :size="15"
                  class="ml-1 shrink-0 text-primary"
                />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <!-- branch switcher + inline create form — see BranchPanel.vue -->
        <BranchPanel
          v-if="!st?.error"
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

        <!-- changed-files tree (height from Settings preset; drag the grip to resize) -->
        <div
          v-if="st && st.dirty > 0"
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
                class="h-6 w-full rounded bg-transparent pr-6 pl-7 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:bg-accent/30 focus-visible:ring-1 focus-visible:ring-ring/40"
              />
              <Loader2
                v-if="contentLoading"
                :size="13"
                class="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 animate-spin text-muted-foreground"
              />
              <button
                v-else-if="treeQuery"
                type="button"
                :aria-label="$t('repo.changes.searchClear')"
                :title="$t('repo.changes.searchClear')"
                class="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                @click="treeQuery = ''"
              >
                <X :size="12" />
              </button>
            </div>
            <!-- search-content toggle: greps inside the changed files (fires at ≥3 chars) -->
            <button
              type="button"
              role="checkbox"
              :aria-checked="contentMode"
              :title="$t('repo.changes.searchContent')"
              class="flex h-6 shrink-0 items-center gap-1.5 rounded px-1.5 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
              :class="contentMode ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
              @click="contentMode = !contentMode"
            >
              <span
                class="flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors"
                :class="contentMode ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"
              >
                <Check v-if="contentMode" :size="11" />
              </span>
              <span class="whitespace-nowrap">{{ $t("repo.changes.searchContent") }}</span>
            </button>
            <button
              v-if="dirPaths.length && !searching"
              type="button"
              class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              :aria-label="allCollapsed ? $t('repo.changes.expandAll') : $t('repo.changes.collapseAll')"
              :title="allCollapsed ? $t('repo.changes.expandAll') : $t('repo.changes.collapseAll')"
              @click="toggleCollapseAll"
            >
              <component :is="allCollapsed ? ChevronsUpDown : ChevronsDownUp" :size="14" />
            </button>
          </div>
          <div ref="treeScroll" class="scroll-slim overflow-y-auto p-1" :style="treeStyle">
            <div
              v-if="store.changesLoading[repo.id]"
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
              :nodes="filteredTree"
              :repo-id="repo.id"
              :force-expand="searching"
              @discard="askDiscard"
            />
            <!-- Server capped an oversized changed-file list (MAX_CHANGED_FILES) — say so. -->
            <div
              v-if="store.changesMeta[repo.id]?.truncated"
              class="px-2.5 py-1.5 text-[11.5px] text-amber-500/80"
            >
              {{
                $t("repo.changes.truncated", {
                  shown: store.changesByRepo[repo.id]?.length ?? 0,
                  total: store.changesMeta[repo.id]?.total,
                })
              }}
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

        <!-- recent commit subjects → one-tap fill (phone typing is slow) -->
        <div v-if="st && st.dirty > 0 && recentMsgs.length" class="flex flex-wrap items-center gap-1.5">
          <span class="text-[11px] text-muted-foreground">{{ $t("repo.commit.recent") }}</span>
          <button
            v-for="(m, i) in recentMsgs"
            :key="i"
            type="button"
            class="max-w-[14rem] truncate rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-[11.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            :title="$t('repo.commit.useRecentTitle')"
            @click="commitMsg = m"
          >
            {{ m }}
          </button>
        </div>

        <!-- commit: auto-growing message box with an inline AI draft button, then a
             split Commit button whose chevron opens the other commit modes. Items align
             to the top so the buttons stay put as the textarea grows downward. -->
        <div v-if="st && st.dirty > 0" class="flex items-start gap-2">
          <div class="relative min-w-0 flex-1">
            <!-- field-sizing-content grows the textarea to fit wrapped/multi-line text
                 (min one row, capped at max-h-40 then scrolls). Enter inserts a newline;
                 committing is only ever via the Commit button / flyout. -->
            <Textarea
              v-model="commitMsg"
              :placeholder="$t('repo.commit.placeholder')"
              :maxlength="300"
              rows="1"
              :class="cn('max-h-40 min-h-9 resize-none py-1.5 leading-snug', aiHere && 'pr-10')"
              @keydown="onCommitKey"
            />
            <button
              v-if="aiHere"
              type="button"
              :disabled="generating"
              :title="$t('repo.commit.generateTitle')"
              :aria-label="$t('repo.commit.generateTitle')"
              class="absolute top-1 right-1 flex size-7 items-center justify-center rounded-md text-primary outline-none transition-colors hover:bg-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/40"
              @click="generate"
            >
              <Loader2 v-if="generating" :size="16" class="animate-spin" />
              <Sparkles v-else :size="16" />
            </button>
          </div>

          <div class="flex shrink-0 items-start gap-1.5">
            <div class="flex">
              <Button
                class="h-9 rounded-r-none"
                :disabled="!commitMsg.trim() || committing"
                @click="doCommit()"
              >
                <Loader2 v-if="committing" class="animate-spin" />
                <GitCommitHorizontal v-else />
                <span>{{ selectedCount > 0 ? $t("repo.commit.commitAll") : $t("repo.commit.commit") }}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    class="h-9 rounded-l-none border-l border-l-black/15 px-1.5 dark:border-l-white/20"
                    :disabled="!commitMsg.trim() || committing"
                    :aria-label="$t('repo.commit.menuLabel')"
                  >
                    <ChevronDown :size="16" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="w-52">
                  <DropdownMenuItem @select="doCommit('commit')">
                    <GitCommitHorizontal :size="15" />
                    <span>{{ $t("repo.commit.commit") }}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem @select="doCommit('amend')">
                    <Pencil :size="15" />
                    <span>{{ $t("repo.commit.amend") }}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem :disabled="!hasUpstream" @select="doCommit('push')">
                    <ArrowUpFromLine :size="15" />
                    <span>{{ $t("repo.commit.commitPush") }}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem :disabled="!hasUpstream" @select="doCommit('sync')">
                    <RefreshCw :size="15" />
                    <span>{{ $t("repo.commit.commitSync") }}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <!-- Smart-commit (AI multi-commit split): inline "Auto", right of Commit. -->
            <Tooltip v-if="aiHere && st && st.dirty > 1">
              <TooltipTrigger as-child>
                <Button
                  variant="outline"
                  class="h-9"
                  :disabled="smartBusy || committing"
                  :aria-label="$t('repo.smartCommit.button')"
                  @click="runSmart"
                >
                  <Loader2 v-if="smartBusy" class="animate-spin" />
                  <Sparkles v-else />
                  <span>{{ $t("repo.smartCommit.button") }}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ store.aiSettings.yolo ? $t('repo.smartCommit.buttonTitleYolo') : $t('repo.smartCommit.buttonTitle') }}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <!-- per-file staging: appears only when ≥1 file is checked in the tree above. Commits ONLY
             the selected files (reusing the message box), leaving everything else pending. -->
        <div
          v-if="st && st.dirty > 0 && selectedCount > 0"
          class="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/[0.06] px-2 py-1.5"
        >
          <Button size="sm" :disabled="!commitMsg.trim() || committing" @click="doCommitSelected()">
            <Loader2 v-if="committing" class="animate-spin" />
            <GitCommitHorizontal v-else />
            <span>{{ $t("repo.commit.commitSelected", { n: selectedCount }) }}</span>
          </Button>
          <button
            type="button"
            class="ml-auto shrink-0 rounded px-2 py-1 text-[11.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            :title="$t('repo.commit.clearSelection')"
            @click="treeSelection.clear()"
          >
            {{ $t("repo.commit.clearSelection") }}
          </button>
        </div>

        <!-- git actions -->
        <div class="flex flex-wrap items-center gap-2">
          <Button
            v-if="caps.fetch"
            variant="secondary"
            size="sm"
            :disabled="!hasRemote || anyBusy"
            @click="run('fetch')"
          >
            <Loader2 v-if="busyAction === 'fetch'" class="animate-spin" />
            <DownloadCloud v-else />
            {{ $t("repo.actions.fetch") }}
          </Button>
          <Button
            :variant="st && st.behind > 0 ? 'default' : 'outline'"
            size="sm"
            :disabled="!hasUpstream || anyBusy"
            @click="run('pull')"
          >
            <Loader2 v-if="busyAction === 'pull'" class="animate-spin" />
            <ArrowDownToLine v-else />
            {{ pullLabel }}
          </Button>
          <Button
            :variant="st && st.ahead > 0 ? 'default' : 'outline'"
            size="sm"
            :disabled="!hasUpstream || anyBusy"
            @click="run('push')"
          >
            <Loader2 v-if="busyAction === 'push'" class="animate-spin" />
            <ArrowUpFromLine v-else />
            {{ $t("repo.actions.push") }}
          </Button>
          <!-- stash save + stash-list (pop / drop) — see StashPanel.vue -->
          <StashPanel :repo-id="repo.id" :can-stash="caps.stash" :dirty="st?.dirty ?? 0" />
          <span class="flex-1" />
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-sm"
                class="size-8"
                :aria-label="$t('repo.actions.refresh')"
                :disabled="anyBusy"
                @click="run('refresh')"
              >
                <RefreshCw :class="busyAction === 'refresh' && 'animate-spin'" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ $t("repo.actions.refresh") }}</TooltipContent>
          </Tooltip>
          <!-- overflow menu (hide / unhide this repo from the dashboard) -->
          <DropdownMenu>
            <DropdownMenuTrigger
              class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              :aria-label="$t('repo.moreActions')"
            >
              <MoreVertical :size="16" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-44">
              <DropdownMenuItem @select="togglePinned">
                <PinOff v-if="repo.pinned" :size="15" />
                <Pin v-else :size="15" />
                <span>{{ repo.pinned ? $t("repo.unpin") : $t("repo.pin") }}</span>
              </DropdownMenuItem>
              <DropdownMenuItem @select="toggleStarred">
                <StarOff v-if="repo.starred" :size="15" />
                <Star v-else :size="15" />
                <span>{{ repo.starred ? $t("repo.unstar") : $t("repo.star") }}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem @select="toggleHidden">
                <Eye v-if="repo.hidden" :size="15" />
                <EyeOff v-else :size="15" />
                <span>{{ repo.hidden ? $t("repo.unhide") : $t("repo.hide") }}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem v-if="caps.multipleRemotes" @select="manageOpen = true">
                <Cloud :size="15" />
                <span>{{ $t("repo.manage.open") }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <!-- commit history (lazy-loaded when opened) — see LogPanel.vue -->
        <LogPanel :repo-id="repo.id" />
      </div>
    </CollapsibleContent>

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

    <!-- smart-commit plan editor (AI multi-commit splitter). v-if so each open mounts a fresh
         instance — keeps the drag-reorder binding wired to the freshly-mounted card list. -->
    <SmartCommitPlan
      v-if="smartOpen"
      v-model:open="smartOpen"
      :repo-id="repo.id"
      :repo-name="repo.name"
      :has-remote="hasRemote"
      @committed="onSmartCommitted"
    />

    <!-- per-repo remote URL + tags management -->
    <RepoManage v-model:open="manageOpen" :repo-id="repo.id" :remote="st?.remote ?? null" />
  </Collapsible>
</template>
