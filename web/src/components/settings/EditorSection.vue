<script setup lang="ts">
// "Open with…" default external editor picker. The file viewer's Open-with button launches this
// editor when the owner doesn't pick a specific one from its dropdown. Editors are launched on the
// daemon's machine, so this is a local-only convenience — but the *preference* is a normal owner
// setting (persisted + synced over `settings_changed`), so it's shown regardless of access mode.
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import type { EditorInfo } from "../../api";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import InfoHint from "@/shell/InfoHint.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const store = useStore();
const { t } = useI18n();

// Load the detected-editor catalogue when Settings mounts (lazy; no-ops after the first success).
onMounted(() => void store.loadEditors());

// <Select> is string-valued; the empty string is our "auto-pick the first installed editor"
// sentinel (maps to a null preference on the daemon).
const editorChoice = computed<string>({
  get: () => store.defaultEditor ?? "",
  set: (v: string) => void onPick(v),
});

async function onPick(id: string): Promise<void> {
  try {
    await store.setDefaultEditor(id);
  } catch {
    toast.error(t("settings.editorDefaultFailed"));
  }
}

/** Menu label — real editors show their name; uninstalled ones are annotated so the owner knows
 *  the button will fall back to the first installed editor. */
function editorLabel(e: EditorInfo): string {
  return e.available ? e.label : t("settings.editorNotInstalled", { name: e.label });
}
</script>

<template>
  <SettingsGroup :label="$t('settings.cardEditor')">
    <div class="flex flex-col gap-1.5 px-3.5 py-3">
      <span class="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {{ $t("settings.editorDefault") }}
        <InfoHint :text="$t('settings.editorHint')" />
      </span>
      <Select v-model="editorChoice">
        <SelectTrigger class="w-full" :aria-label="$t('settings.editorDefault')"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="">{{ $t("settings.editorAuto") }}</SelectItem>
          <SelectItem
            v-for="e in store.editorsCatalog"
            :key="e.id"
            :value="e.id"
            :disabled="!e.available"
          >
            {{ editorLabel(e) }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  </SettingsGroup>
</template>
