<script setup lang="ts">
// Commit UI (auto-growing message box + AI draft + recent-messages dropdown + split commit
// button + smart-commit), extracted from RepoCard. `treeSelection` is the shared, provided
// per-file selection (created once by RepoCard — see @/lib/changes-selection) so "Commit
// selected" stays in sync with the checkboxes in ChangesTree. `loadRecentMsgs` is exposed so
// RepoCard can refresh the "recent" chips right after expanding a dirty repo (see toggle()).
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowUpFromLine, ChevronDown, GitCommitHorizontal, History, Loader2, Pencil, RefreshCw, Sparkles } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { api, ApiError } from "../../api";
import { cn } from "@/lib/utils";
import { useRepoFeedback } from "@/lib/repo-feedback";
import { shortcutsActive } from "@/lib/hotkeys";
import SmartCommitPlan from "../SmartCommitPlan.vue";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { TreeSelectionApi } from "@/lib/changes-selection";
import type { Repo } from "../../types";

const props = defineProps<{ repo: Repo; treeSelection: TreeSelectionApi }>();
const store = useStore();
const { t } = useI18n();
const { friendly } = useRepoFeedback();

const st = computed(() => props.repo.status);
const hasRemote = computed(() => !!st.value?.remote);
const isLore = computed(() => props.repo.vcs === "lore");
// Lore is centralized — it always has a server to push/sync to — so its remote ops don't
// hinge on a configured git remote the way git's do.
const hasUpstream = computed(() => isLore.value || hasRemote.value);
// AI commit message + smart-commit are now VCS-agnostic (the daemon's VcsBackend collects the
// diff / stages groups via `lore diff` / `lore stage`+`lore commit` for Lore), so they're shown
// whenever AI is enabled, on git and Lore alike.
const aiHere = computed(() => store.aiEnabled);
const selectedCount = computed(() => props.treeSelection.count.value); // a ComputedRef → auto-unwraps in template

// ── commit (stage-all + commit, optional AI draft) ────────────────────────────
// The split button commits in one of four modes; `committing` spans the whole flow
// (commit + any follow-on pull/push) so the button stays busy throughout, not just
// for the commit leg.
type CommitMode = "commit" | "amend" | "push" | "sync";
// Lifted to RepoCard (v-model) rather than a plain local ref: RepoCardCommit lives inside
// <CollapsibleContent>, which unmounts its content on collapse (reka-ui's default
// unmountOnHide), so a plain local ref would lose a half-typed message every time the card
// is collapsed/re-expanded — RepoCard's own scope doesn't unmount, so it survives there.
const commitMsg = defineModel<string>("commitMsg", { required: true });
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
    toast.error(e instanceof ApiError ? friendly(e.code ?? "ERROR") || e.message : t("repo.smartCommit.failed"));
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
    const msg = e instanceof ApiError ? (friendly(e.code ?? "ERROR") || e.message) : t("repo.commit.generateFailed");
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
  const paths = [...props.treeSelection.selected];
  if (!msg || !paths.length || committing.value) return;
  committing.value = true;
  try {
    const r = await store.commitSelected(props.repo.id, msg, paths);
    if (!r.ok) {
      toast.error(friendly(r.code) || r.message || t("repo.commit.failed"));
      return;
    }
    commitMsg.value = "";
    props.treeSelection.clear();
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

// Exposed so RepoCard can refresh the "recent" chips on expand / when new dirty files show up
// (see toggle() and the status-dirty watch in RepoCard.vue) without duplicating this state there.
defineExpose({ loadRecentMsgs, recentMsgs });
</script>

<template>
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
        :class="cn('max-h-40 min-h-9 resize-none py-1.5 leading-snug', aiHere && recentMsgs.length ? 'pr-17' : aiHere || recentMsgs.length ? 'pr-10' : '')"
        @keydown="onCommitKey"
      />
      <div class="absolute top-1 right-1 flex items-center gap-0.5">
        <!-- recent commit messages, tucked behind a small history dropdown -->
        <DropdownMenu v-if="recentMsgs.length">
          <DropdownMenuTrigger
            class="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            :title="$t('repo.commit.recent')"
            :aria-label="$t('repo.commit.recent')"
            @click.stop
          >
            <History :size="16" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-w-[min(22rem,80vw)]">
            <DropdownMenuLabel>{{ $t("repo.commit.recent") }}</DropdownMenuLabel>
            <DropdownMenuItem
              v-for="(m, i) in recentMsgs"
              :key="i"
              :title="$t('repo.commit.useRecentTitle')"
              @select="commitMsg = m"
            >
              <span class="truncate text-[12.5px]">{{ m }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          v-if="aiHere"
          type="button"
          :disabled="generating"
          :title="$t('repo.commit.generateTitle')"
          :aria-label="$t('repo.commit.generateTitle')"
          class="flex size-7 items-center justify-center rounded-md text-primary outline-none transition-colors hover:bg-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/40"
          @click="generate"
        >
          <Loader2 v-if="generating" :size="16" class="animate-spin" />
          <Sparkles v-else :size="16" />
        </button>
      </div>
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
</template>
