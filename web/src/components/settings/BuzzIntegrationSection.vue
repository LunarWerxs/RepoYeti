<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  CheckCircle2,
  CircleMinus,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../../store";
import type { BuzzCheck, BuzzPreflight } from "../../types";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

const selectedCommunityId = ref("");
const newName = ref("");
const newUrl = ref("");
const newGitUrl = ref("");
const saving = ref(false);
const checking = ref(false);
const preflight = ref<BuzzPreflight | null>(null);
const confirmRemove = ref<string | null>(null);

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void store.loadBuzzConfig();
  },
  { immediate: true },
);
watch(
  () => store.buzzCommunities,
  (communities) => {
    if (!communities.some((community) => community.id === selectedCommunityId.value)) {
      selectedCommunityId.value = communities[0]?.id ?? "";
      preflight.value = null;
    }
  },
  { immediate: true },
);
watch(selectedCommunityId, () => {
  // A result is evidence about exactly one relay/repository pair. Never leave Community A's
  // result rendered after the owner selects Community B.
  preflight.value = null;
});

async function addCommunity(): Promise<void> {
  const url = newUrl.value.trim();
  if (!url || saving.value) return;
  saving.value = true;
  try {
    const community = await store.addBuzzCommunity({
      name: newName.value.trim() || undefined,
      url,
      gitUrl: newGitUrl.value.trim() || undefined,
    });
    selectedCommunityId.value = community.id;
    newName.value = "";
    newUrl.value = "";
    newGitUrl.value = "";
    preflight.value = null;
    toast.success(t("settings.buzzCommunityAdded"));
  } catch {
    toast.error(t("settings.buzzCommunityAddFailed"));
  } finally {
    saving.value = false;
  }
}

async function removeCommunity(id: string): Promise<void> {
  if (confirmRemove.value !== id) {
    confirmRemove.value = id;
    return;
  }
  confirmRemove.value = null;
  try {
    await store.removeBuzzCommunity(id);
    preflight.value = null;
    toast.success(t("settings.buzzCommunityRemoved"));
  } catch {
    toast.error(t("settings.buzzCommunityRemoveFailed"));
  }
}

async function runPreflight(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  try {
    preflight.value = await store.runBuzzPreflight(selectedCommunityId.value || undefined);
  } catch {
    toast.error(t("settings.buzzPreflightFailed"));
  } finally {
    checking.value = false;
  }
}

const checks = computed<Array<{ id: string; label: string; check: BuzzCheck | null }>>(() => [
  { id: "git", label: t("settings.buzzCheckGit"), check: preflight.value?.git ?? null },
  { id: "helper", label: t("settings.buzzCheckHelper"), check: preflight.value?.credentialHelper ?? null },
  { id: "path", label: t("settings.buzzCheckHttpPath"), check: preflight.value?.useHttpPath ?? null },
  { id: "relay", label: t("settings.buzzCheckRelay"), check: preflight.value?.relay ?? null },
  { id: "auth", label: t("settings.buzzCheckAuth"), check: preflight.value?.authentication ?? null },
]);
</script>

<template>
  <ExpandTransition :open="store.buzzEnabled">
    <div class="flex flex-col gap-3 px-3.5 py-3">
        <div class="rounded-lg border border-border/70 bg-secondary/20">
          <div class="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
            <Select v-if="store.buzzCommunities.length" v-model="selectedCommunityId">
              <SelectTrigger class="h-8 min-w-0 flex-1" :aria-label="$t('settings.buzzCommunity')">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="community in store.buzzCommunities"
                  :key="community.id"
                  :value="community.id"
                >
                  {{ community.name }}
                </SelectItem>
              </SelectContent>
            </Select>
            <span v-else class="min-w-0 flex-1 text-[12px] text-muted-foreground">
              {{ $t("settings.buzzNoCommunityForCheck") }}
            </span>
            <Button size="sm" variant="outline" class="shrink-0" :disabled="checking" @click="runPreflight">
              <Loader2 v-if="checking" class="animate-spin" />
              <RefreshCw v-else />
              {{ $t("settings.buzzRunPreflight") }}
            </Button>
          </div>
          <div class="divide-y divide-border/50">
            <div v-for="item in checks" :key="item.id" class="flex items-start gap-2 px-2.5 py-2">
              <CheckCircle2
                v-if="item.check?.status === 'pass'"
                class="mt-0.5 size-4 shrink-0 text-emerald-500"
              />
              <XCircle
                v-else-if="item.check?.status === 'fail'"
                class="mt-0.5 size-4 shrink-0 text-destructive"
              />
              <CircleMinus v-else class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0">
                <span class="block text-[12.5px] font-medium text-foreground">{{ item.label }}</span>
                <span class="block text-[11.5px] leading-snug text-muted-foreground">
                  {{ item.check?.message ?? $t("settings.buzzNotChecked") }}
                </span>
              </span>
            </div>
          </div>
        </div>

        <p v-if="!store.buzzCommunities.length" class="text-[12.5px] text-muted-foreground">
          {{ $t("settings.buzzCommunitiesEmpty") }}
        </p>
        <div
          v-for="community in store.buzzCommunities"
          :key="community.id"
          class="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2.5 py-1.5"
        >
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-[12.5px] font-medium text-foreground">{{ community.name }}</span>
            <code class="mono truncate text-[11.5px] text-muted-foreground" :title="community.url">
              {{ community.url }}
            </code>
            <code
              v-if="community.gitUrl"
              class="mono truncate text-[11px] text-muted-foreground"
              :title="community.gitUrl"
            >
              {{ community.gitUrl }}
            </code>
          </span>
          <Button
            :variant="confirmRemove === community.id ? 'destructive' : 'ghost'"
            size="sm"
            class="shrink-0"
            :aria-label="$t('settings.buzzCommunityRemove')"
            @click="removeCommunity(community.id)"
            @blur="confirmRemove = null"
          >
            <Trash2 />
            <span v-if="confirmRemove === community.id">{{ $t("settings.buzzCommunityRemove") }}</span>
          </Button>
        </div>

        <form class="flex flex-col gap-2 pt-0.5" @submit.prevent="addCommunity">
          <Input
            v-model="newName"
            class="text-[12.5px]"
            :placeholder="$t('settings.buzzCommunityNamePlaceholder')"
            :aria-label="$t('settings.buzzCommunityName')"
          />
          <Input
            v-model="newUrl"
            class="mono text-[12.5px]"
            :placeholder="$t('settings.buzzCommunityUrlPlaceholder')"
            :aria-label="$t('settings.buzzCommunityUrl')"
          />
          <Input
            v-model="newGitUrl"
            class="mono text-[12.5px]"
            :placeholder="$t('settings.buzzGitUrlPlaceholder')"
            :aria-label="$t('settings.buzzGitUrl')"
          />
          <div class="flex justify-end">
            <Button type="submit" size="sm" :disabled="!newUrl.trim() || saving">
              <Loader2 v-if="saving" class="animate-spin" />
              <Plus v-else />
              {{ $t("settings.buzzCommunityAdd") }}
            </Button>
          </div>
        </form>
        <p class="text-[11.5px] leading-snug text-muted-foreground">
          {{ $t("settings.buzzAuthBoundary") }}
        </p>
    </div>
  </ExpandTransition>
</template>
