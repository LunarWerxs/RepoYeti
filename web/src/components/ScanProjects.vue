<script setup lang="ts">
import { ref, watch } from "vue";
import { ArrowLeft, FolderSearch, HardDrive, Folder, Loader2, X, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import { useStore } from "../store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const { t } = useI18n();

const open = defineModel<boolean>("open", { required: true });
const store = useStore();

// Two scopes: the whole machine (default — every drive) or a single folder the owner types/pastes.
type Mode = "machine" | "folder";
const mode = ref<Mode>("machine");
const folderPath = ref("");
// Repo ids currently being removed from the review list, so their row can show a spinner.
const removing = ref<string[]>([]);

// This component stays mounted for the app's lifetime (AppShell owns it), so closing the dialog
// leaves `mode`/`folderPath` exactly as they were. Reset them, and clear the previous run's
// summary, so reopening starts at the base view instead of a stale "Found 51 projects".
watch(open, (isOpen) => {
  if (isOpen) return;
  mode.value = "machine";
  folderPath.value = "";
  if (!store.scanning) {
    store.scanDone = false;
    store.scanNewRepos = [];
  }
});

function start(): void {
  if (store.scanning) return;
  if (mode.value === "folder") {
    const path = folderPath.value.trim();
    if (!path) return;
    void store.startScan({ path });
  } else {
    void store.startScan();
  }
}

/** Return to "Add a repository" — the flow this modal was opened from. */
function back(): void {
  store.scanReturnToAdd = false;
  open.value = false;
  store.addRepoOpen = true;
}

function close(): void {
  store.scanReturnToAdd = false;
  open.value = false;
}

/**
 * The daemon indexes each repo as it walks, so a scan cannot ask first — this is the undo.
 * removeRepo() tombstones the path, so a later scan won't silently re-add what was rejected here.
 */
async function discard(repo: { id: string; name: string }): Promise<void> {
  if (removing.value.includes(repo.id)) return;
  removing.value.push(repo.id);
  try {
    await store.removeRepo(repo.id);
    store.dropScanNewRepo(repo.id);
    toast.success(t("scan.discarded", { name: repo.name }));
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("scan.discardFailed"));
  } finally {
    removing.value = removing.value.filter((id) => id !== repo.id);
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-1.5">
          <Tooltip v-if="store.scanReturnToAdd">
            <TooltipTrigger as-child>
              <button
                type="button"
                class="-ml-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                :aria-label="$t('scan.back')"
                @click="back"
              >
                <ArrowLeft :size="15" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ $t("scan.back") }}</TooltipContent>
          </Tooltip>
          {{ $t("scan.title") }}
        </DialogTitle>
        <DialogDescription>{{ $t("scan.description") }}</DialogDescription>
      </DialogHeader>

      <!-- scope: the whole computer, or one folder -->
      <div class="inline-flex w-full rounded-lg border border-border/60 bg-secondary/40 p-0.5 text-[12.5px]">
        <button
          type="button"
          class="flex-1 rounded-md px-2.5 py-1.5 font-medium transition-colors"
          :class="mode === 'machine' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
          @click="mode = 'machine'"
        >
          {{ $t("scan.modeMachine") }}
        </button>
        <button
          type="button"
          class="flex-1 rounded-md px-2.5 py-1.5 font-medium transition-colors"
          :class="mode === 'folder' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
          @click="mode = 'folder'"
        >
          {{ $t("scan.modeFolder") }}
        </button>
      </div>

      <!-- whole computer -->
      <div
        v-if="mode === 'machine'"
        class="flex items-start gap-2.5 rounded-md border border-border/60 bg-secondary/40 px-3 py-2.5 text-[12.5px] text-muted-foreground"
      >
        <HardDrive :size="16" class="mt-px shrink-0" />
        <span>{{ $t("scan.machineHint") }}</span>
      </div>

      <!-- specific folder -->
      <div v-else class="flex flex-col gap-1.5">
        <label class="text-[12px] font-medium text-muted-foreground">{{ $t("scan.folderLabel") }}</label>
        <Input
          v-model="folderPath"
          :placeholder="$t('scan.folderPlaceholder')"
          class="mono text-[12.5px]"
          spellcheck="false"
          @keydown.enter.prevent="start"
        />
        <p class="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Folder :size="12" class="shrink-0" /> {{ $t("scan.folderHint") }}
        </p>
      </div>

      <!-- live status: scanning (with a Stop X) → or the last run's summary -->
      <div
        v-if="store.scanning"
        class="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-secondary/40 px-3 py-2"
      >
        <div class="flex min-w-0 items-center gap-2 text-[13px]">
          <Loader2 :size="15" class="shrink-0 animate-spin text-info" />
          <span>{{ $t("scan.scanning") }}</span>
          <span class="truncate text-muted-foreground">{{ $t("scan.foundCount", { count: store.scanFound }) }}</span>
        </div>
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              :aria-label="$t('scan.stop')"
              @click="store.cancelScan()"
            >
              <X :size="15" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{{ $t("scan.stop") }}</TooltipContent>
        </Tooltip>
      </div>
      <div
        v-else-if="store.scanDone"
        class="rounded-md border border-border/60 bg-secondary/40 px-3 py-2 text-[13px]"
      >
        <template v-if="store.scanFound > 0">
          {{ $t("scan.doneFound", { count: store.scanFound }, store.scanFound) }}<span
            v-if="store.scanNew > 0"
            class="text-info"
          > · {{ $t("scan.doneNew", { count: store.scanNew }) }}</span>
        </template>
        <span v-else class="text-muted-foreground">{{ $t("scan.doneNone") }}</span>
        <span v-if="store.lastScanCancelled" class="text-muted-foreground"> · {{ $t("scan.stopped") }}</span>
      </div>

      <!-- Which projects are new. A scan adds as it walks (it has to — it indexes and watches each
           repo to read its status), so this is the review list rather than a confirmation prompt:
           every find is named, and anything unwanted can be discarded right here. -->
      <div v-if="store.scanNewRepos.length" class="flex min-h-0 flex-col gap-1.5">
        <p class="text-[12px] font-medium text-muted-foreground">
          {{ $t("scan.newListLabel", { count: store.scanNewRepos.length }, store.scanNewRepos.length) }}
        </p>
        <ul class="flex max-h-44 flex-col gap-px overflow-y-auto rounded-md border border-border/60 bg-secondary/30 p-1">
          <li
            v-for="repo in store.scanNewRepos"
            :key="repo.id"
            class="group flex items-center gap-2 rounded-sm px-2 py-1.5 transition-colors hover:bg-secondary/70"
          >
            <span class="flex min-w-0 flex-col">
              <span class="truncate text-[12.5px] font-medium text-foreground">{{ repo.name }}</span>
              <span class="mono truncate text-[11px] text-muted-foreground">{{ repo.absPath }}</span>
            </span>
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  type="button"
                  class="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                  :disabled="removing.includes(repo.id)"
                  :aria-label="$t('scan.discard')"
                  @click="discard(repo)"
                >
                  <Loader2 v-if="removing.includes(repo.id)" :size="14" class="animate-spin" />
                  <Trash2 v-else :size="14" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{{ $t("scan.discard") }}</TooltipContent>
            </Tooltip>
          </li>
        </ul>
        <p class="text-[11.5px] text-muted-foreground">{{ $t("scan.newListHint") }}</p>
      </div>

      <DialogFooter>
        <Button v-if="store.scanReturnToAdd" variant="ghost" @click="back">
          <ArrowLeft /> {{ $t("scan.back") }}
        </Button>
        <Button variant="ghost" @click="close">{{ $t("scan.close") }}</Button>
        <Button
          v-if="!store.scanning"
          :disabled="mode === 'folder' && !folderPath.trim()"
          @click="start"
        >
          <FolderSearch />
          {{ store.scanDone ? $t("scan.again") : $t("scan.start") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
