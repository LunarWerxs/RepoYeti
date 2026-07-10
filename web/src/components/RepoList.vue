<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { dragAndDrop } from "@formkit/drag-and-drop/vue";
import { animations, tearDown } from "@formkit/drag-and-drop";
import { Pin, Star, FolderGit2 } from "@lucide/vue";
import { useStore } from "../store";
import type { Repo } from "../types";
import RepoCard from "./RepoCard.vue";

const store = useStore();

// The dashboard splits the *visible* repos into three sections (Pinned, Starred, rest),
// each its own independent drag list — you reorder within a section, and move a repo
// between sections via its ⋮ menu (Pin / Star). We keep local arrays bound to the drag
// library and rebuild them only when membership/flags change — NOT on live SSE status
// patches, which mutate the shared repo objects in place (so cards update without a
// disruptive reassignment mid-drag). Precedence (pinned > starred > rest) lives in the
// store so a repo never renders in two sections.
const pinnedList = ref<Repo[]>([]);
const starredList = ref<Repo[]>([]);
const otherList = ref<Repo[]>([]);

function rebuild(): void {
  pinnedList.value = [...store.pinnedRepos];
  starredList.value = [...store.starredRepos];
  otherList.value = [...store.otherRepos];
}
watch(
  () => store.visibleRepos.map((r) => `${r.id}:${r.pinned ? 1 : 0}:${r.starred ? 1 : 0}`).join(","),
  rebuild,
  { immediate: true },
);

const hasSections = computed(() => pinnedList.value.length > 0 || starredList.value.length > 0);

// Persist the global order as pinned-block → starred-block → rest-block, then append any
// repo NOT in the visible drag set (hidden ones) so they keep a stable spot. The daemon
// stores one global sort_order; the section filters re-derive the grouping from it.
function persist(): void {
  const ids = [...pinnedList.value, ...starredList.value, ...otherList.value].map((r) => r.id);
  const seen = new Set(ids);
  const tail = store.repos.filter((r) => !seen.has(r.id)).map((r) => r.id);
  void store.persistRepoOrder([...ids, ...tail]);
}

const pinnedParent = ref<HTMLElement>();
const starredParent = ref<HTMLElement>();
const otherParent = ref<HTMLElement>();
// `nativeDrag: false` routes every pointer (mouse + touch) through the synthetic
// dragger — the native HTML5 drag drops the item on fast flicks, this doesn't.
// `longPress` gives touch users a tap-and-hold to enter reorder mode (mouse still
// drags immediately from the handle).
const dragOpts = {
  dragHandle: ".drag-handle",
  draggingClass: "dragging",
  nativeDrag: false,
  longPress: true,
  longPressDuration: 250,
  plugins: [animations()],
};
dragAndDrop({ parent: pinnedParent, values: pinnedList, onDragend: persist, ...dragOpts });
dragAndDrop({ parent: starredParent, values: starredList, onDragend: persist, ...dragOpts });
dragAndDrop({ parent: otherParent, values: otherList, onDragend: persist, ...dragOpts });

// `dragAndDrop` (unlike `useDragAndDrop`) wires no teardown — clean up if we unmount.
onBeforeUnmount(() => {
  for (const p of [pinnedParent, starredParent, otherParent]) if (p.value) tearDown(p.value);
});
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- Pinned -->
    <section v-show="pinnedList.length">
      <div
        class="mb-2 flex items-center gap-1.5 px-0.5 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase"
      >
        <Pin :size="13" class="text-primary" />
        {{ $t("shell.sectionPinned") }}
        <span class="text-muted-foreground/60">{{ pinnedList.length }}</span>
      </div>
      <div ref="pinnedParent" class="flex flex-col gap-2.5">
        <RepoCard v-for="repo in pinnedList" :key="repo.id" :repo="repo" />
      </div>
    </section>

    <!-- Starred -->
    <section v-show="starredList.length">
      <div
        class="mb-2 flex items-center gap-1.5 px-0.5 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase"
      >
        <Star :size="13" class="fill-current text-warning" />
        {{ $t("shell.sectionStarred") }}
        <span class="text-muted-foreground/60">{{ starredList.length }}</span>
      </div>
      <div ref="starredParent" class="flex flex-col gap-2.5">
        <RepoCard v-for="repo in starredList" :key="repo.id" :repo="repo" />
      </div>
    </section>

    <!-- Everything else (header shown only when a section above it exists) -->
    <section v-show="otherList.length">
      <div
        v-show="hasSections"
        class="mb-2 flex items-center gap-1.5 px-0.5 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase"
      >
        <FolderGit2 :size="13" />
        {{ $t("shell.sectionAll") }}
        <span class="text-muted-foreground/60">{{ otherList.length }}</span>
      </div>
      <div ref="otherParent" class="flex flex-col gap-2.5">
        <RepoCard v-for="repo in otherList" :key="repo.id" :repo="repo" />
      </div>
    </section>
  </div>
</template>
