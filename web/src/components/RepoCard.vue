<script setup lang="ts">
import { computed, ref } from "vue";
import { NCard, NTag, NIcon, NButton, NSelect, NTooltip, NPopover, NInput, useMessage } from "naive-ui";
import {
  GitBranch,
  ArrowUp,
  ArrowDown,
  Pencil,
  DownloadCloud,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  Cloud,
  CloudOff,
  AlertTriangle,
  Check,
  GitCommitHorizontal,
} from "lucide-vue-next";
import { useStore } from "../store";
import { fromNow } from "../util";
import type { Repo } from "../types";

const props = defineProps<{ repo: Repo }>();
const store = useStore();
const message = useMessage();

const st = computed(() => props.repo.status);
const hasRemote = computed(() => !!st.value?.remote);
const busyAction = computed(() => store.busy[props.repo.id]);
const isClean = computed(
  () => st.value && !st.value.error && st.value.ahead === 0 && st.value.behind === 0 && st.value.dirty === 0,
);

const identityOptions = computed(() => [
  { label: "No identity", value: "__none__" },
  ...store.identities.map((i) => ({ label: `${i.displayName} · ${i.gitEmail}`, value: i.id })),
]);
const identityValue = computed(() => props.repo.identityId ?? "__none__");

function onIdentity(val: string): void {
  void store.assignIdentity(props.repo.id, val === "__none__" ? null : val);
}

// Translate first-class error codes into one calm, actionable sentence.
const FRIENDLY: Record<string, string> = {
  DIRTY_WORKING_TREE: "Uncommitted changes — resolve at your desk.",
  NON_FAST_FORWARD: "Remote has diverged — resolve at your desk.",
  DETACHED_HEAD: "Detached HEAD — resolve at your desk.",
  NO_UPSTREAM: "This branch has no upstream set.",
  NO_REMOTE: "No remote configured.",
  NOTHING_TO_COMMIT: "Nothing to commit.",
  SSH_AUTH_FAILED: "Authentication failed — check this repo's identity / SSH key.",
  SSH_PASSPHRASE_REQUIRED: "SSH key needs a passphrase — use ssh-agent or a passphrase-free key.",
};

async function run(name: "fetch" | "pull" | "push" | "refresh"): Promise<void> {
  const r = await store.doAction(props.repo.id, name);
  if (r.ok) {
    if (name !== "refresh") message.success(r.message || `${name} done`);
  } else {
    message.error(FRIENDLY[r.code] ?? r.message ?? `${name} failed`);
  }
}

// ── commit (stage-all + commit) ───────────────────────────────────────────────
const showCommit = ref(false);
const commitMsg = ref("");
async function doCommit(): Promise<void> {
  const msg = commitMsg.value.trim();
  if (!msg) return;
  const r = await store.commit(props.repo.id, msg);
  if (r.ok) {
    message.success("Committed");
    commitMsg.value = "";
    showCommit.value = false;
  } else {
    message.error(FRIENDLY[r.code] ?? r.message ?? "commit failed");
  }
}
</script>

<template>
  <NCard size="small" :bordered="true" class="repo" :class="{ err: !!st?.error }">
    <!-- name + branch -->
    <div class="top">
      <div class="who">
        <div class="name">{{ repo.name }}</div>
        <div class="path mono">{{ repo.absPath }}</div>
      </div>
      <NTag v-if="st?.branch" :type="st.detached ? 'warning' : 'default'" size="small" round class="branch">
        <template #icon><NIcon :component="GitBranch" /></template>
        <span class="mono">{{ st.detached ? "detached" : st.branch }}</span>
      </NTag>
    </div>

    <!-- status badges -->
    <div class="badges">
      <NTag v-if="st && st.ahead > 0" size="small" type="success" :bordered="false">
        <template #icon><NIcon :component="ArrowUp" /></template>{{ st.ahead }}
      </NTag>
      <NTooltip v-if="st && st.behind > 0">
        <template #trigger>
          <NTag size="small" type="info" :bordered="false">
            <template #icon><NIcon :component="ArrowDown" /></template>{{ st.behind }}
          </NTag>
        </template>
        Behind by {{ st.behind }} as of last fetch{{ st.fetchedAt ? ` · ${fromNow(st.fetchedAt)}` : "" }}
      </NTooltip>
      <NTag v-if="st && st.dirty > 0" size="small" type="warning" :bordered="false">
        <template #icon><NIcon :component="Pencil" /></template>{{ st.dirty }}
      </NTag>
      <NTag v-if="isClean" size="small" :bordered="false" class="clean">
        <template #icon><NIcon :component="Check" /></template>clean
      </NTag>

      <span class="spacer" />

      <NTooltip>
        <template #trigger>
          <span class="remote" :class="{ on: hasRemote }">
            <NIcon :size="16" :component="hasRemote ? Cloud : CloudOff" />
          </span>
        </template>
        {{ hasRemote ? st?.remote : "no remote configured" }}
      </NTooltip>
    </div>

    <!-- error line (progressive disclosure: full reason only when there is one) -->
    <div v-if="st?.error" class="errline">
      <NIcon :component="AlertTriangle" :size="14" />
      <span>{{ st.error }}</span>
    </div>

    <!-- identity -->
    <NSelect
      size="small"
      class="idsel"
      :value="identityValue"
      :options="identityOptions"
      :consistent-menu-width="false"
      @update:value="onIdentity"
    />

    <!-- actions -->
    <div class="actions">
      <NPopover
        v-if="st && st.dirty > 0"
        trigger="manual"
        :show="showCommit"
        placement="top-start"
        @clickoutside="showCommit = false"
      >
        <template #trigger>
          <NButton
            size="small"
            tertiary
            type="warning"
            :loading="busyAction === 'commit'"
            @click="showCommit = !showCommit"
          >
            <template #icon><NIcon :component="GitCommitHorizontal" /></template>
            Commit
          </NButton>
        </template>
        <div class="commitbox">
          <NInput
            v-model:value="commitMsg"
            size="small"
            placeholder="Commit message"
            :maxlength="200"
            @keyup.enter="doCommit"
          />
          <NButton
            size="small"
            type="primary"
            block
            :disabled="!commitMsg.trim()"
            :loading="busyAction === 'commit'"
            @click="doCommit"
          >
            Commit {{ st?.dirty }} change{{ st?.dirty === 1 ? "" : "s" }}
          </NButton>
        </div>
      </NPopover>

      <NButton
        size="small"
        tertiary
        :disabled="!hasRemote"
        :loading="busyAction === 'fetch'"
        @click="run('fetch')"
      >
        <template #icon><NIcon :component="DownloadCloud" /></template>
        Fetch
      </NButton>
      <NButton
        size="small"
        :type="st && st.behind > 0 ? 'primary' : 'default'"
        :disabled="!hasRemote"
        :loading="busyAction === 'pull'"
        @click="run('pull')"
      >
        <template #icon><NIcon :component="ArrowDownToLine" /></template>
        Pull
      </NButton>
      <NButton
        size="small"
        :type="st && st.ahead > 0 ? 'primary' : 'default'"
        :disabled="!hasRemote"
        :loading="busyAction === 'push'"
        @click="run('push')"
      >
        <template #icon><NIcon :component="ArrowUpFromLine" /></template>
        Push
      </NButton>

      <span class="spacer" />

      <NButton
        size="small"
        quaternary
        circle
        aria-label="refresh"
        :loading="busyAction === 'refresh'"
        @click="run('refresh')"
      >
        <template #icon><NIcon :component="RefreshCw" /></template>
      </NButton>
    </div>
  </NCard>
</template>

<style scoped>
.repo {
  transition: border-color 0.2s ease;
}
.repo.err {
  border-color: rgba(240, 106, 106, 0.4);
}
.top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.who {
  min-width: 0;
}
.name {
  font-weight: 650;
  font-size: 15.5px;
  color: #edeef2;
  line-height: 1.2;
}
.path {
  font-size: 11.5px;
  color: #6c6c7a;
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl; /* keep the repo's own folder visible when truncated */
  text-align: left;
}
.branch {
  flex: 0 0 auto;
}
.badges {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.clean {
  color: #7c7c8a;
}
.spacer {
  flex: 1 1 auto;
}
.remote {
  display: inline-flex;
  color: #4c4c58;
}
.remote.on {
  color: #6f93c0;
}
.errline {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12.5px;
  color: #f08a8a;
}
.idsel {
  margin-top: 12px;
}
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.commitbox {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 240px;
}
</style>
