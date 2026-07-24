<script setup lang="ts">
/**
 * The "this isn't your machine" bar, shown on every screen to a share-link guest.
 *
 * Two jobs, both about honesty. It tells the guest whose dashboard this is and what their link
 * actually permits — so the absence of buttons reads as "not for you" rather than "broken". And it
 * gives them a way out (Leave clears the share cookie), because a link that can only be escaped by
 * closing the tab is a link people leave open.
 *
 * Never rendered for the owner: `store.isGuest` is false whenever an owner session is present,
 * even if a share cookie is sitting alongside it.
 */
import { useStore } from "../store";
import { Eye, GitCommitHorizontal, LogOut } from "@lucide/vue";
import { Button } from "@/components/ui/button";

const store = useStore();

async function leave(): Promise<void> {
  await store.leaveShare(); // clears the guest cookie, then shows an explicit "left" screen
}
</script>

<template>
  <div
    v-if="store.isGuest"
    class="flex items-center justify-between gap-3 border-b border-primary/20 bg-primary/10 px-3 py-1.5"
  >
    <div class="flex min-w-0 items-center gap-2">
      <component
        :is="store.canControl ? GitCommitHorizontal : Eye"
        :size="13"
        class="shrink-0 text-primary/80"
      />
      <span class="truncate text-[11.5px] text-foreground/90">
        {{ $t("share.guestBanner") }}
        <span class="text-muted-foreground">
          · {{ store.canControl ? $t("share.guestControl") : $t("share.guestView") }}
        </span>
      </span>
    </div>
    <Button variant="ghost" size="sm" class="h-6 shrink-0 px-2 text-[11px]" @click="leave">
      <LogOut :size="12" />
      {{ $t("share.guestLeave") }}
    </Button>
  </div>
</template>
