<script setup lang="ts">
// Per-repo commit history, redrawn as a "Git Graph"-style DAG (colored lanes + nodes + ref
// chips + tap-to-expand detail). It is CONTAINER-responsive, not viewport-responsive: a
// ResizeObserver measures the panel so a wide desktop card gets the full table (Description /
// Author / Date / Commit columns) while a narrow phone card gets compact two-line rows — both
// sharing one SVG graph gutter. Lane geometry comes from the pure @/lib/git-graph layout; the
// backend log carries `parents` + `refs`, and its branch scope (all / local / current) drives
// the graph's toggle. Detail (files + bounded diff) is fetched per-commit on tap, cached by hash.
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { History, ChevronDown, Loader2, RefreshCw, GitMerge, Copy, CornerDownRight, Tag, FileEdit } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { api, ApiError } from "../api";
import { fromNow } from "@/lib/util";
import { cn } from "@/lib/utils";
import { useRepoFeedback } from "@/lib/repo-feedback";
import { computeGraph, type GraphCommit, type GraphLink } from "@/lib/git-graph";
import { splitUnifiedDiff } from "@/lib/unified-diff";
import { openFile, isViewing } from "@/lib/file-viewer";
import type { CommitDetail, LogEntry } from "../types";

const props = defineProps<{ repoId: string }>();
const store = useStore();
const { t } = useI18n();
const { friendly } = useRepoFeedback();

type Scope = "all" | "local" | "head";
const WORKTREE = "__WORKTREE__"; // synthetic hash for the "uncommitted changes" row

const showHistory = ref(false);
const scope = ref<Scope>("all"); // default to the full multi-branch DAG (owner's pick)
const logResult = computed(() => store.logByRepo[props.repoId]);
const loadingLog = ref(false);

const repo = computed(() => store.repos.find((r) => r.id === props.repoId));
const dirtyCount = computed(() => repo.value?.status?.dirty ?? 0);

// ── container-responsive breakpoint (measure the panel, not the window) ──────────────
const rootEl = ref<HTMLElement | null>(null);
const compact = ref(true);
let ro: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver === "undefined" || !rootEl.value) return;
  ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 0;
    if (w > 0) compact.value = w < 560;
  });
  ro.observe(rootEl.value);
});
onBeforeUnmount(() => ro?.disconnect());

// ── lane geometry (px) — tighter on a narrow card ────────────────────────────────────
const LANE_CAP = 8; // clamp very deep lanes so the gutter can't run away on mobile
const lanePx = computed(() => (compact.value ? 13 : 16));
const rowPx = computed(() => (compact.value ? 46 : 34)); // compact rows are 2-line → taller
const nodeR = computed(() => (compact.value ? 4 : 4.5));
const cx = (l: number): number => Math.min(l, LANE_CAP - 1) * lanePx.value + lanePx.value / 2;
const cy = (y: number): number => y * rowPx.value;
const laneColor = (i: number): string => `var(--chart-${(i % 5) + 1})`;
function linkPath(lk: GraphLink): string {
  const x1 = cx(lk.x1), y1 = cy(lk.y1), x2 = cx(lk.x2), y2 = cy(lk.y2);
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
  const ym = (y1 + y2) / 2; // S-curve for merge/branch diagonals — the classic git-graph bend
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

// ── graph layout: prepend a synthetic "working tree" row when the repo is dirty ──────
const headHash = computed(() => (logResult.value?.commits ?? []).find((c) => /\bHEAD\b/.test(c.refs))?.hash ?? null);
const showWorktree = computed(() => dirtyCount.value > 0 && headHash.value != null);

interface Item { kind: "wt" | "commit"; commit?: LogEntry; row: ReturnType<typeof computeGraph>["rows"][number] }
const graph = computed(() => {
  const commits = logResult.value?.commits ?? [];
  const input: GraphCommit[] = [];
  if (showWorktree.value) input.push({ hash: WORKTREE, parents: [headHash.value!] });
  for (const c of commits) input.push({ hash: c.hash, parents: c.parents ?? [] });
  const layout = computeGraph(input);
  const items: Item[] = [];
  let i = 0;
  if (showWorktree.value) items.push({ kind: "wt", row: layout.rows[i++]! });
  for (const c of commits) items.push({ kind: "commit", commit: c, row: layout.rows[i++]! });
  return { items, laneCount: layout.laneCount };
});
const gutterW = computed(() => Math.min(graph.value.laneCount, LANE_CAP) * lanePx.value || lanePx.value);
// Shared grid template so the wide-mode header + rows keep their columns aligned.
const gridCols = computed(() => `${gutterW.value}px minmax(0,1fr) minmax(72px,132px) auto auto`);

// ── ref-decoration chips (parse the `refs` string git hands us) ──────────────────────
interface RefChip { kind: "current" | "head" | "branch" | "remote" | "tag"; label: string }
const REMOTE_RE = /^(origin|upstream|remote|fork)\//i;
function refChips(refs: string): RefChip[] {
  if (!refs) return [];
  const chips: RefChip[] = [];
  for (const raw of refs.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw === "HEAD") chips.push({ kind: "head", label: "HEAD" });
    else if (raw.startsWith("HEAD -> ")) chips.push({ kind: "current", label: raw.slice(8) });
    else if (raw.startsWith("tag: ")) chips.push({ kind: "tag", label: raw.slice(5) });
    else if (REMOTE_RE.test(raw)) chips.push({ kind: "remote", label: raw });
    else chips.push({ kind: "branch", label: raw });
  }
  // Show the identity-bearing refs first (current > tags > local > remote).
  const rank = { current: 0, head: 1, tag: 2, branch: 3, remote: 4 } as const;
  return chips.sort((a, b) => rank[a.kind] - rank[b.kind]);
}
const CHIP_CAP = 4;

// ── data loading + scope switching ───────────────────────────────────────────────────
async function reload(): Promise<void> {
  loadingLog.value = true;
  try {
    await store.loadLog(props.repoId, 50, 0, scope.value);
  } finally {
    loadingLog.value = false;
  }
}
async function toggleHistory(): Promise<void> {
  showHistory.value = !showHistory.value;
  if (showHistory.value && !logResult.value) await reload();
}
async function setScope(s: Scope): Promise<void> {
  if (scope.value === s) return;
  scope.value = s;
  expandedCommit.value = null;
  await reload();
}
async function loadMoreLog(): Promise<void> {
  if (loadingLog.value) return;
  loadingLog.value = true;
  try {
    await store.loadLog(props.repoId, 50, logResult.value?.commits.length ?? 0, scope.value);
  } finally {
    loadingLog.value = false;
  }
}

// ── per-commit detail (files + bounded diff), lazy + cached by hash ──────────────────
const expandedCommit = ref<string | null>(null);
const commitCache = ref<Record<string, CommitDetail>>({});
const loadingCommit = ref<string | null>(null);
async function toggleCommit(hash: string): Promise<void> {
  if (expandedCommit.value === hash) {
    expandedCommit.value = null;
    return;
  }
  expandedCommit.value = hash;
  if (commitCache.value[hash]) return;
  loadingCommit.value = hash;
  try {
    commitCache.value = { ...commitCache.value, [hash]: await api.commitDetail(props.repoId, hash) };
  } catch (e) {
    const message = e instanceof ApiError ? friendly(e.code ?? "ERROR") || e.message : t("repo.history.detailUnavailable");
    commitCache.value = {
      ...commitCache.value,
      [hash]: {
        ok: false, code: "ERROR", message,
        hash, shortHash: hash.slice(0, 12), subject: "", body: "", authorName: "", authorEmail: "", date: 0,
        parents: [], isMerge: false, committerName: "", committerEmail: "", committerDate: 0,
        files: [], diff: "", truncated: false,
      },
    };
  } finally {
    loadingCommit.value = null;
  }
}

// ── expanded-commit changed files (click one → the shared Monaco viewer, diff at this commit) ──
// VS Code-style git-status colours (match ChangesTree / FileViewerInner).
const STATUS_COLOR: Record<string, string> = { M: "#e2c08d", A: "#73c991", U: "#73c991", D: "#f14c4c", R: "#6cb6ff", C: "#d18616" };
const statusColor = (s: string): string => STATUS_COLOR[s] ?? "#9aa0a6";
function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf("/");
  return i === -1 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

interface DetailFile { status: string; path: string; from?: string; adds: number; dels: number }
/** The open commit's changed files, each with its +add/−del stat from the commit's unified diff. */
const detailFiles = computed<DetailFile[]>(() => {
  const h = expandedCommit.value;
  const d = h ? commitCache.value[h] : null;
  if (!d?.ok) return [];
  const byPath = new Map(splitUnifiedDiff(d.diff).map((f) => [f.path, f] as const));
  return d.files.map((f) => {
    const pf = byPath.get(f.path);
    return { status: f.status, path: f.path, from: f.from, adds: pf?.adds ?? 0, dels: pf?.dels ?? 0 };
  });
});

/** Open a changed file in the shared Monaco viewer, showing its diff AT this commit. */
function openCommitFile(f: DetailFile): void {
  if (!expandedCommit.value) return;
  void openFile({ repoId: props.repoId, path: f.path, status: f.status, commit: expandedCommit.value });
}

// ── uncommitted-files expand (reuses the store's changed-file read) ──────────────────
const wtOpen = ref(false);
async function toggleWorktree(): Promise<void> {
  wtOpen.value = !wtOpen.value;
  if (wtOpen.value) await store.loadChanges(props.repoId);
}
const wtFiles = computed(() => store.changesByRepo[props.repoId] ?? []);

// ── copy hash + jump-to-parent (scroll + flash the target row) ───────────────────────
async function copyHash(hash: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(hash);
    toast.success(t("repo.history.copied"));
  } catch {
    /* clipboard blocked — non-critical */
  }
}
const rowEls = new Map<string, HTMLElement>();
const setRowEl = (hash: string) => (el: unknown): void => {
  if (el instanceof HTMLElement) rowEls.set(hash, el);
  else rowEls.delete(hash);
};
const flashHash = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
function jumpToParent(hash: string): void {
  const el = rowEls.get(hash);
  if (!el) {
    // Parent is on a later page / different scope — copy its hash instead so it's not a dead end.
    void copyHash(hash);
    return;
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  flashHash.value = hash;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flashHash.value = null), 1200);
}

// Reset caches when the repo changes underneath us.
watch(
  () => props.repoId,
  () => {
    expandedCommit.value = null;
    commitCache.value = {};
    wtOpen.value = false;
    rowEls.clear();
  },
);
</script>

<template>
  <div ref="rootEl" class="border-t border-border/40 pt-2">
    <!-- header: expand toggle -->
    <button
      type="button"
      class="flex w-full items-center gap-1.5 text-[12.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
      :aria-expanded="showHistory"
      @click="toggleHistory"
    >
      <History :size="14" />
      <span>{{ $t("repo.history.title") }}</span>
      <ChevronDown :size="14" :class="cn('ml-auto transition-transform', showHistory && 'rotate-180')" />
    </button>

    <div v-if="showHistory" class="mt-2">
      <!-- toolbar: branch-scope toggle + refresh -->
      <div class="mb-2 flex items-center gap-2">
        <div
          class="inline-flex items-center rounded-md border border-border/60 p-0.5"
          role="tablist"
          :aria-label="$t('repo.history.branchScope')"
        >
          <button
            v-for="opt in ([
              { v: 'all', label: $t('repo.history.scopeAllShort'), title: $t('repo.history.scopeAll') },
              { v: 'local', label: $t('repo.history.scopeLocalShort'), title: $t('repo.history.scopeLocal') },
              { v: 'head', label: $t('repo.history.scopeHeadShort'), title: $t('repo.history.scopeHead') },
            ] as const)"
            :key="opt.v"
            type="button"
            role="tab"
            :aria-selected="scope === opt.v"
            :title="opt.title"
            class="rounded px-2 py-0.5 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
            :class="scope === opt.v ? 'bg-primary/15 font-medium text-primary' : 'text-muted-foreground hover:text-foreground'"
            @click="setScope(opt.v)"
          >
            {{ opt.label }}
          </button>
        </div>
        <button
          type="button"
          class="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          :title="$t('repo.history.refresh')"
          :aria-label="$t('repo.history.refresh')"
          :disabled="loadingLog"
          @click="reload"
        >
          <RefreshCw :size="13" :class="loadingLog && 'animate-spin'" />
        </button>
      </div>

      <!-- loading / error / empty -->
      <div v-if="loadingLog && !logResult" class="flex items-center gap-2 px-1 py-1.5 text-[12px] text-muted-foreground">
        <Loader2 :size="13" class="animate-spin" />{{ $t("repo.history.loading") }}
      </div>
      <div v-else-if="logResult && !logResult.ok" class="px-1 py-1.5 text-[12px] text-destructive">
        {{ logResult.message || $t("repo.history.detailUnavailable") }}
      </div>
      <div v-else-if="logResult && !logResult.commits.length" class="px-1 py-1.5 text-[12px] text-muted-foreground">
        {{ $t("repo.history.empty") }}
      </div>

      <template v-else-if="logResult">
        <!-- column header (wide cards only) -->
        <div
          v-if="!compact"
          class="grid items-center border-b border-border/40 pb-1 pr-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/70"
          :style="{ gridTemplateColumns: gridCols }"
        >
          <span aria-hidden="true" />
          <span>{{ $t("repo.history.colDescription") }}</span>
          <span class="text-right">{{ $t("repo.history.colDate") }}</span>
          <span class="pl-2">{{ $t("repo.history.colAuthor") }}</span>
          <span class="pl-3 text-right">{{ $t("repo.history.colCommit") }}</span>
        </div>

        <div class="scroll-slim max-h-104 overflow-y-auto">
          <div v-for="item in graph.items" :key="item.kind === 'wt' ? WORKTREE : item.commit!.hash">
            <!-- ══ uncommitted-changes row ══ -->
            <template v-if="item.kind === 'wt'">
              <div class="group/r flex cursor-pointer items-stretch rounded-md hover:bg-accent/30" @click="toggleWorktree">
                <svg :width="gutterW" :height="rowPx" class="shrink-0" :viewBox="`0 0 ${gutterW} ${rowPx}`" aria-hidden="true">
                  <path
                    v-for="(lk, i) in item.row.links"
                    :key="i"
                    :d="linkPath(lk)"
                    :stroke="laneColor(lk.color)"
                    :stroke-width="compact ? 1.75 : 2"
                    fill="none"
                    stroke-linecap="round"
                  />
                  <circle
                    :cx="cx(item.row.node.lane)"
                    :cy="cy(0.5)"
                    :r="nodeR"
                    fill="var(--background)"
                    stroke="var(--muted-foreground)"
                    stroke-width="1.5"
                    stroke-dasharray="2 1.5"
                  />
                </svg>
                <div class="flex min-w-0 flex-1 items-center gap-2 py-1 pr-1">
                  <FileEdit :size="13" class="shrink-0 text-warning" />
                  <span class="truncate text-[12.5px] font-medium text-foreground">
                    {{ $t("repo.history.uncommitted", { count: dirtyCount }) }}
                  </span>
                  <ChevronDown
                    :size="13"
                    :class="cn('ml-auto shrink-0 text-muted-foreground transition-transform', wtOpen && 'rotate-180')"
                  />
                </div>
              </div>
              <div
                v-if="wtOpen"
                class="mb-1 border-l-2 border-warning/40 py-1 pl-2 text-[11px]"
                :style="{ marginLeft: `${gutterW}px` }"
              >
                <div v-if="!wtFiles.length" class="text-muted-foreground">{{ $t("repo.history.noUncommitted") }}</div>
                <div v-else class="flex flex-wrap gap-1">
                  <span
                    v-for="f in wtFiles.slice(0, 60)"
                    :key="f.path"
                    class="mono inline-flex max-w-full items-center gap-1 rounded bg-secondary px-1.5 py-0.5"
                  >
                    <span class="font-semibold text-muted-foreground">{{ f.status }}</span>
                    <span class="truncate" :title="f.path">{{ f.path }}</span>
                  </span>
                </div>
              </div>
            </template>

            <!-- ══ commit row ══ -->
            <template v-else>
              <div
                :ref="setRowEl(item.commit!.hash)"
                class="group/r flex cursor-pointer items-stretch rounded-md transition-colors hover:bg-accent/40"
                :class="[
                  expandedCommit === item.commit!.hash && 'bg-accent/40',
                  flashHash === item.commit!.hash && 'flash',
                ]"
                :aria-expanded="expandedCommit === item.commit!.hash"
                @click="toggleCommit(item.commit!.hash)"
              >
                <!-- graph gutter -->
                <svg :width="gutterW" :height="rowPx" class="shrink-0" :viewBox="`0 0 ${gutterW} ${rowPx}`" aria-hidden="true">
                  <path
                    v-for="(lk, i) in item.row.links"
                    :key="i"
                    :d="linkPath(lk)"
                    :stroke="laneColor(lk.color)"
                    :stroke-width="compact ? 1.75 : 2"
                    fill="none"
                    stroke-linecap="round"
                  />
                  <circle
                    v-if="headHash === item.commit!.hash"
                    :cx="cx(item.row.node.lane)"
                    :cy="cy(0.5)"
                    :r="nodeR + 2.5"
                    fill="none"
                    stroke="var(--primary)"
                    stroke-width="1.5"
                  />
                  <circle
                    :cx="cx(item.row.node.lane)"
                    :cy="cy(0.5)"
                    :r="nodeR"
                    :fill="laneColor(item.row.node.color)"
                    stroke="var(--background)"
                    stroke-width="1"
                  />
                </svg>

                <!-- WIDE: aligned columns -->
                <div
                  v-if="!compact"
                  class="grid min-w-0 flex-1 items-center py-1 pr-1"
                  :style="{ gridTemplateColumns: 'minmax(0,1fr) minmax(72px,132px) auto auto' }"
                >
                  <div class="flex min-w-0 items-center gap-1.5">
                    <GitMerge
                      v-if="item.row.node.isMerge"
                      :size="12"
                      class="shrink-0 text-muted-foreground"
                      :aria-label="$t('repo.history.mergeCommit')"
                    />
                    <span
                      v-for="(chip, ci) in refChips(item.commit!.refs).slice(0, CHIP_CAP)"
                      :key="ci"
                      class="inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[10px] leading-none"
                      :class="{
                        'border-primary/30 bg-primary/10 text-primary': chip.kind === 'current' || chip.kind === 'head',
                        'border-warning/30 bg-warning/10 text-warning': chip.kind === 'tag',
                        'border-border/60 bg-secondary text-secondary-foreground': chip.kind === 'branch',
                        'border-border/50 bg-muted text-muted-foreground': chip.kind === 'remote',
                      }"
                    >
                      <Tag v-if="chip.kind === 'tag'" :size="9" />
                      <span class="max-w-40 truncate">{{ chip.label }}</span>
                    </span>
                    <span v-if="refChips(item.commit!.refs).length > CHIP_CAP" class="shrink-0 text-[10px] text-muted-foreground">
                      +{{ refChips(item.commit!.refs).length - CHIP_CAP }}
                    </span>
                    <span class="truncate text-[12.5px] text-foreground" :title="item.commit!.subject">{{ item.commit!.subject }}</span>
                  </div>
                  <span class="whitespace-nowrap pl-2 text-right text-[11px] text-muted-foreground">{{ fromNow(item.commit!.date) }}</span>
                  <span class="truncate pl-2 text-[11.5px] text-muted-foreground" :title="item.commit!.authorEmail">{{ item.commit!.authorName }}</span>
                  <button
                    type="button"
                    class="mono pl-3 text-right text-[11px] text-info/80 outline-none hover:underline focus-visible:underline"
                    :title="$t('repo.history.copyHash')"
                    @click.stop="copyHash(item.commit!.hash)"
                  >
                    {{ item.commit!.shortHash }}
                  </button>
                </div>

                <!-- COMPACT: two-line stack -->
                <div v-else class="flex min-w-0 flex-1 flex-col justify-center py-1 pr-1">
                  <div class="flex min-w-0 items-center gap-1">
                    <GitMerge v-if="item.row.node.isMerge" :size="11" class="shrink-0 text-muted-foreground" />
                    <span
                      v-for="(chip, ci) in refChips(item.commit!.refs).slice(0, 2)"
                      :key="ci"
                      class="inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[9.5px] leading-none"
                      :class="{
                        'border-primary/30 bg-primary/10 text-primary': chip.kind === 'current' || chip.kind === 'head',
                        'border-warning/30 bg-warning/10 text-warning': chip.kind === 'tag',
                        'border-border/60 bg-secondary text-secondary-foreground': chip.kind === 'branch',
                        'border-border/50 bg-muted text-muted-foreground': chip.kind === 'remote',
                      }"
                    >
                      <Tag v-if="chip.kind === 'tag'" :size="8" />
                      <span class="max-w-24 truncate">{{ chip.label }}</span>
                    </span>
                    <span class="truncate text-[12.5px] text-foreground" :title="item.commit!.subject">{{ item.commit!.subject }}</span>
                  </div>
                  <div class="truncate text-[10.5px] text-muted-foreground">
                    {{ item.commit!.authorName }} · {{ fromNow(item.commit!.date) }} ·
                    <span class="mono text-info/70">{{ item.commit!.shortHash }}</span>
                  </div>
                </div>
              </div>

              <!-- commit detail (files + bounded diff), indented past the gutter -->
              <div
                v-if="expandedCommit === item.commit!.hash"
                class="mb-1 mt-0.5 rounded-md border-l-2 py-1.5 pl-2.5 pr-2"
                :style="{ marginLeft: `${gutterW}px`, borderColor: laneColor(item.row.node.color) }"
              >
                <div v-if="loadingCommit === item.commit!.hash" class="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 :size="13" class="animate-spin" />{{ $t("repo.history.loading") }}
                </div>
                <template v-else-if="commitCache[item.commit!.hash]?.ok">
                  <!-- meta: short hash + copy · parents -->
                  <div class="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span class="mono text-muted-foreground">{{ commitCache[item.commit!.hash].shortHash }}</span>
                    <button
                      type="button"
                      class="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                      :title="$t('repo.history.copyHash')"
                      :aria-label="$t('repo.history.copyHash')"
                      @click.stop="copyHash(commitCache[item.commit!.hash].hash)"
                    >
                      <Copy :size="12" />
                    </button>
                    <template v-if="commitCache[item.commit!.hash].parents.length">
                      <span class="ml-1 text-muted-foreground/70">{{ $t("repo.history.parents") }}:</span>
                      <button
                        v-for="p in commitCache[item.commit!.hash].parents"
                        :key="p"
                        type="button"
                        class="mono inline-flex items-center gap-0.5 rounded bg-secondary px-1 py-px text-[10px] text-info/80 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
                        :title="$t('repo.history.jumpToParent')"
                        @click.stop="jumpToParent(p)"
                      >
                        <CornerDownRight :size="9" />{{ p.slice(0, 8) }}
                      </button>
                    </template>
                    <span v-else class="ml-1 text-muted-foreground/70">{{ $t("repo.history.root") }}</span>
                  </div>
                  <div class="mb-1.5 text-[11px] text-muted-foreground">
                    <div>
                      <span class="text-muted-foreground/70">{{ $t("repo.history.author") }}:</span>
                      {{ commitCache[item.commit!.hash].authorName }} · {{ fromNow(commitCache[item.commit!.hash].date) }}
                    </div>
                    <div
                      v-if="commitCache[item.commit!.hash].committerName && commitCache[item.commit!.hash].committerName !== commitCache[item.commit!.hash].authorName"
                    >
                      <span class="text-muted-foreground/70">{{ $t("repo.history.committer") }}:</span>
                      {{ commitCache[item.commit!.hash].committerName }} · {{ fromNow(commitCache[item.commit!.hash].committerDate) }}
                    </div>
                  </div>
                  <!-- commit message (subject + body) -->
                  <div class="mb-2 rounded bg-secondary/20 px-2 py-1.5">
                    <div class="whitespace-pre-wrap text-[12px] font-medium text-foreground">{{ commitCache[item.commit!.hash].subject }}</div>
                    <div
                      v-if="commitCache[item.commit!.hash].body"
                      class="mt-1 whitespace-pre-wrap text-[11px] leading-snug text-muted-foreground"
                    >{{ commitCache[item.commit!.hash].body }}</div>
                  </div>
                  <!-- changed files — click one to open it in the shared Monaco viewer (diff at this commit) -->
                  <div v-if="detailFiles.length" class="overflow-hidden rounded-md border border-border">
                    <button
                      v-for="f in detailFiles"
                      :key="f.path"
                      type="button"
                      class="flex w-full items-center gap-2 border-b border-border px-2 py-1 text-left transition-colors last:border-b-0 hover:bg-accent/40"
                      :class="isViewing(props.repoId, f.path, item.commit!.hash) && 'bg-accent/60'"
                      :title="f.from ? `${f.from} → ${f.path}` : f.path"
                      @click.stop="openCommitFile(f)"
                    >
                      <span class="mono shrink-0 text-[11px] font-bold" :style="{ color: statusColor(f.status) }">{{ f.status }}</span>
                      <span class="mono min-w-0 flex-1 truncate text-[11.5px]">
                        <span class="text-muted-foreground/60">{{ splitPath(f.path).dir }}</span><span class="text-foreground">{{ splitPath(f.path).name }}</span>
                      </span>
                      <span v-if="f.adds" class="mono shrink-0 text-[10.5px] text-success">+{{ f.adds }}</span>
                      <span v-if="f.dels" class="mono shrink-0 text-[10.5px] text-destructive">−{{ f.dels }}</span>
                    </button>
                  </div>
                  <div v-else class="text-[11px] text-muted-foreground">{{ $t("repo.history.noChanges") }}</div>
                  <p v-if="commitCache[item.commit!.hash].truncated" class="mt-1 text-[11px] text-muted-foreground">
                    {{ $t("repo.history.diffTruncated") }}
                  </p>
                </template>
                <div v-else class="text-[12px] text-muted-foreground">
                  {{ commitCache[item.commit!.hash]?.message || $t("repo.history.detailUnavailable") }}
                </div>
              </div>
            </template>
          </div>
        </div>

        <button
          v-if="logResult.hasMore"
          type="button"
          class="mt-1 w-full rounded-md py-1.5 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
          :disabled="loadingLog"
          @click="loadMoreLog"
        >
          <Loader2 v-if="loadingLog" :size="13" class="mr-1 inline animate-spin" />{{ $t("repo.history.loadMore") }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Brief highlight when a "jump to parent" lands on a row. */
@keyframes rowFlash {
  0%,
  60% {
    background-color: color-mix(in oklab, var(--primary) 22%, transparent);
  }
  100% {
    background-color: transparent;
  }
}
.flash {
  animation: rowFlash 1.2s ease-out;
}
</style>
