<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Cloud, CloudOff, Copy, Check, ExternalLink, Loader2, Laptop } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { ApiError } from "../api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

const open = defineModel<boolean>("open", { required: true });
const store = useStore();
const { t } = useI18n();

const isRemote = computed(() => store.mode === "remote");
const switching = ref(false);
const qrSvg = ref("");
const copied = ref(false);

// Lazily loaded — qrcode is a ~0.5-1MB lib only needed once the modal is open
// and a tunnel URL exists, so it's kept out of the initial bundle.
let qrcodeModule: typeof import("qrcode") | undefined;
async function loadQrcode(): Promise<typeof import("qrcode")> {
  qrcodeModule ??= (await import("qrcode")).default;
  return qrcodeModule;
}

// (Re)render the QR whenever the dialog opens or the tunnel URL changes. Forced
// dark-on-white so it scans regardless of the app theme.
watch(
  [open, () => store.tunnelUrl],
  async ([isOpen, url]) => {
    if (!isOpen || !url) {
      qrSvg.value = "";
      return;
    }
    try {
      const QRCode = await loadQrcode();
      qrSvg.value = await QRCode.toString(url, {
        type: "svg",
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#0b0b0f", light: "#ffffff" },
      });
    } catch {
      qrSvg.value = "";
    }
  },
  { immediate: true },
);

async function setMode(toRemote: boolean): Promise<void> {
  switching.value = true;
  try {
    await store.setMode(toRemote ? "remote" : "local");
  } catch (e) {
    if (e instanceof ApiError && e.code === "NEEDS_OWNER") {
      toast.message(t("remote.needsOwner"));
      window.location.href = "/oauth/login"; // claim ownership, then come back and re-toggle
      return;
    }
    toast.error(t("remote.modeFailed"));
  } finally {
    switching.value = false;
  }
}

async function setRemoteEditing(v: boolean): Promise<void> {
  try {
    await store.setRemoteEditing(v);
  } catch {
    toast.error(t("remote.editFailed"));
  }
}

async function copyLink(): Promise<void> {
  if (!store.tunnelUrl) return;
  try {
    await navigator.clipboard.writeText(store.tunnelUrl);
    copied.value = true;
    toast.success(t("remote.copied"));
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    toast.error(t("remote.copyFailed"));
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Cloud v-if="isRemote" :size="17" class="text-info" />
          <CloudOff v-else :size="17" class="text-muted-foreground" />
          {{ $t("remote.title") }}
        </DialogTitle>
        <DialogDescription>{{ $t("remote.description") }}</DialogDescription>
      </DialogHeader>

      <!-- mode toggle -->
      <label
        class="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2.5"
      >
        <span class="flex flex-col gap-0.5">
          <span class="text-[13px] font-medium text-foreground">{{ $t("remote.modeLabel") }}</span>
          <span class="text-[12px] text-muted-foreground">
            {{ isRemote ? $t("remote.modeOnHint") : $t("remote.modeOffHint") }}
          </span>
        </span>
        <Loader2 v-if="switching" :size="16" class="animate-spin text-muted-foreground" />
        <Switch
          v-else
          :model-value="isRemote"
          :aria-label="$t('remote.modeLabel')"
          @update:model-value="(v: boolean) => setMode(v)"
        />
      </label>

      <!-- editing-over-remote policy (applies whenever remote access is on) -->
      <label
        class="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2.5"
      >
        <span class="flex flex-col gap-0.5">
          <span class="text-[13px] font-medium text-foreground">{{ $t("remote.editLabel") }}</span>
          <span class="text-[12px] text-muted-foreground">{{ $t("remote.editHint") }}</span>
        </span>
        <Switch
          :model-value="store.remoteEditing"
          :aria-label="$t('remote.editLabel')"
          @update:model-value="(v: boolean) => setRemoteEditing(v)"
        />
      </label>

      <!-- remote enabled -->
      <template v-if="isRemote">
        <div v-if="store.tunnelUrl" class="flex flex-col items-center gap-2.5">
          <!-- eslint-disable-next-line vue/no-v-html -- QR SVG generated locally from our own URL -->
          <div v-if="qrSvg" class="size-44 rounded-md bg-white p-2 [&>svg]:size-full" v-html="qrSvg" />
          <p class="text-center text-[12px] text-muted-foreground">{{ $t("remote.scanHint") }}</p>
        </div>
        <div
          v-else
          class="flex items-center justify-center gap-2 rounded-md border border-border bg-secondary/30 py-4 text-[13px] text-muted-foreground"
        >
          <Loader2 :size="15" class="animate-spin" /> {{ $t("remote.starting") }}
        </div>

        <!-- min-w-0: this block is a direct grid item of DialogContent (display:grid), whose
             default min-width:auto would otherwise let the auto column grow to the URL's
             max-content and push the copy button off the dialog. min-w-0 lets the column
             shrink so the <code> below can truncate. -->
        <div v-if="store.tunnelUrl" class="flex min-w-0 flex-col gap-1.5">
          <span class="text-[12px] text-muted-foreground">{{ $t("remote.activeLabel") }}</span>
          <div class="flex items-center gap-2">
            <code
              class="mono min-w-0 flex-1 truncate rounded-md border border-border bg-secondary/40 px-2.5 py-2 text-[12px]"
            >{{ store.tunnelUrl }}</code>
            <Button variant="secondary" size="icon" :aria-label="$t('remote.copy')" @click="copyLink">
              <Check v-if="copied" class="text-success" />
              <Copy v-else />
            </Button>
          </div>
          <a
            :href="store.tunnelUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-1 inline-flex items-center justify-center gap-1.5 text-[12.5px] text-primary underline-offset-2 transition-colors hover:underline"
          >
            <ExternalLink :size="14" /> {{ $t("remote.open") }}
          </a>
        </div>

        <p class="text-center text-[12px] text-muted-foreground">
          {{ store.authenticated ? $t("remote.signedInAs", { name: store.owner }) : $t("remote.localBypassActive") }}
        </p>
      </template>

      <!-- local only -->
      <div
        v-else
        class="flex items-start gap-2 rounded-md border border-border bg-secondary/30 p-3 text-[12.5px] text-muted-foreground"
      >
        <Laptop :size="15" class="mt-0.5 shrink-0" />
        <span>{{ $t("remote.localBody") }}</span>
      </div>
    </DialogContent>
  </Dialog>
</template>
