<script setup lang="ts">
import { computed } from "vue";
import { Users, Circle } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useStore } from "../../store";
import { Button } from "@/components/ui/button";
import DiffStat from "../DiffStat.vue";
import type { Repo } from "../../types";

const props = defineProps<{
  repo: Repo;
  mode: "mine" | "theirs" | "combined";
}>();
const emit = defineEmits<{
  "update:mode": [mode: "mine" | "theirs" | "combined"];
}>();
const store = useStore();
const { t } = useI18n();

function modeLabel(choice: "mine" | "theirs" | "combined"): string {
  if (choice === "mine") return t("collaboration.mine");
  if (choice === "theirs") return t("collaboration.theirs");
  return t("collaboration.combined");
}

const peers = computed(() =>
  store.collaborationSnapshots
    .filter((snapshot) => snapshot.repoId === props.repo.id)
    .sort((a, b) => a.label.localeCompare(b.label)),
);

interface CombinedRow {
  path: string;
  mine: boolean;
  peers: string[];
  status: string;
}

const combined = computed<CombinedRow[]>(() => {
  const rows = new Map<string, CombinedRow>();
  for (const file of store.changesByRepo[props.repo.id] ?? []) {
    rows.set(file.path, { path: file.path, mine: true, peers: [], status: file.status });
  }
  for (const peer of peers.value) {
    for (const file of peer.changes) {
      const row = rows.get(file.path) ?? {
        path: file.path,
        mine: false,
        peers: [],
        status: file.status,
      };
      if (!row.peers.includes(peer.label)) row.peers.push(peer.label);
      rows.set(file.path, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
});
</script>

<template>
  <div v-if="peers.length" class="flex flex-col gap-2 rounded-lg border border-info/25 bg-info/5 p-2.5">
    <div class="flex flex-wrap items-center gap-2">
      <span class="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
        <Users :size="14" class="text-info" />
        {{ $t("collaboration.livePeers", { n: peers.length }) }}
      </span>
      <div class="ml-auto flex items-center gap-1">
        <Button
          v-for="choice in (['mine', 'theirs', 'combined'] as const)"
          :key="choice"
          size="sm"
          :variant="mode === choice ? 'secondary' : 'ghost'"
          class="h-7 px-2 text-[11px]"
          @click="emit('update:mode', choice)"
        >
          {{ modeLabel(choice) }}
        </Button>
      </div>
    </div>

    <div class="flex flex-wrap gap-x-3 gap-y-1">
      <span v-for="peer in peers" :key="peer.participantId" class="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Circle :size="7" class="fill-success text-success" />
        {{ peer.label }} · {{ peer.localRepoName }} · {{ $t("collaboration.changedFiles", { n: peer.changes.length }) }}
      </span>
    </div>

    <template v-if="mode === 'theirs'">
      <div v-for="peer in peers" :key="peer.participantId" class="rounded border border-border/50 bg-background/40">
        <div class="border-b border-border/40 px-2 py-1 text-[11px] font-medium text-foreground/90">
          {{ peer.label }}
        </div>
        <div v-if="peer.changes.length" class="max-h-64 overflow-auto py-1">
          <div v-for="file in peer.changes" :key="file.path" class="flex items-center gap-2 px-2 py-0.5 text-[11px]">
            <span class="w-3 shrink-0 font-semibold text-muted-foreground">{{ file.status }}</span>
            <span class="mono min-w-0 flex-1 truncate text-foreground/85">{{ file.path }}</span>
            <DiffStat :stat="file.stat" show="lines" />
          </div>
        </div>
        <p v-else class="px-2 py-2 text-[11px] text-muted-foreground">{{ $t("collaboration.peerClean") }}</p>
        <details v-if="peer.diff" class="border-t border-border/40 px-2 py-1.5">
          <summary class="cursor-pointer text-[11px] font-medium text-info">
            {{ $t("collaboration.peerDiff") }}
          </summary>
          <pre
            class="scroll-slim mono mt-1.5 max-h-72 overflow-auto whitespace-pre p-2 text-[10.5px] leading-relaxed text-foreground/80"
          >{{ peer.diff }}</pre>
        </details>
      </div>
    </template>

    <div v-else-if="mode === 'combined'" class="max-h-72 overflow-auto rounded border border-border/50 bg-background/40 py-1">
      <div v-for="row in combined" :key="row.path" class="flex items-center gap-2 px-2 py-0.5 text-[11px]">
        <span class="w-3 shrink-0 font-semibold text-muted-foreground">{{ row.status }}</span>
        <span class="mono min-w-0 flex-1 truncate text-foreground/85">{{ row.path }}</span>
        <span v-if="row.mine" class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
          {{ $t("collaboration.mine") }}
        </span>
        <span
          v-for="peer in row.peers"
          :key="peer"
          class="max-w-28 shrink-0 truncate rounded bg-info/10 px-1.5 py-0.5 text-[9px] text-info"
        >
          {{ peer }}
        </span>
      </div>
      <p v-if="combined.length === 0" class="px-2 py-2 text-[11px] text-muted-foreground">
        {{ $t("collaboration.everyoneClean") }}
      </p>
      <details
        v-for="peer in peers.filter((item) => !!item.diff)"
        :key="`${peer.participantId}-diff`"
        class="border-t border-border/40 px-2 py-1.5"
      >
        <summary class="cursor-pointer text-[11px] font-medium text-info">
          {{ $t("collaboration.peerDiffBy", { label: peer.label }) }}
        </summary>
        <pre
          class="scroll-slim mono mt-1.5 max-h-72 overflow-auto whitespace-pre p-2 text-[10.5px] leading-relaxed text-foreground/80"
        >{{ peer.diff }}</pre>
      </details>
    </div>
  </div>
</template>
