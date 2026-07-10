<script setup lang="ts">
import { reactive, ref, computed, nextTick, useTemplateRef } from "vue";
import { Plus, Pencil, Trash2, KeyRound, Save, X, Check, Users, RefreshCw } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import { useStore } from "../store";
import { cn } from "@/lib/utils";
import { identityInitials, identityTint } from "@/lib/identity-display";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DetectedIdentity, DetectedIdentitySource, Identity } from "../types";

const { t } = useI18n();

const store = useStore();

const editingId = ref<string | null>(null);
const showForm = ref(false);
const saving = ref(false);
const confirmId = ref<string | null>(null);
const formEl = useTemplateRef<HTMLElement>("formEl");
const form = reactive({ displayName: "", gitUsername: "", gitEmail: "", sshKeyPath: "" });

const formTitle = computed(() => (editingId.value ? t("identity.form.titleEdit") : t("identity.form.titleNew")));
const valid = computed(
  () => !!(form.displayName.trim() && form.gitUsername.trim() && form.gitEmail.trim()),
);
const sourceLabels = computed<Record<DetectedIdentitySource, string>>(() => ({
  "git-global": t("identity.detected.source.gitGlobal"),
  "git-local": t("identity.detected.source.gitLocal"),
  "git-credential": t("identity.detected.source.gitCredential"),
  "github-cli": t("identity.detected.source.githubCli"),
  "windows-credential": t("identity.detected.source.windowsCredential"),
  "ssh-key": t("identity.detected.source.sshKey"),
  "ssh-agent": t("identity.detected.source.sshAgent"),
}));
const shownDetected = computed(() => {
  const saved = new Set(
    store.identities.map((i) =>
      [i.gitUsername.trim().toLowerCase(), i.gitEmail.trim().toLowerCase(), i.sshKeyPath ?? ""].join("\0"),
    ),
  );
  return store.detectedIdentities.filter((i) => {
    const s = i.suggestion;
    const key = [s.gitUsername.trim().toLowerCase(), s.gitEmail.trim().toLowerCase(), s.sshKeyPath ?? ""].join("\0");
    return !saved.has(key);
  });
});

function reset(): void {
  form.displayName = "";
  form.gitUsername = "";
  form.gitEmail = "";
  form.sshKeyPath = "";
}
async function revealForm(): Promise<void> {
  await nextTick();
  formEl.value?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  formEl.value?.querySelector<HTMLInputElement>('[data-slot="input"]')?.focus();
}
function openNew(): void {
  editingId.value = null;
  reset();
  showForm.value = true;
  void revealForm();
}
function openEdit(i: Identity): void {
  editingId.value = i.id;
  form.displayName = i.displayName;
  form.gitUsername = i.gitUsername;
  form.gitEmail = i.gitEmail;
  form.sshKeyPath = i.sshKeyPath ?? "";
  showForm.value = true;
  void revealForm();
}
function useDetected(i: DetectedIdentity): void {
  editingId.value = null;
  form.displayName = i.suggestion.displayName;
  form.gitUsername = i.suggestion.gitUsername;
  form.gitEmail = i.suggestion.gitEmail;
  form.sshKeyPath = i.suggestion.sshKeyPath ?? "";
  showForm.value = true;
  void revealForm();
}
function cancel(): void {
  showForm.value = false;
  editingId.value = null;
}

function missingText(i: DetectedIdentity): string {
  const fields = i.missing.filter((field) => field !== "sshKeyPath");
  if (fields.length === 0) return "";
  const labels: Record<string, string> = {
    displayName: t("identity.field.displayName"),
    gitUsername: t("identity.field.gitUsername"),
    gitEmail: t("identity.field.gitEmail"),
  };
  return t("identity.detected.needs", { fields: fields.map((field) => labels[field] ?? field).join(", ") });
}

async function save(): Promise<void> {
  if (!valid.value) return;
  saving.value = true;
  try {
    const payload = {
      displayName: form.displayName.trim(),
      gitUsername: form.gitUsername.trim(),
      gitEmail: form.gitEmail.trim(),
      sshKeyPath: form.sshKeyPath.trim() || null,
    };
    if (editingId.value) {
      await store.updateIdentity(editingId.value, payload);
      toast.success(t("identity.toast.updated"));
    } else {
      await store.createIdentity(payload);
      toast.success(t("identity.toast.created"));
    }
    cancel();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("identity.toast.saveFailed"));
  } finally {
    saving.value = false;
  }
}

async function remove(id: string): Promise<void> {
  try {
    await store.removeIdentity(id);
    toast.success(t("identity.toast.deleted"));
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("identity.toast.deleteFailed"));
  } finally {
    confirmId.value = null;
  }
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <SettingsGroup :label="$t('identity.title')">
    <div class="flex flex-col gap-3 px-3.5 py-3">
        <!-- local machine suggestions -->
        <div class="flex items-center justify-between gap-2">
          <div class="text-[12px] font-medium text-muted-foreground">{{ $t("identity.detected.title") }}</div>
          <Button
            variant="ghost"
            size="icon-sm"
            :aria-label="$t('identity.detected.refresh')"
            :disabled="store.detectedIdentitiesLoading"
            @click="store.loadDetectedIdentities()"
          >
            <RefreshCw :class="store.detectedIdentitiesLoading && 'animate-spin'" />
          </Button>
        </div>
        <div v-if="shownDetected.length" v-auto-animate class="flex flex-col gap-2">
          <div
            v-for="d in shownDetected"
            :key="d.id"
            class="flex items-center gap-3 rounded-xl border border-border bg-background/50 p-2.5"
          >
            <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <KeyRound v-if="d.source === 'ssh-key' || d.source === 'ssh-agent'" :size="15" />
              <Users v-else :size="15" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <div class="truncate text-[13px] font-medium">{{ d.title }}</div>
                <span class="shrink-0 rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {{ sourceLabels[d.source] }}
                </span>
              </div>
              <div class="mono truncate text-[11px] text-muted-foreground">{{ d.detail }}</div>
              <div v-if="missingText(d)" class="mt-0.5 text-[11px] text-warning">{{ missingText(d) }}</div>
            </div>
            <Button variant="secondary" size="sm" @click="useDetected(d)">
              <Plus />
              {{ $t("identity.detected.use") }}
            </Button>
          </div>
        </div>
        <div
          v-else-if="store.detectedIdentitiesReady && !store.detectedIdentitiesLoading"
          class="rounded-lg border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground"
        >
          {{ $t("identity.detected.empty") }}
        </div>

        <!-- identity list -->
        <div
          v-if="store.identities.length || !shownDetected.length"
          class="text-[12px] font-medium text-muted-foreground"
        >
          {{ $t("identity.savedTitle") }}
        </div>
        <div v-if="store.identities.length" v-auto-animate class="flex flex-col gap-2">
          <div
            v-for="i in store.identities"
            :key="i.id"
            class="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 p-2.5"
          >
            <span
              :class="cn('flex size-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold', identityTint(i.id))"
            >
              {{ identityInitials(i.displayName) }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-[14px] font-medium">{{ i.displayName }}</div>
              <div class="mono truncate text-[12px] text-muted-foreground">
                {{ i.gitUsername }} · {{ i.gitEmail }}
              </div>
              <div v-if="i.sshKeyPath" class="mono mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground/80">
                <KeyRound :size="11" class="shrink-0" /> {{ i.sshKeyPath }}
              </div>
            </div>

            <!-- inline delete confirm -->
            <div v-if="confirmId === i.id" class="flex shrink-0 items-center gap-1">
              <Button variant="destructive" size="sm" @click="remove(i.id)">
                <Check />
                {{ $t("identity.action.confirmDelete") }}
              </Button>
              <Button variant="ghost" size="icon-sm" :aria-label="$t('identity.action.cancel')" @click="confirmId = null">
                <X />
              </Button>
            </div>
            <div v-else class="flex shrink-0 items-center gap-0.5">
              <Button variant="ghost" size="icon-sm" :aria-label="$t('identity.action.edit')" @click="openEdit(i)">
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-destructive"
                :aria-label="$t('identity.action.delete')"
                @click="confirmId = i.id"
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        </div>
        <div
          v-else-if="!shownDetected.length"
          class="rounded-xl border border-dashed border-border py-8 text-center text-[13px] text-muted-foreground"
        >
          {{ $t("identity.empty") }}
        </div>

        <!-- create / edit form -->
        <div v-if="showForm" ref="formEl" class="rounded-xl border border-border bg-secondary/40 p-3.5">
          <div class="mb-3 text-[13px] font-semibold text-foreground/90">{{ formTitle }}</div>
          <div class="flex flex-col gap-3">
            <label class="block">
              <span class="mb-1 block text-[12px] text-muted-foreground">{{ $t("identity.field.displayName") }}</span>
              <Input v-model="form.displayName" :placeholder="$t('identity.placeholder.displayName')" />
            </label>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="mb-1 block text-[12px] text-muted-foreground">{{ $t("identity.field.gitUsername") }}</span>
                <Input v-model="form.gitUsername" :placeholder="$t('identity.placeholder.gitUsername')" />
              </label>
              <label class="block">
                <span class="mb-1 block text-[12px] text-muted-foreground">{{ $t("identity.field.gitEmail") }}</span>
                <Input v-model="form.gitEmail" :placeholder="$t('identity.placeholder.gitEmail')" />
              </label>
            </div>
            <label class="block">
              <span class="mb-1 block text-[12px] text-muted-foreground">{{ $t("identity.field.sshKeyPath") }}</span>
              <Input v-model="form.sshKeyPath" :placeholder="$t('identity.placeholder.sshKeyPath')" class="mono" />
            </label>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" @click="cancel">
              <X />
              {{ $t("identity.action.cancel") }}
            </Button>
            <Button size="sm" :disabled="!valid || saving" @click="save">
              <Save />
              {{ $t("identity.action.save") }}
            </Button>
          </div>
        </div>
        <Button v-else variant="outline" class="w-full border-dashed" @click="openNew">
          <Plus />
          {{ $t("identity.action.add") }}
        </Button>
    </div>
    </SettingsGroup>
    <p class="px-1 text-[11px] text-muted-foreground/70">{{ $t("identity.description") }}</p>
  </div>
</template>
