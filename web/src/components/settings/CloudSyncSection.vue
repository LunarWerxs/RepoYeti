<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Cloud, Check, ExternalLink, Loader2, RefreshCw, LogOut } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { fromNow } from "@/lib/util";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

const store = useStore();
const { t } = useI18n();

const confirmDisconnect = ref(false);

function signIn(): void {
  window.location.href = "/oauth/login";
}

/** Master toggle. ON with no connection yet → send through sign-in first. */
async function onToggle(enabled: boolean): Promise<void> {
  confirmDisconnect.value = false;
  if (enabled) {
    if (!store.owner) {
      signIn();
      return;
    }
    try {
      await store.enableSync();
    } catch {
      toast.error(t("settings.cloudSync.enableFailed"));
    }
  } else {
    try {
      await store.disableSync();
    } catch {
      toast.error(t("settings.cloudSync.disableFailed"));
    }
  }
}

async function syncNow(): Promise<void> {
  // pullSync/pushSync absorb a handled failure ({ok:false} with HTTP 200 — expired token,
  // rate-limit) into store.syncError and never rethrow, so catching alone would let a green
  // "pushDone" toast fire on the exact path that means nothing synced. Inspect the returned
  // status instead: only claim success on a genuinely ok + still-connected result.
  try {
    await store.pullSync();
  } catch {
    toast.error(t("settings.cloudSync.pullFailed"));
    return;
  }
  if (!store.syncStatus.ok || !store.syncStatus.connected) {
    toast.error(t("settings.cloudSync.pullFailed"));
    return;
  }
  try {
    await store.pushSync();
  } catch {
    toast.error(t("settings.cloudSync.pushFailed"));
    return;
  }
  if (!store.syncStatus.ok || !store.syncStatus.connected) {
    toast.error(t("settings.cloudSync.pushFailed"));
    return;
  }
  toast.success(t("settings.cloudSync.pushDone"));
}

/** Two-step confirm, matching the tunnel-forget / sign-out-all pattern elsewhere in Settings. */
async function disconnect(): Promise<void> {
  if (!confirmDisconnect.value) {
    confirmDisconnect.value = true;
    return;
  }
  confirmDisconnect.value = false;
  try {
    await store.disableSync(true);
  } catch {
    toast.error(t("settings.cloudSync.disableFailed"));
  }
}
</script>

<template>
  <SettingsGroup :label="$t('settings.cardCloudSync')" :description="$t('settings.cloudSync.privacyNote')">
    <!-- signed out entirely → the primary action is signing in with Connections -->
    <div v-if="!store.owner" class="flex flex-col gap-2.5 px-3.5 py-3">
      <span class="flex flex-col gap-0.5">
        <span class="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
          <Cloud :size="14" class="shrink-0 text-sky-500" />
          {{ $t("settings.cloudSync.title") }}
        </span>
        <span class="text-[12px] text-muted-foreground">{{ $t("settings.cloudSync.enableHint") }}</span>
      </span>
      <Button size="sm" class="self-start" @click="signIn">
        <Cloud />
        {{ $t("settings.cloudSync.signIn") }}
        <ExternalLink :size="14" class="opacity-70" />
      </Button>
    </div>

    <template v-else>
      <!-- Signed-in Connections account — THE one place it's shown (it used to float above the
           Access group, where it read as part of Git identity). This is the account that owns
           remote access AND cloud sync, so it lives with the feature that explains why it exists. -->
      <div class="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <div class="min-w-0">
          <div class="text-[11px] text-primary/80">{{ $t("identity.signedInWith") }}</div>
          <div class="mono truncate text-[13px] text-foreground/90">{{ store.owner }}</div>
        </div>
        <Button variant="ghost" size="sm" @click="store.logout()">
          <LogOut />
          {{ $t("identity.signOut") }}
        </Button>
      </div>

      <!-- master toggle -->
      <SettingsRow :label="$t('settings.cloudSync.enableLabel')">
        <template #info><InfoHint :text="$t('settings.cloudSync.enableHint')" /></template>
        <template #control>
          <Loader2 v-if="store.syncLoading" :size="15" class="animate-spin text-muted-foreground" />
          <Switch
            v-else
            :model-value="store.syncStatus.enabled"
            :aria-label="$t('settings.cloudSync.enableLabel')"
            @update:model-value="(v: boolean) => onToggle(v)"
          />
        </template>
      </SettingsRow>

      <!-- connecting / loading -->
      <div v-if="store.syncLoading && !store.syncStatus.enabled" class="flex items-center gap-2 px-3.5 py-3 text-[12.5px] text-muted-foreground">
        <Loader2 :size="14" class="animate-spin" />
        {{ $t("settings.cloudSync.connecting") }}
      </div>

      <!-- enabled + connected: signed-in identity, last-synced, sync now, disconnect -->
      <div v-else-if="store.syncStatus.enabled && store.syncStatus.connected" class="flex flex-col gap-2.5 px-3.5 py-3">
        <div class="flex items-center justify-between gap-3">
          <img v-if="store.ownerPicture" :src="store.ownerPicture" alt="" class="size-6 rounded-full object-cover shrink-0" />
          <span class="flex flex-col gap-0.5 min-w-0">
            <span class="truncate text-[12.5px] text-foreground/90">{{ $t("settings.cloudSync.signedInAs", { email: store.owner }) }}</span>
            <span class="flex items-center gap-1 text-[12px] text-success">
              <Check :size="12" class="shrink-0" />
              {{ store.syncStatus.lastSyncedAt ? $t("settings.cloudSync.syncedAgo", { time: fromNow(new Date(store.syncStatus.lastSyncedAt).getTime()) }) : $t("settings.cloudSync.neverSynced") }}
            </span>
          </span>
          <Button variant="outline" size="sm" class="shrink-0" :disabled="store.syncActionBusy" @click="syncNow">
            <Loader2 v-if="store.syncActionBusy" :size="14" class="animate-spin" />
            <RefreshCw v-else :size="14" />
            {{ $t("settings.cloudSync.syncNow") }}
          </Button>
        </div>
        <Button
          :variant="confirmDisconnect ? 'destructive' : 'ghost'"
          size="sm"
          class="self-start"
          @click="disconnect"
          @blur="confirmDisconnect = false"
        >
          <LogOut :size="14" />
          {{ confirmDisconnect ? $t("settings.cloudSync.disconnectConfirm") : $t("settings.cloudSync.disconnect") }}
        </Button>
      </div>

      <!-- enabled but not yet connected (fresh daemon restart, expired sync token). The owner IS
           signed in — the row above says so — so a bare "Sign in with Connections" button here
           read as the app contradicting itself. Name the state and offer the actual remedy. -->
      <div v-else-if="store.syncStatus.enabled" class="flex flex-col gap-2 px-3.5 py-3">
        <p class="text-[12px] text-muted-foreground">{{ $t("settings.cloudSync.notConnected") }}</p>
        <Button size="sm" variant="outline" class="self-start" @click="signIn">
          <RefreshCw :size="14" />
          {{ $t("settings.cloudSync.reconnect") }}
        </Button>
      </div>

      <!-- inline, non-blocking error -->
      <p v-if="store.syncError" class="px-3.5 pb-3 text-[11.5px] text-destructive">
        {{ store.syncError }}
        <template v-if="store.syncStatus.retryAfterSeconds">
          — {{ $t("settings.cloudSync.retryHint", { seconds: store.syncStatus.retryAfterSeconds }) }}
        </template>
      </p>
    </template>
  </SettingsGroup>
</template>
