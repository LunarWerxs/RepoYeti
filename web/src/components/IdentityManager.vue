<script setup lang="ts">
import { reactive, ref, computed, nextTick, useTemplateRef } from "vue";
import { Plus, Pencil, Trash2, KeyRound, Save, X, Check, Users, RefreshCw } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import { useStore } from "../store";
import { cn } from "@/lib/utils";
import { identityInitials, identityTint } from "@/lib/identity-display";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import ExpandTransition from "@/shell/ExpandTransition.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DetectedIdentity, DetectedIdentitySource, Identity } from "../types";

const { t } = useI18n();

const store = useStore();

// Is the identity feature carrying its weight on its own — i.e. would `identitiesRelevant` still
// be true with the manual opt-in switched off? Drives the "Hide these" affordance: offering to
// hide a panel that would immediately re-appear would just look broken.
const hasRealIdentityUse = computed(
  () =>
    store.identities.length >= 2 ||
    store.identityRules.length > 0 ||
    store.repos.some((r) => r.identityId),
);

// editingId drives the inline accordion panel on an EXISTING row (Y3: expand in place,
// only one row open at a time). showForm is the separate "add new" panel at the bottom of
// the list, which stays its own affordance since Y3 only concerns editing existing rows.
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
/** Focus the first field of a just-opened INLINE row panel (already in view, so no scroll). */
async function focusInline(rowEl: HTMLElement | null): Promise<void> {
  await nextTick();
  rowEl?.querySelector<HTMLInputElement>('[data-slot="input"]')?.focus();
}
function openNew(): void {
  editingId.value = null;
  reset();
  showForm.value = true;
  void revealForm();
}
function openEdit(i: Identity): void {
  // Toggle: clicking the already-open row's edit button closes it again.
  if (editingId.value === i.id) {
    cancel();
    return;
  }
  showForm.value = false;
  editingId.value = i.id;
  form.displayName = i.displayName;
  form.gitUsername = i.gitUsername;
  form.gitEmail = i.gitEmail;
  form.sshKeyPath = i.sshKeyPath ?? "";
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
// Whether the "hidden" (dismissed-but-still-detected) list is expanded for review.
const showDismissed = ref(false);

/** Hide a detected suggestion — detection re-reads the machine, so this is the only way to make an
 *  unwanted one (or one whose saved copy you deleted) stop coming back. Offers a temporary Undo. */
async function dismiss(d: DetectedIdentity): Promise<void> {
  try {
    await store.dismissDetectedIdentity(d.id);
    toast(t("identity.detected.dismissed", { name: d.title }), {
      action: { label: t("identity.detected.undo"), onClick: () => void store.restoreDetectedIdentity(d.id) },
    });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("identity.detected.dismissFailed"));
  }
}
/** Bring ONE dismissed suggestion back (from the Undo action or the hidden list). */
async function restoreOne(d: DetectedIdentity): Promise<void> {
  try {
    await store.restoreDetectedIdentity(d.id);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("identity.detected.restoreFailed"));
  }
}
async function restoreDismissed(): Promise<void> {
  try {
    await store.restoreDetectedIdentities();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("identity.detected.restoreFailed"));
  }
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
    <!-- Plural key: this is the multi-identity MANAGER (identitiesRelevant), while the singular
         `identity.title` heads the one-row opt-in group in IdentitiesSection. -->
    <SettingsGroup :label="$t('identity.titlePlural')" :description="$t('identity.description')">
    <div class="flex flex-col gap-3 px-3.5 py-3">
        <!-- The way back out. This panel is only forced open by the "Set up" opt-in (see
             IdentitiesSection.vue); without this, turning it on would be one-way and the owner
             would be stuck with a feature they don't use. Offered only while it ISN'T earning
             its place on the real signals (2+ identities, a Firewall rule, an assigned repo) —
             once it is, `identitiesRelevant` is true regardless and hiding would be a lie. -->
        <div
          v-if="store.identityUiForced && !hasRealIdentityUse"
          class="flex items-center justify-between gap-2 rounded-md bg-secondary/50 px-2.5 py-1.5"
        >
          <span class="text-[11px] text-muted-foreground">{{ $t("identity.optIn.activeNote") }}</span>
          <button
            type="button"
            class="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground underline-offset-2 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
            @click="store.setIdentityUiForced(false)"
          >
            {{ $t("identity.optIn.hide") }}
          </button>
        </div>
        <!-- local machine suggestions -->
        <div class="flex items-center justify-between gap-2">
          <div class="text-[12px] font-medium text-muted-foreground">{{ $t("identity.detected.title") }}</div>
          <div class="flex items-center gap-1">
            <button
              v-if="store.dismissedDetectedIdentities.length"
              type="button"
              :aria-expanded="showDismissed"
              class="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground underline-offset-2 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
              @click="showDismissed = !showDismissed"
            >
              {{
                showDismissed
                  ? $t("identity.detected.hideDismissed")
                  : $t(
                      "identity.detected.hiddenCount",
                      { count: store.dismissedDetectedIdentities.length },
                      store.dismissedDetectedIdentities.length,
                    )
              }}
            </button>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="inline-flex">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :aria-label="$t('identity.detected.refresh')"
                    :disabled="store.detectedIdentitiesLoading"
                    @click="store.loadDetectedIdentities()"
                  >
                    <RefreshCw :class="store.detectedIdentitiesLoading && 'animate-spin'" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{{ $t("identity.detected.refresh") }}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <p class="-mt-1.5 text-[11px] text-muted-foreground/80">{{ $t("identity.detected.hint") }}</p>
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
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="shrink-0 text-muted-foreground hover:text-destructive"
                  :aria-label="$t('identity.detected.dismiss')"
                  @click="dismiss(d)"
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ $t("identity.detected.dismiss") }}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div
          v-else-if="store.detectedIdentitiesReady && !store.detectedIdentitiesLoading"
          class="rounded-lg border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground"
        >
          {{ $t("identity.detected.empty") }}
        </div>

        <!-- dismissed (hidden) suggestions — expandable review + per-item / all restore -->
        <ExpandTransition :open="showDismissed && store.dismissedDetectedIdentities.length > 0">
          <div class="flex flex-col gap-2 rounded-xl border border-dashed border-border/70 bg-secondary/20 p-2.5">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[11px] font-medium text-muted-foreground">{{ $t("identity.detected.dismissedTitle") }}</span>
              <button
                type="button"
                class="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground underline-offset-2 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
                @click="restoreDismissed"
              >
                {{ $t("identity.detected.restoreAll") }}
              </button>
            </div>
            <div
              v-for="d in store.dismissedDetectedIdentities"
              :key="d.id"
              class="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5"
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-[12px] text-muted-foreground">{{ d.title }}</div>
                <div class="mono truncate text-[11px] text-muted-foreground/70">{{ d.detail }}</div>
              </div>
              <Button variant="ghost" size="sm" class="shrink-0" @click="restoreOne(d)">
                {{ $t("identity.detected.restore") }}
              </Button>
            </div>
          </div>
        </ExpandTransition>

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
            class="overflow-hidden rounded-xl border border-border bg-secondary/40"
          >
            <div class="flex items-center gap-3 p-2.5">
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
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button variant="ghost" size="icon-sm" :aria-label="$t('identity.action.cancel')" @click="confirmId = null">
                      <X />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ $t("identity.action.cancel") }}</TooltipContent>
                </Tooltip>
              </div>
              <div v-else class="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      :aria-label="editingId === i.id ? $t('identity.action.cancel') : $t('identity.action.edit')"
                      :aria-expanded="editingId === i.id"
                      @click="openEdit(i)"
                    >
                      <X v-if="editingId === i.id" />
                      <Pencil v-else />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ editingId === i.id ? $t("identity.action.cancel") : $t("identity.action.edit") }}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:text-destructive"
                      :aria-label="$t('identity.action.delete')"
                      @click="confirmId = i.id"
                    >
                      <Trash2 />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ $t("identity.action.delete") }}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <!-- inline edit panel (accordion, one row open at a time) -->
            <ExpandTransition :open="editingId === i.id">
              <div :ref="(el) => focusInline(el as HTMLElement | null)" class="border-t border-border/60 p-3.5">
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
            </ExpandTransition>
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
  </div>
</template>
