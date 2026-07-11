<script setup lang="ts">
import { onMounted, ref, computed, watch } from "vue";
import { Plus, Loader2 } from "@lucide/vue";
import { useStore } from "./store";
import { Button } from "@/components/ui/button";
import AppHeader from "./components/AppHeader.vue";
import ConflictConcierge from "./components/ConflictConcierge.vue";
import AgentApprovalCard from "./components/AgentApprovalCard.vue";
import RepoList from "./components/RepoList.vue";
import RepoCard from "./components/RepoCard.vue";
import RepoFilters from "./components/RepoFilters.vue";
import AddRepo from "./components/AddRepo.vue";
import ScanProjects from "./components/ScanProjects.vue";
import Settings from "./components/Settings.vue";
import SignIn from "./components/SignIn.vue";
import RemoteAccess from "./components/RemoteAccess.vue";
import FileViewer from "./components/FileViewer.vue";
import { pageShiftPx, fileViewer, closeFile } from "@/lib/file-viewer";
import { usePushPanel } from "@/shell/usePushPanel";
import AppContainer from "@/shell/AppContainer.vue";
import AppFooter from "@/shell/AppFooter.vue";

const store = useStore();
const showAdd = ref(false);
const showSettings = ref(false);
const showRemote = ref(false);
const { side: settingsSide, shiftPx: settingsShiftPx } = usePushPanel(showSettings, {
  shellMaxWidth: () => 800,
});
const appShiftPx = computed(() => pageShiftPx.value + settingsShiftPx.value);

// Only one right-side push panel is open at a time — opening the file viewer closes Settings /
// Remote access, and opening either of those closes the file viewer, so they never stack in the
// same region. (Settings applies changes live, so there's no save-that-closes-the-panel concern.)
watch(
  () => fileViewer.open,
  (open) => {
    if (open) {
      showSettings.value = false;
      showRemote.value = false;
    }
  },
);
watch(showSettings, (open) => {
  if (open) {
    closeFile();
    showRemote.value = false;
  }
});
watch(showRemote, (open) => {
  if (open) {
    closeFile();
    showSettings.value = false;
  }
});

// The login gate shows only in remote mode, when there's no owner session and no local
// bypass. Local mode (and the "Continue local for now" bypass) skip straight to the app.
const needsSignIn = computed(
  () => store.authReady && store.mode === "remote" && !store.authenticated && !store.localBypass,
);

/** Run work when the browser is idle (or shortly after) — keeps it off the startup path. */
function scheduleIdle(fn: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 4000 });
  else window.setTimeout(fn, 1500);
}

onMounted(async () => {
  await store.loadAuth();
  if (needsSignIn.value) return; // show the sign-in gate instead of loading data
  void store.loadAll();
  void store.loadAccounts();
  store.connect();
  // Sweep the whole machine for repos on launch, if the owner opted in — deferred so it never
  // competes with the initial paint. Found repos stream in live (repo_added) and a finished scan
  // raises the "new projects" notification via notifyNewProjects() — both already wired in connect().
  scheduleIdle(() => {
    if (store.autoScan) void store.startScan();
  });
});
</script>

<template>
  <div v-if="!store.authReady" class="grid min-h-dvh place-items-center">
    <Loader2 :size="30" class="animate-spin text-muted-foreground" />
  </div>

  <SignIn v-else-if="needsSignIn" />

  <div
    v-else
    class="safe-bottom relative min-h-dvh transition-[padding] duration-300 ease-in-out"
    :style="{
      paddingRight: appShiftPx ? `${appShiftPx}px` : undefined,
    }"
  >
    <AppHeader
      :connected="store.connected"
      :repo-count="store.repos.length"
      @reload="store.loadAll()"
      @add="showAdd = true"
      @settings="showSettings = true"
      @remote="showRemote = true"
    />

    <main class="pt-3 pb-10">
      <AppContainer>
      <AgentApprovalCard />
      <template v-if="store.loading">
        <div class="flex flex-col gap-2.5">
          <div
            v-for="i in 4"
            :key="i"
            class="h-[58px] animate-pulse rounded-md border border-border/60 bg-card"
          />
        </div>
      </template>

      <div
        v-else-if="store.repos.length === 0"
        class="mx-auto mt-[20vh] flex max-w-sm flex-col items-center gap-4 text-center"
      >
        <div class="text-sm font-medium text-muted-foreground">{{ $t("shell.noReposTitle") }}</div>
        <Button @click="showAdd = true">
          <Plus />
          {{ $t("shell.addRepository") }}
        </Button>
      </div>

      <template v-else>
        <ConflictConcierge />
        <RepoFilters />
        <template v-if="store.filtersActive">
          <div v-if="store.filteredRepos.length" class="flex flex-col gap-2.5">
            <RepoCard
              v-for="repo in store.filteredRepos"
              :key="repo.id"
              :repo="repo"
              :draggable="false"
            />
          </div>
          <div v-else class="py-12 text-center text-[13px] text-muted-foreground">
            {{ $t("shell.noMatch") }}
          </div>
        </template>
        <RepoList v-else-if="store.visibleRepos.length" />
        <div v-else class="py-12 text-center text-[13px] text-muted-foreground">
          {{ $t("shell.allHidden") }}
        </div>
      </template>
      </AppContainer>
    </main>

    <AppFooter />

    <AddRepo v-model:open="showAdd" />
    <ScanProjects v-model:open="store.scanOpen" />
    <Settings v-model:open="showSettings" :side="settingsSide" :right-offset-px="pageShiftPx" />
    <RemoteAccess v-model:open="showRemote" />
    <FileViewer />
  </div>
</template>
