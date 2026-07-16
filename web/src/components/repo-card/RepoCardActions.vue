<script setup lang="ts">
// Git action buttons (fetch/pull/push/stash) + the overflow menu (pin/star/hide, remote
// + tag management), extracted from RepoCard. Per-VCS capabilities (mirrors the daemon) drive
// which controls this shows — see VCS_CAPABILITIES. Refresh lives in RepoCardChanges now (see
// RepoCardChanges.vue) — the busy state both read is the store's shared per-repo `busy` map, so
// the two components' spinners (and any other action's disabled state here) can never disagree.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Cloud,
  DownloadCloud,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Star,
  StarOff,
  Timer,
  TimerOff,
  Trash2,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { ApiError } from "@/api";
import { useRepoFeedback } from "@/lib/repo-feedback";
import StashPanel from "../StashPanel.vue";
import RepoManage from "../RepoManage.vue";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { VCS_CAPABILITIES } from "../../types";
import type { Repo } from "../../types";

const props = defineProps<{ repo: Repo }>();
const store = useStore();
const { t } = useI18n();
const { friendly } = useRepoFeedback();

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
const pullTooltip = computed(() =>
  caps.value.fetch ? t("repo.actions.pullTooltip") : t("repo.actions.syncTooltip"),
);
const busyAction = computed(() => store.busy[props.repo.id]);
const anyBusy = computed(() => !!busyAction.value);

async function run(name: "fetch" | "pull" | "push" | "refresh"): Promise<void> {
  const r = await store.doAction(props.repo.id, name);
  if (r.ok) {
    if (name !== "refresh") toast.success(r.message || t("repo.actions.done", { action: name }));
  } else {
    toast.error(friendly(r.code) || r.message || t("repo.actions.failed", { action: name }));
  }
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

// ── opt this repo in/out of the auto-commit timer ─────────────────────────────
async function toggleAutoCommit(): Promise<void> {
  const next = !props.repo.autoCommit;
  try {
    await store.setRepoAutoCommit(props.repo.id, next);
    undoableToast(
      next ? t("repo.toastAutoCommitOn") : t("repo.toastAutoCommitOff"),
      () => store.setRepoAutoCommit(props.repo.id, !next),
    );
  } catch {
    toast.error(t("repo.toastAutoCommitFailed"));
  }
}

// ── "Open with…" — open the repo FOLDER in an external editor (local only) ────
// Only folder-capable targets make sense here (there's no file to hand a single-file editor
// like Notepad); the File Explorer / Finder reveal is always in the list.
const folderEditors = computed(() => store.editorsCatalog.filter((e) => e.available && e.folder));
// Lazy-load the catalogue the first time the overflow menu opens (no-ops after the first fetch).
function onMenuToggle(open: boolean): void {
  if (open && store.canContinueLocal) void store.loadEditors();
}
async function openRepoWith(editor?: string): Promise<void> {
  try {
    const r = await store.openInEditor(props.repo.id, editor ? { editor } : {});
    const label = store.editorsCatalog.find((e) => e.id === r.editor)?.label;
    toast.success(label ? t("repo.openingIn", { editor: label }) : t("repo.openingEditor"));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("repo.openFailed"));
  }
}

// ── rename (display label only — the folder on disk is never touched) ─────────
const renameOpen = ref(false);
const renameDraft = ref("");
function openRename(): void {
  renameDraft.value = props.repo.displayName ?? props.repo.name;
  renameOpen.value = true;
}
async function saveRename(): Promise<void> {
  const next = renameDraft.value.trim();
  // Typing the folder name back in means "no custom label", not "label that happens to match" —
  // otherwise the label would silently outlive a folder rename it was only ever mirroring.
  const label = !next || next === props.repo.name ? null : next;
  const prev = props.repo.displayName ?? null;
  renameOpen.value = false;
  if (label === prev) return;
  try {
    await store.renameRepo(props.repo.id, label);
    undoableToast(label ? t("repo.toastRenamed", { name: label }) : t("repo.toastRenameCleared"), () =>
      store.renameRepo(props.repo.id, prev),
    );
  } catch {
    toast.error(t("repo.toastRenameFailed"));
  }
}

// ── remove from RepoYeti (index-only — never deletes the folder) ──────────────
const removeOpen = ref(false);
async function confirmRemove(): Promise<void> {
  removeOpen.value = false;
  try {
    const removed = await store.removeRepo(props.repo.id);
    if (!removed) return;
    // Undo is a genuine restore (drops the tombstone + re-indexes), not just a re-add — a rescan
    // would otherwise refuse the path and the repo would vanish again on the next scan.
    undoableToast(t("repo.toastRemoved", { name: removed.displayName || removed.name }), () =>
      store.restoreRemovedRepo(removed.absPath),
    );
  } catch {
    toast.error(t("repo.toastRemoveFailed"));
  }
}

// ── remote & tags management (self-contained dialog) ─────────────────────────
const manageOpen = ref(false);
</script>

<template>
  <!-- git actions -->
  <div class="flex flex-wrap items-center gap-2">
    <Tooltip v-if="caps.fetch && store.canControl">
      <TooltipTrigger as-child>
        <Button
          variant="secondary"
          size="sm"
          :disabled="!hasRemote || anyBusy"
          @click="run('fetch')"
        >
          <Loader2 v-if="busyAction === 'fetch'" class="animate-spin" />
          <DownloadCloud v-else />
          {{ $t("repo.actions.fetch") }}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ $t("repo.actions.fetchTooltip") }}</TooltipContent>
    </Tooltip>
    <Tooltip v-if="store.canControl">
      <TooltipTrigger as-child>
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
      </TooltipTrigger>
      <TooltipContent>{{ pullTooltip }}</TooltipContent>
    </Tooltip>
    <Tooltip v-if="store.canControl">
      <TooltipTrigger as-child>
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
      </TooltipTrigger>
      <TooltipContent>{{ $t("repo.actions.pushTooltip") }}</TooltipContent>
    </Tooltip>
    <!-- stash save + stash-list (pop / drop) — see StashPanel.vue -->
    <StashPanel v-if="!store.isGuest" :repo-id="repo.id" :can-stash="caps.stash" :dirty="st?.dirty ?? 0" />
    <span class="flex-1" />
    <!-- refresh moved to RepoCardChanges (immediately left of the remote-presence cloud icon,
         directly under the repo title) — see RepoCardChanges.vue. -->
    <!-- overflow menu (hide / unhide this repo from the dashboard) — every item in it is owner-only -->
    <DropdownMenu v-if="!store.isGuest" @update:open="onMenuToggle">
      <DropdownMenuTrigger
        class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        :aria-label="$t('repo.moreActions')"
      >
        <MoreVertical :size="16" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-44">
        <!-- Open the repo folder in an external editor (local sessions only). -->
        <template v-if="store.canContinueLocal">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ExternalLink :size="15" />
              <span>{{ $t("repo.openWith") }}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent class="w-48">
              <DropdownMenuItem v-for="e in folderEditors" :key="e.id" @select="openRepoWith(e.id)">
                <span class="truncate">{{ e.label }}</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
        </template>
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
        <template v-if="!isLore">
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="toggleAutoCommit">
            <TimerOff v-if="repo.autoCommit" :size="15" />
            <Timer v-else :size="15" />
            <span>{{ repo.autoCommit ? $t("repo.autoCommitStop") : $t("repo.autoCommitStart") }}</span>
          </DropdownMenuItem>
        </template>
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
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="openRename">
          <Pencil :size="15" />
          <span>{{ $t("repo.rename.action") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" @select="removeOpen = true">
          <Trash2 :size="15" />
          <span>{{ $t("repo.remove.action") }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>

  <!-- rename: a display label only. The folder on disk keeps its own name, so this is safe to
       undo, safe to clear, and survives a rescan (which would overwrite `name`, not this). -->
  <Dialog v-model:open="renameOpen">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.rename.title") }}</DialogTitle>
        <DialogDescription>{{ $t("repo.rename.description") }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-2">
        <Input
          v-model="renameDraft"
          :placeholder="repo.name"
          :aria-label="$t('repo.rename.title')"
          autofocus
          @keydown.enter.prevent="saveRename"
        />
        <p class="mono truncate text-[11px] text-muted-foreground">{{ repo.absPath }}</p>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="renameOpen = false">{{ $t("common.cancel") }}</Button>
        <Button @click="saveRename">{{ $t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- remove: index-only. The copy says so in as many words, because "Remove" next to a repo
       name reads as "delete my code" and that fear is the whole reason to spell it out. -->
  <Dialog v-model:open="removeOpen">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.remove.title", { name: repo.displayName || repo.name }) }}</DialogTitle>
        <DialogDescription>{{ $t("repo.remove.description") }}</DialogDescription>
      </DialogHeader>
      <div class="rounded-md border border-border bg-secondary/40 p-3">
        <p class="mono truncate text-[11px] text-muted-foreground">{{ repo.absPath }}</p>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="removeOpen = false">{{ $t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmRemove">{{ $t("repo.remove.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- per-repo remote URL + tags management -->
  <RepoManage v-model:open="manageOpen" :repo-id="repo.id" :remote="st?.remote ?? null" />
</template>
