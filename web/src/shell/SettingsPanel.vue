<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { computed } from "vue";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { type PushPanelSide, DEFAULT_PANEL_WIDTH } from "./usePushPanel";

/**
 * SettingsPanel — the unified slide-in settings panel.
 *   · desktop (side="right") → PURE PUSH: no backdrop; the parent shifts page
 *     content left (see usePushPanel). Non-modal so the page stays interactive.
 *   · mobile  (side="bottom") → a normal bottom sheet WITH a backdrop (you can't
 *     push content on a phone), modal.
 * Drive `side` from usePushPanel so the visual width and the content shift match.
 * `rightOffsetPx` nudges the desktop panel left so it can stack beside another
 * docked panel (e.g. a file viewer).
 *
 *   const open = ref(false);
 *   const { side, shiftPx, containerStyle } = usePushPanel(open);
 *   // shell root: class="transition-[padding] duration-300 ease-in-out" :style="containerStyle"
 *   <SettingsPanel v-model:open="open" :side="side" :title="$t('settings.title')">
 *     <template #title-icon><Cog /></template>
 *     … settings …
 *   </SettingsPanel>
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    side?: PushPanelSide;
    title: string;
    description?: string;
    widthPx?: number;
    rightOffsetPx?: number;
    class?: HTMLAttributes["class"];
  }>(),
  {
    side: "right",
    widthPx: DEFAULT_PANEL_WIDTH,
    rightOffsetPx: 0,
  },
);

const emit = defineEmits<{ "update:open": [boolean] }>();

const isBottom = computed(() => props.side === "bottom");
const contentStyle = computed(() =>
  props.side === "right"
    ? { width: "100%", maxWidth: `${props.widthPx}px` }
    : undefined,
);
</script>

<template>
  <Sheet :open="open" :modal="isBottom" @update:open="emit('update:open', $event)">
    <SheetContent
      :side="side"
      :show-overlay="isBottom"
      :right-offset-px="rightOffsetPx"
      :class="cn('gap-0 p-0 transition-[right,transform]', isBottom && 'max-h-[92vh] rounded-t-2xl', props.class)"
      :style="contentStyle"
    >
      <div class="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3 pr-12">
        <slot name="title-icon" />
        <SheetTitle class="text-sm font-semibold">{{ title }}</SheetTitle>
        <SheetDescription class="sr-only">{{ description || title }}</SheetDescription>
      </div>

      <div class="scroll-slim min-h-0 flex-1 overflow-y-auto p-4">
        <slot />
      </div>

      <div v-if="$slots.footer" class="shrink-0 border-t border-border/60 px-4 py-3">
        <slot name="footer" />
      </div>
    </SheetContent>
  </Sheet>
</template>
