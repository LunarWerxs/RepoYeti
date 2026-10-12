<script setup lang="ts">
// A click menu that mounts on its first interest, not with its row: see lib/first-interest.ts.
// Pass the trigger element as the default slot and the menu items as #content (a DropdownMenuContent).
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { keepFocusAcrossMount } from "@/lib/first-interest";
import { ref } from "vue";

const emit = defineEmits<{ "update:open": [open: boolean] }>();

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
  <span ref="root" class="contents" @pointerenter="arm" @focusin="arm">
    <DropdownMenu v-if="armed" @update:open="emit('update:open', $event)">
      <DropdownMenuTrigger as-child>
        <slot />
      </DropdownMenuTrigger>
      <slot name="content" />
    </DropdownMenu>
    <slot v-else />
  </span>
</template>
