<script setup lang="ts">
// A right-click menu that mounts on its first interest, not with its row: see lib/first-interest.ts.
// Armed by pointer enter and by contextmenu (the keyboard menu key), not focus: a focus-driven remount
// would swap the row out from under a roving-focus tree. The first keyboard press therefore only arms.
// Pass the trigger element as the default slot and the menu items as #content (a ContextMenuContent).
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { keepFocusAcrossMount } from "@/lib/first-interest";
import { ref } from "vue";

const root = ref<HTMLElement | null>(null);
const armed = ref(false);

function arm() {
  if (armed.value) return;
  const restoreFocus = keepFocusAcrossMount(root);
  armed.value = true;
  restoreFocus();
}
</script>

<template>
  <span ref="root" class="contents" @pointerenter="arm" @contextmenu="arm">
    <ContextMenu v-if="armed">
      <ContextMenuTrigger as-child>
        <slot />
      </ContextMenuTrigger>
      <slot name="content" />
    </ContextMenu>
    <slot v-else />
  </span>
</template>
