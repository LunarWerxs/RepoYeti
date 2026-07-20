<script setup lang="ts">
import { watch } from "vue";
import { UserCog } from "@lucide/vue";
import { useStore } from "../../store";
import IdentityManager from "../IdentityManager.vue";
import AccountSwitcher from "../AccountSwitcher.vue";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import { Button } from "@/components/ui/button";

/** Whether the parent Settings sheet is open — drives the on-open refresh below. */
const props = defineProps<{ open: boolean }>();
const store = useStore();

// Load the current identities/accounts whenever the sheet opens. Split from the old
// combined IdentityAccessSection; its access half now lives in AccessSection.vue.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      void store.loadDetectedIdentities();
      void store.loadAccounts();
    }
  },
  // Required — see AccessSection.vue: the sheet's DialogRoot mounts this only once `open` is
  // already true, so without `immediate` a plain watcher never fires and this never refreshed.
  { immediate: true },
);
</script>

<template>
  <!-- GitHub accounts (machine-wide active account switcher via gh) ────── -->
  <AccountSwitcher />

  <!-- Identities (git commit authors).
       Shown only when they're actually doing something (2+ saved, a Firewall rule, or a repo
       already assigned one) — see the store's `identitiesRelevant`. With a single git identity
       there is no choice to make, so the manager collapses to the one-row opt-in group below
       instead of taking a whole panel. That opt-in is also what makes adding a SECOND identity
       possible: hiding the UI below 2 identities would otherwise be a trap you can't climb out
       of. The what-is-this paragraph lives behind the group's ⓘ, matching every other section. -->
  <IdentityManager v-if="store.identitiesRelevant" />
  <SettingsGroup v-else :label="$t('identity.title')" :description="$t('identity.optIn.description')">
    <div class="flex items-center justify-between gap-3 px-3.5 py-3">
      <div class="flex min-w-0 items-center gap-2.5">
        <UserCog :size="16" class="shrink-0 text-muted-foreground" />
        <p class="text-[13px] font-medium text-foreground">{{ $t("identity.optIn.title") }}</p>
      </div>
      <Button variant="outline" size="sm" class="shrink-0" @click="store.setIdentityUiForced(true)">
        {{ $t("identity.optIn.action") }}
      </Button>
    </div>
  </SettingsGroup>
</template>
