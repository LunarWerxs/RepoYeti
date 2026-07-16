<script setup lang="ts">
// Machine-wide GitHub account switcher (via the `gh` CLI). The active account is what push/pull —
// and any tool using git's `gh auth git-credential` helper, including AI agents — authenticates as.
// Switching flips the active account AND aligns the credential username pin so it actually sticks
// (see src/gh-cli.ts). Commit authorship is separate — it lives under Identities.
import { reactive } from "vue";
import { ArrowLeftRight, Check, RefreshCw, Loader2, Link2, ChevronDown } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import { useStore } from "../store";
import { cn } from "@/lib/utils";
import { identityInitials, identityTint } from "@/lib/identity-display";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { GhAccount } from "../types";

// <Select> can't hold an empty value, so "no identity" rides this sentinel.
const NONE = "__none__";

const { t } = useI18n();
const store = useStore();

// Y4: the commit-identity picker takes space it doesn't earn on every account row, so it's
// behind progressive disclosure (collapsed by default, toggled open per-account; local,
// display-only state; nothing to persist). The linked identity's name still shows collapsed
// so the info isn't lost from view.
const linkOpen = reactive<Record<string, boolean>>({});
function toggleLink(a: GhAccount): void {
  linkOpen[a.login] = !linkOpen[a.login];
}

async function switchTo(a: GhAccount): Promise<void> {
  if (a.active || store.switchingAccount) return;
  try {
    await store.switchAccount(a.login, a.host);
    toast.success(t("accounts.toast.switched", { login: a.login }));
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("accounts.toast.switchFailed"));
  }
}

// Link/unlink a saved identity to an account (applied as the git author on the next switch).
async function onMap(a: GhAccount, value: string): Promise<void> {
  const identityId = value === NONE ? null : value;
  if (identityId === (a.identityId ?? null)) return; // no change
  try {
    await store.setAccountIdentity(a.login, identityId, a.host);
    toast.success(identityId ? t("accounts.toast.linked", { login: a.login }) : t("accounts.toast.unlinked", { login: a.login }));
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("accounts.toast.linkFailed"));
  }
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <SettingsGroup :label="$t('accounts.title')" :description="$t('accounts.description')">
    <div class="flex flex-col gap-3 px-3.5 py-3">
      <div class="flex items-center justify-end">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="$t('accounts.refresh')"
              :disabled="store.accountsLoading"
              @click="store.loadAccounts()"
            >
              <RefreshCw :class="store.accountsLoading && 'animate-spin'" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ $t("accounts.refresh") }}</TooltipContent>
        </Tooltip>
      </div>

      <!-- gh not installed / unreachable -->
      <div
        v-if="!store.ghAvailable && store.accountsReady"
        class="rounded-xl border border-dashed border-border px-3 py-6 text-center"
      >
        <div class="text-[13px] font-medium">{{ $t("accounts.unavailableTitle") }}</div>
        <p class="mt-1 text-[12px] text-muted-foreground">{{ $t("accounts.unavailableBody") }}</p>
      </div>

      <!-- authenticated accounts -->
      <div v-else-if="store.ghAccounts.length" v-auto-animate class="flex flex-col gap-2">
        <div
          v-for="a in store.ghAccounts"
          :key="`${a.host}/${a.login}`"
          class="flex items-center gap-3 rounded-xl border p-2.5"
          :class="a.active ? 'border-success/40 bg-success/5' : 'border-border bg-secondary/40'"
        >
          <span
            :class="cn('flex size-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold', identityTint(a.login))"
          >
            {{ identityInitials(a.login) }}
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <div class="truncate text-[14px] font-medium">{{ a.login }}</div>
              <span
                v-if="a.active"
                class="inline-flex shrink-0 items-center gap-1 rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"
              >
                <Check :size="11" /> {{ $t("accounts.active") }}
              </span>
            </div>
            <div class="mono truncate text-[12px] text-muted-foreground">
              {{ a.host }} · {{ a.gitProtocol }}
            </div>
            <div v-if="a.scopes.length" class="mono truncate text-[11px] text-muted-foreground/70">
              {{ a.scopes.join(", ") }}
            </div>
            <!-- commit-identity link: collapsed by default (progressive disclosure); a
                 compact summary shows the current state, the toggle reveals the picker.
                 Hidden outright when identities aren't in use (store's `identitiesRelevant`) —
                 its empty state reads "Add an identity above", which would point at a manager
                 that is itself hidden in that case. -->
            <div v-if="store.identitiesRelevant" class="mt-1.5 flex items-center gap-1.5">
              <span class="shrink-0 text-[11px] text-muted-foreground">{{ $t("accounts.linkLabel") }}:</span>
              <span class="truncate text-[11px] text-foreground/80">
                {{ a.identityId ? (store.identityById[a.identityId]?.displayName ?? $t("accounts.linkNotSet")) : $t("accounts.linkNotSet") }}
              </span>
              <Tooltip v-if="store.identities.length">
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="size-5 shrink-0 text-muted-foreground"
                    :aria-label="$t('accounts.linkToggle')"
                    :aria-expanded="!!linkOpen[a.login]"
                    @click="toggleLink(a)"
                  >
                    <Link2 :size="12" />
                    <ChevronDown :size="10" :class="cn('transition-transform', linkOpen[a.login] && 'rotate-180')" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ $t("accounts.linkToggle") }}</TooltipContent>
              </Tooltip>
              <span v-else class="text-[11px] text-muted-foreground/70">· {{ $t("accounts.linkEmpty") }}</span>
            </div>
            <ExpandTransition :open="!!linkOpen[a.login] && store.identities.length > 0 && store.identitiesRelevant">
              <div class="pt-1.5">
                <Select
                  :model-value="a.identityId ?? NONE"
                  @update:model-value="(v) => onMap(a, String(v))"
                >
                  <SelectTrigger class="h-7 w-full max-w-[13rem] text-[12px]" :aria-label="$t('accounts.linkLabel')">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="NONE">{{ $t("accounts.linkNone") }}</SelectItem>
                    <SelectItem v-for="i in store.identities" :key="i.id" :value="i.id">{{ i.displayName }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </ExpandTransition>
          </div>
          <Button
            v-if="!a.active"
            variant="secondary"
            size="sm"
            :disabled="!!store.switchingAccount"
            @click="switchTo(a)"
          >
            <Loader2 v-if="store.switchingAccount === a.login" class="animate-spin" />
            <ArrowLeftRight v-else />
            {{ $t("accounts.switch") }}
          </Button>
        </div>
      </div>

      <!-- gh present but no accounts logged in -->
      <div
        v-else-if="store.accountsReady"
        class="rounded-xl border border-dashed border-border py-8 text-center text-[13px] text-muted-foreground"
      >
        {{ $t("accounts.empty") }}
      </div>

      <!-- commit identity context (switching auth doesn't change authorship) -->
      <div class="rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
        <div class="text-[12px]">
          <span class="text-muted-foreground">{{ $t("accounts.commitIdentityLabel") }}:</span>
          <span
            v-if="store.gitCommitIdentity.name || store.gitCommitIdentity.email"
            class="mono ml-1 text-foreground/80"
          >
            {{ store.gitCommitIdentity.name }} · {{ store.gitCommitIdentity.email }}
          </span>
          <span v-else class="ml-1 text-muted-foreground/70">{{ $t("accounts.commitIdentityNone") }}</span>
        </div>
        <p class="mt-1 text-[11px] text-muted-foreground/70">{{ $t("accounts.commitIdentityNote") }}</p>
      </div>
    </div>
    </SettingsGroup>
  </div>
</template>
