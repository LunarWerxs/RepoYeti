<script setup lang="ts">
// "An update is available — want it?"
//
// Raised by the daemon's scheduled check (SSE `update_available` → store.notifyUpdateAvailable).
// This is the OFFER, not the act: nothing installs until the owner clicks Update. The separate
// `autoUpdate` setting is the one that installs unattended, and when it's on this prompt never
// appears — the daemon applies and relaunches instead of announcing.
//
// Dismissing leaves the bell entry in place, so a "later" is recoverable without waiting for the
// next scheduled check.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Download, Loader2, Sparkles } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const store = useStore();
const { t } = useI18n();

const open = computed({
  get: () => store.updatePromptOpen,
  set: (v: boolean) => (store.updatePromptOpen = v),
});
/** Set when the update exists but can't be installed right now (usually a dirty tree). */
const blocked = computed(() => store.updateBlockedReason);
const applying = ref(false);

async function updateNow(): Promise<void> {
  if (applying.value) return;
  applying.value = true;
  try {
    const result = await store.applyUpdate();
    store.clearUpdateNotification();
    toast.success(t("notify.updateApplied"), {
      description: result.restartRequired ? t("notify.updateRestarting") : undefined,
    });
  } catch (e) {
    toast.error(t("notify.updateFailed"), {
      description: e instanceof Error ? e.message : undefined,
    });
  } finally {
    applying.value = false;
  }
}

/** "Later" keeps the bell entry — this is a deferral, not a decision. */
function later(): void {
  open.value = false;
}
</script>

<template>
  <Dialog v-model:open="open">
    <!-- z-[60], because this is now raised from INSIDE the Settings panel (its version badge, see
         UpdatesSection.vue) and that panel is itself a dialog at the shared z-50. Equal z-index
         hands the decision to DOM order, and the portal that mounts last won — so the offer opened,
         took focus, and rendered completely hidden behind the panel.
         The shadow goes with it: only the OVERLAY dims, and the overlay stays at z-50 under the
         panel, so over a full-width panel (mobile) the ring alone left this reading as an inline
         card rather than something on top. -->
    <DialogContent class="z-[60] shadow-xl sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Sparkles :size="16" class="shrink-0 text-primary" />
          {{ $t("notify.updateTitle") }}
        </DialogTitle>
        <DialogDescription>
          {{ blocked ? $t("notify.updateBlockedBody") : $t("notify.updatePromptBody") }}
        </DialogDescription>
      </DialogHeader>

      <!-- A dirty tree (or a detached HEAD) blocks the install. Say which, since it's the owner's
           to resolve — the update stays waiting either way. -->
      <div
        v-if="blocked"
        class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-warning"
      >
        <AlertTriangle :size="15" class="mt-px shrink-0" />
        <span class="min-w-0">{{ blocked }}</span>
      </div>

      <DialogFooter>
        <Button variant="ghost" :disabled="applying" @click="later">
          {{ $t("notify.updateLater") }}
        </Button>
        <Button :disabled="applying || !!blocked" @click="updateNow">
          <Loader2 v-if="applying" class="animate-spin" />
          <Download v-else />
          {{ $t("notify.updateNow") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
