<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Trash2, LogOut, Loader2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { ApiError } from "../../api";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import IdentityManager from "../IdentityManager.vue";
import AccountSwitcher from "../AccountSwitcher.vue";

/** Whether the parent Settings sheet is open — drives the on-open refresh below. */
const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

// ── access mode (local ↔ remote) ──────────────────────────────────────────────
const isRemote = computed(() => store.mode === "remote");
const switchingMode = ref(false);
async function setAccessMode(toRemote: boolean): Promise<void> {
  switchingMode.value = true;
  try {
    await store.setMode(toRemote ? "remote" : "local");
  } catch (e) {
    if (e instanceof ApiError && e.code === "NEEDS_OWNER") {
      toast.message(t("remote.needsOwner"));
      window.location.href = "/oauth/login"; // claim ownership, then re-toggle
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

// Load the current identities/accounts whenever the sheet opens, and seed the stable-address
// field from the live config (the token stays blank — it's write-only). Split out of the
// combined open-watcher that used to live in Settings.vue; the roots/servers half of it now
// lives in DiscoverySection.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      void store.loadDetectedIdentities();
      void store.loadAccounts();
      tunnelHost.value = store.tunnelConfig.hostname ?? "";
      confirmForgetTunnel.value = false;
    }
  },
);
</script>

<template>
  <!-- Signed-in account (the daemon owner). Its own row above the sections — it's the
       Connections account, NOT a git identity, so it no longer lives inside Identities.
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

  <!-- Identities (git author identities) ────────────────────────────── -->
  <IdentityManager />

  <!-- GitHub accounts (machine-wide active account switcher via gh) ────── -->
  <AccountSwitcher />

  <!-- Access (local ↔ remote) ───────────────────────────────────── -->
  <SettingsGroup :label="$t('settings.cardAccess')">
    <SettingsRow
      :label="$t('settings.accessMode')"
      :description="isRemote ? $t('remote.modeOnHint') : $t('remote.modeOffHint')"
    >
      <template #control>
        <Switch
          :model-value="isRemote"
          :disabled="switchingMode"
          :aria-label="$t('settings.accessMode')"
          @update:model-value="(v: boolean) => setAccessMode(v)"
        />
      </template>
    </SettingsRow>

    <!-- stable address (named Cloudflare tunnel) — a permanent URL instead of a rotating one -->
    <div class="flex flex-col gap-2.5 px-3.5 py-3">
      <div class="flex flex-col gap-0.5">
        <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.tunnelLabel") }}</span>
        <span class="text-[12px] text-muted-foreground">{{ $t("settings.tunnelHint") }}</span>
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
      <span class="flex flex-col gap-0.5">
        <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.signOutAll") }}</span>
        <span class="text-[12px] text-muted-foreground">{{ $t("settings.signOutAllHint") }}</span>
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
  </SettingsGroup>
</template>
