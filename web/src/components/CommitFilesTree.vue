<script setup lang="ts">
// Read-only folder tree for ONE commit's changed files (the History tap-to-expand detail),
// behind the Appearance → "History files as folder tree" switch (see @/lib/history-view).
//
// Deliberately NOT ChangesTree: that component is a working-tree control surface (stage,
// discard, select-to-commit, drag-to-move) with per-repo collapse/selection contexts provided
// by RepoCard — every one of those affordances is a lie against a historical snapshot. This is
// the same visual language (24px rows, chevrons, vscode icons, status letters) with exactly the
// four actions the flat history list already offers, bubbled up to LogPanel which owns them.
//
// Collapse state is component-local and dies with the expanded commit (each expand mounts a
// fresh tree, folders open) — remembering folds for a commit you may never reopen is clutter.
import { reactive } from "vue";
import { ChevronRight, Copy, Eye, FolderOpen, SquarePen } from "@lucide/vue";
import type { TreeNode } from "../types";
import { fileVisual } from "@/lib/file-icons";
import { statusColor } from "@/lib/git-status-colors";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

defineOptions({ name: "CommitFilesTree" });

const props = defineProps<{
  nodes: TreeNode[];
  depth?: number;
  /** Shared collapsed-folder set — created once by the root instance, passed down the
   *  recursion so every level toggles the same state. */
  collapsed?: Set<string>;
}>();

// LogPanel owns the actual actions (open at commit / editor / reveal / copy path) — the same
// handlers its flat list uses — so a row here only reports which file was asked for.
const emit = defineEmits<{
  open: [node: TreeNode];
  editor: [path: string];
  reveal: [path: string];
  copyPath: [path: string];
}>();

/** Above this many files, folders start COLLAPSED. Folders default open because a normal commit
 *  reads best fully spread out — but at the daemon's 500-file cap that means mounting ~700 rows
 *  (files + folder buttons) in one tick, and a wall that tall isn't readable anyway. Collapsed-
 *  first turns a pathological commit into a scannable directory overview instead. 200 sits above
 *  any commit worth reading expanded and below the cap where the mount cost gets real. */
const COLLAPSE_ALL_ABOVE = 200;

/** Root only: the shared collapse Set — pre-seeded with every folder path when the commit is
 *  huge (see COLLAPSE_ALL_ABOVE), empty (all open) otherwise. Runs once per mount, and the tree
 *  remounts per expanded commit, so the census is never stale. */
function seedCollapsed(nodes: TreeNode[]): Set<string> {
  const s = reactive(new Set<string>());
  let files = 0;
  const dirs: string[] = [];
  const walk = (ns: TreeNode[]): void => {
    for (const n of ns) {
      if (n.type === "dir") {
        dirs.push(n.path);
        if (n.children) walk(n.children);
      } else files++;
    }
  };
  walk(nodes);
  if (files > COLLAPSE_ALL_ABOVE) for (const d of dirs) s.add(d);
  return s;
}

const collapsed = props.collapsed ?? seedCollapsed(props.nodes);
const isOpen = (path: string): boolean => !collapsed.has(path);
function toggle(path: string): void {
  if (collapsed.has(path)) collapsed.delete(path);
  else collapsed.add(path);
}
</script>

<template>
  <div>
    <template v-for="n in nodes" :key="n.path">
      <!-- folder row — toggles its subtree -->
      <button
        v-if="n.type === 'dir'"
        type="button"
        class="commit-tree-row group flex h-[24px] w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12px] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
        :style="{ paddingLeft: (depth ?? 0) * 14 + 6 + 'px' }"
        :title="n.path"
        :aria-expanded="isOpen(n.path)"
        @click.stop="toggle(n.path)"
      >
        <ChevronRight
          :size="13"
          class="shrink-0 text-muted-foreground/70 transition-transform duration-150"
          :class="isOpen(n.path) && 'rotate-90'"
        />
        <component :is="fileVisual(n.name, true)" class="shrink-0 text-[14px]" />
        <span class="truncate text-muted-foreground">{{ n.name }}</span>
      </button>
      <!-- file row — same actions as the flat history list, via LogPanel -->
      <ContextMenu v-else>
        <ContextMenuTrigger as-child>
          <button
            type="button"
            class="commit-tree-row group flex h-[24px] w-full items-center gap-1.5 rounded-md pr-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
            :style="{ paddingLeft: (depth ?? 0) * 14 + 6 + 'px' }"
            :title="n.from ? `${n.from} → ${n.path}` : n.path"
            @click.stop="emit('open', n)"
          >
            <span class="w-[13px] shrink-0" aria-hidden="true" />
            <component :is="fileVisual(n.name, false)" class="shrink-0 text-[14px]" />
            <span
              class="mono min-w-0 flex-1 truncate text-[11.5px]"
              :class="n.status === 'D' ? 'text-muted-foreground line-through' : 'text-foreground'"
            >{{ n.name }}</span>
            <span v-if="n.stat?.addedLines" class="mono shrink-0 text-[10.5px] text-success">+{{ n.stat.addedLines }}</span>
            <span v-if="n.stat?.removedLines" class="mono shrink-0 text-[10.5px] text-destructive">−{{ n.stat.removedLines }}</span>
            <span class="mono shrink-0 pl-1 text-[11px] font-bold" :style="{ color: statusColor(n.status ?? 'M') }">{{ n.status }}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent class="w-52">
          <ContextMenuItem @select="emit('open', n)">
            <Eye :size="15" /><span>{{ $t("repo.history.ctxOpenAtCommit") }}</span>
          </ContextMenuItem>
          <ContextMenuItem @select="emit('editor', n.path)">
            <SquarePen :size="15" /><span>{{ $t("repo.changes.ctxEditor") }}</span>
          </ContextMenuItem>
          <ContextMenuItem @select="emit('reveal', n.path)">
            <FolderOpen :size="15" /><span>{{ $t("repo.changes.revealAction") }}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @select="emit('copyPath', n.path)">
            <Copy :size="15" /><span>{{ $t("repo.changes.ctxCopyPath") }}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <!-- children render only while this folder is expanded -->
      <ExpandTransition v-if="n.children && n.children.length" :open="isOpen(n.path)">
        <CommitFilesTree
          :nodes="n.children"
          :depth="(depth ?? 0) + 1"
          :collapsed="collapsed"
          @open="emit('open', $event)"
          @editor="emit('editor', $event)"
          @reveal="emit('reveal', $event)"
          @copy-path="emit('copyPath', $event)"
        />
      </ExpandTransition>
    </template>
  </div>
</template>

<style scoped>
/* Same skip-offscreen-rows trick as ChangesTree: a capped commit still ships up to 500 files,
   and rows outside the scroll viewport shouldn't cost layout/paint. Keep the 24px in lockstep
   with the row height above or the scrollbar drifts. */
.commit-tree-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 24px;
}
</style>
