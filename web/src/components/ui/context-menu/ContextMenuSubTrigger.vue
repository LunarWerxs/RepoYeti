<script setup lang="ts">
import type { ContextMenuSubTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  ContextMenuSubTrigger,
  useForwardProps,
} from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/context-menu"

const props = defineProps<ContextMenuSubTriggerProps & { class?: HTMLAttributes["class"], inset?: boolean }>()

const delegatedProps = reactiveOmit(props, "class", "inset")
const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <ContextMenuSubTrigger
    data-slot="context-menu-sub-trigger"
    :data-inset="inset ? '' : undefined"
    v-bind="forwardedProps"
    :class="cn('min-h-7 gap-2 rounded-md px-2 py-1 data-inset:ps-7.5 [&_svg:not([class*=size-])]:size-3.5 flex cursor-default items-center outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0', skin.subTrigger, props.class)"
  >
    <slot />
    <skin.ChevronRightIcon class="cn-rtl-flip ms-auto" />
  </ContextMenuSubTrigger>
</template>
