<script setup lang="ts">
import { reactive, ref, computed } from "vue";
import {
  NDrawer,
  NDrawerContent,
  NButton,
  NIcon,
  NInput,
  NForm,
  NFormItem,
  NEmpty,
  NPopconfirm,
  NText,
  useMessage,
} from "naive-ui";
import { Plus, Pencil, Trash2, KeyRound, Save, X, LogOut } from "lucide-vue-next";
import { useStore } from "../store";
import type { Identity } from "../types";

defineProps<{ show: boolean }>();
const emit = defineEmits<{ "update:show": [boolean] }>();
const store = useStore();
const message = useMessage();

const editingId = ref<string | null>(null);
const showForm = ref(false);
const saving = ref(false);
const form = reactive({ displayName: "", gitUsername: "", gitEmail: "", sshKeyPath: "" });

const formTitle = computed(() => (editingId.value ? "Edit identity" : "New identity"));
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
      message.success("Identity updated");
    } else {
      await store.createIdentity(payload);
      message.success("Identity created");
    }
    cancel();
  } catch (e) {
    message.error(e instanceof Error ? e.message : "Save failed");
  } finally {
    saving.value = false;
  }
}

async function remove(id: string): Promise<void> {
  try {
    await store.removeIdentity(id);
    message.success("Identity deleted");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "Delete failed");
  }
}
</script>

<template>
  <NDrawer
    :show="show"
    placement="bottom"
    height="88vh"
    :auto-focus="false"
    @update:show="emit('update:show', $event)"
  >
    <NDrawerContent title="Identities" closable>
      <div class="wrap">
        <div v-if="store.authEnforced" class="account">
          <div class="acctmain">
            <div class="acctlabel">Signed in with Connections</div>
            <div class="acctowner mono">{{ store.owner }}</div>
          </div>
          <NButton size="small" tertiary @click="store.logout()">
            <template #icon><NIcon :component="LogOut" /></template>Sign out
          </NButton>
        </div>

        <NText depth="3" class="intro">
          Git identities you can attach to repos. SSH keys are referenced by path — never read or copied.
        </NText>

        <div v-if="store.identities.length" v-auto-animate class="ids">
          <div v-for="i in store.identities" :key="i.id" class="idrow">
            <div class="idmain">
              <div class="idname">{{ i.displayName }}</div>
              <div class="idmeta mono">{{ i.gitUsername }} · {{ i.gitEmail }}</div>
              <div v-if="i.sshKeyPath" class="idkey mono">
                <NIcon :component="KeyRound" :size="12" /> {{ i.sshKeyPath }}
              </div>
            </div>
            <div class="idactions">
              <NButton size="small" quaternary circle aria-label="edit" @click="openEdit(i)">
                <template #icon><NIcon :component="Pencil" /></template>
              </NButton>
              <NPopconfirm @positive-click="remove(i.id)">
                <template #trigger>
                  <NButton size="small" quaternary circle type="error" aria-label="delete">
                    <template #icon><NIcon :component="Trash2" /></template>
                  </NButton>
                </template>
                Delete “{{ i.displayName }}”? Repos using it revert to no identity.
              </NPopconfirm>
            </div>
          </div>
        </div>
        <NEmpty v-else description="No identities yet" class="emptyids" />

        <div v-if="showForm" class="formcard">
          <div class="formhead">{{ formTitle }}</div>
          <NForm size="small" label-placement="top" :show-feedback="false">
            <NFormItem label="Display name" required>
              <NInput v-model:value="form.displayName" placeholder="Personal GitHub" />
            </NFormItem>
            <div class="two">
              <NFormItem label="Git username" required>
                <NInput v-model:value="form.gitUsername" placeholder="octocat" />
              </NFormItem>
              <NFormItem label="Git email" required>
                <NInput v-model:value="form.gitEmail" placeholder="me@example.com" />
              </NFormItem>
            </div>
            <NFormItem label="SSH key path (optional)">
              <NInput v-model:value="form.sshKeyPath" placeholder="~/.ssh/id_ed25519" />
            </NFormItem>
          </NForm>
          <div class="formactions">
            <NButton size="small" tertiary @click="cancel">
              <template #icon><NIcon :component="X" /></template>Cancel
            </NButton>
            <NButton size="small" type="primary" :disabled="!valid" :loading="saving" @click="save">
              <template #icon><NIcon :component="Save" /></template>Save
            </NButton>
          </div>
        </div>
        <NButton v-else block dashed class="addbtn" @click="openNew">
          <template #icon><NIcon :component="Plus" /></template>Add identity
        </NButton>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.wrap {
  max-width: 640px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: env(safe-area-inset-bottom);
}
.account {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  background: #15211a;
  border: 1px solid #1f3a2a;
  border-radius: 11px;
}
.acctlabel {
  font-size: 11px;
  color: #6aa583;
}
.acctowner {
  font-size: 13px;
  color: #cfe9d9;
  margin-top: 2px;
}
.intro {
  font-size: 12.5px;
}
.ids {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.idrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  background: #1b1b24;
  border: 1px solid #262630;
  border-radius: 11px;
}
.idmain {
  min-width: 0;
}
.idname {
  font-weight: 600;
  font-size: 14px;
}
.idmeta {
  font-size: 12px;
  color: #8b8b97;
  margin-top: 2px;
}
.idkey {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #6c6c7a;
  margin-top: 3px;
}
.idactions {
  display: flex;
  gap: 2px;
  flex: 0 0 auto;
}
.formcard {
  background: #1b1b24;
  border: 1px solid #262630;
  border-radius: 12px;
  padding: 14px;
}
.formhead {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 10px;
  color: #cfcfd8;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.formactions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.addbtn {
  margin-top: 2px;
}
@media (max-width: 460px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
