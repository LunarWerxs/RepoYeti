<script setup lang="ts">
// ⭐ Agent Safety Rail — the persistent, state-driven card for MCP mutating tool calls (git_commit,
// create_branch, git_checkout, git_push, git_pull, git_fetch) a headless agent has fired and that
// are now blocked awaiting a one-tap owner approve/deny. Mirrors ConflictConcierge.vue's pattern
// (state-driven card + SSE-kept-live list) but each entry additionally carries a live countdown to
// its auto-deny timeout and its own Approve/Deny actions.
import { ref, onMounted, onUnmounted } from "vue";
import { ShieldAlert, Check, X } from "@lucide/vue";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";

const store = useStore();

// Ticks once a second so the countdown labels stay live without each one owning a timer.
const now = ref(Date.now());
let tickId: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  tickId = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  clearInterval(tickId);
});

/** Seconds remaining until auto-deny (floored at 0 — the SSE approval_resolved event removes the
 *  card the instant the timer actually fires, so this never shows a negative count for long). */
function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - now.value) / 1000));
}

async function onApprove(id: string): Promise<void> {
  try {
    await store.approveCall(id);
  } catch {
    /* the card stays put on failure — the owner can retry, or it'll resolve via SSE/timeout */
  }
}
async function onDeny(id: string): Promise<void> {
  try {
    await store.denyCall(id);
  } catch {
    /* same as onApprove — best-effort, non-blocking */
  }
}
</script>

<template>
  <div
    v-if="store.pendingApprovals.length"
    class="ring-primary/30 bg-primary/5 mb-2.5 flex flex-col gap-1.5 rounded-lg py-2.5 text-xs/relaxed ring-1"
  >
    <div class="flex items-center gap-1.5 px-3 text-[13px] font-semibold text-primary">
      <ShieldAlert :size="15" />
      <span>{{ $t("approvals.title") }}</span>
      <span class="text-primary/70">
        {{
          store.pendingApprovals.length === 1
            ? $t("approvals.countOne")
            : $t("approvals.countMany", { count: store.pendingApprovals.length })
        }}
      </span>
    </div>
    <div class="flex flex-col gap-1 px-1.5">
      <div
        v-for="req in store.pendingApprovals"
        :key="req.id"
        class="flex items-center gap-2 rounded-md px-1.5 py-1.5"
      >
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="mono truncate text-[13px] font-medium text-foreground">{{ req.tool }}</span>
            <span v-if="req.repo" class="mono shrink-0 truncate text-[11px] text-muted-foreground">
              {{ req.repo }}
            </span>
          </div>
          <div class="mono truncate text-[11px] text-muted-foreground">{{ req.argsSummary }}</div>
          <div class="text-[11px] text-primary/80">
            {{ $t("approvals.countdown", { seconds: secondsLeft(req.expiresAt) }) }}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          :disabled="!!store.approvalBusy[req.id]"
          :aria-label="$t('approvals.approveAria', { tool: req.tool })"
          @click="onApprove(req.id)"
        >
          <Check />
          {{ $t("approvals.approve") }}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          :disabled="!!store.approvalBusy[req.id]"
          :aria-label="$t('approvals.denyAria', { tool: req.tool })"
          @click="onDeny(req.id)"
        >
          <X />
          {{ $t("approvals.deny") }}
        </Button>
      </div>
    </div>
  </div>
</template>
