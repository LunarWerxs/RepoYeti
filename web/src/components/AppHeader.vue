<script setup lang="ts">
import { RefreshCw, Plus, Settings, Cloud, CloudOff } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useStore } from "../store";

defineProps<{ connected: boolean; repoCount: number }>();
defineEmits<{ reload: []; add: []; settings: []; remote: [] }>();

const store = useStore();
</script>

<template>
  <header
    class="safe-top sticky top-0 z-30 border-b border-border/70 bg-background/70 backdrop-blur-xl"
  >
    <div class="mx-auto flex max-w-3xl items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
      <div class="flex items-center gap-2.5">
        <img src="/icon.svg" alt="" width="30" height="30" class="rounded-lg" />
        <div class="leading-tight">
          <div class="text-[17px] font-bold tracking-tight">{{ $t("app.name") }}</div>
          <div class="text-[12px] text-muted-foreground">
            {{ $t("header.repoCount", { count: repoCount }, repoCount) }}
          </div>
        </div>
      </div>

      <div class="flex items-center gap-1">
        <!-- remote-access button, with the live/offline dot pinned to its top-right corner -->
        <div class="relative">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                :class="store.mode === 'remote' ? 'text-info' : 'text-muted-foreground'"
                :aria-label="$t('header.connection')"
                @click="$emit('remote')"
              >
                <Cloud v-if="store.mode === 'remote'" />
                <CloudOff v-else />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {{ store.mode === "remote" ? $t("header.connectionRemote") : $t("header.connectionLocal") }}
            </TooltipContent>
          </Tooltip>
          <span
            class="pointer-events-none absolute right-1.5 top-1.5 flex size-2"
            role="status"
            :aria-label="connected ? $t('header.connectedStatus') : $t('header.reconnecting')"
          >
            <span
              v-if="connected"
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60"
            />
            <span
              class="relative inline-flex size-2 rounded-full ring-2 ring-background"
              :class="connected ? 'bg-emerald-500' : 'bg-red-500'"
            />
          </span>
        </div>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" :aria-label="$t('header.reload')" @click="$emit('reload')">
              <RefreshCw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ $t("header.reload") }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" :aria-label="$t('header.settings')" @click="$emit('settings')">
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ $t("header.settingsTooltip") }}</TooltipContent>
        </Tooltip>

        <Button class="ml-1" size="sm" :aria-label="$t('header.addRepository')" @click="$emit('add')">
          <Plus />
          <span class="hidden sm:inline">{{ $t("header.add") }}</span>
        </Button>
      </div>
    </div>
  </header>
</template>
