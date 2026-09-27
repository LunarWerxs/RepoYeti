<script setup lang="ts">
// Advanced-tab section: diff tuning knobs. Holds the large-file patch threshold — a byte-size
// implementation detail nobody should meet on the General tab. The everyday diff switches
// (per-file stats, always-side-by-side) stay in Appearance; this row only exists while the
// compact-patch mode those switches control is actually in play.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const store = useStore();
const { t } = useI18n();

// Preset sizes are powers of two so the labels read as real KB/MB (512 KB = 524288 = the
// server default). <Select> is string-valued, so map via String(bytes).
const DIFF_PATCH_OPTIONS = [
  { bytes: 256 * 1024, label: "256 KB" },
  { bytes: 512 * 1024, label: "512 KB" },
  { bytes: 1024 * 1024, label: "1 MB" },
  { bytes: 2 * 1024 * 1024, label: "2 MB" },
];
const diffPatchChoice = computed<string>({
  get: () => String(store.diffPatchBytes),
  set: (v: string) => void onDiffPatchBytes(Number(v)),
});
async function onDiffPatchBytes(bytes: number): Promise<void> {
  try {
    await store.setDiffPatchBytes(bytes);
  } catch {
    toast.error(t("settings.diffPatchThresholdFailed"));
  }
}
</script>

<template>
  <SettingsGroup :label="$t('settings.cardDiffs')">
    <!-- Threshold is moot when "always side-by-side" (Appearance) is on → HIDE it (not dim);
         the group then collapses to its header, which is honest: nothing to tune. -->
    <ExpandTransition :open="store.diffPatchEnabled">
      <SettingsRow :label="$t('settings.diffPatchThreshold')">
        <template #info><InfoHint :text="$t('settings.diffPatchThresholdHint')" /></template>
        <template #control>
          <Select v-model="diffPatchChoice">
            <SelectTrigger class="w-full max-w-36" :aria-label="$t('settings.diffPatchThreshold')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="o in DIFF_PATCH_OPTIONS" :key="o.bytes" :value="String(o.bytes)">
                {{ o.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </template>
      </SettingsRow>
    </ExpandTransition>
    <!-- When the threshold is hidden (always-side-by-side on), say why instead of rendering an
         empty card — an Advanced group with visibly nothing in it reads as a rendering bug. -->
    <p v-if="!store.diffPatchEnabled" class="px-3.5 py-3 text-xs text-muted-foreground">
      {{ $t("settings.diffPatchAllOff") }}
    </p>
  </SettingsGroup>
</template>
