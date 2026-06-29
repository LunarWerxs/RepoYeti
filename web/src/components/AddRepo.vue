<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { FolderGit2, FolderPlus } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { cn } from "@/lib/utils";
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

const { t } = useI18n();

const open = defineModel<boolean>("open", { required: true });
const store = useStore();

const mode = ref<"register" | "create">("register");
const path = ref("");
const busy = ref(false);
const canSubmit = computed(() => path.value.trim().length > 0 && !busy.value);

const seg = (active: boolean): string =>
  cn(
    "flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium outline-none transition-all active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring/40",
    active
      ? "bg-card text-foreground shadow-sm"
      : "text-muted-foreground hover:bg-card/50 hover:text-foreground active:bg-card/70",
  );

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  try {
    const repo = await store.addRepo(mode.value, path.value.trim());
    toast.success(mode.value === "create" ? t("addRepo.toastCreated", { name: repo.name }) : t("addRepo.toastAdded", { name: repo.name }));
    path.value = "";
    open.value = false;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("addRepo.toastFailed"));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ $t("addRepo.title") }}</DialogTitle>
        <DialogDescription>{{ $t("addRepo.description") }}</DialogDescription>
      </DialogHeader>

      <div class="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1">
        <button :class="seg(mode === 'register')" :aria-pressed="mode === 'register'" @click="mode = 'register'">
          <FolderGit2 :size="14" /> {{ $t("addRepo.modeRegister") }}
        </button>
        <button :class="seg(mode === 'create')" :aria-pressed="mode === 'create'" @click="mode = 'create'">
          <FolderPlus :size="14" /> {{ $t("addRepo.modeCreate") }}
        </button>
      </div>

      <p class="text-[12.5px] text-muted-foreground">
        <template v-if="mode === 'register'">{{ $t("addRepo.hintRegister") }}</template>
        <template v-else>{{ $t("addRepo.hintCreateBefore") }}<code class="mono">git init</code>{{ $t("addRepo.hintCreateAfter") }}</template>
      </p>

      <Input
        v-model="path"
        class="mono"
        :placeholder="mode === 'register' ? $t('addRepo.placeholderRegister') : $t('addRepo.placeholderCreate')"
        @keyup.enter="submit"
      />

      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ $t("addRepo.cancel") }}</Button>
        <Button :disabled="!canSubmit" @click="submit">
          {{ mode === "create" ? $t("addRepo.submitCreate") : $t("addRepo.submitAdd") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
