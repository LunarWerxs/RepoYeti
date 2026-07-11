<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Trash2, LogOut, Loader2, Cloud } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { ApiError } from "../../api";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/** Whether the parent Settings sheet is open — drives the on-open reset/seed below. */
const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

// ── access mode (local ↔ remote) ──────────────────────────────────────────────
const isRemote = computed(() => store.mode === "remote");
const switchingMode = ref(false);
// Set when enabling remote is refused because no Connections owner has claimed this
// daemon yet. Discloses the inline sign-in prompt below the toggle instead of
// bouncing the whole page to OAuth mid-toggle.
const needsOwner = ref(false);
async function setAccessMode(toRemote: boolean): Promise<void> {
  switchingMode.value = true;
  try {
    await store.setMode(toRemote ? "remote" : "local");
    needsOwner.value = false;
  } catch (e) {
    if (e instanceof ApiError && e.code === "NEEDS_OWNER") {
      needsOwner.value = true;
      return;
    }
    toast.error(t("remote.modeFailed"));
  } finally {
    switchingMode.value = false;
  }
}

// ── stable address (named Cloudflare tunnel) ──────────────────────────────────
// By default the remote URL rotates each restart; a named tunnel (stable hostname + connector
// token) gives a permanent address. The token is write-only — the daemon never echoes it back,
// so the field stays blank and an empty submit keeps the saved one.
const tunnelHost = ref("");
const tunnelToken = ref("");
const savingTunnel = ref(false);
const confirmForgetTunnel = ref(false);
async function saveTunnel(): Promise<void> {
  if (savingTunnel.value) return;
  savingTunnel.value = true;
  try {
    const input: { hostname?: string; token?: string } = { hostname: tunnelHost.value.trim() };
    const tok = tunnelToken.value.trim();
    if (tok) input.token = tok; // omit when blank → keep the saved token
    await store.setTunnel(input);
    tunnelToken.value = "";
    toast.success(t("settings.tunnelSaved"));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("settings.tunnelSaveFailed"));
  } finally {
    savingTunnel.value = false;
  }
}
async function forgetTunnel(): Promise<void> {
  if (!confirmForgetTunnel.value) {
    confirmForgetTunnel.value = true; // first click arms the confirm
    return;
  }
  confirmForgetTunnel.value = false;
  try {
    await store.setTunnel({ hostname: "", token: "" });
    tunnelHost.value = "";
    tunnelToken.value = "";
    toast.success(t("settings.tunnelForgot"));
  } catch {
    toast.error(t("settings.tunnelSaveFailed"));
  }
}

// ── sign out everywhere (rotates the daemon signing key) ──────────────────────
const confirmSignOutAll = ref(false);
async function signOutAll(): Promise<void> {
  if (!confirmSignOutAll.value) {
    confirmSignOutAll.value = true; // inline two-step confirm
    return;
  }
  confirmSignOutAll.value = false;
  try {
    await store.logoutAll();
    toast.success(t("settings.signOutAllDone"));
    // The current device's cookie is now void too — reload so the auth gate re-evaluates.
    window.location.reload();
  } catch {
    toast.error(t("settings.signOutAllFailed"));
  }
}

// Seed the stable-address field from the live config whenever the sheet opens (the token
// stays blank — it's write-only) and reset the transient disclosure/confirm states.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      tunnelHost.value = store.tunnelConfig.hostname ?? "";
      confirmForgetTunnel.value = false;
      needsOwner.value = false;
    }
  },
);
</script>

<template>
  <!-- Signed-in account (the daemon owner). Its own row above the group — it's the
       Connections account remote access authenticates against, NOT a git identity.
       Shown only when actually signed in (store.owner). -->
  <div
    v-if="store.owner"
    class="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/10 px-3 py-2.5"
  >
    <div class="min-w-0">
      <div class="text-[11px] text-primary/80">{{ $t("identity.signedInWith") }}</div>
      <div class="mono truncate text-[13px] text-foreground/90">{{ store.owner }}</div>
    </div>
    <Button variant="ghost" size="sm" @click="store.logout()">
      <LogOut />
      {{ $t("identity.signOut") }}
    </Button>
  </div>

  <!-- Access (local ↔ remote) ───────────────────────────────────── -->
  <SettingsGroup :label="$t('settings.cardAccess')">
    <SettingsRow :label="$t('settings.accessMode')">
      <template #info><InfoHint :text="isRemote ? $t('remote.modeOnHint') : $t('remote.modeOffHint')" /></template>
      <template #control>
        <Switch
          :model-value="isRemote"
          :disabled="switchingMode"
          :aria-label="$t('settings.accessMode')"
          @update:model-value="(v: boolean) => setAccessMode(v)"
        />
      </template>
    </SettingsRow>

    <!-- Turning remote on needs a claimed Connections owner: disclose the sign-in step
         inline instead of redirecting out from under the toggle. -->
    <div v-if="needsOwner && !isRemote" class="px-3.5 pb-3">
      <div class="flex flex-col gap-2.5 rounded-lg border border-info/30 bg-info/10 p-3">
        <p class="text-[12.5px] leading-snug text-foreground/90">{{ $t("remote.needsOwner") }}</p>
        <Button as="a" href="/oauth/login" size="sm" class="self-start">
          <Cloud />
          {{ $t("remote.connectCta") }}
        </Button>
      </div>
    </div>

    <!-- The rows below only mean anything while remote access is on: the tunnel names the
         remote URL, and "sign out everywhere" revokes remote sessions. Hidden otherwise. -->
    <template v-if="isRemote">
      <!-- stable address (named Cloudflare tunnel) — a permanent URL instead of a rotating one -->
      <div class="flex flex-col gap-2.5 px-3.5 py-3">
        <div class="flex items-center gap-1.5">
          <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.tunnelLabel") }}</span>
          <InfoHint :text="$t('settings.tunnelHint')" />
        </div>
        <p
          v-if="store.tunnelConfig.named"
          class="flex items-center gap-1.5 text-[12px] text-success"
        >
          <Check :size="13" class="shrink-0" />
          <span class="min-w-0 break-all">{{ $t("settings.tunnelActive", { host: store.tunnelConfig.hostname }) }}</span>
        </p>
        <Input
          v-model="tunnelHost"
          class="mono text-[12.5px]"
          :placeholder="$t('settings.tunnelHostPlaceholder')"
          :aria-label="$t('settings.tunnelHostLabel')"
        />
        <Input
          v-if="!store.tunnelConfig.tokenFromEnv"
          v-model="tunnelToken"
          type="password"
          class="text-[12.5px]"
          :placeholder="store.tunnelConfig.hasToken ? $t('settings.tunnelTokenSaved') : $t('settings.tunnelTokenPlaceholder')"
          :aria-label="$t('settings.tunnelTokenLabel')"
        />
        <p v-else class="text-[11.5px] text-muted-foreground">{{ $t("settings.tunnelTokenEnv") }}</p>
        <div class="flex items-center gap-2">
          <Button size="sm" :disabled="savingTunnel" @click="saveTunnel">
            <Loader2 v-if="savingTunnel" class="animate-spin" />
            <Check v-else />
            {{ $t("settings.tunnelSave") }}
          </Button>
          <Button
            v-if="store.tunnelConfig.hostname || store.tunnelConfig.hasToken"
            :variant="confirmForgetTunnel ? 'destructive' : 'ghost'"
            size="sm"
            class="ml-auto"
            @click="forgetTunnel"
            @blur="confirmForgetTunnel = false"
          >
            <Trash2 />
            {{ confirmForgetTunnel ? $t("settings.tunnelForgetConfirm") : $t("settings.tunnelForget") }}
          </Button>
        </div>
      </div>

      <!-- sign out everywhere (rotates the signing key → invalidates all devices) -->
      <div v-if="store.authEnforced" class="flex items-center justify-between gap-3 px-3.5 py-3">
        <span class="flex items-center gap-1.5">
          <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.signOutAll") }}</span>
          <InfoHint :text="$t('settings.signOutAllHint')" />
        </span>
        <Button
          :variant="confirmSignOutAll ? 'destructive' : 'outline'"
          size="sm"
          class="shrink-0"
          @click="signOutAll"
          @blur="confirmSignOutAll = false"
        >
          <LogOut />
          {{ confirmSignOutAll ? $t("settings.signOutAllConfirm") : $t("settings.signOutAll") }}
        </Button>
      </div>
    </template>
  </SettingsGroup>
</template>
