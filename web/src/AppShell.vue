<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { NEmpty, NSkeleton, NText, NSpin, NButton, NIcon } from "naive-ui";
import { Plus } from "lucide-vue-next";
import { useStore } from "./store";
import AppHeader from "./components/AppHeader.vue";
import RepoCard from "./components/RepoCard.vue";
import IdentityManager from "./components/IdentityManager.vue";
import AddRepo from "./components/AddRepo.vue";
import SignIn from "./components/SignIn.vue";

const store = useStore();
const showIdentities = ref(false);
const showAdd = ref(false);

const needsSignIn = computed(() => store.authReady && store.authEnforced && !store.authenticated);

onMounted(async () => {
  await store.loadAuth();
  if (needsSignIn.value) return; // show the sign-in gate instead of loading data
  void store.loadAll();
  store.connect();
});
</script>

<template>
  <div v-if="!store.authReady" class="boot">
    <NSpin size="large" />
  </div>

  <SignIn v-else-if="needsSignIn" />

  <div v-else class="page safe-bottom">
    <AppHeader
      :connected="store.connected"
      :repo-count="store.repos.length"
      @manage="showIdentities = true"
      @reload="store.loadAll()"
      @add="showAdd = true"
    />

    <main class="content">
      <template v-if="store.loading">
        <NSkeleton v-for="i in 4" :key="i" height="150px" style="border-radius: 14px" />
      </template>

      <NEmpty v-else-if="store.repos.length === 0" class="empty" description="No repositories yet">
        <template #extra>
          <NButton type="primary" size="small" @click="showAdd = true">
            <template #icon><NIcon :component="Plus" /></template>
            Add a repository
          </NButton>
          <NText depth="3" tag="div" class="emptyhint">
            or scan a whole folder — <code class="mono">gitmob add-root &lt;path&gt;</code> — then restart.
          </NText>
        </template>
      </NEmpty>

      <div v-else v-auto-animate class="list">
        <RepoCard v-for="repo in store.repos" :key="repo.id" :repo="repo" />
      </div>
    </main>

    <IdentityManager v-model:show="showIdentities" />
    <AddRepo v-model:show="showAdd" />
  </div>
</template>

<style scoped>
.boot {
  min-height: 100vh;
  display: grid;
  place-items: center;
}
.page {
  max-width: 720px;
  margin: 0 auto;
  min-height: 100vh;
}
.content {
  padding: 12px 12px 32px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.empty {
  margin-top: 16vh;
}
.emptyhint {
  margin-top: 14px;
  font-size: 12px;
}
</style>
