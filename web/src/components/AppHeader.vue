<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RefreshCw, Plus, Settings, Cloud, CloudOff, CircleUser, Check, DownloadCloud, FolderSearch, Loader2, MoreVertical, Power } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useStore } from "../store";
import { useRepoFeedback } from "@/lib/repo-feedback";

defineProps<{ connected: boolean; repoCount: number }>();
const emit = defineEmits<{ reload: []; add: []; settings: []; remote: [] }>();

const store = useStore();
const { t } = useI18n();
const { friendly } = useRepoFeedback();
const actionsOpen = ref(false);
const actionsMenuRef = ref<HTMLElement | null>(null);
const confirmShutdownOpen = ref(false);
const shuttingDown = ref(false);
// GitHub account quick-switcher (only shown when the gh CLI has at least one account).
const accountsOpen = ref(false);
const accountsMenuRef = ref<HTMLElement | null>(null);
const showAccounts = computed(() => store.ghAvailable && store.ghAccounts.length >= 1);

function firstFetchFailureDescription(failed: Array<{ name: string; code: string }>): string | undefined {
  const first = failed[0];
  if (!first) return undefined;
  const reason = friendly(first.code) || first.code;
  const more = failed.length - 1;
  return more > 0
    ? t("header.fetchAllFirstFailureMore", { name: first.name, reason, count: more }, more)
    : t("header.fetchAllFirstFailure", { name: first.name, reason });
}

function toastFetchError(e: unknown): void {
  const description = e instanceof Error ? e.message : "";
  if (description) toast.error(t("header.fetchAllFailed"), { description });
  else toast.error(t("header.fetchAllFailed"));
}

// Fetch every repo that has a remote, then toast a one-line summary.
async function fetchAll(): Promise<void> {
  if (store.fetchingAll) return;
  actionsOpen.value = false;
  if (store.repos.length === 0) {
    toast.message(t("header.fetchAllNoRepos"));
    return;
  }
  try {
    const r = await store.fetchAll();
    if (r.total === 0) toast.message(t("header.fetchAllNone"));
    else if (r.failed.length === 0) toast.success(t("header.fetchAllDone", { count: r.ok }, r.ok));
    else {
      const description = firstFetchFailureDescription(r.failed);
      if (description) toast.warning(t("header.fetchAllPartial", { ok: r.ok, failed: r.failed.length }), { description });
      else toast.warning(t("header.fetchAllPartial", { ok: r.ok, failed: r.failed.length }));
    }
  } catch (e) {
    toastFetchError(e);
  }
}

async function updateApp(): Promise<void> {
  actionsOpen.value = false;
  if (store.updateApplying || store.updateChecking) return;
  try {
    let status = store.updateStatus;
    if (!status) status = await store.checkForUpdate();
    if (!status?.ok) {
      toast.warning(t("header.updateCheckFailed"), {
        description: status?.reason ?? undefined,
      });
      return;
    }
    if (!status?.updateAvailable) {
      toast.message(t("header.updateNone"));
      return;
    }
    if (!status.canApply) {
      toast.warning(t("header.updateBlocked"), {
        description: status.reason ?? undefined,
      });
      return;
    }
    const result = await store.applyUpdate();
    toast.success(t("header.updateApplied"), {
      description: result.restartRequired ? t("header.updateRestart") : undefined,
    });
  } catch (e) {
    toast.error(t("header.updateFailed"), {
      description: e instanceof Error ? e.message : undefined,
    });
  }
}

function toggleActions(): void {
  actionsOpen.value = !actionsOpen.value;
  if (actionsOpen.value) accountsOpen.value = false;
}

function toggleAccounts(): void {
  accountsOpen.value = !accountsOpen.value;
  if (accountsOpen.value) actionsOpen.value = false;
}

// Switch the machine's active GitHub account, then toast the outcome. Closes the menu first so the
// quick-switch feels instant; the header label + settings list update from the returned snapshot.
async function switchAccount(login: string, host: string): Promise<void> {
  accountsOpen.value = false;
  if (store.switchingAccount) return;
  try {
    await store.switchAccount(login, host);
    toast.success(t("accounts.toast.switched", { login }));
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("accounts.toast.switchFailed"));
  }
}

function manageAccounts(): void {
  accountsOpen.value = false;
  emit("settings");
}

function onWindowPointerDown(e: PointerEvent): void {
  const target = e.target;
  if (!(target instanceof Node)) return;
  if (actionsOpen.value && !actionsMenuRef.value?.contains(target)) actionsOpen.value = false;
  if (accountsOpen.value && !accountsMenuRef.value?.contains(target)) accountsOpen.value = false;
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    actionsOpen.value = false;
    accountsOpen.value = false;
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown.value) return;
  shuttingDown.value = true;
  try {
    await store.shutdown();
    confirmShutdownOpen.value = false;
    toast.message(t("header.shutdownStarted"));
  } catch {
    toast.error(t("header.shutdownFailed"));
    confirmShutdownOpen.value = false;
    shuttingDown.value = false;
  }
}

function reload(): void {
  actionsOpen.value = false;
  emit("reload");
}

function openScan(): void {
  actionsOpen.value = false;
  store.scanOpen = true;
}

function openSettings(): void {
  actionsOpen.value = false;
  emit("settings");
}

function openShutdownConfirm(): void {
  actionsOpen.value = false;
  confirmShutdownOpen.value = true;
}

onMounted(() => {
  window.addEventListener("pointerdown", onWindowPointerDown);
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onWindowPointerDown);
  window.removeEventListener("keydown", onWindowKeydown);
});
</script>

<template>
  <header class="safe-top sticky top-0 z-30 bg-background/80 backdrop-blur">
    <div class="mx-auto flex max-w-(--container-max) items-center justify-between gap-2 px-4 py-2.5 sm:px-6">
      <div class="flex items-center gap-2.5">
        <!-- Standalone medallion, swapped by theme so the disc always contrasts with the header. -->
        <img :src="'/icon-light.svg'" alt="" width="30" height="30" class="dark:hidden" />
        <img :src="'/icon-dark.svg'" alt="" width="30" height="30" class="hidden dark:block" />
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
            v-if="store.mode === 'remote'"
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

        <!-- GitHub account quick-switcher -->
        <div v-if="showAccounts" ref="accountsMenuRef" class="relative">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="sm"
                class="gap-1.5 px-2 text-muted-foreground"
                :aria-label="$t('header.switchAccount')"
                :aria-expanded="accountsOpen"
                aria-haspopup="menu"
                @click.stop="toggleAccounts"
              >
                <Loader2 v-if="store.switchingAccount" class="animate-spin" />
                <CircleUser v-else />
                <span class="hidden max-w-[9rem] truncate sm:inline">
                  {{ store.activeAccount?.login ?? store.ghAccounts[0]?.login }}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ $t("header.switchAccount") }}</TooltipContent>
          </Tooltip>
          <div
            v-if="accountsOpen"
            role="menu"
            class="absolute top-[calc(100%+0.375rem)] right-0 z-50 w-56 rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl shadow-black/40"
            @click.stop
          >
            <div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{{ $t("header.accounts") }}</div>
            <button
              v-for="a in store.ghAccounts"
              :key="`${a.host}/${a.login}`"
              type="button"
              role="menuitemradio"
              :aria-checked="a.active"
              :disabled="a.active || !!store.switchingAccount"
              class="relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
              @click="switchAccount(a.login, a.host)"
            >
              <Loader2 v-if="store.switchingAccount === a.login" class="animate-spin" />
              <Check v-else-if="a.active" class="text-emerald-500" />
              <CircleUser v-else class="text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate">{{ a.login }}</span>
              <span v-if="a.active" class="shrink-0 text-[10px] text-muted-foreground">{{ $t("accounts.active") }}</span>
            </button>
            <div class="-mx-1 my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              class="relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
              @click="manageAccounts"
            >
              <Settings />
              <span>{{ $t("header.accountsManage") }}</span>
            </button>
          </div>
        </div>

        <div ref="actionsMenuRef" class="relative">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                :aria-label="$t('header.moreActions')"
                :aria-expanded="actionsOpen"
                aria-haspopup="menu"
                @click.stop="toggleActions"
              >
                <MoreVertical />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ $t("header.moreActions") }}</TooltipContent>
          </Tooltip>
          <div
            v-if="actionsOpen"
            role="menu"
            class="absolute top-[calc(100%+0.375rem)] right-0 z-50 w-52 rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl shadow-black/40"
            @click.stop
          >
            <div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{{ $t("header.actions") }}</div>
            <button
              type="button"
              role="menuitem"
              :disabled="store.fetchingAll"
              class="relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0"
              @click="fetchAll"
            >
              <Loader2 v-if="store.fetchingAll" class="animate-spin" />
              <DownloadCloud v-else />
              <span>{{ $t("header.fetchAll") }}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              :disabled="store.updateChecking || store.updateApplying"
              class="relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0"
              @click="updateApp"
            >
              <Loader2 v-if="store.updateChecking || store.updateApplying" class="animate-spin" />
              <DownloadCloud v-else />
              <span>{{ $t("header.checkUpdates") }}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
              @click="openScan"
            >
              <FolderSearch />
              <span>{{ $t("header.scanProjects") }}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
              @click="reload"
            >
              <RefreshCw />
              <span>{{ $t("header.reload") }}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
              @click="openSettings"
            >
              <Settings />
              <span>{{ $t("header.settings") }}</span>
            </button>
            <div class="-mx-1 my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              :disabled="shuttingDown"
              class="relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive outline-hidden transition-colors hover:bg-destructive/10 focus:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-destructive/20 dark:focus:bg-destructive/20 [&_svg]:size-4 [&_svg]:shrink-0"
              @click="openShutdownConfirm"
            >
              <Power />
              <span>{{ $t("header.shutdown") }}</span>
            </button>
          </div>
        </div>

        <Button
          size="icon-sm"
          class="ml-1 transition-transform hover:scale-105 sm:w-auto sm:gap-1.5 sm:px-2.5"
          :aria-label="$t('header.addRepository')"
          @click="$emit('add')"
        >
          <Plus />
          <span class="hidden sm:inline">{{ $t("header.addRepository") }}</span>
        </Button>
      </div>
    </div>
  </header>

  <Dialog v-model:open="confirmShutdownOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t("header.shutdownTitle") }}</DialogTitle>
        <DialogDescription>{{ $t("header.shutdownBody") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button variant="secondary" :disabled="shuttingDown" @click="confirmShutdownOpen = false">
          {{ $t("common.cancel") }}
        </Button>
        <Button variant="destructive" :disabled="shuttingDown" @click="shutdown">
          <Loader2 v-if="shuttingDown" class="animate-spin" />
          <Power v-else />
          {{ $t("header.shutdownConfirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
