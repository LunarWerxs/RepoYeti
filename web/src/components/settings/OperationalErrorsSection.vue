<script setup lang="ts">
// Grouped operational-error history (src/http/routes/errors.ts): "what has gone wrong, and how
// often" for failed mutating git actions, grouped by (repo, op, code). Owner-only, same as every
// other Settings section: the Settings button itself is hidden from a share-link guest
// (AppHeader.vue), so nothing further is needed here to keep this off a guest's screen.
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { BellOff, Bell, Trash2, CircleAlert } from "@lucide/vue";
import { useStore } from "../../store";
import { ApiError } from "../../api";
import { fromNow } from "@/lib/util";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const props = defineProps<{ open?: boolean }>();
const store = useStore();
const { t } = useI18n();

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void store.loadOperationalErrors();
  },
  { immediate: true },
);

// Unmuted first (what needs attention), each group's own most-recently-seen order preserved
// within that split (the daemon already sorts by lastSeenAt DESC).
const sortedErrors = computed(() => {
  const unmuted = store.operationalErrors.filter((e) => !e.muted);
  const muted = store.operationalErrors.filter((e) => e.muted);
  return [...unmuted, ...muted];
});

async function toggleMute(fingerprint: string, muted: boolean): Promise<void> {
  try {
    await store.setOperationalErrorMuted(fingerprint, muted);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("settings.operationalErrorMuteFailed"));
  }
}

async function dismiss(fingerprint: string): Promise<void> {
  try {
    await store.dismissOperationalError(fingerprint);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("settings.operationalErrorDismissFailed"));
  }
}
</script>

<template>
  <SettingsGroup :label="$t('settings.cardOperationalErrors')" :description="$t('settings.operationalErrorsDescription')">
    <div class="flex flex-col gap-2 px-3.5 py-3">
      <p v-if="!store.operationalErrorsReady" class="text-xs text-muted-foreground/70">
        {{ $t("settings.operationalErrorsLoading") }}
      </p>
      <p v-else-if="!sortedErrors.length" class="text-xs text-muted-foreground/70">
        {{ $t("settings.operationalErrorsEmpty") }}
      </p>
      <div v-else class="flex flex-col gap-1.5">
        <div
          v-for="err in sortedErrors"
          :key="err.fingerprint"
          class="flex items-start gap-2 rounded-lg border border-border p-2.5"
          :class="err.muted ? 'bg-secondary/30 opacity-70' : 'bg-destructive/5 border-destructive/25'"
        >
          <CircleAlert :size="14" class="mt-0.5 shrink-0" :class="err.muted ? 'text-muted-foreground' : 'text-destructive'" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <p class="truncate text-ui font-medium">{{ err.repoName }}</p>
              <Badge variant="outline"><span class="mono">{{ err.op }}</span></Badge>
              <Badge variant="outline"><span class="mono">{{ err.code }}</span></Badge>
              <Badge v-if="err.occurrences > 1" variant="warning">
                {{ $t("settings.operationalErrorOccurrences", { n: err.occurrences }, err.occurrences) }}
              </Badge>
            </div>
            <p class="mt-0.5 truncate text-xs text-muted-foreground" :title="err.message">{{ err.message }}</p>
            <p class="text-2xs text-muted-foreground/70">{{ fromNow(err.lastSeenAt) }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="err.muted ? $t('settings.operationalErrorUnmute') : $t('settings.operationalErrorMute')"
              :title="err.muted ? $t('settings.operationalErrorUnmute') : $t('settings.operationalErrorMute')"
              @click="toggleMute(err.fingerprint, !err.muted)"
            >
              <Bell v-if="err.muted" />
              <BellOff v-else />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="$t('settings.operationalErrorDismiss')"
              :title="$t('settings.operationalErrorDismiss')"
              @click="dismiss(err.fingerprint)"
            >
              <Trash2 class="text-muted-foreground group-hover/button:text-destructive" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  </SettingsGroup>
</template>
