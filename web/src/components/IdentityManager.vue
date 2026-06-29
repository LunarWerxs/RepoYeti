<script setup lang="ts">
import { reactive, ref, computed } from "vue";
import { Plus, Pencil, Trash2, KeyRound, Save, X, LogOut, Check, Users } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import { useStore } from "../store";
import { cn } from "@/lib/utils";
import { identityInitials, identityTint } from "@/lib/identity-display";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Identity } from "../types";

const { t } = useI18n();

const store = useStore();

const editingId = ref<string | null>(null);
const showForm = ref(false);
const saving = ref(false);
const confirmId = ref<string | null>(null);
const form = reactive({ displayName: "", gitUsername: "", gitEmail: "", sshKeyPath: "" });

const formTitle = computed(() => (editingId.value ? t("identity.form.titleEdit") : t("identity.form.titleNew")));
const valid = computed(
  () => !!(form.displayName.trim() && form.gitUsername.trim() && form.gitEmail.trim()),
);

function reset(): void {
  form.displayName = "";
  form.gitUsername = "";
  form.gitEmail = "";
  form.sshKeyPath = "";
}
function openNew(): void {
  editingId.value = null;
  reset();
  showForm.value = true;
}
function openEdit(i: Identity): void {
  editingId.value = i.id;
  form.displayName = i.displayName;
  form.gitUsername = i.gitUsername;
  form.gitEmail = i.gitEmail;
  form.sshKeyPath = i.sshKeyPath ?? "";
  showForm.value = true;
}
function cancel(): void {
  showForm.value = false;
  editingId.value = null;
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
  <Card class="gap-4 border-border bg-secondary/20 py-4 shadow-none">
    <CardHeader class="gap-1.5 px-4">
      <CardTitle class="flex items-center gap-2 text-[13px]">
        <Users :size="15" class="text-muted-foreground" /> {{ $t("identity.title") }}
      </CardTitle>
      <CardDescription class="text-[12px] leading-relaxed">
        {{ $t("identity.description") }}
      </CardDescription>
    </CardHeader>

    <CardContent class="flex flex-col gap-3 px-4">
        <!-- signed-in account -->
        <div
          v-if="store.authEnforced"
          class="flex items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/10 px-3 py-2.5"
        >
          <div class="min-w-0">
            <div class="text-[11px] text-primary/80">{{ $t("identity.signedInWith") }}</div>
            <div class="mono truncate text-[13px] text-foreground/90">{{ store.owner }}</div>
          </div>
          <Button variant="ghost" size="sm" @click="store.logout()">
            <LogOut />
            {{ $t("identity.signOut") }}
          </Button>
        </div>

        <!-- identity list -->
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
        <div v-else class="rounded-xl border border-dashed border-border py-8 text-center text-[13px] text-muted-foreground">
          {{ $t("identity.empty") }}
        </div>

        <!-- create / edit form -->
        <div v-if="showForm" class="rounded-xl border border-border bg-secondary/40 p-3.5">
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
    </CardContent>
  </Card>
</template>
