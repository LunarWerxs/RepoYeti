<script setup lang="ts">
import type { CollapsibleContentProps } from "reka-ui"
import { reactiveOmit } from "@vueuse/core"
import { CollapsibleContent, useForwardProps } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<CollapsibleContentProps & { class?: string }>()
const delegated = reactiveOmit(props, "class")
const forwarded = useForwardProps(delegated)
</script>

<template>
  <CollapsibleContent
    data-slot="collapsible-content"
    v-bind="forwarded"
    :class="cn('overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up', props.class)"
  >
    <slot />
  </CollapsibleContent>
</template>
