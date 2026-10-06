<script setup lang="ts">
// The Cloudflare API token behind Artifacts remotes (src/artifacts.ts on the daemon). Write-only:
// the daemon reports whether one is saved and never sends it back, so this panel can only replace
// or remove it.
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ExternalLink, Loader2, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { api, ApiError } from "../../api";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const props = defineProps<{ open: boolean }>();
const { t } = useI18n();

const CREATE_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";
const configured = ref(false);
const token = ref("");
const saving = ref(false);

async function refresh(): Promise<void> {
  try {
    configured.value = (await api.artifactsStatus()).configured;
  } catch {
    // Leave the last known state; the field still works, and a save reports its own result.
  }
}

async function save(clear = false): Promise<void> {
  const value = clear ? "" : token.value.trim();
  if (saving.value || (!clear && !value)) return;
  saving.value = true;
  try {
    configured.value = (await api.setArtifactsToken(value)).configured;
    token.value = "";
    toast.success(clear ? t("settings.artifacts.cleared") : t("settings.artifacts.saved"));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("settings.artifacts.saveFailed"));
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    token.value = "";
    void refresh();
  },
  // Required — see AccessSection.vue: the sheet's DialogRoot mounts this only once `open` is
  // already true, so without `immediate` a plain watcher never fires and this never refreshed.
  { immediate: true },
);
</script>

<template>
  <SettingsGroup :label="$t('settings.artifacts.title')" :description="$t('settings.artifacts.description')">
    <form class="flex flex-col gap-2 px-3.5 py-3" @submit.prevent="save()">
      <Input
        v-model="token"
        type="password"
        text-size="ui"
        autocomplete="off"
        :placeholder="configured ? $t('settings.artifacts.tokenSaved') : $t('settings.artifacts.tokenPlaceholder')"
        :aria-label="$t('settings.artifacts.tokenLabel')"
      />
      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" :disabled="saving || !token.trim()">
          <Loader2 v-if="saving" class="animate-spin" />
          <Check v-else />
          {{ $t("settings.artifacts.save") }}
        </Button>
        <Button v-if="configured" type="button" variant="ghost" size="sm" :disabled="saving" @click="save(true)">
          <Trash2 />
          {{ $t("settings.artifacts.clear") }}
        </Button>
        <a
          :href="CREATE_TOKEN_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1 text-xs text-info underline-offset-2 hover:underline"
        >
          {{ $t("settings.artifacts.createToken") }}
          <ExternalLink :size="11" class="opacity-70" />
        </a>
      </div>
    </form>
  </SettingsGroup>
</template>
