<script setup lang="ts">
// Collapsed header row (drag handle, name/branch/badges, status pills, identity/sync-account
// dropdown, expand chevron), extracted from RepoCard. `expanded` drives both the aria state and
// the status-pill morph (see statusChip/statusWord below); RepoCard still owns `expanded` and the
// toggle() side effects (loading branches/changes/stashes on open) — this component just emits
// `toggle` for the row/keyboard/chevron interactions.
import { computed } from "vue";
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
import { cn } from "@/lib/utils";
import { fromNow } from "@/lib/util";
import { identityInitials, identityTint } from "@/lib/identity-display";
import { repoViolatesIdentityRule } from "@/lib/identity-firewall";
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
import type { Repo } from "../../types";

const props = withDefaults(defineProps<{ repo: Repo; draggable?: boolean; expanded: boolean }>(), {
  draggable: true,
});
const emit = defineEmits<{ toggle: [] }>();
const store = useStore();
const { t } = useI18n();

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

// ── sync account (which GitHub account this repo fetches/pulls/pushes as) ──────
function onAccount(a: { host: string; login: string } | null): void {
  void store.assignRepoAccount(props.repo.id, a?.host ?? null, a?.login ?? null);
}
</script>

<template>
  <!-- ── collapsed header row — the whole row toggles + highlights on hover ── -->
  <div
    role="button"
    tabindex="0"
    :aria-expanded="expanded"
    :aria-label="expanded ? $t('repo.collapse') : $t('repo.expand')"
    class="flex cursor-pointer items-center gap-1.5 rounded-md p-2 outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40 sm:gap-2 sm:p-2.5"
    @click="emit('toggle')"
    @keydown.enter.prevent="emit('toggle')"
    @keydown.space.prevent="emit('toggle')"
  >
    <!-- drag handle (hidden in filtered view, where reordering is disabled) -->
    <button
      v-if="draggable"
      class="drag-handle flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/60 outline-none transition-colors hover:bg-accent hover:text-muted-foreground active:bg-accent/70 active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring/40"
      :aria-label="$t('repo.dragToReorder')"
      @click.stop
    >
      <GripVertical :size="16" />
    </button>

    <!-- name + branch -->
    <div class="flex min-w-0 flex-1 items-center gap-2 px-0.5">
      <span class="truncate text-[15px] leading-tight font-semibold text-foreground">
        {{ repo.name }}
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
      <span
        v-if="repo.pinned"
        class="flex shrink-0 items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-primary"
        :title="$t('repo.badge.pinned')"
        :aria-label="$t('repo.badge.pinned')"
      >
        <Pin :size="11" />
      </span>
      <span
        v-if="repo.starred"
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
      <!-- aggregate line delta (left of ahead/changed); chars + breakdown on hover.
           Shown only when the diff-stats setting is on and the tree is dirty. -->
      <Tooltip v-if="store.diffStatsEnabled && st?.diff && st.dirty > 0">
        <TooltipTrigger as-child>
          <span class="inline-flex items-center"><DiffStat :stat="st?.diff" show="lines" /></span>
        </TooltipTrigger>
        <TooltipContent>
          {{ $t("repo.diffStat.lines", { added: st?.diff?.addedLines ?? 0, removed: st?.diff?.removedLines ?? 0 }) }}
          ·
          {{ $t("repo.diffStat.chars", { added: (st?.diff?.addedChars ?? 0).toLocaleString(), removed: (st?.diff?.removedChars ?? 0).toLocaleString() }) }}
        </TooltipContent>
      </Tooltip>
      <Tooltip v-if="st && st.behind > 0">
        <TooltipTrigger as-child>
          <span :class="statusChip('warning')" :aria-label="$t('repo.badge.behindLabel', { count: st.behind })">
            <ArrowDown :size="12" /><span class="ml-0.5">{{ st.behind }}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {{ $t("repo.badge.behindTooltip", { count: st.behind }) }}{{ st.fetchedAt ? ` · ${fromNow(st.fetchedAt)}` : "" }}
        </TooltipContent>
      </Tooltip>
      <span
        v-if="st && st.ahead > 0"
        :class="statusChip('success')"
        :title="$t('repo.badge.aheadLabel', { count: st.ahead })"
        :aria-label="$t('repo.badge.aheadLabel', { count: st.ahead })"
      >
        <ArrowUp :size="12" /><span class="ml-0.5">{{ st.ahead }}</span
        ><span :class="statusWord">&nbsp;{{ $t("repo.badge.ahead") }}</span>
      </span>
      <span
        v-if="st && st.dirty > 0"
        :class="statusChip('warning')"
        :title="$t('repo.badge.changedLabel', { count: st.dirty })"
        :aria-label="$t('repo.badge.changedLabel', { count: st.dirty })"
      >
        <Pencil :size="12" /><span class="ml-0.5">{{ st.dirty }}</span
        ><span :class="statusWord">&nbsp;{{ $t("repo.badge.changed") }}</span>
      </span>
      <span v-if="isClean" :class="statusChip('muted')" :title="$t('repo.badge.clean')" :aria-label="$t('repo.badge.clean')">
        <Check :size="12" /><span :class="statusWord">&nbsp;{{ $t("repo.badge.clean") }}</span>
      </span>
      <AlertTriangle v-if="st?.error" :size="14" class="text-destructive" />
    </div>

    <!-- identity avatar → dropdown picker (stops row toggle; no Tooltip wrapper —
         stacking two as-child triggers on one element breaks reka's popper anchor) -->
    <DropdownMenu>
      <DropdownMenuTrigger
        :title="[
          repo.syncAccountLogin ? `Syncs as ${repo.syncAccountLogin}` : null,
          identity ? `${identity.displayName} · ${identity.gitEmail}` : null,
        ].filter(Boolean).join(' · ') || $t('repo.identity.setTitle')"
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
        :aria-label="$t('repo.identity.setTitle')"
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
            <span class="flex-1">{{ $t("repo.syncAccount.machineDefault") }}</span>
            <Check v-if="!repo.syncAccountLogin" :size="15" class="text-primary" />
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
          <DropdownMenuSeparator />
        </template>

        <!-- git commit author (the name/email commits are made under) -->
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
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- expand chevron (keyboard/AT toggle; .stop so the row handler doesn't double-fire) -->
    <button
      class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-all hover:bg-accent hover:text-foreground active:scale-90 active:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/40"
      :aria-label="expanded ? $t('repo.collapse') : $t('repo.expand')"
      :aria-expanded="expanded"
      @click.stop="emit('toggle')"
    >
      <ChevronDown :size="17" :class="cn('transition-transform duration-200', expanded && 'rotate-180')" />
    </button>
  </div>
</template>
