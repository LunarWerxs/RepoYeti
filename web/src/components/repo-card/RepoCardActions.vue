<script setup lang="ts">
// Git action buttons (fetch/pull/push/stash), extracted from RepoCard. Per-VCS capabilities
// (mirrors the daemon) drive which controls this shows — see VCS_CAPABILITIES. Refresh and the
// overflow (⋮) menu both live in the card's identity line now (see RepoCardChanges.vue and
// repo-card/RepoCardMenu.vue) — the busy state they and this component read is the store's shared
// per-repo `busy` map, so their spinners (and any action's disabled state here) can never disagree.
import { computed } from "vue";
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
// Pull goes accent when there is actually something to pull. Computed once and handed to BOTH
// halves of the split button, so the caret can never disagree with the button it is attached to.
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
  st.value && st.value.behind > 0 ? "default" : "outline",
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
              :disabled="!hasUpstream || anyBusy"
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
        :disabled="!hasUpstream || anyBusy"
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
