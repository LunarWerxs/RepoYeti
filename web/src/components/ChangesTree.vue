<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";
import { Ban, Check, ChevronRight, Copy, Eye, FolderOpen, Minus, Plus, SquarePen, Undo2 } from "@lucide/vue";
import type { DiffStat as DiffStatT, TreeNode } from "../types";
import { fileVisual } from "@/lib/file-icons";
import { fmtCount } from "@/lib/diffstat";
import { openFile, isViewing } from "@/lib/file-viewer";
import { useTreeCollapse } from "@/lib/changes-tree";
import { useTreeSelection } from "@/lib/changes-selection";
import { statusColor } from "@/lib/git-status-colors";
import DiffStat from "./DiffStat.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

const { t } = useI18n();

// Tooltip for a file row's stat: lines breakdown · characters breakdown. Character counts come
// from parsing patch text, which the read-only (pre-pull) tree has none of — it works off
// `git diff --numstat`, and numstat reports lines only. So drop the chars half there rather
// than render a confident "+0 −0 characters".
function diffTitle(s: DiffStatT): string {
  const lines = t("repo.diffStat.lines", { added: s.addedLines, removed: s.removedLines });
  if (props.readOnly) return lines;
  return `${lines} · ${t("repo.diffStat.chars", { added: fmtCount(s.addedChars), removed: fmtCount(s.removedChars) })}`;
}

// Self-recursive component (renders <ChangesTree> for each subfolder). In `flat` (list-view)
// mode the caller passes only file nodes — no folders — and each row shows the file's full
// path (muted directory prefix + filename) instead of just its name; everything else (open,
// select, discard, diff-stats, keyboard nav) is unchanged.
defineOptions({ name: "ChangesTree" });
const props = withDefaults(
  defineProps<{
    nodes: TreeNode[];
    repoId: string;
    depth?: number;
    forceExpand?: boolean;
    flat?: boolean;
    /** Share-link gating (see store.canControl/isGuest) — owner defaults keep every other call site as-is. */
    canControl?: boolean;
    isGuest?: boolean;
    /** Render the tree as a pure listing: clicking a file opens nothing. Used by the pre-pull
     *  preview, where the files describe commits you don't have yet — there is no local
     *  working-tree version of them to show, so opening one would be a lie or an error. */
    readOnly?: boolean;
    /** Show per-file +/- stats. The caller passes the owner's "diff stats" setting: the daemon
     *  already stops COMPUTING them when it's off, but a list fetched while it was on keeps its
     *  stats in the client cache, so the tree would go on showing them until a reload. Gating
     *  the render as well makes the toggle take effect the moment it's flipped. */
    showStats?: boolean;
  }>(),
  { canControl: true, isGuest: false, readOnly: false, showStats: true },
);

// Directory of a flat-list row WITHOUT the trailing slash, e.g. "src/components". Empty for a
// repo-root file. Shown muted AFTER the filename in list view (filename-first). Only used when
// `flat` is on; `truncate` then clips the path tail first, keeping the filename always visible.
function rowDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}
// Bubbles a per-file "discard changes" request up to RepoCard (which confirms, then calls
// the store). Re-emitted through each recursion level so a deep file reaches the root.
// `stage` (git add — non-destructive, no confirm) and `reveal` (open the repo folder in the OS
// file manager) follow the same bubble-up pattern.
const emit = defineEmits<{
  discard: [path: string];
  stage: [path: string];
  reveal: [path: string];
  move: [payload: { from: string; toDir: string }];
  editor: [path: string];
  gitignore: [path: string];
  copyPath: [path: string];
}>();

// Shared collapsed-folder state (provided once by RepoCard; see @/lib/changes-tree).
const collapse = useTreeCollapse();
// Shared per-file selection (provided once by RepoCard; drives "Commit selected" — see
// @/lib/changes-selection). Every row owns a checkbox: a file's ticks itself, a folder's ticks
// every file beneath it (see folderState/toggleFolder).
const selection = useTreeSelection();

// While a search is active the tree is force-expanded so matches inside otherwise-collapsed
// folders stay visible; otherwise we honour the per-folder collapse state.
const isOpen = (path: string): boolean => props.forceExpand || !collapse.isCollapsed(path);

// ── folder selection ──────────────────────────────────────────────────────────
// A folder's checkbox fans out over every FILE beneath it, recursively. It is never itself
// "selected": the shared selection holds file paths only (that is what commit-selected takes),
// so a folder's box reports, and edits, the state of its descendants. That also means a folder
// with no files under it has nothing to tick, and its box is a no-op.
function descendantFiles(n: TreeNode): string[] {
  if (n.type === "file") return [n.path];
  const out: string[] = [];
  for (const c of n.children ?? []) out.push(...descendantFiles(c));
  return out;
}

// none / some / all, where `some` renders the indeterminate dash. Reads the reactive selection,
// so it re-evaluates when any descendant is ticked — including from a deeper folder's own box.
function folderState(files: string[]): "none" | "some" | "all" {
  if (!files.length) return "none";
  let picked = 0;
  for (const p of files) if (selection.isSelected(p)) picked++;
  return picked === 0 ? "none" : picked === files.length ? "all" : "some";
}

// Clicking a folder's box selects ALL of its files unless they are already all selected, in
// which case it clears them. So a PARTIAL selection fills up rather than clearing: the next
// click is always predictable from what the box currently shows, and a half-ticked folder can
// never silently throw away the files you had already picked by hand.
function toggleFolder(files: string[]): void {
  if (!files.length) return;
  selection.setMany(files, folderState(files) !== "all");
}

// Pre-resolve each row's vscode-icons glyph once (colours are baked into the SVG), and, for a
// folder, its descendant file paths. Walking the subtree here rather than in the template keeps
// it to once per nodes-change instead of once per selection-change on every render.
const rows = computed(() =>
  props.nodes.map((node) => ({
    node,
    icon: fileVisual(node.name, node.type === "dir"),
    files: node.type === "dir" ? descendantFiles(node) : [],
  })),
);

// Clicking a file opens it in the read-only viewer drawer/sheet.
function open(n: TreeNode): void {
  if (props.readOnly || n.type !== "file") return;
  openFile({ repoId: props.repoId, path: n.path, status: n.status, staged: n.staged });
}

// ── drag-to-move: drag a file row onto a folder row to move it there ──────────
// The dragged file's repo-relative path rides in dataTransfer; the folder under the cursor is
// the destination. The actual git-mv/rename is bubbled up to RepoCard (like `discard`) so the
// store owns the op + refresh, and re-emitted through each recursion level. Only works in tree
// view (list/flat mode shows no folders → no drop targets).
const DND_MIME = "application/x-repoyeti-path";
const dragOverPath = ref<string | null>(null);
const draggingPath = ref<string | null>(null);

function onFileDragStart(e: DragEvent, n: TreeNode): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(DND_MIME, n.path);
  e.dataTransfer.setData("text/plain", n.name); // sane fallback for other drop zones
  e.dataTransfer.effectAllowed = "move";
  draggingPath.value = n.path;
}
function onFileDragEnd(): void {
  draggingPath.value = null;
  dragOverPath.value = null;
}
function onFolderDragOver(e: DragEvent, dir: TreeNode): void {
  if (!e.dataTransfer?.types.includes(DND_MIME)) return; // ignore non-file drags
  e.preventDefault(); // allow the drop
  e.dataTransfer.dropEffect = "move";
  dragOverPath.value = dir.path;
}
function onFolderDrop(e: DragEvent, dir: TreeNode): void {
  if (props.isGuest) return; // guests can't move files (rows are also non-draggable — see below)
  dragOverPath.value = null;
  const from = e.dataTransfer?.getData(DND_MIME);
  if (!from) return;
  // No-op if the file already lives directly in this folder.
  const slash = from.lastIndexOf("/");
  const fromDir = slash >= 0 ? from.slice(0, slash) : "";
  if (fromDir === dir.path) return;
  emit("move", { from, toDir: dir.path });
}

// ── keyboard navigation (VS Code-style) ───────────────────────────────────────
// Rows are real <button>s, so Tab + Enter/Space already focus and activate them (open a
// file / toggle a folder). The arrows add tree movement on top: ↑/↓ between visible rows,
// Home/End to the ends, → to open a folder (or step into it), ← to close it (or jump to its
// parent). Row order and indent are read straight from the DOM, so this stays correct
// across the recursion without threading any extra state through the component. A TreeWalker
// advances from the current row instead of rebuilding an array of all 2,000 rows on every key.
function rowWalker(from: HTMLElement): { root: HTMLElement; walker: TreeWalker } | null {
  const root = from.closest<HTMLElement>("[data-changes-root]");
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      node instanceof HTMLElement && node.matches("button[data-tree-row]")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });
  walker.currentNode = from;
  return { root, walker };
}
function onRowKey(e: KeyboardEvent, n: TreeNode, depth: number): void {
  const btn = e.currentTarget as HTMLElement;
  const traversal = rowWalker(btn);
  if (!traversal) return;
  const { root, walker } = traversal;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      (walker.nextNode() as HTMLElement | null)?.focus();
      break;
    case "ArrowUp":
      e.preventDefault();
      (walker.previousNode() as HTMLElement | null)?.focus();
      break;
    case "Home":
      e.preventDefault();
      root.querySelector<HTMLElement>("button[data-tree-row]")?.focus();
      break;
    case "End": {
      e.preventDefault();
      walker.currentNode = root;
      let last: HTMLElement | null = null;
      for (let row = walker.nextNode(); row; row = walker.nextNode()) last = row as HTMLElement;
      last?.focus();
      break;
    }
    case "ArrowRight":
      if (n.type === "dir") {
        e.preventDefault();
        if (!isOpen(n.path) && !props.forceExpand) collapse.toggle(n.path);
        else (walker.nextNode() as HTMLElement | null)?.focus(); // open → first child
      }
      break;
    case "ArrowLeft":
      e.preventDefault();
      if (n.type === "dir" && isOpen(n.path) && !props.forceExpand) {
        collapse.toggle(n.path); // collapse this folder, keep focus on it
      } else {
        // jump to the parent: nearest preceding row at a shallower indent
        for (let row = walker.previousNode(); row; row = walker.previousNode()) {
          if (row instanceof HTMLElement && Number(row.dataset.depth) < depth) {
            row.focus();
            break;
          }
        }
      }
      break;
  }
}

// ── roving tabindex: the whole tree is ONE Tab stop ───────────────────────────
// Otherwise every row (often hundreds) is its own tab stop. Instead exactly one row stays
// in the Tab order: Tab moves into the tree (to the row you last touched) and the next Tab
// leaves it — arrows move within (see onRowKey). The top instance owns this on the DOM so a
// single rule covers the whole recursion: the focused row becomes the anchor, and any
// add/remove of rows (expand / collapse / search) re-validates which row is tabbable.
const isRoot = props.depth === undefined;
const rootRef = useTemplateRef<HTMLElement>("rootRef");
let rovingObserver: MutationObserver | null = null;
let rovingAnchor: HTMLElement | null = null;

function setRovingAnchor(next: HTMLElement | null): void {
  if (rovingAnchor === next) return;
  if (rovingAnchor) rovingAnchor.tabIndex = -1;
  rovingAnchor = next;
  if (next) next.tabIndex = 0;
}

function syncRovingAfterMutation(): void {
  const root = rootRef.value;
  if (!root) return;
  if (rovingAnchor && root.contains(rovingAnchor)) {
    rovingAnchor.tabIndex = 0;
    return;
  }
  const focused =
    document.activeElement instanceof HTMLElement &&
    document.activeElement.matches("button[data-tree-row]") &&
    root.contains(document.activeElement)
      ? document.activeElement
      : null;
  setRovingAnchor(
    focused ?? root.querySelector<HTMLElement>("button[data-tree-row]"),
  );
}
function onFocusIn(e: FocusEvent): void {
  if (!isRoot) return;
  const t = e.target as HTMLElement | null;
  if (t?.matches?.("button[data-tree-row]")) setRovingAnchor(t);
}
onMounted(() => {
  if (!isRoot || !rootRef.value) return;
  setRovingAnchor(rootRef.value.querySelector<HTMLElement>("button[data-tree-row]"));
  // Expand / collapse / search add and remove rows; keep exactly one row tabbable.
  // Every row is declaratively -1 below; the observer only has work when the current anchor was
  // removed. Focus changes are O(1), with no full-tree rewrite on mount, expand, or arrow keys.
  rovingObserver = new MutationObserver(() => syncRovingAfterMutation());
  rovingObserver.observe(rootRef.value, { childList: true, subtree: true });
});
onBeforeUnmount(() => {
  rovingObserver?.disconnect();
  rovingAnchor = null;
});
</script>

<template>
  <!-- the top instance (depth undefined) marks the scope arrow-key nav + roving tabindex use -->
  <div ref="rootRef" :data-changes-root="depth === undefined ? '' : undefined" @focusin="onFocusIn">
    <template v-for="{ node: n, icon, files } in rows" :key="n.path">
      <!-- folder row — the whole row toggles its subtree open/closed.
           Right-click gets the same treatment as a file row. Every action here is path-based all
           the way down to the daemon (`git add <dir>`, a `/dir` .gitignore pattern, discard over a
           path), so a folder is a legitimate target for them — offering these only on files meant
           ignoring a build directory took one right-click per file inside it. Open / Open in
           editor are deliberately absent: there is no folder to show in a diff viewer.
           Wrapped in a relative div (like the file row) so the selection checkbox can be an
           absolutely-positioned SIBLING: button-in-button is invalid HTML. -->
      <ContextMenu v-if="n.type === 'dir'">
        <ContextMenuTrigger as-child>
          <div class="tree-row-cv group/dir relative">
      <button
        type="button"
        class="group flex h-[24px] w-full items-center gap-1.5 rounded-md pr-3 text-left text-[12.5px] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
        :class="dragOverPath === n.path && 'bg-primary/15 ring-1 ring-primary/40'"
        :style="{ paddingLeft: (depth ?? 0) * 14 + 8 + 'px' }"
        :title="n.path"
        :aria-expanded="isOpen(n.path)"
        tabindex="-1"
        data-tree-row
        :data-depth="depth ?? 0"
        @click="collapse.toggle(n.path)"
        @keydown="onRowKey($event, n, depth ?? 0)"
        @dragover="onFolderDragOver($event, n)"
        @dragleave="dragOverPath = null"
        @drop.prevent="onFolderDrop($event, n)"
      >
        <!-- leading checkbox column, reserved in-flow on EVERY row kind at EVERY depth so the
             boxes line up in one gutter and disclosing one never reflows the row (the same
             reserve-space convention the file row's chevron spacer already used). Dropped in a
             read-only tree, which has no selection at all, so the pull preview keeps its indent. -->
        <span v-if="!readOnly" class="w-3.5 shrink-0" aria-hidden="true" />
        <ChevronRight
          :size="14"
          class="shrink-0 text-muted-foreground/70 transition-transform duration-150"
          :class="isOpen(n.path) && 'rotate-90'"
        />
        <component :is="icon" class="shrink-0 text-[15px]" />
        <span class="truncate text-[#93939f]">{{ n.name }}</span>
      </button>
      <!-- folder selection checkbox: ticks every file beneath this folder at once, which is the
           whole point of having it (ticking a build output folder used to be one click per file).
           Tri-state: checked when all descendants are selected, a dash when only some are, so a
           collapsed folder still tells you a selection exists inside it. Same disclosure rules as
           the file box below — hidden at rest, shown on this row's hover/focus, on touch, or
           whenever anything anywhere in the tree is selected. Nested one indent step per depth, so
           a parent's box sits immediately left of its children's rather than on top of them. -->
      <button
        v-if="!readOnly && files.length"
        type="button"
        role="checkbox"
        tabindex="-1"
        :aria-checked="folderState(files) === 'all' ? 'true' : folderState(files) === 'some' ? 'mixed' : 'false'"
        :aria-label="$t('repo.changes.select', { name: n.name })"
        :title="$t('repo.changes.selectFolder')"
        class="absolute top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded opacity-0 outline-none transition-opacity pointer-coarse:opacity-100 group-hover/dir:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40"
        :class="(folderState(files) !== 'none' || selection.count.value > 0) && 'opacity-100'"
        :style="{ left: (depth ?? 0) * 14 + 3 + 'px' }"
        @click.stop="toggleFolder(files)"
      >
        <span
          class="flex size-3.5 items-center justify-center rounded-[4px] border transition-colors"
          :class="
            folderState(files) !== 'none'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border/70 bg-card/70'
          "
        >
          <Check v-if="folderState(files) === 'all'" :size="11" />
          <Minus v-else-if="folderState(files) === 'some'" :size="11" />
        </span>
      </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent class="w-52">
          <ContextMenuItem v-if="!isGuest" @select="emit('reveal', n.path)">
            <FolderOpen :size="15" />
            <span>{{ $t("repo.changes.revealAction") }}</span>
          </ContextMenuItem>
          <ContextMenuItem @select="emit('copyPath', n.path)">
            <Copy :size="15" />
            <span>{{ $t("repo.changes.ctxCopyPath") }}</span>
          </ContextMenuItem>
          <!-- Same conditional-separator rule as the file menu below. -->
          <ContextMenuSeparator v-if="canControl || !isGuest" />
          <ContextMenuItem v-if="canControl" @select="emit('stage', n.path)">
            <Plus :size="15" />
            <span>{{ $t("repo.changes.ctxStageFolder") }}</span>
          </ContextMenuItem>
          <ContextMenuItem v-if="!isGuest" @select="emit('gitignore', n.path)">
            <Ban :size="15" />
            <span>{{ $t("repo.changes.ctxGitignore") }}</span>
          </ContextMenuItem>
          <ContextMenuSeparator v-if="!isGuest" />
          <ContextMenuItem v-if="!isGuest" variant="destructive" @select="emit('discard', n.path)">
            <Undo2 :size="15" />
            <span>{{ $t("repo.changes.ctxDiscardFolder") }}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <!-- file row — opens the read-only viewer (spacer keeps it aligned under folders).
           Wrapped so the hover action buttons are SIBLINGS (button-in-button is invalid).
           Right-click opens a ContextMenu (same actions as the hover buttons, plus Open / Open in
           editor / Add to .gitignore / Copy path). Trigger `as-child` merges onto the row wrapper
           (no extra DOM); the menu Content mounts lazily on right-click, so it's far lighter than an
           eager per-row Tooltip. -->
      <ContextMenu v-else>
        <ContextMenuTrigger as-child>
          <div class="tree-row-cv group/file relative">
        <button
          type="button"
          :draggable="!isGuest"
          class="group flex h-[24px] w-full items-center gap-1.5 rounded-md pr-3 text-left text-[12.5px] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
          :class="[isViewing(repoId, n.path) && 'bg-accent/80 ring-1 ring-primary/30', draggingPath === n.path && 'opacity-40']"
          :style="{ paddingLeft: (depth ?? 0) * 14 + 8 + 'px' }"
          :title="n.path"
          tabindex="-1"
          data-tree-row
          :data-depth="depth ?? 0"
          @click="open(n)"
          @keydown="onRowKey($event, n, depth ?? 0)"
          @dragstart="onFileDragStart($event, n)"
          @dragend="onFileDragEnd"
        >
          <!-- two reserved columns: the checkbox gutter (matches the folder row's, and dropped in
               a read-only tree for the same reason), then the chevron column a folder occupies,
               which keeps file icons aligned under folder icons. -->
          <span v-if="!readOnly" class="w-3.5 shrink-0" aria-hidden="true" />
          <span class="w-3.5 shrink-0" aria-hidden="true" />
          <component :is="icon" class="shrink-0 text-[15px]" />
          <span
            class="truncate"
            :class="n.status === 'D' ? 'text-muted-foreground line-through' : n.staged ? 'text-[#cfe9d9]' : 'text-[#cfcfd8]'"
          >
            {{ n.name }}<span v-if="flat && rowDir(n.path)" class="ml-1.5 text-muted-foreground/55">{{ rowDir(n.path) }}</span>
          </span>
          <!-- right side: per-file diff stats (when enabled), a reserved slot for the (overlaid)
               action buttons, then the git-status letter last — GitHub-Desktop-style, actions to
               the LEFT of the status letter. The action-button slot is always reserved in-flow
               (fixed width) so hover/selection never shifts the diff-stat or status letter — the
               real buttons are absolutely-positioned siblings anchored to the row's right edge,
               on top of this slot (see below), matching the checkbox's reserve-space convention. -->
          <span class="mono ml-auto flex shrink-0 items-center gap-1.5">
            <DiffStat v-if="n.stat && showStats" :stat="n.stat" :show="readOnly ? 'lines' : 'both'" :title="diffTitle(n.stat)" />
            <span class="w-[84px] shrink-0" aria-hidden="true" />
            <span class="pl-1 text-[11px] font-bold" :style="{ color: statusColor(n.status) }">{{
              n.status
            }}</span>
          </span>
        </button>
        <!-- per-file selection checkbox: sits in the leading gutter column on the left so it
             never shifts the row (the row's first `w-3.5` spacer above always reserves this space,
             whether or not the checkbox itself is visible). Toggling it adds/removes this file
             from the shared selection that drives RepoCard's "Commit selected (N)". A sibling
             (not nested) since the row is a <button>; tabindex -1 to stay out of the tree's
             roving tabindex (matches discard). Native `title` (like the row itself) rather than a
             reka Tooltip: two Tooltip instances per file row made mounting a 2000-file tree
             measurably janky.
             Visibility (never layout): hidden at rest, revealed on THIS row's hover/focus, on
             touch (pointer-coarse — phones have no :hover), on THIS file's own selection, or on
             ANY file being selected anywhere in the tree (so a partial selection stays visible
             across every row, not just the one under the pointer). -->
        <!-- Not rendered in a read-only tree (the pull preview): selection exists to drive
             "Commit selected", and there is nothing to commit there. It was previously only
             transparent, so it stayed hoverable and clickable — offering to tick files for a
             pull, which is all-or-nothing and cannot honour a subset. -->
        <button
          v-if="!readOnly"
          type="button"
          role="checkbox"
          tabindex="-1"
          :aria-checked="selection.isSelected(n.path)"
          :aria-label="$t('repo.changes.select', { name: n.name })"
          :title="$t('repo.changes.selectFile')"
          class="absolute top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded opacity-0 outline-none transition-opacity pointer-coarse:opacity-100 group-hover/file:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40"
          :class="(selection.isSelected(n.path) || selection.count.value > 0) && 'opacity-100'"
          :style="{ left: (depth ?? 0) * 14 + 3 + 'px' }"
          @click.stop="selection.toggle(n.path)"
        >
          <span
            class="flex size-3.5 items-center justify-center rounded-[4px] border transition-colors"
            :class="
              selection.isSelected(n.path)
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border/70 bg-card/70'
            "
          >
            <Check v-if="selection.isSelected(n.path)" :size="11" />
          </span>
        </button>
        <!-- row actions (GitHub-Desktop-style): reveal-in-folder, stage, discard — positioned to
             the LEFT of the status letter (right offset clears the letter + row padding), sitting
             over the reserved 74px slot above so they never shift the diff-stat/status letter.
             Hidden-until-hover on pointer devices, but always visible on touch (pointer-coarse) —
             phones have no :hover, so hover-only reveal would make them unreachable there. -->
        <div
          class="absolute top-1/2 right-8 flex -translate-y-1/2 items-center gap-0.5 opacity-0 pointer-coarse:opacity-70 group-hover/file:opacity-100 focus-within:opacity-100"
        >
          <!-- reveal this file's repo in the OS file manager (same convention as "Open with…" → File Explorer/Finder). -->
          <button
            v-if="!isGuest"
            type="button"
            tabindex="-1"
            class="flex size-6 items-center justify-center rounded bg-card/80 text-muted-foreground outline-none transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            :aria-label="$t('repo.changes.revealAction')"
            :title="$t('repo.changes.revealAction')"
            @click.stop="emit('reveal', n.path)"
          >
            <FolderOpen :size="12" />
          </button>
          <!-- stage this file's working-tree change into the index (non-destructive; doesn't commit). -->
          <button
            v-if="canControl"
            type="button"
            tabindex="-1"
            class="flex size-6 items-center justify-center rounded bg-card/80 text-muted-foreground outline-none transition hover:bg-primary/15 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/40"
            :aria-label="$t('repo.changes.stageAction')"
            :title="$t('repo.changes.stageAction')"
            @click.stop="emit('stage', n.path)"
          >
            <Plus :size="12" />
          </button>
          <!-- discard this file's working-tree changes (RepoCard confirms first). -->
          <button
            v-if="!isGuest"
            type="button"
            tabindex="-1"
            class="flex size-6 items-center justify-center rounded bg-card/80 text-muted-foreground outline-none transition hover:bg-destructive/15 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40"
            :aria-label="$t('repo.discard.action')"
            :title="$t('repo.discard.action')"
            @click.stop="emit('discard', n.path)"
          >
            <Undo2 :size="12" />
          </button>
        </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent class="w-52">
          <ContextMenuItem v-if="!readOnly" @select="open(n)">
            <Eye :size="15" />
            <span>{{ $t("repo.changes.ctxOpen") }}</span>
          </ContextMenuItem>
          <ContextMenuItem v-if="!isGuest" @select="emit('editor', n.path)">
            <SquarePen :size="15" />
            <span>{{ $t("repo.changes.ctxEditor") }}</span>
          </ContextMenuItem>
          <ContextMenuItem v-if="!isGuest" @select="emit('reveal', n.path)">
            <FolderOpen :size="15" />
            <span>{{ $t("repo.changes.revealAction") }}</span>
          </ContextMenuItem>
          <ContextMenuItem @select="emit('copyPath', n.path)">
            <Copy :size="15" />
            <span>{{ $t("repo.changes.ctxCopyPath") }}</span>
          </ContextMenuItem>
          <!-- Separators are conditional on the group they introduce actually having items. In a
               read-only tree (the pull preview) every action below is hidden and only Copy path
               survives, which used to leave two dividers floating under a single item. -->
          <ContextMenuSeparator v-if="canControl || !isGuest" />
          <ContextMenuItem v-if="canControl" @select="emit('stage', n.path)">
            <Plus :size="15" />
            <span>{{ $t("repo.changes.stageAction") }}</span>
          </ContextMenuItem>
          <ContextMenuItem v-if="!isGuest" @select="emit('gitignore', n.path)">
            <Ban :size="15" />
            <span>{{ $t("repo.changes.ctxGitignore") }}</span>
          </ContextMenuItem>
          <ContextMenuSeparator v-if="!isGuest" />
          <ContextMenuItem v-if="!isGuest" variant="destructive" @select="emit('discard', n.path)">
            <Undo2 :size="15" />
            <span>{{ $t("repo.discard.action") }}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <!-- children render only while this folder is expanded -->
      <ExpandTransition v-if="n.children && n.children.length" :open="isOpen(n.path)">
        <ChangesTree
          :nodes="n.children"
          :repo-id="repoId"
          :depth="(depth ?? 0) + 1"
          :force-expand="forceExpand"
          :can-control="canControl"
          :is-guest="isGuest"
          :read-only="readOnly"
          :show-stats="showStats"
          @discard="emit('discard', $event)"
          @stage="emit('stage', $event)"
          @reveal="emit('reveal', $event)"
          @move="emit('move', $event)"
          @editor="emit('editor', $event)"
          @gitignore="emit('gitignore', $event)"
          @copy-path="emit('copyPath', $event)"
        />
      </ExpandTransition>
    </template>
  </div>
</template>

<style scoped>
/* Rows outside the scroll viewport skip layout + paint entirely (a tree can hold up to the
   server's MAX_CHANGED_FILES = 2000 files). The fixed 24px placeholder keeps the scrollbar
   exact (every row is h-[24px] — keep these two in lockstep or the scrollbar drifts). This is
   what keeps huge trees smooth while the card's collapse/expand height animation runs: each
   animation frame lays out only the ~20 visible rows instead of thousands. */
.tree-row-cv {
  content-visibility: auto;
  contain-intrinsic-size: auto 24px;
}
</style>
