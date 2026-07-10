<script setup lang="ts">
/**
 * Combined per-commit review inside the Smart Commit plan editor: the diffs of EVERY file in one
 * proposed commit, stacked, so the owner can read the whole change the commit will contain in one
 * scroll (the "Files changed" tab of a PR, in miniature). Companion to SmartCommitFileDiff, which
 * zooms into a SINGLE file with the rich Monaco viewer — this one stays lightweight on purpose so
 * many files can render at once (see @/lib/unified-diff). Each file's diff is fetched in parallel
 * and renders as soon as it lands; new/deleted/large files all fall out of the same diff endpoint.
 */
import { reactive, onMounted } from "vue";
import { Loader2, FileWarning } from "@lucide/vue";
import { api, ApiError } from "@/api";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { renderFileDiff, type RenderedDiff, type DiffRow } from "@/lib/unified-diff";
import { statusColor } from "@/lib/git-status-colors";

const props = defineProps<{ repoId: string; files: string[]; statusByPath: Record<string, string> }>();

interface FileState {
  phase: "loading" | "done" | "error";
  rendered?: RenderedDiff;
  error?: string;
}
const states = reactive<Record<string, FileState>>({});

function rowClass(kind: DiffRow["kind"]): string {
  if (kind === "add") return "bg-success/10";
  if (kind === "del") return "bg-destructive/10";
  return "";
}
function sign(kind: DiffRow["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "del") return "−";
  return "";
}

async function load(path: string): Promise<void> {
  states[path] = { phase: "loading" };
  try {
    const res = await api.fileDiff(props.repoId, path);
    if (!res.ok) {
      states[path] = { phase: "error", error: res.message ?? t("fileViewer.error") };
      return;
    }
    states[path] = { phase: "done", rendered: renderFileDiff(res) };
  } catch (e) {
    states[path] = { phase: "error", error: e instanceof ApiError ? e.message : t("fileViewer.error") };
  }
}

onMounted(() => {
  // Fetch every file's diff in parallel; each block fills in as its request resolves.
  for (const p of props.files) void load(p);
});
</script>

<template>
  <div class="max-h-[60vh] divide-y divide-border overflow-y-auto rounded-md border border-border bg-background/40">
    <div v-for="path in files" :key="path" class="min-w-0">
      <!-- file header: status letter + path -->
      <div class="flex items-center gap-2 bg-card/60 px-2.5 py-1.5">
        <span class="mono shrink-0 text-[11px] font-bold" :style="{ color: statusColor(statusByPath[path]) }">
          {{ statusByPath[path] ?? "·" }}
        </span>
        <span class="mono min-w-0 flex-1 truncate text-[11.5px] text-foreground" :title="path">{{ path }}</span>
      </div>

      <!-- body: loading · error · binary · too-large · the diff rows -->
      <div v-if="!states[path] || states[path].phase === 'loading'" class="flex items-center gap-2 px-3 py-2 text-[11.5px] text-muted-foreground">
        <Loader2 :size="14" class="animate-spin" />
      </div>
      <div v-else-if="states[path].phase === 'error'" class="flex items-center gap-2 px-3 py-2 text-[11.5px] text-muted-foreground">
        <FileWarning :size="14" class="shrink-0 text-destructive" />
        <span class="mono truncate">{{ states[path].error }}</span>
      </div>
      <div v-else-if="states[path].rendered?.binary" class="flex items-center gap-2 px-3 py-2 text-[11.5px] text-muted-foreground">
        <FileWarning :size="14" class="shrink-0" />
        <span>{{ $t("fileViewer.binary") }}</span>
      </div>
      <div v-else-if="states[path].rendered?.tooLarge" class="flex items-center gap-2 px-3 py-2 text-[11.5px] text-muted-foreground">
        <FileWarning :size="14" class="shrink-0" />
        <span>{{ $t("repo.smartCommit.diffTooLarge") }}</span>
      </div>
      <div v-else class="overflow-x-auto">
        <div class="mono w-max min-w-full text-[11px] leading-[1.5]">
          <template v-for="(row, ri) in states[path].rendered?.rows ?? []" :key="ri">
            <div
              v-if="row.kind === 'meta'"
              class="bg-secondary/30 px-2.5 py-0.5 text-[10.5px] text-muted-foreground select-none"
            >
              {{ row.collapsed ? $t("repo.smartCommit.elided", { n: row.collapsed }) : row.text }}
            </div>
            <div v-else :class="cn('flex', rowClass(row.kind))">
              <span class="w-5 shrink-0 select-none text-center text-muted-foreground/50">{{ sign(row.kind) }}</span>
              <span class="whitespace-pre pr-3">{{ row.text }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
