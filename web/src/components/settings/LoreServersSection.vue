<script setup lang="ts">
// Expandable Lore server-registry body hosted by ExperimentalServersSection.
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Trash2, Plus, Loader2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Whether the parent Settings sheet is open — drives the on-open refresh below. */
const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void store.loadServers();
  },
  // Required: the Settings sheet is a Reka DialogRoot, so this component mounts only once the
  // sheet is already open — `open` is true on creation and a plain watcher never sees a
  // false→true edge, so this refresh never ran. See AccessSection.vue for the full note.
  { immediate: true },
);

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
  <ExpandTransition :open="store.loreServersEnabled">
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
        </form>
    </div>
  </ExpandTransition>
</template>
