<script setup lang="ts">
// Git action buttons (fetch/pull/push/stash), extracted from RepoCard. Per-VCS capabilities
// (mirrors the daemon) drive which controls this shows — see VCS_CAPABILITIES. Refresh and the
// overflow (⋮) menu both live in the card's identity line now (see RepoCardChanges.vue and
// repo-card/RepoCardMenu.vue) — the busy state they and this component read is the store's shared
// per-repo `busy` map, so their spinners (and any action's disabled state here) can never disagree.
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDownToLine, ArrowUpFromLine, DownloadCloud, Loader2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { useRepoFeedback } from "@/lib/repo-feedback";
import StashPanel from "../StashPanel.vue";
import PullPreview from "./PullPreview.vue";
import { Button } from "@/components/ui/button";
import type { ButtonVariants } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { VCS_CAPABILITIES } from "../../types";
import type { PullDisposition, Repo } from "../../types";

const props = withDefaults(defineProps<{ repo: Repo; active?: boolean }>(), { active: true });
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
const busyAction = computed(() => store.busy[props.repo.id]);
const anyBusy = computed(() => !!busyAction.value);
const incoming = computed(() => store.incomingByRepo[props.repo.id]);
const statusDiverged = computed(() => (st.value?.ahead ?? 0) > 0 && (st.value?.behind ?? 0) > 0);

const blockedDispositions = new Set<PullDisposition>([
  "blocked_non_fast_forward",
  "blocked_would_overwrite",
]);
/**
 * Whether the cached preview still describes the live status snapshot.
 *
 * Counts alone are not identities: HEAD/upstream can both move while keeping the same numbers.
 * `headOid` catches the former exactly; a newer fetched/status timestamp invalidates upstream or
 * index/worktree changes, and the server's snapshot token proves those inputs stayed fixed for
 * the duration of the preview itself. A legacy/incomplete success without that token fails closed.
 */
const previewMatchesStatus = computed(() => {
  const preview = incoming.value;
  const status = st.value;
  if (!preview || !status || !Number.isFinite(preview.checkedAt)) return false;
  if (preview.ahead !== status.ahead || preview.behind !== status.behind) return false;
  if (status.updatedAt > preview.checkedAt) return false;
  if ((status.fetchedAt ?? 0) > preview.checkedAt) return false;
  if (
    status.headOid &&
    preview.snapshot?.headOid &&
    status.headOid.toLowerCase() !== preview.snapshot.headOid.toLowerCase()
  ) {
    return false;
  }
  if (
    status.upstreamOid &&
    preview.snapshot?.upstreamOid &&
    status.upstreamOid.toLowerCase() !== preview.snapshot.upstreamOid.toLowerCase()
  ) {
    return false;
  }
  if (
    status.worktreeStateHash &&
    preview.snapshot?.worktreeStateHash &&
    status.worktreeStateHash !== preview.snapshot.worktreeStateHash
  ) {
    return false;
  }
  return true;
});
const currentPreview = computed(() =>
  previewMatchesStatus.value && !store.incomingLoading[props.repo.id]
    ? incoming.value
    : undefined,
);
const currentPreviewDisposition = computed<PullDisposition | undefined>(
  () => currentPreview.value?.pullDisposition,
);
const previewUnavailable = computed(() => {
  // Once a preview exists, never fall back to an optimistic button while that preview is stale
  // or being revalidated. That is how a same-count worktree edit used to leave a cached green
  // verdict actionable until the dialog was opened again.
  if (store.incomingLoading[props.repo.id]) return true;
  if (incoming.value && !currentPreview.value) return true;
  const preview = currentPreview.value;
  if (!preview) return false;
  return (
    !preview.ok ||
    preview.noUpstream ||
    preview.relation === "no_upstream" ||
    preview.relation === "unknown" ||
    preview.pullDisposition === "unknown" ||
    (preview.ok &&
      !preview.noUpstream &&
      (!preview.snapshot?.headOid || !preview.snapshot.worktreeStateHash))
  );
});
const previewProvesBlocked = computed(() =>
  currentPreviewDisposition.value
    ? blockedDispositions.has(currentPreviewDisposition.value)
    : false,
);
const pullProvesBlocked = computed(() =>
  caps.value.fetch ? statusDiverged.value || previewProvesBlocked.value : false,
);

// Pull goes accent when there is something safe to pull, and destructive as soon as the local and
// remote histories have diverged. One computed variant drives BOTH halves of the split button.
/**
 * Whether the preview caret is actually rendered beside Pull.
 *
 * ONE source of truth, because Pull squares off its right corners to butt against that caret —
 * and a share-link guest doesn't get the caret (the incoming endpoint is owner-only), so keying
 * the rounding off a different condition left the guest's Pull button with a flat right edge
 * joined to nothing.
 */
const hasPullCaret = computed(() => caps.value.fetch && !store.isGuest);
const pullVariant = computed<ButtonVariants["variant"]>(() =>
  pullProvesBlocked.value
    ? "destructive"
    : previewUnavailable.value
      ? "outline"
    : st.value && st.value.behind > 0
      ? "default"
      : "outline",
);
const pullDisabled = computed(
  () =>
    !hasUpstream.value ||
    anyBusy.value ||
    pullProvesBlocked.value ||
    (caps.value.fetch && previewUnavailable.value),
);
const caretDisabled = computed(() => !hasUpstream.value || anyBusy.value);
const pullTooltip = computed(() => {
  if (currentPreviewDisposition.value === "blocked_would_overwrite") {
    return t("repo.actions.pullBlockedOverwriteTooltip");
  }
  if (
    statusDiverged.value ||
    currentPreviewDisposition.value === "blocked_non_fast_forward"
  ) {
    return t("repo.actions.pullBlockedDivergedTooltip");
  }
  if (previewUnavailable.value) return t("repo.actions.pullUnavailableTooltip");
  return caps.value.fetch ? t("repo.actions.pullTooltip") : t("repo.actions.syncTooltip");
});

// A status with commits on both sides already proves `pull --ff-only` cannot run. While this
// expanded owner card is visible, ask the read-only preview endpoint for the more specific
// explanation without fetching again. Refresh it whenever status is reconciled after a fetch.
watch(
  () => [
    props.active,
    props.repo.vcs,
    store.isGuest,
    st.value?.ahead ?? 0,
    st.value?.behind ?? 0,
    st.value?.headOid ?? null,
    st.value?.upstreamOid ?? null,
    st.value?.worktreeStateHash ?? null,
    st.value?.fetchedAt ?? null,
    st.value?.updatedAt ?? 0,
  ] as const,
  ([active, vcs, guest, _ahead, behind]) => {
    if (
      active &&
      vcs === "git" &&
      !guest &&
      !store.incomingLoading[props.repo.id] &&
      ((behind > 0 && !currentPreview.value) ||
        (!!incoming.value && !previewMatchesStatus.value))
    ) {
      void store.loadIncoming(props.repo.id, false);
    }
  },
  { immediate: true },
);

async function run(name: "fetch" | "pull" | "push" | "refresh"): Promise<void> {
  const r = await store.doAction(props.repo.id, name);
  if (r.ok) {
    if (name !== "refresh") toast.success(r.message || t("repo.actions.done", { action: name }));
  } else {
    toast.error(friendly(r.code) || r.message || t("repo.actions.failed", { action: name }));
  }
}

</script>

<template>
  <!-- git actions -->
  <div class="flex flex-wrap items-center gap-2">
    <Tooltip v-if="caps.fetch && store.canControl">
      <TooltipTrigger as-child>
        <span class="inline-flex">
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
        </span>
      </TooltipTrigger>
      <TooltipContent>{{ $t("repo.actions.fetchTooltip") }}</TooltipContent>
    </Tooltip>
    <!-- Pull, with a caret beside it that previews the pull first. The two read as one split
         button (the caret's left corners are squared off against Pull's right edge). -->
    <div v-if="store.canControl" class="flex items-center">
      <Tooltip>
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <Button
              :variant="pullVariant"
              size="sm"
              :class="hasPullCaret ? 'rounded-r-none' : ''"
              data-testid="repo-pull-primary"
              :disabled="pullDisabled"
              @click="run('pull')"
            >
              <Loader2 v-if="busyAction === 'pull'" class="animate-spin" />
              <ArrowDownToLine v-else />
              {{ pullLabel }}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ pullTooltip }}</TooltipContent>
      </Tooltip>
      <!-- Git only: the preview is defined as a merge against an upstream ref, which a
           centralized backend (Lore) has no local equivalent of. Owner-only too — the endpoint
           is owner-gated (see src/share/policy.ts), so a share-link guest would just get a 403. -->
      <!-- No class here: PullPreview's root is a renderless <DropdownMenu>, so anything passed
           in never reaches an element. It owns its own split-button joining classes. -->
      <PullPreview
        v-if="hasPullCaret"
        :repo-id="repo.id"
        :variant="pullVariant"
        :disabled="caretDisabled"
        :pull-disabled="pullDisabled"
        :status-diverged="statusDiverged"
        @pull="run('pull')"
      />
    </div>
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
    <!-- Nothing trails this row any more: refresh and the overflow (⋮) menu both moved up to the
         card's identity line, right of the remote-presence cloud under the repo title — see
         RepoCardChanges.vue and repo-card/RepoCardMenu.vue. (The right-hand `flex-1` spacer that
         used to push them over went with them.) -->
  </div>
</template>
