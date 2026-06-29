<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight } from "@lucide/vue";
import type { DiffStat as DiffStatT, TreeNode } from "../types";
import { fileVisual } from "@/lib/file-icons";
import { fmtCount } from "@/lib/diffstat";
import { openFile, isViewing } from "@/lib/file-viewer";
import { useTreeCollapse } from "@/lib/changes-tree";
import DiffStat from "./DiffStat.vue";

const { t } = useI18n();

// Tooltip for a file row's stat: lines breakdown · characters breakdown.
function diffTitle(s: DiffStatT): string {
  return (
    `${t("repo.diffStat.lines", { added: s.addedLines, removed: s.removedLines })} · ` +
    `${t("repo.diffStat.chars", { added: fmtCount(s.addedChars), removed: fmtCount(s.removedChars) })}`
  );
}

// Self-recursive component (renders <ChangesTree> for each subfolder).
defineOptions({ name: "ChangesTree" });
const props = defineProps<{ nodes: TreeNode[]; repoId: string; depth?: number; forceExpand?: boolean }>();

// Shared collapsed-folder state (provided once by RepoCard; see @/lib/changes-tree).
const collapse = useTreeCollapse();

// While a search is active the tree is force-expanded so matches inside otherwise-collapsed
// folders stay visible; otherwise we honour the per-folder collapse state.
const isOpen = (path: string): boolean => props.forceExpand || !collapse.isCollapsed(path);

// Pre-resolve each row's vscode-icons glyph once (colours are baked into the SVG).
const rows = computed(() =>
  props.nodes.map((node) => ({ node, icon: fileVisual(node.name, node.type === "dir") })),
);

// VS Code-style git-status colours (the M/A/U/D letter on the right).
const STATUS_COLOR: Record<string, string> = {
  M: "#e2c08d", // modified
  A: "#73c991", // added
  U: "#73c991", // untracked
  D: "#f14c4c", // deleted
  R: "#6cb6ff", // renamed
  C: "#d18616", // conflicted
};
const statusColor = (s?: string): string => (s ? (STATUS_COLOR[s] ?? "#9aa0a6") : "#9aa0a6");

// Clicking a file opens it in the read-only viewer drawer/sheet.
function open(n: TreeNode): void {
  if (n.type !== "file") return;
  openFile({ repoId: props.repoId, path: n.path, status: n.status, staged: n.staged });
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
      rows[rows.length - 1]?.focus();
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
          if (Number(rows[k].dataset.depth) < depth) {
            rows[k].focus();
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
const rootRef = ref<HTMLElement | null>(null);
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
        :style="{ paddingLeft: (depth ?? 0) * 14 + 8 + 'px' }"
        :title="n.path"
        :aria-expanded="isOpen(n.path)"
        data-tree-row
        :data-depth="depth ?? 0"
        @click="collapse.toggle(n.path)"
        @keydown="onRowKey($event, n, depth ?? 0)"
      >
        <ChevronRight
          :size="14"
          class="shrink-0 text-muted-foreground/70 transition-transform duration-150"
          :class="isOpen(n.path) && 'rotate-90'"
        />
        <component :is="icon" class="shrink-0 text-[15px]" />
        <span class="truncate text-[#93939f]">{{ n.name }}</span>
      </button>
      <!-- file row — opens the read-only viewer (spacer keeps it aligned under folders) -->
      <button
        v-else
        type="button"
        class="group flex h-[26px] w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
        :class="isViewing(repoId, n.path) && 'bg-accent/80 ring-1 ring-primary/30'"
        :style="{ paddingLeft: (depth ?? 0) * 14 + 8 + 'px' }"
        :title="n.path"
        data-tree-row
        :data-depth="depth ?? 0"
        @click="open(n)"
        @keydown="onRowKey($event, n, depth ?? 0)"
      >
        <span class="w-3.5 shrink-0" aria-hidden="true" />
        <component :is="icon" class="shrink-0 text-[15px]" />
        <span class="truncate" :class="n.staged ? 'text-[#cfe9d9]' : 'text-[#cfcfd8]'">
          {{ n.name }}
        </span>
        <!-- right side: per-file diff stats (when enabled) + the git-status letter -->
        <span class="mono ml-auto flex shrink-0 items-center gap-1.5">
          <DiffStat v-if="n.stat" :stat="n.stat" show="both" :title="diffTitle(n.stat)" />
          <span class="text-[11px] font-bold" :style="{ color: statusColor(n.status) }">{{
            n.status
          }}</span>
        </span>
      </button>
      <!-- children render only while this folder is expanded -->
      <ChangesTree
        v-if="n.children && n.children.length && isOpen(n.path)"
        :nodes="n.children"
        :repo-id="repoId"
        :depth="(depth ?? 0) + 1"
        :force-expand="forceExpand"
      />
    </template>
  </div>
</template>
