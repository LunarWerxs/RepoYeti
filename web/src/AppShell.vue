<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { Plus, FolderGit2, FolderSearch, Loader2 } from "@lucide/vue";
import { useStore } from "./store";
import { Button } from "@/components/ui/button";
import AppHeader from "./components/AppHeader.vue";
import RepoList from "./components/RepoList.vue";
import RepoCard from "./components/RepoCard.vue";
import RepoFilters from "./components/RepoFilters.vue";
import AddRepo from "./components/AddRepo.vue";
import ScanProjects from "./components/ScanProjects.vue";
import Settings from "./components/Settings.vue";
import SignIn from "./components/SignIn.vue";
import RemoteAccess from "./components/RemoteAccess.vue";
import FileViewer from "./components/FileViewer.vue";
import { pageShiftPx } from "@/lib/file-viewer";
import { usePushPanel } from "@/shell/usePushPanel";
import AppContainer from "@/shell/AppContainer.vue";
import AppFooter from "@/shell/AppFooter.vue";

const store = useStore();
const showAdd = ref(false);
const showSettings = ref(false);
const showRemote = ref(false);
const { side: settingsSide, shiftPx: settingsShiftPx } = usePushPanel(showSettings);
const appShiftPx = computed(() => pageShiftPx.value + settingsShiftPx.value);

// The login gate shows only in remote mode, when there's no owner session and no local
// bypass. Local mode (and the "Continue local for now" bypass) skip straight to the app.
const needsSignIn = computed(
  () => store.authReady && store.mode === "remote" && !store.authenticated && !store.localBypass,
);

onMounted(async () => {
  await store.loadAuth();
  if (needsSignIn.value) return; // show the sign-in gate instead of loading data
  void store.loadAll();
  void store.loadAccounts();
  store.connect();
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
        class="mx-auto mt-[14vh] flex max-w-sm flex-col items-center text-center"
      >
        <div class="mb-4 flex size-14 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
          <FolderGit2 :size="26" />
        </div>
        <div class="text-base font-semibold">{{ $t("shell.noReposTitle") }}</div>
        <p class="mt-1 mb-4 text-[13px] text-muted-foreground">
          {{ $t("shell.noReposBody") }}
        </p>
        <div class="flex flex-wrap items-center justify-center gap-2">
          <Button @click="showAdd = true">
            <Plus />
            {{ $t("shell.addRepository") }}
          </Button>
          <Button variant="secondary" @click="showSettings = true">
            <FolderSearch />
            {{ $t("shell.addScanFolder") }}
          </Button>
        </div>
      </div>

      <template v-else>
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
