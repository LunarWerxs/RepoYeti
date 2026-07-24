<script setup lang="ts">
// Collapsed header row (drag handle, name/branch/badges, status pills, identity/sync-account
// dropdown, expand chevron), extracted from RepoCard. `expanded` drives both the aria state and
// the status-pill morph (see statusChip/statusWord below); RepoCard still owns `expanded` and the
// toggle() side effects (loading branches/changes/stashes on open) — this component just emits
// `toggle` for the row/keyboard/chevron interactions.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  GitBranch,
  ArrowUp,
  ArrowDown,
  Pencil,
  AlertTriangle,
  Check,
  ChevronDown,
  GripVertical,
  User,
  AtSign,
  Pin,
  Star,
  Timer,
  EyeOff,
  ShieldAlert,
} from "@lucide/vue";
import { useStore } from "../../store";
import { api } from "../../api";
import type { ResolvedRepoAccount } from "../../types";
import { cn } from "@/lib/utils";
import { fromNow } from "@/lib/util";
import { identityInitials, identityTint } from "@/lib/identity-display";
import { repoViolatesIdentityRule } from "@/lib/identity-firewall";
import { isSelected, selectionActive, toggleSelected } from "@/lib/repo-selection";
import DiffStat from "../DiffStat.vue";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useTooltipConfig } from "@/lib/tooltip-config";
import type { Repo } from "../../types";

const props = withDefaults(
  defineProps<{
    repo: Repo;
    draggable?: boolean;
    expanded: boolean;
    /** Which dashboard section this card is rendered in — see RepoList.vue. Lets the header drop
     *  the badge the section heading already states. */
    section?: "pinned" | "starred" | "other";
  }>(),
  { draggable: true, section: "other" },
);
const emit = defineEmits<{ toggle: [] }>();
const store = useStore();
const { t } = useI18n();
// Dropdown triggers can't take the reka Tooltip wrapper (stacked as-child triggers break the
// popper anchor), so their native :title is gated on the same "show tooltips" setting instead.
const { enabled: tooltipsEnabled } = useTooltipConfig();

// ── multi-select mode ─────────────────────────────────────────────────────────
// While the dashboard is selecting, the row picks/unpicks this repo instead of expanding it,
// and the identity dropdown + expand chevron step aside (they'd act on a card you can't see).
const selecting = selectionActive;
const picked = computed(() => isSelected(props.repo.id));
const rowLabel = computed(() => {
  if (selecting.value) return t("repo.selectToggle", { name: props.repo.displayName || props.repo.name });
  return props.expanded ? t("repo.collapse") : t("repo.expand");
});
function onRowActivate(): void {
  if (selecting.value) toggleSelected(props.repo.id);
  else emit("toggle");
}

const st = computed(() => props.repo.status);
const isClean = computed(
  () =>
    st.value &&
    !st.value.error &&
    st.value.ahead === 0 &&
    st.value.behind === 0 &&
    st.value.dirty === 0,
);

// ── status-pill morph ─────────────────────────────────────────────────────────
// The collapsed header and the expanded view share ONE set of status indicators
// instead of swapping two markups (which snaps). Collapsed they read as bare
// coloured "icon + count" text; expanded they fill into pills with a trailing word
// ("ahead" / "changed" / "clean"). Background, padding, and the word reveal all
// animate off `expanded`, so toggling grows the pill in/out smoothly.
type StatusTone = "success" | "info" | "warning" | "muted";
const STATUS_BG: Record<StatusTone, string> = {
  success: "bg-success/15",
  info: "bg-info/15",
  warning: "bg-warning/15",
  muted: "bg-secondary",
};
const STATUS_TEXT: Record<StatusTone, string> = {
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  muted: "text-muted-foreground",
};
function statusChip(tone: StatusTone): string {
  return cn(
    "inline-flex items-center rounded-md transition-all duration-200 ease-out",
    STATUS_TEXT[tone],
    props.expanded ? `${STATUS_BG[tone]} px-1.5 py-0.5` : "bg-transparent px-0 py-0",
  );
}
// Trailing word: width-0 + transparent when collapsed (and on mobile, where the pill
// stays count-only); on ≥sm screens it slides + fades in once expanded. max-width
// (not a grid 1fr track) keeps the reveal animatable on every browser we target.
const statusWord = computed(() =>
  cn(
    "overflow-hidden whitespace-nowrap opacity-0 max-w-0 transition-[max-width,opacity] duration-200 ease-out",
    props.expanded && "sm:max-w-[7rem] sm:opacity-100",
  ),
);

// ── identity (avatar dropdown) ────────────────────────────────────────────────
const identity = computed(() =>
  props.repo.identityId ? (store.identityById[props.repo.identityId] ?? null) : null,
);

// ⭐ Identity Firewall: does this repo currently violate a pinned-identity rule? Display-only —
// the daemon is the one that actually hard-blocks the mutating action.
const identityViolation = computed(() => repoViolatesIdentityRule(props.repo, store.identityRules));
const identityViolationTitle = computed(() => {
  const rule = identityViolation.value;
  if (!rule) return "";
  const name = store.identityById[rule.requiredIdentityId]?.displayName ?? rule.requiredIdentityId;
  return t("repo.badge.identityViolation", { name });
});
function onIdentity(id: string | null): void {
  void store.assignIdentity(props.repo.id, id);
}

// What this dropdown actually offers depends on whether identities are in play (see the store's
// `identitiesRelevant`). With one git identity the menu is GitHub accounts only, so calling the
// button "Set git identity" would name the one thing it can't do — and it's the only label a
// screen reader gets.
const triggerLabel = computed(() =>
  store.identitiesRelevant ? t("repo.identity.setTitle") : t("repo.syncAccount.setTitle"),
);

// ── sync account (which GitHub account this repo fetches/pulls/pushes as) ──────
function onAccount(a: { host: string; login: string } | null): void {
  void store.assignRepoAccount(props.repo.id, a?.host ?? null, a?.login ?? null);
}

// What the repo will sync as when nothing is pinned. A repo usually answers this itself — via its
// own credential username, a remote it owns, or GitHub's push permissions — and the menu has to say
// so: ticking "Automatic" while the sync authenticates as somebody else is the exact confusion that made the
// original "could not read Password" failure unreadable. Fetched on open (it shells out to git on
// the daemon), and only when it would actually be shown.
const resolvedAccount = ref<ResolvedRepoAccount | null>(null);
function onMenuToggle(open: boolean): void {
  if (!open || props.repo.syncAccountLogin) return;
  void api.repoAccountResolution(props.repo.id).then(
    (r) => (resolvedAccount.value = r),
    () => (resolvedAccount.value = null), // best-effort: the menu just shows nothing extra
  );
}
/** The auto-detected account, only while no explicit pin overrides it. */
const detected = computed(() =>
  props.repo.syncAccountLogin ? null : resolvedAccount.value,
);
const detectedReason = computed(() => {
  if (detected.value?.source === "permission") return t("repo.syncAccount.fromPermission");
  if (detected.value?.source === "remote") return t("repo.syncAccount.fromRemote");
  return t("repo.syncAccount.fromGitConfig");
});
</script>

<template>
  <!-- ── collapsed header row — the whole row toggles + highlights on hover ── -->
  <div
    role="button"
    tabindex="0"
    :aria-expanded="selecting ? undefined : expanded"
    :aria-pressed="selecting ? picked : undefined"
    :aria-label="rowLabel"
    class="group flex cursor-pointer items-center gap-1 rounded-md p-2 outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40 sm:gap-1.5 sm:p-2.5"
    :class="selecting && picked && 'bg-primary/10'"
    @click="onRowActivate"
    @keydown.enter.prevent="onRowActivate"
    @keydown.space.prevent="onRowActivate"
  >
    <!-- In multi-select mode the drag handle's slot becomes the selection checkbox — same
         position, so rows don't reflow when the mode flips. See @/lib/repo-selection. -->
    <!-- Same WIDTH as the drag handle below, so flipping into select mode doesn't shift the
         name sideways. -->
    <span
      v-if="selecting"
      class="flex h-7 w-4 shrink-0 items-center justify-center"
      aria-hidden="true"
    >
      <span
        class="flex size-4 items-center justify-center rounded-[4px] border transition-colors"
        :class="picked ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70 bg-card/70'"
      >
        <Check v-if="picked" :size="12" />
      </span>
    </span>
    <!-- drag handle: hidden entirely when a preset sort is active (draggable=false, since
         dragging is meaningless then; see RepoList.vue); otherwise rendered but only
         revealed on row hover/focus, so it doesn't clutter the row at rest.
         Only as wide as the grip glyph — a 28px square reserved a visible gutter to the left of
         every repo name for a control that is invisible at rest. No hover plate either: the
         grab cursor already says "drag me", which is the convention everywhere else. The
         focus-visible ring STAYS, because that is the only cue a keyboard user gets. -->
    <button
      v-else-if="draggable"
      class="drag-handle flex h-7 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground/60 opacity-0 outline-none transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 hover:text-muted-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing"
      :aria-label="$t('repo.dragToReorder')"
      @click.stop
    >
      <GripVertical :size="16" />
    </button>

    <!-- name + branch. `displayName` is the owner's label (Rename); `name` is the folder on
         disk and the fallback. The folder name stays reachable as the title so a renamed card
         never hides where it actually lives. -->
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <span
        class="truncate text-[15px] leading-tight font-semibold text-foreground"
        :title="tooltipsEnabled && repo.displayName ? repo.name : undefined"
      >
        {{ repo.displayName || repo.name }}
      </span>
      <span
        v-if="st?.branch"
        :class="
          cn(
            'mono hidden shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] sm:inline-flex',
            st.detached ? 'bg-warning/15 text-warning' : 'bg-secondary text-muted-foreground',
          )
        "
      >
        <GitBranch :size="11" />{{ st.detached ? "detached" : st.branch }}
      </span>
      <span
        v-if="repo.vcs !== 'git'"
        class="mono flex shrink-0 items-center rounded-md bg-info/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-info uppercase"
      >
        {{ repo.vcs }}
      </span>
      <!-- Pinned/Starred badges are suppressed inside their OWN section: the section heading
           right above the card already says "Pinned" / "Starred", so the icon is pure noise
           there. They still show anywhere the card appears outside that section. -->
      <span
        v-if="repo.pinned && section !== 'pinned'"
        class="flex shrink-0 items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-primary"
        :title="$t('repo.badge.pinned')"
        :aria-label="$t('repo.badge.pinned')"
      >
        <Pin :size="11" />
      </span>
      <span
        v-if="repo.starred && section !== 'starred'"
        class="flex shrink-0 items-center rounded-md bg-warning/15 px-1.5 py-0.5 text-warning"
        :title="$t('repo.badge.starred')"
        :aria-label="$t('repo.badge.starred')"
      >
        <Star :size="11" class="fill-current" />
      </span>
      <span
        v-if="repo.autoCommit"
        class="flex shrink-0 items-center rounded-md bg-success/15 px-1.5 py-0.5 text-success"
        :title="$t('repo.badge.autoCommit')"
        :aria-label="$t('repo.badge.autoCommit')"
      >
        <Timer :size="11" />
      </span>
      <span
        v-if="repo.hidden"
        class="flex shrink-0 items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground"
        :title="$t('repo.badge.hidden')"
        :aria-label="$t('repo.badge.hidden')"
      >
        <EyeOff :size="11" />
      </span>
      <Tooltip v-if="identityViolation">
        <TooltipTrigger as-child>
          <span
            class="flex shrink-0 items-center gap-1 rounded-md bg-destructive/15 px-1.5 py-0.5 text-destructive"
            :aria-label="identityViolationTitle"
          >
            <ShieldAlert :size="11" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ identityViolationTitle }}</TooltipContent>
      </Tooltip>
    </div>

    <!-- status indicators — ONE set that morphs between bare "icon + count" text
         (collapsed) and filled pills with a trailing word (expanded); see statusChip
         / statusWord. Order mirrors the pull→push flow: behind, ahead, dirty, clean. -->
    <div class="flex shrink-0 items-center gap-1.5 text-[12px] font-medium">
      <Tooltip v-if="st && st.behind > 0">
        <TooltipTrigger as-child>
          <!-- `info` (blue), NOT warning: "behind" was previously the same amber as "changed",
               so two unrelated numbers sitting side by side read as one thing. Blue also matches
               the remote-presence cloud, so incoming-from-remote shares a colour language:
               blue = comes from the remote, green = goes to it, amber = uncommitted here. -->
          <span :class="statusChip('info')" :aria-label="$t('repo.badge.behindLabel', { count: st.behind })">
            <ArrowDown :size="12" /><span class="ml-0.5">{{ st.behind }}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {{ $t("repo.badge.behindTooltip", { count: st.behind }) }}{{ st.fetchedAt ? ` · ${fromNow(st.fetchedAt)}` : "" }}
        </TooltipContent>
      </Tooltip>
      <Tooltip v-if="st && st.ahead > 0">
        <TooltipTrigger as-child>
          <span :class="statusChip('success')" :aria-label="$t('repo.badge.aheadLabel', { count: st.ahead })">
            <ArrowUp :size="12" /><span class="ml-0.5">{{ st.ahead }}</span
            ><span :class="statusWord">&nbsp;{{ $t("repo.badge.ahead") }}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ $t("repo.badge.aheadLabel", { count: st.ahead }) }}</TooltipContent>
      </Tooltip>
      <!-- Dirty-tree stats read as a pair: how many FILES, then how many LINES. Collapsed they
           are bare coloured numbers; expanded each fills into a pill and reveals its noun
           ("12 files changed" · "+340 −87 lines"), via the same statusChip/statusWord morph as
           every other indicator here. -->
      <Tooltip v-if="st && st.dirty > 0">
        <TooltipTrigger as-child>
          <span :class="statusChip('warning')" :aria-label="$t('repo.badge.changedLabel', { count: st.dirty })">
            <Pencil :size="12" /><span class="ml-0.5">{{ st.dirty }}</span
            ><span :class="statusWord">&nbsp;{{ $t("repo.badge.filesChanged") }}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ $t("repo.badge.changedLabel", { count: st.dirty }) }}</TooltipContent>
      </Tooltip>
      <!-- Aggregate line delta. Present only when the daemon actually computed it (the
           "diff stats" setting drives that — with it off there is no `st.diff` to show). -->
      <Tooltip v-if="st?.diff && st.dirty > 0">
        <TooltipTrigger as-child>
          <span :class="statusChip('muted')" :aria-label="$t('repo.diffStat.lines', { added: st.diff.addedLines, removed: st.diff.removedLines })">
            <DiffStat :stat="st.diff" show="lines" /><span :class="statusWord">&nbsp;{{ $t("repo.badge.lines") }}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {{ $t("repo.diffStat.lines", { added: st.diff.addedLines, removed: st.diff.removedLines }) }}
          ·
          {{ $t("repo.diffStat.chars", { added: (st.diff.addedChars ?? 0).toLocaleString(), removed: (st.diff.removedChars ?? 0).toLocaleString() }) }}
        </TooltipContent>
      </Tooltip>
      <Tooltip v-if="isClean">
        <TooltipTrigger as-child>
          <span :class="statusChip('muted')" :aria-label="$t('repo.badge.clean')">
            <Check :size="12" /><span :class="statusWord">&nbsp;{{ $t("repo.badge.clean") }}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ $t("repo.badge.clean") }}</TooltipContent>
      </Tooltip>
      <AlertTriangle v-if="st?.error" :size="14" class="text-destructive" />
    </div>

    <!-- identity avatar → dropdown picker (stops row toggle; no Tooltip wrapper —
         stacking two as-child triggers on one element breaks reka's popper anchor, so the
         hover hint is a native :title, gated on the "show tooltips" setting) -->
    <DropdownMenu
      v-if="!selecting && !store.isGuest && (store.ghAccounts.length > 0 || store.identitiesRelevant)"
      @update:open="onMenuToggle"
    >
      <DropdownMenuTrigger
        :title="tooltipsEnabled ? ([
          repo.syncAccountLogin ? `Syncs as ${repo.syncAccountLogin}` : null,
          identity ? `${identity.displayName} · ${identity.gitEmail}` : null,
        ].filter(Boolean).join(' · ') || triggerLabel) : undefined"
        :class="
          cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold outline-none transition hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/50',
            repo.syncAccountLogin
              ? 'bg-primary/15 text-primary'
              : identity
                ? identityTint(identity.id)
                : 'bg-secondary text-muted-foreground hover:bg-accent',
          )
        "
        :aria-label="triggerLabel"
        @click.stop
      >
        <span v-if="repo.syncAccountLogin">{{ identityInitials(repo.syncAccountLogin) }}</span>
        <span v-else-if="identity">{{ identityInitials(identity.displayName) }}</span>
        <User v-else :size="15" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-64">
        <!-- which GitHub account this repo pushes / pulls as (auto-switched on sync) -->
        <template v-if="store.ghAccounts.length">
          <DropdownMenuLabel>{{ $t("repo.syncAccount.dropdownLabel") }}</DropdownMenuLabel>
          <DropdownMenuItem class="text-muted-foreground" @select="onAccount(null)">
            <AtSign :size="15" />
            <div class="min-w-0 flex-1">
              <div class="truncate">{{ $t("repo.syncAccount.machineDefault") }}</div>
              <!-- Not pinned, but not a free-for-all either: name the account this repo resolves
                   to on its own, and why, so "Automatic" isn't read as "syncs as whoever". -->
              <div v-if="detected" class="truncate text-[11px] text-muted-foreground/80">
                {{ $t("repo.syncAccount.detected", { login: detected.login }) }} · {{ detectedReason }}
              </div>
            </div>
            <Check v-if="!repo.syncAccountLogin" :size="15" class="shrink-0 text-primary" />
          </DropdownMenuItem>
          <DropdownMenuItem
            v-for="a in store.ghAccounts"
            :key="`${a.host}/${a.login}`"
            @select="onAccount(a)"
          >
            <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-muted-foreground">{{ identityInitials(a.login) }}</span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px]">{{ a.login }}</div>
              <div class="mono truncate text-[11px] text-muted-foreground">{{ a.host }}</div>
            </div>
            <Check
              v-if="repo.syncAccountLogin === a.login && (repo.syncAccountHost || 'github.com') === a.host"
              :size="15"
              class="ml-1 shrink-0 text-primary"
            />
          </DropdownMenuItem>
          <!-- only divides if there's an identity block below it to divide from -->
          <DropdownMenuSeparator v-if="store.identitiesRelevant" />
        </template>

        <!-- git commit author (the name/email commits are made under). Hidden entirely unless
             the owner actually juggles more than one — with a single identity there is no
             choice to make here, only noise on every card. See store's `identitiesRelevant`. -->
        <template v-if="store.identitiesRelevant">
          <DropdownMenuLabel>{{ $t("repo.identity.dropdownLabel") }}</DropdownMenuLabel>
          <DropdownMenuItem class="text-muted-foreground" @select="onIdentity(null)">
            <User :size="15" />
            <span class="flex-1">{{ $t("repo.identity.noIdentity") }}</span>
            <Check v-if="!repo.identityId" :size="15" class="text-primary" />
          </DropdownMenuItem>
          <DropdownMenuItem
            v-for="i in store.identities"
            :key="i.id"
            @select="onIdentity(i.id)"
          >
            <span
              :class="cn('flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold', identityTint(i.id))"
              >{{ identityInitials(i.displayName) }}</span
            >
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px]">{{ i.displayName }}</div>
              <div class="mono truncate text-[11px] text-muted-foreground">{{ i.gitEmail }}</div>
            </div>
            <Check v-if="repo.identityId === i.id" :size="15" class="ml-1 shrink-0 text-primary" />
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- expand chevron (keyboard/AT toggle; .stop so the row handler doesn't double-fire).
         Hidden while selecting — the row means "pick this one" then, not "open it". -->
    <button
      v-if="!selecting"
      class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-all hover:bg-accent hover:text-foreground active:scale-90 active:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/40"
      :aria-label="expanded ? $t('repo.collapse') : $t('repo.expand')"
      :aria-expanded="expanded"
      @click.stop="emit('toggle')"
    >
      <ChevronDown :size="17" :class="cn('transition-transform duration-200', expanded && 'rotate-180')" />
    </button>
  </div>
</template>
