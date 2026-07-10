<script setup lang="ts">
// A circle-i info icon that discloses a description on hover/focus — the single progressive-
// disclosure primitive for settings. Keeps rows/sections showing only their label, with the
// verbose text tucked behind the icon. Pass `text`, or default-slot content for richer bodies.
import { Info } from "@lucide/vue";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

defineProps<{ text?: string }>();
</script>

<template>
  <Tooltip v-if="text || $slots.default">
    <TooltipTrigger as-child>
      <button
        type="button"
        aria-label="More information"
        class="inline-flex shrink-0 rounded-full text-muted-foreground/50 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Info class="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent class="max-w-xs text-[12px] leading-snug"><slot>{{ text }}</slot></TooltipContent>
  </Tooltip>
</template>
