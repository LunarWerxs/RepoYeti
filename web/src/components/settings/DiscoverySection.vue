<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Trash2, Plus, Loader2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Whether the parent Settings sheet is open — drives the on-open refresh below. */
const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

// ── scan roots (discovery folders) ─────────────────────────────────────────────
const newRoot = ref("");
const addingRoot = ref(false);
const confirmRemoveRoot = ref<string | null>(null);
// Load the current roots/servers whenever the sheet opens. Split out of the combined
// open-watcher that used to live in Settings.vue; the identities/accounts/tunnel half of it
// now lives in IdentityAccessSection.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      void store.loadRoots();
      void store.loadServers();
    }
  },
);
async function addRoot(): Promise<void> {
  const path = newRoot.value.trim();
  if (!path || addingRoot.value) return;
  addingRoot.value = true;
  try {
    await store.addScanRoot(path);
    toast.success(t("settings.rootsAdded", { path }));
    newRoot.value = "";
  } catch {
    toast.error(t("settings.rootsAddFailed"));
  } finally {
    addingRoot.value = false;
  }
}
async function removeRoot(path: string): Promise<void> {
  if (confirmRemoveRoot.value !== path) {
    confirmRemoveRoot.value = path; // first click arms the confirm
    return;
  }
  confirmRemoveRoot.value = null;
  try {
    const removed = await store.removeScanRoot(path);
    toast.success(t("settings.rootsRemoved", { count: removed }, removed));
  } catch {
    toast.error(t("settings.rootsRemoveFailed"));
  }
}

// ── lore servers (registry RepoYeti can clone from) ─────────────────────────────
const newServerName = ref("");
const newServerUrl = ref("");
const addingServer = ref(false);
const confirmRemoveServer = ref<string | null>(null);
async function addServer(): Promise<void> {
  const url = newServerUrl.value.trim();
  if (!url || addingServer.value) return;
  addingServer.value = true;
  try {
    await store.addServer(url, newServerName.value.trim() || undefined);
    toast.success(t("settings.serversAdded"));
    newServerName.value = "";
    newServerUrl.value = "";
  } catch {
    toast.error(t("settings.serversAddFailed"));
  } finally {
    addingServer.value = false;
  }
}
async function removeServer(id: string): Promise<void> {
  if (confirmRemoveServer.value !== id) {
    confirmRemoveServer.value = id; // first click arms the confirm
    return;
  }
  confirmRemoveServer.value = null;
  try {
    await store.removeServer(id);
    toast.success(t("settings.serversRemoved"));
  } catch {
    toast.error(t("settings.serversRemoveFailed"));
  }
}
</script>

<template>
  <!-- Scan folders (discovery roots) ───────────────────────────────── -->
  <div class="flex flex-col gap-1.5">
    <SettingsGroup :label="$t('settings.cardRoots')">
      <div class="flex flex-col gap-2.5 px-3.5 py-3">
        <p v-if="!store.roots.length" class="text-[12.5px] text-muted-foreground">
          {{ $t("settings.rootsEmpty") }}
        </p>
        <div
          v-for="r in store.roots"
          :key="r"
          class="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2.5 py-1.5"
        >
          <code class="mono min-w-0 flex-1 truncate text-[12px]" :title="r">{{ r }}</code>
          <Button
            :variant="confirmRemoveRoot === r ? 'destructive' : 'ghost'"
            size="sm"
            class="shrink-0"
            :aria-label="$t('settings.rootsRemove')"
            @click="removeRoot(r)"
            @blur="confirmRemoveRoot = null"
          >
            <Trash2 />
            <span v-if="confirmRemoveRoot === r">{{ $t("settings.rootsRemove") }}</span>
          </Button>
        </div>
        <form class="flex items-center gap-2 pt-0.5" @submit.prevent="addRoot">
          <Input
            v-model="newRoot"
            class="mono min-w-0 flex-1 text-[12.5px]"
            :placeholder="$t('settings.rootsPlaceholder')"
            :aria-label="$t('settings.rootsAdd')"
          />
          <Button type="submit" size="sm" class="shrink-0" :disabled="!newRoot.trim() || addingRoot">
            <Loader2 v-if="addingRoot" class="animate-spin" />
            <Plus v-else />
            {{ $t("settings.rootsAdd") }}
          </Button>
        </form>
      </div>
    </SettingsGroup>
    <p class="px-1 text-[11px] text-muted-foreground/70">{{ $t("settings.rootsHint") }}</p>
  </div>

  <!-- Lore servers (clone-from-server registry) ─────────────────────────── -->
  <div class="flex flex-col gap-1.5">
    <SettingsGroup :label="$t('settings.cardServers')">
      <div class="flex flex-col gap-2.5 px-3.5 py-3">
        <p v-if="!store.servers.length" class="text-[12.5px] text-muted-foreground">
          {{ $t("settings.serversEmpty") }}
        </p>
        <div
          v-for="s in store.servers"
          :key="s.id"
          class="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2.5 py-1.5"
        >
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-[12.5px] font-medium text-foreground">{{ s.name }}</span>
            <code class="mono truncate text-[11.5px] text-muted-foreground" :title="s.url">{{ s.url }}</code>
          </span>
          <Button
            :variant="confirmRemoveServer === s.id ? 'destructive' : 'ghost'"
            size="sm"
            class="shrink-0"
            :aria-label="$t('settings.serversRemove')"
            @click="removeServer(s.id)"
            @blur="confirmRemoveServer = null"
          >
            <Trash2 />
            <span v-if="confirmRemoveServer === s.id">{{ $t("settings.serversRemove") }}</span>
          </Button>
        </div>
        <form class="flex flex-col gap-2 pt-0.5" @submit.prevent="addServer">
          <Input
            v-model="newServerName"
            class="text-[12.5px]"
            :placeholder="$t('settings.serversPlaceholderName')"
            :aria-label="$t('settings.serversLabelName')"
          />
          <div class="flex items-center gap-2">
            <Input
              v-model="newServerUrl"
              class="mono min-w-0 flex-1 text-[12.5px]"
              :placeholder="$t('settings.serversPlaceholderUrl')"
              :aria-label="$t('settings.serversLabelUrl')"
            />
            <Button type="submit" size="sm" class="shrink-0" :disabled="!newServerUrl.trim() || addingServer">
              <Loader2 v-if="addingServer" class="animate-spin" />
              <Plus v-else />
              {{ $t("settings.serversAdd") }}
            </Button>
          </div>
          <p class="text-[11.5px] text-muted-foreground">{{ $t("settings.serversIpHint") }}</p>
        </form>
      </div>
    </SettingsGroup>
    <p class="px-1 text-[11px] text-muted-foreground/70">{{ $t("settings.serversHint") }}</p>
  </div>
</template>
