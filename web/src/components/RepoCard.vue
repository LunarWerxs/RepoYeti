<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useStore } from "../store";
import { cn } from "@/lib/utils";
import { provideTreeSelection } from "@/lib/changes-selection";
import { VCS_CAPABILITIES } from "../types";
import type { Repo } from "../types";
import RepoCardHeader from "./repo-card/RepoCardHeader.vue";
import RepoCardChanges from "./repo-card/RepoCardChanges.vue";
import RepoCardCommit from "./repo-card/RepoCardCommit.vue";
import RepoCardActions from "./repo-card/RepoCardActions.vue";
import LogPanel from "./LogPanel.vue";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";

const props = withDefaults(defineProps<{ repo: Repo; draggable?: boolean }>(), {
  draggable: true,
});
const store = useStore();

const st = computed(() => props.repo.status);
// Per-VCS capabilities (mirrors the daemon) — only needed here to gate the stash load below;
// each child re-derives its own copy from `repo` for its own rendering (see repo-card/*.vue).
const caps = computed(() => VCS_CAPABILITIES[props.repo.vcs] ?? VCS_CAPABILITIES.git);

// ── collapse + changed-files tree ─────────────────────────────────────────────
const expanded = ref(false);

// Owned here (not in the children below) because RepoCardChanges/RepoCardCommit render inside
// <CollapsibleContent>, which unmounts its content on collapse (reka-ui's default
// unmountOnHide) — a ref living there would reset every time the card is collapsed and
// re-expanded. RepoCard's own scope never unmounts, so a half-typed commit message or an
// active changed-files search survives across a collapse/expand cycle, matching the
// pre-split behavior (these were plain local refs in the single-file RepoCard).
const commitMsg = ref("");
const treeQuery = ref("");
const contentMode = ref(false);

// Per-file selection (the checkboxes in ChangesTree) → drives the "Commit selected (N)" bar in
// RepoCardCommit. Shared with the recursive tree via provide/inject, persisted per repo (see
// @/lib/changes-selection). Provided here (not in a child) so both RepoCardChanges' ChangesTree
// (via inject) and RepoCardCommit (via prop) read/write the exact same selection.
const treeSelection = provideTreeSelection(props.repo.id);
// Keep the selection honest: once the changed-file list loads/updates, drop any selected path that's
// no longer pending (just committed, discarded, or vanished) so a stale path can't reach the backend
// (which would reject it as PLAN_STALE). Skip while the list is still unloaded (undefined).
watch(
  () => store.changesByRepo[props.repo.id],
  (files) => {
    if (files) treeSelection.prune(files.map((f) => f.path));
  },
);

// RepoCardCommit exposes loadRecentMsgs() (+ its recentMsgs state) so the "recent commit
// message" chips can be refreshed right when a dirty repo is expanded, without hoisting that
// state back up here.
const commitRef = ref<InstanceType<typeof RepoCardCommit> | null>(null);

function toggle(): void {
  expanded.value = !expanded.value;
  if (expanded.value) {
    if ((st.value?.dirty ?? 0) > 0) {
      void store.loadChanges(props.repo.id);
      void commitRef.value?.loadRecentMsgs();
    }
    void store.loadBranches(props.repo.id);
    if (caps.value.stash) void store.loadStashes(props.repo.id);
  }
}
watch(
  () => st.value?.dirty,
  () => {
    if (expanded.value && (st.value?.dirty ?? 0) > 0) {
      void store.loadChanges(props.repo.id);
      if (!commitRef.value?.recentMsgs.length) void commitRef.value?.loadRecentMsgs();
    }
  },
);
</script>

<template>
  <Collapsible
    :id="`repo-card-${repo.id}`"
    :open="expanded"
    :class="
      cn(
        'overflow-hidden rounded-md border border-border bg-card transition-colors',
        expanded && 'border-border/80 bg-card/90 ring-1 ring-white/5',
        repo.hidden && 'opacity-60',
      )
    "
  >
    <!-- collapsed header row — see repo-card/RepoCardHeader.vue -->
    <RepoCardHeader :repo="repo" :draggable="draggable" :expanded="expanded" @toggle="toggle" />

    <!-- ── expanded body ───────────────────────────────────────────────────── -->
    <CollapsibleContent>
      <div class="flex flex-col gap-3 border-t border-border/60 px-3 pt-3 pb-3.5">
        <!-- path/branch/error + changed-files tree — see repo-card/RepoCardChanges.vue -->
        <RepoCardChanges :repo="repo" v-model:tree-query="treeQuery" v-model:content-mode="contentMode" />

        <!-- commit message box + smart-commit — see repo-card/RepoCardCommit.vue -->
        <RepoCardCommit
          ref="commitRef"
          :repo="repo"
          :tree-selection="treeSelection"
          v-model:commit-msg="commitMsg"
        />

        <!-- fetch/pull/push/stash/refresh + overflow menu — see repo-card/RepoCardActions.vue -->
        <RepoCardActions :repo="repo" />

        <!-- commit history (lazy-loaded when opened) — see LogPanel.vue -->
        <LogPanel :repo-id="repo.id" />
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
