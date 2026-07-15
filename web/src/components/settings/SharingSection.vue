<script setup lang="ts">
/**
 * Settings → Access → Sharing. Mint, list, and revoke share links.
 *
 * The one screen in RepoYeti that hands someone else access to this machine, so it's written to
 * make the consequences legible BEFORE the link exists (what the tier actually permits, which
 * repos, how long) rather than explaining them afterwards. It lives under Access, next to the
 * remote-access toggle, because a link is worthless without a tunnel — and the panel says so
 * instead of minting a link that silently can't be opened.
 */
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Copy, Link2, Loader2, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { api, ApiError } from "../../api";
import type { Share, ShareDuration, SharePerm } from "../../types";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import InfoHint from "@/shell/InfoHint.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

const shares = ref<Share[]>([]);
const loading = ref(false);
const creating = ref(false);
/** Which link's revoke button is armed (inline two-step confirm, as elsewhere in Settings). */
const confirmRevoke = ref<string | null>(null);
/** The freshly-minted link. The ONLY moment its token exists client-side — once this clears, it's
 *  gone for good (the daemon stored only a hash), so it stays until the owner dismisses it. */
const minted = ref<{ url: string; label: string } | null>(null);
const copied = ref(false);

// ── the create form ────────────────────────────────────────────────────────────
const label = ref("");
const perm = ref<SharePerm>("view");
const duration = ref<ShareDuration>("week");
const scopeAll = ref(false);
const picked = ref<Set<string>>(new Set());

const isRemote = computed(() => store.mode === "remote");
const canSubmit = computed(
  () => label.value.trim().length > 0 && (scopeAll.value || picked.value.size > 0) && !creating.value,
);

const DURATIONS: ShareDuration[] = ["hour", "day", "week", "month", "year", "never"];

/** Static t() calls, not `t(\`share.duration.${d}\`)`: scripts/i18n-check.mjs only sees literal
 *  keys, so a template-literal lookup would report every duration key as unused. */
function durationLabel(d: ShareDuration): string {
  switch (d) {
    case "hour":
      return t("share.duration.hour");
    case "day":
      return t("share.duration.day");
    case "week":
      return t("share.duration.week");
    case "month":
      return t("share.duration.month");
    case "year":
      return t("share.duration.year");
    default:
      return t("share.duration.never");
  }
}

function resetForm(): void {
  label.value = "";
  perm.value = "view";
  duration.value = "week";
  scopeAll.value = false;
  picked.value = new Set();
}

function togglePick(id: string): void {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    shares.value = (await api.listShares()).shares;
  } catch {
    /* the panel just shows empty — nothing actionable to say */
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  if (!canSubmit.value) return;
  creating.value = true;
  try {
    const res = await api.createShare({
      label: label.value.trim(),
      perm: perm.value,
      duration: duration.value,
      scopeAll: scopeAll.value,
      repoIds: scopeAll.value ? [] : [...picked.value],
    });
    // Build the URL against the tunnel origin when we know it: the owner is very likely reading
    // this on localhost, and a localhost link is useless to the person they're sending it to.
    const origin = store.tunnelUrl ?? window.location.origin;
    minted.value = { url: `${origin.replace(/\/$/, "")}/s/${res.token}`, label: res.share.label };
    copied.value = false;
    resetForm();
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("share.createFailed"));
  } finally {
    creating.value = false;
  }
}

async function copyLink(): Promise<void> {
  if (!minted.value) return;
  try {
    await navigator.clipboard.writeText(minted.value.url);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    toast.error(t("share.copyFailed"));
  }
}

async function revoke(id: string): Promise<void> {
  if (confirmRevoke.value !== id) {
    confirmRevoke.value = id; // first click arms
    return;
  }
  confirmRevoke.value = null;
  try {
    await api.revokeShare(id);
    await load();
    toast.success(t("share.revoked"));
  } catch {
    toast.error(t("share.revokeFailed"));
  }
}

/** "in 6 days" / "Expired" / "Never expires" — the thing the owner actually scans this list for. */
function expiryLabel(s: Share): string {
  if (s.expiresAt === null) return t("share.neverExpires");
  const left = s.expiresAt - Date.now();
  if (left <= 0) return t("share.expired");
  const days = Math.floor(left / 86_400_000);
  if (days >= 1) return t("share.expiresInDays", { n: days });
  const hours = Math.max(1, Math.floor(left / 3_600_000));
  return t("share.expiresInHours", { n: hours });
}

function usageLabel(s: Share): string {
  if (!s.lastUsedAt) return t("share.neverOpened");
  return t("share.opened", { n: s.useCount });
}

function repoLabel(s: Share): string {
  if (s.scopeAll) return t("share.allRepos");
  return t("share.nRepos", { n: s.repoIds.length });
}

// `immediate: true` is load-bearing, not a habit. The Settings sheet is a Reka DialogRoot, which
// only MOUNTS its content when it opens — so by the time this component exists, `open` is already
// true and a plain watcher never sees a false→true edge. Without `immediate`, load() never runs and
// the panel permanently claims "No share links yet" while the owner's links sit there in the API.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      confirmRevoke.value = null;
      minted.value = null;
      resetForm();
      void load();
    }
  },
  { immediate: true },
);
</script>

<template>
  <SettingsGroup :label="$t('share.card')">
    <!-- A share link is reachable only over the tunnel. Rather than mint one that can't be
         opened, say so and point at the toggle directly above this panel. -->
    <div v-if="!isRemote" class="px-3.5 py-3">
      <p class="text-[12.5px] leading-snug text-muted-foreground">{{ $t("share.needsRemote") }}</p>
    </div>

    <template v-else>
      <!-- The freshly-minted link: shown once, and only once. -->
      <div v-if="minted" class="mx-3.5 my-3 flex flex-col gap-2.5 rounded-lg border border-success/30 bg-success/10 p-3">
        <div class="flex items-center gap-1.5">
          <Link2 :size="13" class="shrink-0 text-success" />
          <span class="text-[12.5px] font-medium text-foreground">{{ $t("share.readyTitle", { label: minted.label }) }}</span>
        </div>
        <p class="text-[11.5px] leading-snug text-muted-foreground">{{ $t("share.readyOnce") }}</p>
        <code class="mono block break-all rounded bg-background/60 px-2 py-1.5 text-[11px] text-foreground/90">{{ minted.url }}</code>
        <div class="flex items-center gap-2">
          <Button size="sm" @click="copyLink">
            <Check v-if="copied" />
            <Copy v-else />
            {{ copied ? $t("share.copied") : $t("share.copy") }}
          </Button>
          <Button variant="ghost" size="sm" class="ml-auto" @click="minted = null">{{ $t("common.close") }}</Button>
        </div>
      </div>

      <!-- Existing links -->
      <div v-if="loading" class="px-3.5 py-3">
        <Loader2 :size="14" class="animate-spin text-muted-foreground" />
      </div>
      <div v-else-if="shares.length === 0" class="px-3.5 py-3">
        <p class="text-[12.5px] text-muted-foreground">{{ $t("share.none") }}</p>
      </div>
      <div
        v-for="s in shares"
        v-else
        :key="s.id"
        class="flex items-center justify-between gap-3 border-t border-border/40 px-3.5 py-2.5 first:border-t-0"
        :class="{ 'opacity-55': !s.live }"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-[12.5px] font-medium text-foreground">{{ s.label }}</span>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
              :class="s.perm === 'control' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground'"
            >
              {{ s.perm === "control" ? $t("share.tierControl") : $t("share.tierView") }}
            </span>
          </div>
          <div class="mt-0.5 truncate text-[11px] text-muted-foreground">
            {{ repoLabel(s) }} · {{ expiryLabel(s) }} · {{ usageLabel(s) }}
          </div>
        </div>
        <Button
          :variant="confirmRevoke === s.id ? 'destructive' : 'ghost'"
          size="sm"
          class="shrink-0"
          @click="revoke(s.id)"
          @blur="confirmRevoke = null"
        >
          <Trash2 />
          {{ confirmRevoke === s.id ? $t("share.revokeConfirm") : $t("share.revoke") }}
        </Button>
      </div>

      <!-- Create ─────────────────────────────────────────────────────── -->
      <div class="flex flex-col gap-2.5 border-t border-border/40 px-3.5 py-3">
        <div class="flex items-center gap-1.5">
          <span class="text-[12.5px] font-medium text-foreground">{{ $t("share.newTitle") }}</span>
          <InfoHint :text="$t('share.newHint')" />
        </div>

        <Input
          v-model="label"
          class="text-[12.5px]"
          :placeholder="$t('share.labelPlaceholder')"
          :aria-label="$t('share.labelLabel')"
        />

        <!-- Tier. Spelled out rather than named, because "control" is the decision that matters. -->
        <div class="flex gap-1.5">
          <button
            v-for="p in (['view', 'control'] as SharePerm[])"
            :key="p"
            type="button"
            class="flex-1 rounded-lg border px-2.5 py-2 text-left transition-colors"
            :class="perm === p ? 'border-primary/60 bg-primary/10' : 'border-border/60 hover:bg-muted/40'"
            @click="perm = p"
          >
            <div class="text-[12px] font-medium text-foreground">
              {{ p === "view" ? $t("share.tierView") : $t("share.tierControl") }}
            </div>
            <div class="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
              {{ p === "view" ? $t("share.tierViewHint") : $t("share.tierControlHint") }}
            </div>
          </button>
        </div>

        <!-- Duration -->
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="d in DURATIONS"
            :key="d"
            type="button"
            class="rounded-md border px-2 py-1 text-[11.5px] transition-colors"
            :class="duration === d ? 'border-primary/60 bg-primary/10 text-foreground' : 'border-border/60 text-muted-foreground hover:bg-muted/40'"
            @click="duration = d"
          >
            {{ durationLabel(d) }}
          </button>
        </div>

        <!-- Scope -->
        <div class="flex items-center justify-between gap-3 pt-0.5">
          <span class="flex items-center gap-1.5">
            <span class="text-[12px] text-foreground">{{ $t("share.scopeAll") }}</span>
            <InfoHint :text="$t('share.scopeAllHint')" />
          </span>
          <Switch :model-value="scopeAll" :aria-label="$t('share.scopeAll')" @update:model-value="(v: boolean) => (scopeAll = v)" />
        </div>

        <!-- Repo picker — collapsed away entirely when sharing everything. -->
        <div v-if="!scopeAll" class="max-h-44 overflow-y-auto rounded-lg border border-border/60">
          <button
            v-for="r in store.repos"
            :key="r.id"
            type="button"
            class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
            @click="togglePick(r.id)"
          >
            <span
              class="grid size-3.5 shrink-0 place-items-center rounded border"
              :class="picked.has(r.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"
            >
              <Check v-if="picked.has(r.id)" :size="10" />
            </span>
            <span class="truncate text-[12px] text-foreground">{{ r.name }}</span>
          </button>
        </div>

        <Button size="sm" class="self-start" :disabled="!canSubmit" @click="create">
          <Loader2 v-if="creating" class="animate-spin" />
          <Link2 v-else />
          {{ $t("share.create") }}
        </Button>
      </div>
    </template>
  </SettingsGroup>
</template>
