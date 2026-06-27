<script setup lang="ts">
import { ref, computed } from "vue";
import { NModal, NCard, NTabs, NTabPane, NInput, NButton, NIcon, NText, useMessage } from "naive-ui";
import { FolderGit2, FolderPlus } from "lucide-vue-next";
import { useStore } from "../store";

defineProps<{ show: boolean }>();
const emit = defineEmits<{ "update:show": [boolean] }>();
const store = useStore();
const message = useMessage();

const mode = ref<"register" | "create">("register");
const path = ref("");
const busy = ref(false);
const canSubmit = computed(() => path.value.trim().length > 0 && !busy.value);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  try {
    const repo = await store.addRepo(mode.value, path.value.trim());
    message.success(mode.value === "create" ? `Created ${repo.name}` : `Added ${repo.name}`);
    path.value = "";
    emit("update:show", false);
  } catch (e) {
    message.error(e instanceof Error ? e.message : "Failed");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <NModal
    :show="show"
    @update:show="emit('update:show', $event)"
    transform-origin="center"
  >
    <NCard class="addcard" :bordered="true" role="dialog" aria-modal="true">
      <NTabs v-model:value="mode" type="segment" size="small">
        <NTabPane name="register" tab="Point to folder">
          <NText depth="3" class="hint">
            <NIcon :component="FolderGit2" :size="13" /> Index an existing git repo by its absolute path.
          </NText>
        </NTabPane>
        <NTabPane name="create" tab="Create new">
          <NText depth="3" class="hint">
            <NIcon :component="FolderPlus" :size="13" /> Make a new folder and <code>git init</code> it.
          </NText>
        </NTabPane>
      </NTabs>

      <NInput
        v-model:value="path"
        class="pathinput"
        :placeholder="mode === 'register' ? '/Users/you/code/my-repo' : '/Users/you/code/new-repo'"
        clearable
        @keyup.enter="submit"
      />

      <div class="acts">
        <NButton size="small" tertiary @click="emit('update:show', false)">Cancel</NButton>
        <NButton size="small" type="primary" :disabled="!canSubmit" :loading="busy" @click="submit">
          {{ mode === "create" ? "Create" : "Add" }}
        </NButton>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.addcard {
  width: min(92vw, 440px);
}
.hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  padding: 4px 0 2px;
}
.pathinput {
  margin-top: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.acts {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
