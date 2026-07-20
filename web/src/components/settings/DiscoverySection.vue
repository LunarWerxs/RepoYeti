<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Trash2, Plus, Loader2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/** Whether the parent Settings sheet is open — drives the on-open refresh below. */
const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

// ── scan roots (discovery folders) ─────────────────────────────────────────────
// Most owners scan on-demand (whole-computer / a folder) rather than keeping watched roots, so the
// roots config is collapsed behind a toggle (default off). Purely a display preference — persisted
// per-browser in localStorage, no daemon setting. The switch never DISABLES watching (roots stay
// active regardless), so when roots exist the section auto-discloses below rather than sitting
// collapsed with an off-looking switch — the old collapsed "(1)" badge read as "disabled, yet
// somehow counting", which was exactly wrong.
const SCAN_FOLDERS_KEY = "repoyeti.showScanFolders";
const showScanFolders = ref(
  (() => {
    try {
      return localStorage.getItem(SCAN_FOLDERS_KEY) === "1";
    } catch {
      return false;
    }
  })(),
);
watch(showScanFolders, (v) => {
  try {
    localStorage.setItem(SCAN_FOLDERS_KEY, v ? "1" : "0");
  } catch {
    /* private mode / storage disabled — the in-memory ref still drives this session */
  }
});
// Configured roots mean folder-watching IS active — force the section open so the state is
// visible instead of hinted at by a count. A deliberate collapse THIS session is respected
// (userTouched); the next settings open re-discloses, which is the honest default while
// watching continues underneath.
const userTouchedScanFolders = ref(false);
watch(
  () => store.roots.length,
  (n) => {
    if (n > 0 && !userTouchedScanFolders.value && !showScanFolders.value) showScanFolders.value = true;
  },
  { immediate: true },
);
const newRoot = ref("");
const addingRoot = ref(false);
const confirmRemoveRoot = ref<string | null>(null);
// Load the current roots/servers whenever the sheet opens. Split out of the combined
// open-watcher that used to live in Settings.vue; the identities/accounts half now lives
// in IdentitiesSection and the access/tunnel half in AccessSection.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void store.loadRoots();
  },
  // Required: the Settings sheet is a Reka DialogRoot, so this component mounts only once the
  // sheet is already open — `open` is true on creation and a plain watcher never sees a
  // false→true edge, so this refresh never ran. See AccessSection.vue for the full note.
  { immediate: true },
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

// (Lore servers moved to LoreServersSection.vue under the Advanced tab — this section is
// scan-folders only now.)
</script>

<template>
  <!-- Scan folders (discovery roots) ───────────────────────────────── -->
  <!-- Collapsed behind a toggle (default off): most owners scan on demand and never keep watched
       roots, so the list/input is hidden until they opt in. -->
  <SettingsGroup :label="$t('settings.cardRoots')" :description="$t('settings.rootsHint')">
    <SettingsRow :label="$t('settings.scanFoldersEnable')">
      <template #control>
        <Switch
          :model-value="showScanFolders"
          :aria-label="$t('settings.scanFoldersEnable')"
          @update:model-value="(v: boolean) => { userTouchedScanFolders = true; showScanFolders = v; }"
        />
      </template>
    </SettingsRow>
    <ExpandTransition :open="showScanFolders">
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
    </ExpandTransition>
  </SettingsGroup>
</template>
