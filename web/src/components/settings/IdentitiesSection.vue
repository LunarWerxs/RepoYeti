<script setup lang="ts">
import { watch } from "vue";
import { useStore } from "../../store";
import IdentityManager from "../IdentityManager.vue";
import AccountSwitcher from "../AccountSwitcher.vue";

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

  <!-- Identities (git author identities) ────────────────────────────── -->
  <IdentityManager />
</template>
