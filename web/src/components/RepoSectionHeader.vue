<script setup lang="ts">
// The heading above each dashboard section (Pinned / Starred / everything else), doubling as its
// collapse toggle. A real <button> rather than a clickable <div>: this is the only control for a
// section's contents, so it has to be reachable by keyboard and announce its state.
//
// `collapsible` is false for the catch-all section when it renders alone, where there is no
// grouping to speak of and folding the only list on screen would just empty the dashboard.
import type { Component } from "vue";
import { ChevronRight } from "@lucide/vue";

defineProps<{
  icon: Component;
  iconClass?: string;
  label: string;
  count: number;
  collapsed: boolean;
  collapsible?: boolean;
}>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <component
    :is="collapsible ? 'button' : 'div'"
    :type="collapsible ? 'button' : undefined"
    :aria-expanded="collapsible ? !collapsed : undefined"
    class="mb-2 flex w-full items-center gap-1.5 rounded-sm px-0.5 py-0.5 text-start text-[12px] font-semibold tracking-wide text-muted-foreground uppercase outline-none"
    :class="
      collapsible
        ? 'cursor-pointer transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30'
        : ''
    "
    @click="collapsible ? $emit('toggle') : undefined"
  >
    <!-- Points right when folded, down when open: the usual disclosure convention, and the only
         moving part, so the row stays quiet until you look at it. -->
    <ChevronRight
      v-if="collapsible"
      :size="13"
      class="shrink-0 transition-transform duration-150"
      :class="collapsed ? '' : 'rotate-90'"
    />
    <component :is="icon" :size="13" :class="iconClass" />
    {{ label }}
    <span class="text-muted-foreground/60">{{ count }}</span>
  </component>
</template>
