<script setup lang="ts">
// A hover tooltip that mounts on its first interest, not with its row: see lib/first-interest.ts.
// Pass the trigger as the default slot and the text as #content.
import type { TooltipTouchMode } from "@/components/ui/tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { keepFocusAcrossMount } from "@/lib/first-interest";
import { ref } from "vue";

defineProps<{ touch?: TooltipTouchMode }>();

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
    <Tooltip v-if="armed">
      <TooltipTrigger as-child :touch="touch">
        <slot />
      </TooltipTrigger>
      <TooltipContent>
        <slot name="content" />
      </TooltipContent>
    </Tooltip>
    <slot v-else />
  </span>
</template>
