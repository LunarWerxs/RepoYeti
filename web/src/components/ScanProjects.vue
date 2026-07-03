<script setup lang="ts">
import { ref } from "vue";
import { FolderSearch, HardDrive, Folder, Loader2, X } from "@lucide/vue";
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

const open = defineModel<boolean>("open", { required: true });
const store = useStore();

// Two scopes: the whole machine (default — every drive) or a single folder the owner types/pastes.
type Mode = "machine" | "folder";
const mode = ref<Mode>("machine");
const folderPath = ref("");

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
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t("scan.title") }}</DialogTitle>
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
        <button
          type="button"
          class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          :aria-label="$t('scan.stop')"
          @click="store.cancelScan()"
        >
          <X :size="15" />
        </button>
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

      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ $t("scan.close") }}</Button>
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
