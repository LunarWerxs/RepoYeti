<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from "vue";
import { Plus, Loader2, LogOut } from "@lucide/vue";
import { useStore } from "./store";
import { Button } from "@/components/ui/button";
import AppHeader from "./components/AppHeader.vue";
import GuestBanner from "./components/GuestBanner.vue";
import ConflictConcierge from "./components/ConflictConcierge.vue";
import AgentApprovalCard from "./components/AgentApprovalCard.vue";
import RepoList from "./components/RepoList.vue";
import RepoBulkBar from "./components/RepoBulkBar.vue";
import UpdatePrompt from "./components/UpdatePrompt.vue";
import RepoCard from "./components/RepoCard.vue";
import RepoFilters from "./components/RepoFilters.vue";
import AddRepo from "./components/AddRepo.vue";
import ScanProjects from "./components/ScanProjects.vue";
import Settings from "./components/Settings.vue";
import SignIn from "./components/SignIn.vue";
import RemoteAccess from "./components/RemoteAccess.vue";
import FileViewer from "./components/FileViewer.vue";
import { pageShiftPx, fileViewer, closeFile } from "@/lib/file-viewer";
import { selectionActive } from "@/lib/repo-selection";
import { usePushPanel } from "@/shell/usePushPanel";
import AppContainer from "@/shell/AppContainer.vue";
import AppFooter from "@/shell/AppFooter.vue";

const store = useStore();
const leftSharedWorkspace = new URLSearchParams(window.location.search).get("leftShare") === "1";
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

// "toggle" (header Settings menu item) flips the panel; "open" (e.g. the account-switcher's
// "manage accounts" shortcut, or a bell notification deep-linking to a tab) always force-opens it,
// even if already open. An optional `tab` deep-links Settings to that tab (e.g. the dead-AI-key
// notification → the Automation tab where AI providers live); cleared when the panel closes so a
// later plain open lands on General again.
const settingsTab = ref<string | null>(null);
function onSettings(mode: "toggle" | "open", tab?: string): void {
  settingsTab.value = tab ?? null;
  showSettings.value = mode === "open" ? true : !showSettings.value;
}

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
  // GET /api/accounts is owner-only (it lists the machine's GitHub logins), so a share-link guest
  // is 403'd by design. It's best-effort and swallows the error, but asking anyway would write a
  // "denied" row into that link's audit trail on every page load — burying the entries the owner
  // actually opens the trail to read ("did my brother push this?") under the app probing itself.
  if (!store.isGuest) void store.loadAccounts();
  store.connect();
  // Sweep the whole machine for repos on launch, if the owner opted in — deferred so it never
  // competes with the initial paint. Found repos stream in live (repo_added) and a finished scan
  // raises the "new projects" notification via notifyNewProjects() — both already wired in connect().
  scheduleIdle(() => {
    if (store.autoScan) void store.startScan();
  });

  // Sign-in opens in a NEW tab (see RemoteAccess / AccessSection), so this tab never navigates
  // and would otherwise sit on a stale "not signed in" view until reloaded by hand. Re-read auth
  // whenever the window comes back to the foreground — cheap, and only while signed out, so a
  // normal alt-tab on a signed-in dashboard costs nothing.
  window.addEventListener("focus", onWindowFocus);
});

function onWindowFocus(): void {
  if (store.authenticated) return;
  void store.loadAuth();
}
onBeforeUnmount(() => window.removeEventListener("focus", onWindowFocus));
</script>

<template>
  <div v-if="!store.authReady" class="grid min-h-dvh place-items-center">
    <Loader2 :size="30" class="animate-spin text-muted-foreground" />
  </div>

  <div v-else-if="leftSharedWorkspace" class="grid min-h-dvh place-items-center px-5">
    <div class="flex max-w-md flex-col items-center gap-3 text-center">
      <div class="grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
        <LogOut :size="20" />
      </div>
      <h1 class="text-lg font-semibold text-foreground">{{ $t("share.leftTitle") }}</h1>
      <p class="text-[13px] leading-relaxed text-muted-foreground">{{ $t("share.leftHint") }}</p>
    </div>
  </div>

  <SignIn v-else-if="needsSignIn" />

  <div
    v-else
    class="safe-bottom relative min-h-dvh transition-[padding] duration-300 ease-in-out"
    :style="{
      paddingRight: appShiftPx ? `${appShiftPx}px` : undefined,
    }"
  >
    <!-- Above the header, so a guest sees whose machine this is before anything else. Renders
         nothing for the owner. -->
    <GuestBanner />

    <AppHeader
      :connected="store.connected"
      :repo-count="store.repos.length"
      @reload="store.loadAll()"
      @add="showAdd = true"
      @settings="onSettings"
      @remote="showRemote = true"
    />

    <!-- extra bottom room while the bulk bar is up, so it can't sit on top of the last card -->
    <main class="pt-3" :class="selectionActive ? 'pb-28' : 'pb-10'">
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
        <!-- A guest can't add repos (the daemon refuses it), and an empty dashboard for them means
             the share simply names no live repo — not that they should go make one. -->
        <Button v-if="!store.isGuest" @click="showAdd = true">
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

    <!-- bulk action bar — only while the dashboard is in multi-select mode (started from the
         header's ⋮ menu; see @/lib/repo-selection) -->
    <RepoBulkBar v-if="selectionActive && !store.isGuest" />

    <!-- "an update is available, want it?" — never installs on its own; see UpdatePrompt.vue -->
    <UpdatePrompt v-if="!store.isGuest" />

    <AddRepo v-model:open="showAdd" />
    <ScanProjects v-model:open="store.scanOpen" />
    <Settings v-model:open="showSettings" :side="settingsSide" :right-offset-px="pageShiftPx" :target-tab="settingsTab" />
    <!-- "I want to share ONE repo, not my whole dashboard" — the remote modal hands off to
         Settings → Access, where share links live. -->
    <RemoteAccess v-model:open="showRemote" @share-links="onSettings('open', 'access')" />
    <FileViewer />
  </div>
</template>
