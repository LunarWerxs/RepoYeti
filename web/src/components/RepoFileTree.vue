<script setup lang="ts">
// The "All files" browse tree: the repo's WHOLE working directory, ignored paths included,
// fetched one folder at a time as you open it.
//
// Deliberately separate from ChangesTree rather than another mode inside it. That component's
// data model is a fully-materialised nested tree whose every leaf carries git status, staged
// state, diff stats and a selection checkbox; this one's is a lazily-fetched directory listing
// where most files have no git status at all. Overloading it would mean threading async children
// and a "clean file" fallback through the app's most-used surface for no gain — the parts worth
// reusing are shared instead: the same VS Code icon set (@/lib/file-icons), the same read-only
// viewer (@/lib/file-viewer), the same row styling, and the same expand animation.
//
// Folders start CLOSED — see @/lib/file-browser for why that is the opposite of the changed-files
// tree's default.
import { computed, type Component } from "vue";
import { Ban, ChevronRight, Copy, Eye, FolderOpen, Loader2, SquarePen } from "@lucide/vue";
import { fileVisual } from "@/lib/file-icons";
import { openFile, isViewing, viewerMode } from "@/lib/file-viewer";
import { useFileBrowser } from "@/lib/file-browser";
import { statusColor } from "@/lib/git-status-colors";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { ChangedFile, RepoTreeEntry } from "../types";

defineOptions({ name: "RepoFileTree" });

const props = withDefaults(
  defineProps<{
    repoId: string;
    /** Directory this level renders ("" = repo root). */
    dir?: string;
    depth?: number;
    /** Share-link gating — matches ChangesTree's props so both trees hide the same things. */
    isGuest?: boolean;
    /** The repo's changed files, so a file that IS modified still shows its status letter here
     *  and opens straight onto its diff. Keyed by path by the caller. */
    changed?: Map<string, ChangedFile>;
    /** Search mode: render THESE entries as a flat list of full paths instead of the lazy tree.
     *  Root level only — a result list has no folders to recurse into. */
    results?: RepoTreeEntry[] | null;
  }>(),
  { dir: "", depth: 0, isGuest: false, results: null },
);

const emit = defineEmits<{
  reveal: [path: string];
  editor: [path: string];
  copyPath: [path: string];
  /** Append this path to the repo's root .gitignore — files and folders alike. */
  gitignore: [path: string];
  /** A folder result was clicked — the panel clears the query and jumps to it in the tree. */
  goToFolder: [entry: RepoTreeEntry];
}>();

const browser = useFileBrowser();
const searching = computed(() => props.results !== null);
const state = computed(() => browser.dirs.get(props.dir));
const entries = computed<RepoTreeEntry[]>(() =>
  searching.value ? (props.results ?? []) : (state.value?.entries ?? []),
);

/** The directory half of a result's path, shown muted after the name (same shape the
 *  changed-files list view uses). Empty for a root-level hit. */
function rowDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

const iconFor = (entry: RepoTreeEntry): Component => fileVisual(entry.name, entry.type === "dir");

const changedFor = (path: string): ChangedFile | undefined => props.changed?.get(path);

async function open(entry: RepoTreeEntry): Promise<void> {
  const hit = changedFor(entry.path);
  // An unchanged file has no diff to show, and the viewer's tab is sticky — landing someone on an
  // empty side-by-side is a worse answer than "here is the file". A file that IS changed keeps the
  // normal behaviour, status letter and all.
  if (!hit) viewerMode.value = "content";
  await openFile({
    repoId: props.repoId,
    path: entry.path,
    status: hit?.status,
    staged: hit?.staged,
  });
}
</script>

<template>
  <!-- The root level owns the empty/loading/error states; nested levels render inside their
       parent's ExpandTransition, which only mounts once that folder is open. -->
  <!-- These describe the DIRECTORY listing, so none of them apply while showing search results —
       the panel owns the searching/no-matches copy in that mode. -->
  <div
    v-if="!searching && depth === 0 && state?.loading && !entries.length"
    class="flex items-center gap-2 px-2.5 py-2 text-[12.5px] text-muted-foreground"
  >
    <Loader2 :size="14" class="animate-spin" /> {{ $t("repo.files.loading") }}
  </div>
  <div v-else-if="!searching && state?.error" class="px-2.5 py-2 text-[12px] text-destructive">
    {{ state.error }}
  </div>
  <!-- `state &&` matters: an unrequested directory has no state at all, and rendering "empty" for
       one would claim a folder is empty when it simply has not been read yet. -->
  <div
    v-else-if="!searching && depth === 0 && state && !state.loading && !entries.length"
    class="px-2.5 py-2 text-[12px] text-muted-foreground"
  >
    {{ $t("repo.files.empty") }}
  </div>

  <template v-for="n in entries" :key="n.path">
    <!-- folder row — the whole row toggles its subtree, fetching children on first open.
         In search mode there is no subtree to open, so the row jumps to the folder instead. -->
    <div v-if="n.type === 'dir'">
      <!-- Folders get the same right-click menu as files, minus the two actions that need a file:
           Open (nothing to show in the viewer) and Open in editor. Every action left is path-based
           all the way down to the daemon — `explorer /select,<dir>` reveals a folder, and a
           .gitignore pattern names a directory just as happily as a file — so offering these on
           files only meant ignoring `node_modules` was one right-click per file inside it.
           The ContextMenu wraps the ROW alone, with the subtree as a sibling below: wrapping both
           would nest a menu per depth level and let a child's right-click reach its ancestors. -->
      <ContextMenu>
        <ContextMenuTrigger as-child>
          <div class="group/dir relative">
            <button
              type="button"
              class="group flex h-[24px] w-full items-center gap-1.5 rounded-md pr-3 text-left text-[12.5px] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
              :style="{ paddingLeft: (searching ? 8 : depth * 14 + 8) + 'px' }"
              :aria-expanded="searching ? undefined : browser.isOpen(n.path)"
              :title="n.ignored ? $t('repo.files.ignoredTitle', { path: n.path }) : n.path"
              @click="searching ? emit('goToFolder', n) : browser.toggle(n.path)"
            >
              <ChevronRight
                v-if="!searching"
                :size="12"
                class="shrink-0 text-muted-foreground transition-transform"
                :class="browser.isOpen(n.path) && 'rotate-90'"
              />
              <component :is="iconFor(n)" class="shrink-0 text-[15px]" :class="n.ignored && 'opacity-40'" />
              <span class="truncate" :class="n.ignored ? 'text-[#cfcfd8]/45' : 'text-[#cfcfd8]'">
                {{ n.name }}<span v-if="searching && rowDir(n.path)" class="ml-1.5 text-muted-foreground/55">{{ rowDir(n.path) }}</span>
              </span>
              <Loader2
                v-if="!searching && browser.dirs.get(n.path)?.loading"
                :size="11"
                class="shrink-0 animate-spin text-muted-foreground"
              />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem v-if="!isGuest" @select="emit('reveal', n.path)">
            <FolderOpen :size="15" />
            <span>{{ $t("repo.changes.revealAction") }}</span>
          </ContextMenuItem>
          <ContextMenuItem @select="emit('copyPath', n.path)">
            <Copy :size="15" />
            <span>{{ $t("repo.changes.ctxCopyPath") }}</span>
          </ContextMenuItem>
          <!-- Separator only when the group it introduces has something in it — a guest sees Copy
               path alone, and a divider under a single item reads as a menu that failed to load. -->
          <ContextMenuSeparator v-if="!isGuest" />
          <ContextMenuItem v-if="!isGuest" @select="emit('gitignore', n.path)">
            <Ban :size="15" />
            <span>{{ $t("repo.changes.ctxGitignore") }}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ExpandTransition v-if="!searching" :open="browser.isOpen(n.path)">
        <RepoFileTree
          :repo-id="repoId"
          :dir="n.path"
          :depth="depth + 1"
          :is-guest="isGuest"
          :changed="changed"
          @reveal="emit('reveal', $event)"
          @editor="emit('editor', $event)"
          @copy-path="emit('copyPath', $event)"
          @gitignore="emit('gitignore', $event)"
          @go-to-folder="emit('goToFolder', $event)"
        />
      </ExpandTransition>
    </div>

    <!-- file row — opens the same read-only viewer the changed-files tree uses -->
    <ContextMenu v-else>
      <ContextMenuTrigger as-child>
        <div class="group/file relative">
          <button
            type="button"
            class="group flex h-[24px] w-full items-center gap-1.5 rounded-md pr-3 text-left text-[12.5px] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
            :class="isViewing(repoId, n.path) && 'bg-accent/80 ring-1 ring-primary/30'"
            :style="{ paddingLeft: (searching ? 8 : depth * 14 + 8 + 22) + 'px' }"
            :title="n.ignored ? $t('repo.files.ignoredTitle', { path: n.path }) : n.path"
            @click="open(n)"
          >
            <component :is="iconFor(n)" class="shrink-0 text-[15px]" :class="n.ignored && 'opacity-40'" />
            <span class="truncate" :class="n.ignored ? 'text-[#cfcfd8]/45' : 'text-[#cfcfd8]'">
              {{ n.name }}<span v-if="searching && rowDir(n.path)" class="ml-1.5 text-muted-foreground/55">{{ rowDir(n.path) }}</span>
            </span>
            <!-- A file that is ALSO in the changed list keeps its status letter, so switching to
                 "All files" never loses the one signal the changes view existed to give. -->
            <span
              v-if="changedFor(n.path)"
              class="mono ml-auto shrink-0 pl-1 text-[11px] font-bold"
              :style="{ color: statusColor(changedFor(n.path)!.status) }"
              >{{ changedFor(n.path)!.status }}</span
            >
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem @select="open(n)">
          <Eye :size="15" />
          <span>{{ $t("repo.changes.ctxOpen") }}</span>
        </ContextMenuItem>
        <ContextMenuSeparator v-if="!isGuest" />
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
        <ContextMenuSeparator v-if="!isGuest" />
        <ContextMenuItem v-if="!isGuest" @select="emit('gitignore', n.path)">
          <Ban :size="15" />
          <span>{{ $t("repo.changes.ctxGitignore") }}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </template>

  <!-- an oversized directory was capped server-side; say so rather than silently showing a head -->
  <div
    v-if="!searching && state?.truncated"
    class="px-2.5 py-1.5 text-[11.5px] text-warning/80"
    :style="{ paddingLeft: depth * 14 + 10 + 'px' }"
  >
    {{ $t("repo.files.truncated", { shown: entries.length, total: state.total }) }}
  </div>
</template>
