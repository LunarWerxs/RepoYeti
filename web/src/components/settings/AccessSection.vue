<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown, Copy, Cloud, ExternalLink, Link2, Loader2, LogOut } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import { ApiError } from "../../api";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

// ── local ↔ remote ────────────────────────────────────────────────────────────
const isRemote = computed(() => store.mode === "remote");
const switchingMode = ref(false);
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

// ── address choice ────────────────────────────────────────────────────────────
type AddressChoice = "hosted" | "cloudflare" | "custom";
const addressChoice = ref<AddressChoice>("hosted");
const addressOptionsOpen = ref(false);
const switchingAddress = ref(false);
const tunnelHost = ref("");
const tunnelToken = ref("");
const savingTunnel = ref(false);
const copiedAddress = ref(false);
const STABLE_ADDRESS_DOCS =
  "https://github.com/LunarWerxs/RepoYeti/blob/main/docs/STABLE_ADDRESS.md";

function liveChoice(): AddressChoice {
  if (store.tunnelConfig.named) return "custom";
  return store.relayConfig.enabled ? "hosted" : "cloudflare";
}

function addressTitle(choice: AddressChoice): string {
  if (choice === "hosted") return t("settings.address.hosted");
  if (choice === "cloudflare") return t("settings.address.cloudflare");
  return t("settings.address.custom");
}

function addressHint(choice: AddressChoice): string {
  if (choice === "hosted") return t("settings.address.hostedHint");
  if (choice === "cloudflare") return t("settings.address.cloudflareHint");
  return t("settings.address.customHint");
}

async function selectAddress(choice: AddressChoice): Promise<void> {
  addressChoice.value = choice;
  if (choice === "custom") return;
  switchingAddress.value = true;
  try {
    // Leaving a named tunnel must clear both halves of its write-only configuration. The selected
    // built-in mode then decides whether the quick tunnel is reached through RepoYeti's stable
    // hosted front door or exposed directly at its generated trycloudflare.com address.
    if (store.tunnelConfig.hostname || store.tunnelConfig.hasToken) {
      await store.setTunnel({ hostname: "", token: "" });
      tunnelHost.value = "";
      tunnelToken.value = "";
    }
    await store.setRelay({ enabled: choice === "hosted", url: "" });
    addressOptionsOpen.value = false;
    toast.success(t("settings.addressSaved"));
  } catch (e) {
    addressChoice.value = liveChoice();
    toast.error(e instanceof ApiError ? e.message : t("settings.addressSaveFailed"));
  } finally {
    switchingAddress.value = false;
  }
}

async function saveCustomAddress(): Promise<void> {
  if (savingTunnel.value) return;
  savingTunnel.value = true;
  try {
    const input: { hostname?: string; token?: string } = { hostname: tunnelHost.value.trim() };
    const token = tunnelToken.value.trim();
    if (token) input.token = token;
    await store.setTunnel(input);
    tunnelToken.value = "";
    addressChoice.value = "custom";
    toast.success(t("settings.tunnelSaved"));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("settings.tunnelSaveFailed"));
  } finally {
    savingTunnel.value = false;
  }
}

const displayedAddress = computed(() => {
  if (addressChoice.value === "custom" && store.tunnelConfig.hostname) {
    return `https://${store.tunnelConfig.hostname}`;
  }
  if (addressChoice.value === "hosted") return store.relayUrl;
  return store.tunnelUrl;
});

async function copyAddress(): Promise<void> {
  if (!displayedAddress.value) return;
  try {
    await navigator.clipboard.writeText(displayedAddress.value);
    copiedAddress.value = true;
    setTimeout(() => (copiedAddress.value = false), 2000);
  } catch {
    toast.error(t("share.copyFailed"));
  }
}

// ── sign out everywhere ──────────────────────────────────────────────────────
const confirmSignOutAll = ref(false);
async function signOutAll(): Promise<void> {
  if (!confirmSignOutAll.value) {
    confirmSignOutAll.value = true;
    return;
  }
  confirmSignOutAll.value = false;
  try {
    await store.logoutAll();
    toast.success(t("settings.signOutAllDone"));
    window.location.reload();
  } catch {
    toast.error(t("settings.signOutAllFailed"));
  }
}

watch(
  [
    () => props.open,
    () => store.tunnelConfig.named,
    () => store.relayConfig.enabled,
  ],
  ([open]) => {
    if (!open) return;
    addressChoice.value = liveChoice();
    tunnelHost.value = store.tunnelConfig.hostname ?? "";
    tunnelToken.value = "";
    copiedAddress.value = false;
    confirmSignOutAll.value = false;
    needsOwner.value = false;
    addressOptionsOpen.value = false;
  },
  { immediate: true },
);
</script>

<template>
  <SettingsGroup :label="$t('settings.cardAccess')">
    <SettingsRow :label="$t('settings.accessMode')">
      <template #info>
        <InfoHint :text="isRemote ? $t('remote.modeOnHint') : $t('remote.modeOffHint')" />
      </template>
      <template #control>
        <Switch
          :model-value="isRemote"
          :disabled="switchingMode"
          :aria-label="$t('settings.accessMode')"
          @update:model-value="(value: boolean) => setAccessMode(value)"
        />
      </template>
    </SettingsRow>

    <div v-if="needsOwner && !isRemote" class="px-3.5 pb-3">
      <div class="flex flex-col gap-2.5 rounded-lg border border-info/30 bg-info/10 p-3">
        <p class="text-[12.5px] leading-snug text-foreground/90">{{ $t("remote.needsOwner") }}</p>
        <Button
          as="a"
          href="/oauth/login"
          target="_blank"
          rel="noopener noreferrer"
          size="sm"
          class="self-start"
        >
          <Cloud />
          {{ $t("remote.connectCta") }}
          <ExternalLink :size="13" class="opacity-70" />
        </Button>
      </div>
    </div>

    <template v-if="isRemote">
      <div class="flex flex-col gap-3 px-3.5 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-[12.5px] font-medium text-foreground">{{ $t("settings.addressTitle") }}</span>
              <InfoHint :text="$t('settings.addressHint')" />
            </div>
            <p class="mt-1 text-[12px] font-medium text-foreground/90">{{ addressTitle(addressChoice) }}</p>
            <p
              class="text-[11px] leading-snug"
              :class="
                addressChoice === 'hosted' && store.relayAnnounced
                  ? 'text-success'
                  : addressChoice === 'hosted' && store.relayError
                    ? 'text-destructive'
                  : 'text-muted-foreground'
              "
            >
              {{
                addressChoice === "hosted" && store.relayAnnounced
                  ? $t("settings.relayRegistered")
                  : addressChoice === "hosted" && store.relayError
                    ? $t("settings.relayFailedShort")
                  : addressHint(addressChoice)
              }}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            class="shrink-0"
            :aria-expanded="addressOptionsOpen"
            @click="addressOptionsOpen = !addressOptionsOpen"
          >
            {{ addressOptionsOpen ? $t("settings.addressDone") : $t("settings.addressChange") }}
            <ChevronDown
              :size="13"
              class="transition-transform"
              :class="addressOptionsOpen && 'rotate-180'"
            />
          </Button>
        </div>

        <div
          v-if="displayedAddress"
          class="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-2"
        >
          <Link2 :size="13" class="shrink-0 text-muted-foreground" />
          <span class="mono min-w-0 flex-1 truncate text-[12px] text-foreground/90">
            {{ displayedAddress }}
          </span>
          <Button variant="ghost" size="sm" class="shrink-0" @click="copyAddress">
            <Check v-if="copiedAddress" />
            <Copy v-else />
            {{ copiedAddress ? $t("share.copied") : $t("share.copy") }}
          </Button>
        </div>

        <p
          v-if="addressChoice === 'hosted' && store.relayError"
          class="text-[11.5px] leading-snug text-destructive"
        >
          {{ $t("settings.relayFailed", { error: store.relayError }) }}
        </p>
        <p
          v-else-if="addressChoice === 'hosted' && !store.relayAnnounced"
          class="text-[11.5px] leading-snug text-warning"
        >
          {{ $t("settings.relayPending") }}
        </p>
        <p
          v-else-if="addressChoice === 'cloudflare'"
          class="text-[11.5px] leading-snug text-muted-foreground"
        >
          {{ $t("settings.address.cloudflareNotice") }}
        </p>

        <div v-if="addressOptionsOpen" class="flex flex-col gap-2.5 border-t border-border/50 pt-3">
          <div class="grid gap-2 sm:grid-cols-3">
            <button
              v-for="choice in (['hosted', 'cloudflare', 'custom'] as AddressChoice[])"
              :key="choice"
              type="button"
              class="rounded-lg border p-2.5 text-left transition-colors"
              :class="
                addressChoice === choice
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-border/60 hover:bg-muted/40'
              "
              :disabled="switchingAddress"
              @click="selectAddress(choice)"
            >
              <p class="text-[12px] font-medium text-foreground">{{ addressTitle(choice) }}</p>
              <p class="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
                {{ addressHint(choice) }}
              </p>
            </button>
          </div>

          <div
            v-if="addressChoice === 'custom'"
            class="flex flex-col gap-2 rounded-lg border border-border/60 p-2.5"
          >
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
              :placeholder="
                store.tunnelConfig.hasToken
                  ? $t('settings.tunnelTokenSaved')
                  : $t('settings.tunnelTokenPlaceholder')
              "
              :aria-label="$t('settings.tunnelTokenLabel')"
            />
            <p v-else class="text-[11.5px] text-muted-foreground">{{ $t("settings.tunnelTokenEnv") }}</p>
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" :disabled="savingTunnel || !tunnelHost.trim()" @click="saveCustomAddress">
                <Loader2 v-if="savingTunnel" class="animate-spin" />
                <Check v-else />
                {{ $t("settings.tunnelSave") }}
              </Button>
              <a
                :href="STABLE_ADDRESS_DOCS"
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center gap-1 text-[11.5px] text-info underline-offset-2 hover:underline"
              >
                {{ $t("settings.stableAddressDocs") }}
                <ExternalLink :size="11" class="opacity-70" />
              </a>
            </div>
          </div>
        </div>
      </div>

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
