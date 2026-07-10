<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronRight, Undo2 } from "@lucide/vue";
import type { DiffStat as DiffStatT, TreeNode } from "../types";
import { fileVisual } from "@/lib/file-icons";
import { fmtCount } from "@/lib/diffstat";
import { openFile, isViewing } from "@/lib/file-viewer";
import { useTreeCollapse } from "@/lib/changes-tree";
import { useTreeSelection } from "@/lib/changes-selection";
import { statusColor } from "@/lib/git-status-colors";
import DiffStat from "./DiffStat.vue";

const { t } = useI18n();

// Tooltip for a file row's stat: lines breakdown · characters breakdown.
function diffTitle(s: DiffStatT): string {
  return (
    `${t("repo.diffStat.lines", { added: s.addedLines, removed: s.removedLines })} · ` +
    `${t("repo.diffStat.chars", { added: fmtCount(s.addedChars), removed: fmtCount(s.removedChars) })}`
  );
}

// Self-recursive component (renders <ChangesTree> for each subfolder). In `flat` (list-view)
// mode the caller passes only file nodes — no folders — and each row shows the file's full
// path (muted directory prefix + filename) instead of just its name; everything else (open,
// select, discard, diff-stats, keyboard nav) is unchanged.
defineOptions({ name: "ChangesTree" });
const props = defineProps<{ nodes: TreeNode[]; repoId: string; depth?: number; forceExpand?: boolean; flat?: boolean }>();

// Directory of a flat-list row WITHOUT the trailing slash, e.g. "src/components". Empty for a
// repo-root file. Shown muted AFTER the filename in list view (filename-first). Only used when
// `flat` is on; `truncate` then clips the path tail first, keeping the filename always visible.
function rowDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}
// Bubbles a per-file "discard changes" request up to RepoCard (which confirms, then calls
// the store). Re-emitted through each recursion level so a deep file reaches the root.
const emit = defineEmits<{ discard: [path: string]; move: [payload: { from: string; toDir: string }] }>();

// Shared collapsed-folder state (provided once by RepoCard; see @/lib/changes-tree).
const collapse = useTreeCollapse();
// Shared per-file selection (provided once by RepoCard; drives "Commit selected" — see
// @/lib/changes-selection). Each file row owns a checkbox; folders are not selectable directly.
const selection = useTreeSelection();

// While a search is active the tree is force-expanded so matches inside otherwise-collapsed
// folders stay visible; otherwise we honour the per-folder collapse state.
const isOpen = (path: string): boolean => props.forceExpand || !collapse.isCollapsed(path);

// Pre-resolve each row's vscode-icons glyph once (colours are baked into the SVG).
const rows = computed(() =>
  props.nodes.map((node) => ({ node, icon: fileVisual(node.name, node.type === "dir") })),
);

// Clicking a file opens it in the read-only viewer drawer/sheet.
function open(n: TreeNode): void {
  if (n.type !== "file") return;
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
// across the recursion without threading any extra state through the component.
function visibleRows(from: HTMLElement): HTMLElement[] {
  const root = from.closest("[data-changes-root]");
  return root ? [...root.querySelectorAll<HTMLElement>("button[data-tree-row]")] : [from];
}
function onRowKey(e: KeyboardEvent, n: TreeNode, depth: number): void {
  const btn = e.currentTarget as HTMLElement;
  const rows = visibleRows(btn);
  const i = rows.indexOf(btn);
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      rows[i + 1]?.focus();
      break;
    case "ArrowUp":
      e.preventDefault();
      rows[i - 1]?.focus();
      break;
    case "Home":
      e.preventDefault();
      rows[0]?.focus();
      break;
    case "End":
      e.preventDefault();
      rows.at(-1)?.focus();
      break;
    case "ArrowRight":
      if (n.type === "dir") {
        e.preventDefault();
        if (!isOpen(n.path) && !props.forceExpand) collapse.toggle(n.path);
        else rows[i + 1]?.focus(); // already open → step into the first child
      }
      break;
    case "ArrowLeft":
      e.preventDefault();
      if (n.type === "dir" && isOpen(n.path) && !props.forceExpand) {
        collapse.toggle(n.path); // collapse this folder, keep focus on it
      } else {
        // jump to the parent: nearest preceding row at a shallower indent
        for (let k = i - 1; k >= 0; k--) {
          const row = rows[k];
          if (row && Number(row.dataset.depth) < depth) {
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
function treeRows(): HTMLElement[] {
  return rootRef.value
    ? [...rootRef.value.querySelectorAll<HTMLElement>("button[data-tree-row]")]
    : [];
}
function syncRoving(anchor?: HTMLElement | null): void {
  const list = treeRows();
  if (!list.length) return;
  const current = list.find((r) => r.tabIndex === 0);
  const active = anchor && list.includes(anchor) ? anchor : (current ?? list[0]);
  for (const r of list) r.tabIndex = r === active ? 0 : -1;
}
function onFocusIn(e: FocusEvent): void {
  if (!isRoot) return;
  const t = e.target as HTMLElement | null;
  if (t?.matches?.("button[data-tree-row]")) syncRoving(t);
}
onMounted(() => {
  if (!isRoot || !rootRef.value) return;
  syncRoving();
  // Expand / collapse / search add and remove rows; keep exactly one row tabbable.
  rovingObserver = new MutationObserver(() => syncRoving());
  rovingObserver.observe(rootRef.value, { childList: true, subtree: true });
});
onBeforeUnmount(() => rovingObserver?.disconnect());
</script>

<template>
  <!-- the top instance (depth undefined) marks the scope arrow-key nav + roving tabindex use -->
  <div ref="rootRef" :data-changes-root="depth === undefined ? '' : undefined" @focusin="onFocusIn">
    <template v-for="{ node: n, icon } in rows" :key="n.path">
      <!-- folder row — the whole row toggles its subtree open/closed -->
      <button
        v-if="n.type === 'dir'"
        type="button"
        class="group flex h-[26px] w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
        :class="dragOverPath === n.path && 'bg-primary/15 ring-1 ring-primary/40'"
        :style="{ paddingLeft: (depth ?? 0) * 14 + 8 + 'px' }"
        :title="n.path"
        :aria-expanded="isOpen(n.path)"
        data-tree-row
        :data-depth="depth ?? 0"
        @click="collapse.toggle(n.path)"
        @keydown="onRowKey($event, n, depth ?? 0)"
        @dragover="onFolderDragOver($event, n)"
        @dragleave="dragOverPath = null"
        @drop.prevent="onFolderDrop($event, n)"
      >
        <ChevronRight
          :size="14"
          class="shrink-0 text-muted-foreground/70 transition-transform duration-150"
          :class="isOpen(n.path) && 'rotate-90'"
        />
        <component :is="icon" class="shrink-0 text-[15px]" />
        <span class="truncate text-[#93939f]">{{ n.name }}</span>
      </button>
      <!-- file row — opens the read-only viewer (spacer keeps it aligned under folders).
           Wrapped so the hover "discard" button is a SIBLING (button-in-button is invalid). -->
      <div v-else class="group/file relative">
        <button
          type="button"
          draggable="true"
          class="group flex h-[26px] w-full items-center gap-1.5 rounded-md pr-8 text-left text-[12.5px] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
          :class="[isViewing(repoId, n.path) && 'bg-accent/80 ring-1 ring-primary/30', draggingPath === n.path && 'opacity-40']"
          :style="{ paddingLeft: (depth ?? 0) * 14 + 8 + 'px' }"
          :title="n.path"
          data-tree-row
          :data-depth="depth ?? 0"
          @click="open(n)"
          @keydown="onRowKey($event, n, depth ?? 0)"
          @dragstart="onFileDragStart($event, n)"
          @dragend="onFileDragEnd"
        >
          <span class="w-3.5 shrink-0" aria-hidden="true" />
          <component :is="icon" class="shrink-0 text-[15px]" />
          <span
            class="truncate"
            :class="n.status === 'D' ? 'text-muted-foreground line-through' : n.staged ? 'text-[#cfe9d9]' : 'text-[#cfcfd8]'"
          >
            {{ n.name }}<span v-if="flat && rowDir(n.path)" class="ml-1.5 text-muted-foreground/55">{{ rowDir(n.path) }}</span>
          </span>
          <!-- right side: per-file diff stats (when enabled) + the git-status letter -->
          <span class="mono ml-auto flex shrink-0 items-center gap-1.5">
            <DiffStat v-if="n.stat" :stat="n.stat" show="both" :title="diffTitle(n.stat)" />
            <span class="text-[11px] font-bold" :style="{ color: statusColor(n.status) }">{{
              n.status
            }}</span>
          </span>
        </button>
        <!-- per-file selection checkbox: sits over the (empty) chevron column on the left so it
             never shifts the row. Toggling it adds/removes this file from the shared selection that
             drives RepoCard's "Commit selected (N)". A sibling (not nested) since the row is a
             <button>; tabindex -1 to stay out of the tree's roving tabindex (matches discard). -->
        <button
          type="button"
          role="checkbox"
          tabindex="-1"
          :aria-checked="selection.isSelected(n.path)"
          :aria-label="$t('repo.changes.select', { name: n.name })"
          class="absolute top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded outline-none transition focus-visible:ring-2 focus-visible:ring-ring/40"
          :style="{ left: (depth ?? 0) * 14 + 3 + 'px' }"
          @click.stop="selection.toggle(n.path)"
        >
          <span
            class="flex size-3.5 items-center justify-center rounded-[4px] border transition-colors"
            :class="
              selection.isSelected(n.path)
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border/70 bg-card/70 opacity-70 group-hover/file:opacity-100'
            "
          >
            <Check v-if="selection.isSelected(n.path)" :size="11" />
          </span>
        </button>
        <!-- discard this file's working-tree changes (RepoCard confirms first). Hidden-until-hover on
             pointer devices, but always visible on touch (pointer-coarse) — phones have no :hover, so
             hover-only reveal would make discard unreachable on the primary surface. -->
        <button
          type="button"
          tabindex="-1"
          class="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded bg-card/80 text-muted-foreground opacity-0 pointer-coarse:opacity-70 outline-none transition group-hover/file:opacity-100 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40"
          :title="$t('repo.discard.action')"
          :aria-label="$t('repo.discard.action')"
          @click.stop="emit('discard', n.path)"
        >
          <Undo2 :size="12" />
        </button>
      </div>
      <!-- children render only while this folder is expanded -->
      <ChangesTree
        v-if="n.children && n.children.length && isOpen(n.path)"
        :nodes="n.children"
        :repo-id="repoId"
        :depth="(depth ?? 0) + 1"
        :force-expand="forceExpand"
        @discard="emit('discard', $event)"
        @move="emit('move', $event)"
      />
    </template>
  </div>
</template>
