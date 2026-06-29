<script setup lang="ts">
import { computed } from "vue";
import { useColorMode } from "@vueuse/core";
import { Toaster } from "vue-sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppShell from "./AppShell.vue";

// Shared light/dark/system theme. GitMob defaults to dark (see index.html and
// web/UI_UNIFICATION.md §3); the switcher in Settings writes to the same store.
const mode = useColorMode({ initialValue: "dark" });
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
      rich-colors
      close-button
    />
  </TooltipProvider>
</template>
