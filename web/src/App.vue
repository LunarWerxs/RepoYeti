<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme } from "naive-ui";
import { themeOverrides } from "./theme";
import AppShell from "./AppShell.vue";
</script>

<template>
  <NConfigProvider :theme="darkTheme" :theme-overrides="themeOverrides">
    <NMessageProvider placement="bottom" :max="3">
      <NDialogProvider>
        <AppShell />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
