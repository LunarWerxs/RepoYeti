<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FolderGit2, FolderPlus, DownloadCloud, Server, FolderSearch, Loader2 } from "@lucide/vue";
import { toast } from "vue-sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const { t } = useI18n();

const open = defineModel<boolean>("open", { required: true });
const store = useStore();

type Mode = "register" | "create" | "clone" | "lore";
const mode = ref<Mode>("register");
const path = ref(""); // register / create

// clone fields
const cloneUrl = ref("");
const cloneParent = ref("");
const cloneName = ref("");
const cloneIdentity = ref("none"); // "none" sentinel → null on submit

// lore fields (clone from a registered Lore server)
const loreServerUrl = ref(""); // selected server's URL
const loreRepoPath = ref(""); // repo path on the server, appended to the server URL
const loreName = ref("");
const loreParent = ref("");

const busy = ref(false);

// Load scan roots when the dialog opens so the clone destination can default to one.
watch(open, (isOpen) => {
  if (isOpen) {
    if (!store.roots.length) void store.loadRoots();
    if (!store.servers.length) void store.loadServers();
  }
});
watch(
  () => store.roots,
  (rs) => {
    if (rs.length) {
      if (!cloneParent.value) cloneParent.value = rs[0]!;
      if (!loreParent.value) loreParent.value = rs[0]!;
    }
  },
  { immediate: true },
);
watch(
  () => store.servers,
  (ss) => {
    if (!loreServerUrl.value && ss.length) loreServerUrl.value = ss[0]!.url;
  },
  { immediate: true },
);

const canSubmit = computed(() => {
  if (busy.value) return false;
  if (mode.value === "clone") return cloneUrl.value.trim().length > 0 && cloneParent.value.trim().length > 0;
  if (mode.value === "lore")
    return loreServerUrl.value.length > 0 && loreRepoPath.value.trim().length > 0 && loreParent.value.trim().length > 0;
  return path.value.trim().length > 0;
});

// Single-select mode switch. reka-ui's ToggleGroup lets you toggle the active item
// OFF (empty) — guard against that so a mode is always selected.
function selectMode(v: unknown): void {
  if (v && typeof v === "string") mode.value = v as Mode;
}

// Hand off to the one "Scan for projects" modal — scanning lives there, not in this dialog.
function openScan(): void {
  open.value = false;
  store.scanOpen = true;
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  try {
    if (mode.value === "clone") {
      const repo = await store.cloneRepo({
        url: cloneUrl.value.trim(),
        parentPath: cloneParent.value.trim(),
        name: cloneName.value.trim() || undefined,
        identityId: cloneIdentity.value === "none" ? null : cloneIdentity.value,
      });
      toast.success(t("addRepo.toastCloned", { name: repo.name }));
      cloneUrl.value = "";
      cloneName.value = "";
    } else if (mode.value === "lore") {
      const base = loreServerUrl.value.replace(/\/+$/, "");
      const url = `${base}/${loreRepoPath.value.trim().replace(/^\/+/, "")}`;
      const repo = await store.cloneFromServer({
        url,
        parentPath: loreParent.value.trim(),
        name: loreName.value.trim() || undefined,
      });
      toast.success(t("addRepo.toastLoreCloned", { name: repo.name }));
      loreRepoPath.value = "";
      loreName.value = "";
    } else {
      const repo = await store.addRepo(mode.value, path.value.trim());
      toast.success(
        mode.value === "create"
          ? t("addRepo.toastCreated", { name: repo.name })
          : t("addRepo.toastAdded", { name: repo.name }),
      );
      path.value = "";
    }
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

      <ToggleGroup
        type="single"
        :model-value="mode"
        class="grid w-full grid-cols-2 gap-1 rounded-lg bg-secondary p-1"
        @update:model-value="selectMode"
      >
        <ToggleGroupItem value="register" class="justify-center gap-1.5">
          <FolderGit2 :size="14" /> {{ $t("addRepo.modeRegister") }}
        </ToggleGroupItem>
        <ToggleGroupItem value="create" class="justify-center gap-1.5">
          <FolderPlus :size="14" /> {{ $t("addRepo.modeCreate") }}
        </ToggleGroupItem>
        <ToggleGroupItem value="clone" class="justify-center gap-1.5">
          <DownloadCloud :size="14" /> {{ $t("addRepo.modeClone") }}
        </ToggleGroupItem>
        <ToggleGroupItem value="lore" class="justify-center gap-1.5">
          <Server :size="14" /> {{ $t("addRepo.modeLore") }}
        </ToggleGroupItem>
      </ToggleGroup>

      <!-- hand-off to the dedicated Scan-for-projects modal -->
      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-left transition-colors hover:bg-secondary/60 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
        @click="openScan"
      >
        <FolderSearch />
        <span class="flex flex-col">
          <span class="text-[13px] font-medium text-foreground">{{ $t("addRepo.scanButton") }}</span>
          <span class="text-[11.5px] text-muted-foreground">{{ $t("addRepo.scanHint") }}</span>
        </span>
      </button>

      <!-- register / create: a single path -->
      <template v-if="mode === 'register' || mode === 'create'">
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
      </template>

      <!-- clone: url + destination folder + optional name + identity -->
      <template v-else-if="mode === 'clone'">
        <p class="text-[12.5px] text-muted-foreground">{{ $t("addRepo.hintClone") }}</p>
        <div class="flex flex-col gap-1.5">
          <label class="text-[12px] text-muted-foreground">{{ $t("addRepo.labelUrl") }}</label>
          <Input v-model="cloneUrl" class="mono" :placeholder="$t('addRepo.placeholderUrl')" @keyup.enter="submit" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[12px] text-muted-foreground">{{ $t("addRepo.labelParent") }}</label>
          <Input v-model="cloneParent" class="mono" :placeholder="$t('addRepo.placeholderParent')" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[12px] text-muted-foreground">{{ $t("addRepo.labelName") }}</label>
          <Input v-model="cloneName" class="mono" :placeholder="$t('addRepo.placeholderName')" @keyup.enter="submit" />
        </div>
        <div v-if="store.identities.length" class="flex flex-col gap-1.5">
          <label class="text-[12px] text-muted-foreground">{{ $t("addRepo.labelIdentity") }}</label>
          <Select v-model="cloneIdentity">
            <SelectTrigger class="w-full" :aria-label="$t('addRepo.labelIdentity')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{{ $t("addRepo.identityNone") }}</SelectItem>
              <SelectItem v-for="i in store.identities" :key="i.id" :value="i.id">{{ i.displayName }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </template>

      <!-- lore: clone from a registered Lore server -->
      <template v-else-if="mode === 'lore'">
        <p class="text-[12.5px] text-muted-foreground">{{ $t("addRepo.hintLore") }}</p>
        <div v-if="store.servers.length" class="flex flex-col gap-1.5">
          <label class="text-[12px] text-muted-foreground">{{ $t("addRepo.labelServer") }}</label>
          <Select v-model="loreServerUrl">
            <SelectTrigger class="w-full" :aria-label="$t('addRepo.labelServer')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="s in store.servers" :key="s.id" :value="s.url">{{ s.name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p v-else class="text-[12.5px] text-muted-foreground">{{ $t("addRepo.loreNoServers") }}</p>
        <div class="flex flex-col gap-1.5">
          <label class="text-[12px] text-muted-foreground">{{ $t("addRepo.labelLoreRepo") }}</label>
          <Input v-model="loreRepoPath" class="mono" :placeholder="$t('addRepo.placeholderLoreRepo')" @keyup.enter="submit" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[12px] text-muted-foreground">{{ $t("addRepo.labelParent") }}</label>
          <Input v-model="loreParent" class="mono" :placeholder="$t('addRepo.placeholderParent')" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[12px] text-muted-foreground">{{ $t("addRepo.labelName") }}</label>
          <Input v-model="loreName" class="mono" :placeholder="$t('addRepo.placeholderName')" @keyup.enter="submit" />
        </div>
      </template>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ $t("addRepo.cancel") }}</Button>
        <Button :disabled="!canSubmit" @click="submit">
          <Loader2 v-if="busy" class="animate-spin" />
          {{ mode === "create" ? $t("addRepo.submitCreate") : mode === "clone" ? $t("addRepo.submitClone") : mode === "lore" ? $t("addRepo.submitLore") : $t("addRepo.submitAdd") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
