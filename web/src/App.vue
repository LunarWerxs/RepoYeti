<script setup lang="ts">
import { computed } from "vue";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRepoYetiColorMode } from "@/lib/theme";
import AppShell from "./AppShell.vue";

// Shared light/dark/system theme. RepoYeti defaults to dark (see index.html and
// web/UI_UNIFICATION.md §3); the switcher in Settings writes to the same store.
const mode = useRepoYetiColorMode();
const toasterTheme = computed(() => (mode.value === "auto" ? "system" : mode.value));
</script>

<template>
  <TooltipProvider>
    <AppShell />
    <Toaster
      :theme="toasterTheme"
      position="bottom-center"
      :duration="3500"
      :offset="16"
      close-button
    />
  </TooltipProvider>
</template>
