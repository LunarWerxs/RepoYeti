<script setup lang="ts">
// ⭐ Identity Firewall rules editor: a simple list of {pathPattern, requiredIdentityId} rows.
// v1 is dead simple — no per-rule endpoints; editing any row just replaces the whole list on
// Save (mirrors src/http/routes/identity-rules.ts PUT semantics). The violation BADGE itself
// lives on each repo card (RepoCardHeader.vue) — this section only edits the rules.
import { reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Plus, Trash2, Save, ShieldAlert } from "@lucide/vue";
import { useStore } from "../../store";
import { ApiError } from "../../api";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { IdentityRule } from "../../types";

const props = defineProps<{ open: boolean }>();
const store = useStore();
const { t } = useI18n();

const rows = reactive<IdentityRule[]>([]);
const saving = ref(false);

function loadRows(): void {
  rows.splice(0, rows.length, ...store.identityRules.map((r) => ({ ...r })));
}

// Seed the editable rows whenever the Settings sheet opens or the store's rules change under us
// (e.g. another tab saved first) — mirrors IdentitiesSection's on-open refresh pattern.
// `immediate` required — see AccessSection.vue: the sheet's DialogRoot mounts this only once
// `open` is already true, so a plain watcher never sees the false→true edge and never fired.
watch(() => props.open, (isOpen) => {
  if (isOpen) void store.loadIdentityRules().then(loadRows);
}, { immediate: true });
watch(() => store.identityRules, loadRows, { deep: true });

function addRow(): void {
  rows.push({ pathPattern: "", requiredIdentityId: store.identities[0]?.id ?? "" });
}
function removeRow(i: number): void {
  rows.splice(i, 1);
}

async function save(): Promise<void> {
  const cleaned = rows
    .map((r) => ({ pathPattern: r.pathPattern.trim(), requiredIdentityId: r.requiredIdentityId }))
    .filter((r) => r.pathPattern);
  if (cleaned.some((r) => !r.requiredIdentityId)) {
    toast.error(t("identity.firewall.needsIdentity"));
    return;
  }
  saving.value = true;
  try {
    await store.setIdentityRules(cleaned);
    toast.success(t("identity.firewall.saved"));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("identity.firewall.saveFailed"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <SettingsGroup :label="$t('identity.firewall.title')" :description="$t('identity.firewall.description')">
    <div class="flex flex-col gap-3 px-3.5 py-3">
      <div v-if="rows.length" class="flex flex-col gap-2">
        <div
          v-for="(row, i) in rows"
          :key="i"
          class="flex flex-col gap-2 rounded-xl border border-border bg-secondary/40 p-2.5 sm:flex-row sm:items-center"
        >
          <Input
            v-model="row.pathPattern"
            class="mono flex-1 text-[12.5px]"
            :placeholder="$t('identity.firewall.patternPlaceholder')"
            :aria-label="$t('identity.firewall.patternLabel')"
          />
          <Select v-model="row.requiredIdentityId">
            <SelectTrigger class="w-full sm:w-48" :aria-label="$t('identity.firewall.identityLabel')">
              <SelectValue :placeholder="$t('identity.firewall.identityPlaceholder')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="idn in store.identities" :key="idn.id" :value="idn.id">
                {{ idn.displayName }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0 self-end text-muted-foreground hover:text-destructive sm:self-auto"
            :aria-label="$t('identity.firewall.remove')"
            @click="removeRow(i)"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <!-- No saved git identities yet → a rule has nothing to pin to. Say so (and why the Add
           button below is disabled) instead of leaving it looking broken. -->
      <div
        v-else-if="!store.identities.length"
        class="flex items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground"
      >
        <ShieldAlert :size="14" class="mt-0.5 shrink-0" />
        <span>{{ $t("identity.firewall.needIdentityFirst") }}</span>
      </div>
      <div
        v-else
        class="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground"
      >
        <ShieldAlert :size="14" class="shrink-0" />
        {{ $t("identity.firewall.empty") }}
      </div>

      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="!store.identities.length"
          :title="!store.identities.length ? $t('identity.firewall.needIdentityFirst') : undefined"
          @click="addRow"
        >
          <Plus />
          {{ $t("identity.firewall.add") }}
        </Button>
        <Button size="sm" class="ml-auto" :disabled="saving" @click="save">
          <Save />
          {{ $t("identity.firewall.save") }}
        </Button>
      </div>
    </div>
  </SettingsGroup>
</template>
