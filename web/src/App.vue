<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/theme";
import AppShell from "./AppShell.vue";

// Shared kit light/dark/system theme (defaults to dark — see index.html and the kit
// README "Theme boot snippet"). The Settings switcher writes the same store. `mode`
// ("light" | "dark" | "system") maps 1:1 to vue-sonner's theme prop.
const { mode } = useTheme();
</script>

<template>
  <TooltipProvider>
    <AppShell />
    <Toaster
      :theme="mode"
      position="bottom-center"
      :duration="3500"
      :offset="16"
      close-button
    />
  </TooltipProvider>
</template>
