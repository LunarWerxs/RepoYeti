<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Cloud, Check, ExternalLink, Loader2, RefreshCw, LogOut } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { fromNow } from "@/lib/util";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
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
  try {
    await store.pullSync();
  } catch {
    toast.error(t("settings.cloudSync.pullFailed"));
    return;
  }
  try {
    await store.pushSync();
    toast.success(t("settings.cloudSync.pushDone"));
  } catch {
    toast.error(t("settings.cloudSync.pushFailed"));
  }
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
  <SettingsGroup :label="$t('settings.cardCloudSync')">
    <p class="px-3.5 py-2.5 text-[12px] leading-snug text-muted-foreground">
      {{ $t("settings.cloudSync.privacyNote") }}
    </p>
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
      <!-- master toggle -->
      <SettingsRow :label="$t('settings.cloudSync.enableLabel')" :description="$t('settings.cloudSync.enableHint')">
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

      <!-- enabled but not yet connected (shouldn't normally happen once signed in, but keep it non-blocking) -->
      <div v-else-if="store.syncStatus.enabled" class="flex flex-col gap-2 px-3.5 py-3">
        <Button size="sm" class="self-start" @click="signIn">
          <Cloud :size="14" />
          {{ $t("settings.cloudSync.signIn") }}
          <ExternalLink :size="14" class="opacity-70" />
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
