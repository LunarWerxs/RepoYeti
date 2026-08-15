<script setup lang="ts">
// The repo card's overflow (⋮) menu and the three dialogs it opens: rename, remove, and
// remote/tag management. Split out of RepoCardActions so the trigger can sit up in the
// card's identity line (immediately right of the refresh + remote-presence cloud, under the
// repo title — see RepoCardChanges.vue) instead of trailing the fetch/pull/push button row.
// Every item in here is owner-only; the whole component is gated on !store.isGuest by its
// caller, and re-checks nothing itself beyond the per-VCS capability flags.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
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

const st = computed(() => props.repo.status);
const caps = computed(() => VCS_CAPABILITIES[props.repo.vcs] ?? VCS_CAPABILITIES.git);
const isLore = computed(() => props.repo.vcs === "lore");

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
    // Turning a repo on while the global switch is OFF is the #1 source of "why didn't it run?" —
    // say so in the toast instead of implying it's now live.
    const onMessage = store.autoCommit ? t("repo.toastAutoCommitOn") : t("repo.toastAutoCommitOnGlobalOff");
    undoableToast(
      next ? onMessage : t("repo.toastAutoCommitOff"),
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

/** Copy the repo's absolute path (the remove dialog's path box). */
async function copyPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.repo.absPath);
    toast.success(t("repo.changes.copiedPath"));
  } catch {
    toast.error(t("repo.changes.copyPathFailed"));
  }
}

// ── remote & tags management (self-contained dialog) ─────────────────────────
const manageOpen = ref(false);
</script>

<template>
  <DropdownMenu @update:open="onMenuToggle">
    <DropdownMenuTrigger
      class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      :aria-label="$t('repo.moreActions')"
      @click.stop
    >
      <MoreVertical :size="15" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="max-w-44">
      <!-- Open the repo folder in an external editor (local sessions only). -->
      <template v-if="store.canContinueLocal">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ExternalLink :size="15" />
            <span>{{ $t("repo.openWith") }}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="max-w-48">
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

  <!-- rename: a display label only. The folder on disk keeps its own name, so this is safe to
       undo, safe to clear, and survives a rescan (which would overwrite `name`, not this). -->
  <Dialog v-model:open="renameOpen">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.rename.title") }}</DialogTitle>
        <DialogDescription>{{ $t("repo.rename.description") }}</DialogDescription>
      </DialogHeader>
      <div class="min-w-0 space-y-2">
        <Input
          v-model="renameDraft"
          :placeholder="repo.name"
          :aria-label="$t('repo.rename.title')"
          autofocus
          @keydown.enter.prevent="saveRename"
        />
        <p class="mono truncate text-[11px] text-muted-foreground" :title="repo.absPath">{{ repo.absPath }}</p>
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
      <DialogHeader class="min-w-0">
        <DialogTitle class="break-words">
          {{ $t("repo.remove.title", { name: repo.displayName || repo.name }) }}
        </DialogTitle>
        <DialogDescription>{{ $t("repo.remove.description") }}</DialogDescription>
      </DialogHeader>
      <!-- The path gets its OWN horizontal scroller. DialogContent is a grid, so a grid item's
           `min-width: auto` resolves to its min-content width — a long nowrap path therefore
           stretched the whole dialog and made the MODAL scroll sideways. min-w-0 caps the item,
           and the overflow is contained to this box (with a copy button, since a scrolled-off
           path is awkward to select by hand). -->
      <div class="flex min-w-0 items-center gap-2 rounded-md border border-border bg-secondary/40 p-2">
        <p class="scroll-slim mono min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground">
          {{ repo.absPath }}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          class="shrink-0"
          :aria-label="$t('repo.changes.ctxCopyPath')"
          :title="$t('repo.changes.ctxCopyPath')"
          @click="copyPath"
        >
          <Copy />
        </Button>
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
