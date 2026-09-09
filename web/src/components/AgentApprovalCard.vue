<script setup lang="ts">
// ⭐ Agent Safety Rail — the persistent, state-driven card for MCP mutating tool calls (git_commit,
// create_branch, git_checkout, git_push, git_pull, git_fetch) a headless agent has fired and that
// are now blocked awaiting a one-tap owner approve/deny. Mirrors ConflictConcierge.vue's pattern
// (state-driven card + SSE-kept-live list) but each entry additionally carries a live countdown to
// its auto-deny timeout and its own Approve/Deny actions.
import { reactive, ref, onMounted, onUnmounted } from "vue";
import { ShieldAlert, Check, X } from "@lucide/vue";
import { useStore } from "../store";
import { api } from "../api";
import type { ApprovalDetails } from "../types";
import { Button } from "@/components/ui/button";

const store = useStore();

// ── full-request detail (audit item 13): the summary line clips every argument at 80 chars while
// the tool runs with the full original arguments, so an owner approving from the summary alone
// can't actually see what they're approving. State is local and keyed by request id — a card that
// re-renders after an SSE update must not lose an already-expanded/fetched detail.
interface RequestDetailState {
  expanded: boolean;
  loading: boolean;
  details: ApprovalDetails | null;
  error: boolean;
}
const requestDetails = reactive<Record<string, RequestDetailState>>({});
const DEFAULT_REQUEST_STATE: RequestDetailState = {
  expanded: false,
  loading: false,
  details: null,
  error: false,
};

function requestState(id: string): RequestDetailState {
  return requestDetails[id] ?? DEFAULT_REQUEST_STATE;
}

/** Toggles the expanded panel; fetches the full request on the FIRST expand only — later toggles
 *  just show/hide whatever was already fetched (or the error state from a failed fetch). */
async function toggleRequest(id: string): Promise<void> {
  const existing = requestDetails[id];
  if (existing) {
    existing.expanded = !existing.expanded;
    return;
  }
  requestDetails[id] = { expanded: true, loading: true, details: null, error: false };
  try {
    requestDetails[id].details = await api.approvalDetails(id);
  } catch {
    // A 404 here means the call already resolved (approved/denied/timed out) — the card itself
    // will disappear via the approval_resolved SSE event, so this just explains the gap till then.
    requestDetails[id].error = true;
  } finally {
    requestDetails[id].loading = false;
  }
}

/** How to render one argument value: the literal secret-redaction marker becomes the localized
 *  "hidden" label, a string renders verbatim (preserving newlines), anything else is pretty-printed. */
function argText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
function argIsHidden(value: unknown): boolean {
  return value === "[hidden]";
}

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
    v-if="store.pendingApprovals.length && !store.isGuest"
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
        class="flex flex-col gap-1 rounded-md px-1.5 py-1.5"
      >
        <div class="flex items-center gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="mono truncate text-[13px] font-medium text-foreground">{{ req.tool }}</span>
              <span v-if="req.repo" class="mono shrink-0 truncate text-[11px] text-muted-foreground">
                {{ req.repo }}
              </span>
            </div>
            <div class="mono truncate text-[11px] text-muted-foreground">{{ req.argsSummary }}</div>
            <div v-if="req.autoAction === 'approve'" class="text-[11px] text-primary/80">
              {{ $t("approvals.countdownApprove", { seconds: secondsLeft(req.expiresAt) }) }}
            </div>
            <div v-else-if="req.autoAction === 'deny'" class="text-[11px] text-primary/80">
              {{ $t("approvals.countdown", { seconds: secondsLeft(req.expiresAt) }) }}
            </div>
            <div v-else class="text-[11px] text-muted-foreground/80">
              {{ $t("approvals.waiting") }}
            </div>
            <Button
              size="sm"
              variant="link"
              class="h-auto px-0 py-0.5 text-[11px]"
              :aria-expanded="requestState(req.id).expanded"
              @click="toggleRequest(req.id)"
            >
              {{ requestState(req.id).expanded ? $t("approvals.hideRequest") : $t("approvals.showRequest") }}
            </Button>
            <div
              v-if="requestState(req.id).expanded"
              class="mt-1 rounded-md border border-border/60 bg-background/60 p-2"
            >
              <div v-if="requestState(req.id).loading" class="text-[11px] text-muted-foreground">
                {{ $t("approvals.loadingRequest") }}
              </div>
              <div v-else-if="requestState(req.id).error" class="text-[11px] text-muted-foreground">
                {{ $t("approvals.requestUnavailable") }}
              </div>
              <template v-else-if="requestState(req.id).details">
                <div
                  v-if="Object.keys(requestState(req.id).details!.request.args).length === 0"
                  class="text-[11px] text-muted-foreground"
                >
                  {{ $t("approvals.noArguments") }}
                </div>
                <div v-else class="flex flex-col gap-1.5">
                  <div
                    v-for="[argKey, argValue] in Object.entries(requestState(req.id).details!.request.args)"
                    :key="argKey"
                    class="flex flex-col gap-0.5"
                  >
                    <span class="mono text-[11px] font-medium text-foreground">{{ argKey }}</span>
                    <span v-if="argIsHidden(argValue)" class="text-[11px] text-muted-foreground italic">
                      {{ $t("approvals.hiddenValue") }}
                    </span>
                    <pre
                      v-else
                      class="mono max-h-32 overflow-y-auto rounded bg-muted/50 p-1.5 text-[11px] break-words whitespace-pre-wrap"
                    >{{ argText(argValue) }}</pre>
                  </div>
                </div>
                <div
                  v-if="requestState(req.id).details!.request.truncated"
                  class="mt-1.5 text-[11px] text-muted-foreground"
                >
                  {{ $t("approvals.truncated") }}
                </div>
              </template>
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
  </div>
</template>
