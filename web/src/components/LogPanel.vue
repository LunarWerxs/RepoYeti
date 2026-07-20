<script setup lang="ts">
// Per-repo commit history, redrawn as a "Git Graph"-style DAG (colored lanes + nodes + ref
// chips + tap-to-expand detail). It is CONTAINER-responsive, not viewport-responsive: a
// ResizeObserver measures the panel so a wide desktop card gets the full table (Description /
// Author / Date / Commit columns) while a narrow phone card gets compact two-line rows — both
// sharing one SVG graph gutter. Lane geometry comes from the pure @/lib/git-graph layout; the
// backend log carries `parents` + `refs`, and its branch scope (all / local / current) drives
// the graph's toggle. Detail (files + bounded diff) is fetched per-commit on tap, cached by hash.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";
import { History, ChevronDown, Loader2, RefreshCw, GitMerge, Copy, CornerDownRight, Tag, FileEdit, Files, Eye, SquarePen, FolderOpen } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { api, ApiError } from "../api";
import { fromNow, buildChangeTree } from "@/lib/util";
import { cn } from "@/lib/utils";
import { useRepoFeedback } from "@/lib/repo-feedback";
import { computeGraph, type GraphCommit, type GraphLink } from "@/lib/git-graph";
import { statusColor } from "@/lib/git-status-colors";
import { openFile, isViewing } from "@/lib/file-viewer";
import { historyFilesView } from "@/lib/history-view";
import CommitFilesTree from "./CommitFilesTree.vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { ChangedFile, CommitDetail, LogEntry, TreeNode } from "../types";

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
const rootEl = useTemplateRef<HTMLElement>("rootEl");
const compact = ref(true);
let ro: ResizeObserver | null = null;
let io: IntersectionObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver === "undefined" || !rootEl.value) return;
  ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 0;
    // 640, not the old 560: the wide table gained a fifth column (Changes), so its fixed tracks
    // now total 380px. At 560 the flexible Description track was squeezed to ~144px and every
    // subject truncated after a couple of words. 640 keeps Description at ~224px or better, and
    // anything narrower gets the two-line compact rows, which read better at that size anyway.
    if (w > 0) compact.value = w < 640;
  });
  ro.observe(rootEl.value);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  io?.disconnect();
});

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
// ONE column template, shared verbatim by the wide-mode header and every commit row. The header
// and each row are SEPARATE grids, so content-sized tracks (auto / minmax) resolve independently
// per grid — the header sizing to the word "AUTHOR", each row to its own author name — which is
// why the titles never lined up with the columns under them. Fixed tracks keep the two in
// lockstep. Order: description · changes · date · author · commit.
const COLS = "minmax(0,1fr) 112px 88px 116px 64px";

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

// ── per-commit change totals (the "Changes" column) ──────────────────────────────────
/** True when the commit reports any change. A merge reports none — git prints no diff for one. */
function hasStat(c: LogEntry): boolean {
  const s = c.stat;
  return !!s && (s.filesChanged > 0 || s.addedLines > 0 || s.removedLines > 0);
}
/** Compact count so the narrow column can't blow out: 1234 → "1.2k", 20500 → "21k". */
function compactN(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}
/** Exact figures for the hover title, since the cell itself abbreviates. */
function statTitle(c: LogEntry): string {
  const s = c.stat;
  if (!s) return "";
  return `${t("repo.history.filesChanged", { count: s.filesChanged }, s.filesChanged)} · ${t("repo.diffStat.lines", { added: s.addedLines, removed: s.removedLines })}`;
}

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

// Infinite scroll: observe a sentinel at the bottom of the list and fetch the next page as it
// nears view (rootMargin), so there's no "Load more" button. Re-observes whenever the sentinel
// mounts/unmounts (history opened AND more pages remain).
const scrollEl = useTemplateRef<HTMLElement>("scrollEl");
const sentinelEl = useTemplateRef<HTMLElement>("sentinelEl");
watch(sentinelEl, (el) => {
  io?.disconnect();
  if (!el) return;
  io = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting && logResult.value?.hasMore && !loadingLog.value) void loadMoreLog();
    },
    { root: scrollEl.value ?? null, rootMargin: "200px" },
  );
  io.observe(el);
});

// ── per-commit detail (files + bounded diff), lazy + cached by hash ──────────────────
const expandedCommit = ref<string | null>(null);
const commitCache = ref<Record<string, CommitDetail>>({});
const loadingCommit = ref<string | null>(null);
/** Nearest ancestor that actually scrolls vertically — the history list has its own
 *  overflow-y container, so corrections must land on it, not on the window. Resolved per
 *  frame because a collapse can shrink the list below its max-height cap mid-animation,
 *  at which point the remaining drift belongs to whatever scrolls outside it. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * Hold `el` at `targetTop` (viewport px) while the surrounding layout animates.
 *
 * Only one commit is expanded at a time, so opening a new one closes the old one. When the old
 * one is ABOVE and was tall — you scrolled through its file list to reach the next commit — that
 * collapse pulls hundreds of pixels out from over your head and the row you just clicked shoots
 * off the top of the screen. Scrolling once afterwards isn't enough either: the collapse is a
 * 200ms grid-rows transition, so the layout keeps moving after the click. This re-pins every
 * frame until it settles, which also makes the collapse look anchored rather than jumpy.
 */
function holdRowInPlace(el: HTMLElement, targetTop: number, ms = 260): void {
  const started = performance.now();
  const step = (): void => {
    const drift = el.getBoundingClientRect().top - targetTop;
    // Sub-pixel drift isn't worth a scroll write; at a scroll boundary the correction simply
    // can't apply, and retrying costs nothing.
    if (Math.abs(drift) > 0.5) {
      const scroller = scrollParentOf(el);
      if (scroller) scroller.scrollTop += drift;
      else window.scrollBy(0, drift);
    }
    if (performance.now() - started < ms) requestAnimationFrame(step);
  };
  step();
}

async function toggleCommit(hash: string): Promise<void> {
  if (expandedCommit.value === hash) {
    expandedCommit.value = null;
    return;
  }
  // Anchor only when something else was already open — that's the case where a collapse moves
  // this row. Opening the first one just adds content below it and shifts nothing above.
  const displacing = expandedCommit.value !== null;
  const row = rowEls.get(hash);
  // Capture the anchor BEFORE the state flip: if the old detail collapses without a transition
  // (reduced motion, teleported tab), the jump happens during the same patch nextTick waits on,
  // and a post-patch measurement would anchor the row at its already-wrong position.
  const targetTop = displacing && row ? row.getBoundingClientRect().top : 0;
  expandedCommit.value = hash;
  if (displacing && row) {
    await nextTick();
    holdRowInPlace(row, targetTop);
  }
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
        files: [], filesTotal: 0,
      },
    };
  } finally {
    loadingCommit.value = null;
  }
}

// ── expanded-commit changed files (click one → the shared Monaco viewer, diff at this commit) ──
function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf("/");
  return i === -1 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

// ── commit-message body clamp ────────────────────────────────────────────────────────
// A long body (a generated changelog, a template with trailers) would otherwise push the
// changed-files list off the bottom of the card. Clamp it to a few lines and offer Show more.
//
// The clamp is measured rather than assumed: the toggle only appears when the text really is
// taller than the clamp, so a two-line message never sprouts a pointless "Show more". And the
// open height is the measured content height, not a large guess, so the transition finishes
// exactly when the text stops growing instead of running on against a cap it never reaches.
const BODY_CLAMP_LINES = 8;
// The body sits inside the v-for over commits, and Vue collects a ref declared inside a v-for
// into an ARRAY even when only one element is rendered (only the open commit renders a detail).
// Unwrap it, or every measurement runs against an array and throws.
const bodyEl = useTemplateRef<HTMLElement | HTMLElement[]>("bodyEl");
const bodyOpen = ref(false);
const bodyOverflows = ref(false);
const bodyMaxHeight = ref<string | undefined>(undefined);

function measureBody(): void {
  const raw = bodyEl.value;
  const el = Array.isArray(raw) ? raw[0] : raw;
  if (!el) {
    bodyOverflows.value = false;
    bodyMaxHeight.value = undefined;
    return;
  }
  const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 14;
  const clampPx = Math.round(lineHeight * BODY_CLAMP_LINES);
  // scrollHeight is the FULL text height even while max-height clips it.
  const full = el.scrollHeight;
  bodyOverflows.value = full > clampPx + 1;
  bodyMaxHeight.value = !bodyOverflows.value || bodyOpen.value ? `${full}px` : `${clampPx}px`;
}

// Re-measure when the open commit changes (new text) or the toggle flips. A commit's detail
// arrives asynchronously, so this also runs when the cache fills in.
watch([expandedCommit, bodyOpen, () => commitCache.value], async () => {
  await nextTick();
  measureBody();
});
// A new commit starts clamped — carrying "expanded" across to a different message would be
// remembering a decision about text the owner never saw.
watch(expandedCommit, () => (bodyOpen.value = false));

/** The open commit's cached detail (undefined until loaded, or never for a hash not yet fetched). */
const expandedDetail = computed<CommitDetail | undefined>(() => {
  const h = expandedCommit.value;
  return h ? commitCache.value[h] : undefined;
});

interface DetailFile { status: string; path: string; from?: string; adds: number; dels: number }
/** The open commit's changed files, each with its +add/−del stat (counted server-side via
 *  `git show --numstat`, so it's exact for every file and needs no client-side patch parsing). */
const detailFiles = computed<DetailFile[]>(() => {
  const d = expandedDetail.value;
  if (!d?.ok) return [];
  return d.files.map((f) => ({ status: f.status, path: f.path, from: f.from, adds: f.adds, dels: f.dels }));
});

/** The same files as a compressed folder tree (Appearance → "History files as folder tree").
 *  Reuses the Changes panel's builder so folder compression + dirs-first sorting match; the
 *  numstat counts ride in as a lines-only DiffStat. Built lazily — list view never pays for it. */
const detailTree = computed<TreeNode[]>(() =>
  historyFilesView.value === "tree"
    ? buildChangeTree(detailFiles.value.map((f) => ({
        path: f.path,
        status: f.status,
        staged: false,
        from: f.from,
        stat: { addedLines: f.adds, removedLines: f.dels, addedChars: 0, removedChars: 0 },
      })))
    : [],
);

/** Open a changed file in the shared Monaco viewer, showing its diff AT this commit. */
function openCommitFile(f: DetailFile): void {
  if (!expandedCommit.value) return;
  void openFile({ repoId: props.repoId, path: f.path, status: f.status, commit: expandedCommit.value });
}

/** Open an uncommitted file's working-tree diff in the shared Monaco viewer. */
function openWorktreeFile(f: ChangedFile): void {
  void openFile({ repoId: props.repoId, path: f.path, status: f.status, staged: f.staged });
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

// ── file-row context-menu actions (right-click a file in a commit or the working tree) ──
async function copyFilePath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success(t("repo.changes.copiedPath"));
  } catch {
    toast.error(t("repo.changes.copyPathFailed"));
  }
}
// Open the file in the owner's default editor (loopback-only, like the changes tree). Opens the
// CURRENT working-tree file (not the historical revision) — matches "Open with…" semantics.
async function editFile(path: string): Promise<void> {
  try {
    await store.openInEditor(props.repoId, { path });
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("repo.openFailed"));
  }
}
// Reveal (select) the file in the OS file manager (loopback-only).
async function revealFile(path: string): Promise<void> {
  try {
    await store.openInEditor(props.repoId, { editor: "system", path });
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t("repo.openFailed"));
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

    <!-- Section body animates open/closed with the same grid-rows trick as the per-commit
         detail below (Transition name="expand"), instead of a hard v-if pop. -->
    <Transition name="expand">
    <div v-if="showHistory" class="expand-grid">
    <div class="min-h-0 overflow-hidden">
    <div class="mt-2">
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
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
              :aria-label="$t('repo.history.refresh')"
              :disabled="loadingLog"
              @click="reload"
            >
              <RefreshCw :size="13" :class="loadingLog && 'animate-spin'" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{{ $t("repo.history.refresh") }}</TooltipContent>
        </Tooltip>
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
        <!-- column header (wide cards only). Mirrors a commit row's own structure exactly — a
             gutter-width spacer, then the SAME grid template with the SAME per-cell padding and
             alignment — so every title sits over the column it names. -->
        <div v-if="!compact" class="flex items-stretch border-b border-border/40 pb-1">
          <span :style="{ width: `${gutterW}px` }" class="shrink-0" aria-hidden="true" />
          <div
            class="grid min-w-0 flex-1 items-center pr-1 text-[10.5px] font-medium tracking-wide uppercase text-muted-foreground/70"
            :style="{ gridTemplateColumns: COLS }"
          >
            <span class="truncate">{{ $t("repo.history.colDescription") }}</span>
            <span class="truncate pl-2 text-right">{{ $t("repo.history.colChanges") }}</span>
            <span class="truncate pl-2 text-right">{{ $t("repo.history.colDate") }}</span>
            <span class="truncate pl-2">{{ $t("repo.history.colAuthor") }}</span>
            <span class="truncate pl-2 text-right">{{ $t("repo.history.colCommit") }}</span>
          </div>
        </div>

        <div ref="scrollEl" class="scroll-slim max-h-104 overflow-y-auto">
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
              <!-- Same clickable micro-table a commit's detail uses (not the old flex-wrapped
                   chip cloud) — each row opens the file's working-tree diff in the viewer. -->
              <Transition name="expand">
                <div v-if="wtOpen" class="expand-grid">
                  <div class="min-h-0 overflow-hidden">
                    <div
                      class="mb-1 border-l-2 border-warning/40 py-1 pl-2 text-[11px]"
                      :style="{ marginLeft: `${gutterW}px` }"
                    >
                      <div v-if="!wtFiles.length" class="text-muted-foreground">{{ $t("repo.history.noUncommitted") }}</div>
                      <template v-else>
                        <div class="overflow-hidden rounded-md border border-border">
                          <ContextMenu v-for="f in wtFiles.slice(0, 60)" :key="`${f.path}:${f.staged}`">
                            <ContextMenuTrigger as-child>
                              <button
                                type="button"
                                class="flex w-full items-center gap-2 border-b border-border px-2 py-1 text-left transition-colors last:border-b-0 hover:bg-accent/40"
                                :class="isViewing(props.repoId, f.path) && 'bg-accent/60'"
                                :title="f.path"
                                @click.stop="openWorktreeFile(f)"
                              >
                                <span class="mono shrink-0 text-[11px] font-bold" :style="{ color: statusColor(f.status) }">{{ f.status }}</span>
                                <span class="mono min-w-0 flex-1 truncate text-[11.5px]">
                                  <span class="text-foreground">{{ splitPath(f.path).name }}</span><span v-if="splitPath(f.path).dir" class="ml-1.5 text-muted-foreground/55">{{ splitPath(f.path).dir.replace(/\/+$/, "") }}</span>
                                </span>
                                <span v-if="f.stat?.addedLines" class="mono shrink-0 text-[10.5px] text-success">+{{ f.stat.addedLines }}</span>
                                <span v-if="f.stat?.removedLines" class="mono shrink-0 text-[10.5px] text-destructive">−{{ f.stat.removedLines }}</span>
                              </button>
                            </ContextMenuTrigger>
                            <ContextMenuContent class="w-52">
                              <ContextMenuItem @select="openWorktreeFile(f)">
                                <Eye :size="15" /><span>{{ $t("repo.changes.ctxOpen") }}</span>
                              </ContextMenuItem>
                              <ContextMenuItem @select="editFile(f.path)">
                                <SquarePen :size="15" /><span>{{ $t("repo.changes.ctxEditor") }}</span>
                              </ContextMenuItem>
                              <ContextMenuItem @select="revealFile(f.path)">
                                <FolderOpen :size="15" /><span>{{ $t("repo.changes.revealAction") }}</span>
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem @select="copyFilePath(f.path)">
                                <Copy :size="15" /><span>{{ $t("repo.changes.ctxCopyPath") }}</span>
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        </div>
                        <div v-if="wtFiles.length > 60" class="mt-1 text-muted-foreground">
                          {{ $t("repo.history.moreFiles", { count: wtFiles.length - 60 }) }}
                        </div>
                      </template>
                    </div>
                  </div>
                </div>
              </Transition>
            </template>

            <!-- ══ commit row ══ -->
            <template v-else>
              <!-- A clickable row, made operable by keyboard: it was a bare <div> with a click
                   handler, so it carried aria-expanded but could not be reached by Tab or fired
                   with Enter. Same treatment the repo-card header row uses. It stays a div rather
                   than a <button> because it contains its own copy-hash control, and a button
                   cannot legally contain another button. -->
              <div
                :ref="setRowEl(item.commit!.hash)"
                role="button"
                tabindex="0"
                class="group/r flex cursor-pointer items-stretch rounded-md outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/40"
                :class="[
                  expandedCommit === item.commit!.hash && 'bg-accent/40',
                  flashHash === item.commit!.hash && 'flash',
                ]"
                :aria-expanded="expandedCommit === item.commit!.hash"
                :aria-label="t('repo.history.commitRowLabel', { subject: item.commit!.subject })"
                @click="toggleCommit(item.commit!.hash)"
                @keydown.enter.prevent="toggleCommit(item.commit!.hash)"
                @keydown.space.prevent="toggleCommit(item.commit!.hash)"
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

                <!-- WIDE: aligned columns (same COLS template as the header above) -->
                <div
                  v-if="!compact"
                  class="grid min-w-0 flex-1 items-center py-1 pr-1"
                  :style="{ gridTemplateColumns: COLS }"
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
                  <!-- total change: +added / −removed / files touched. Abbreviated (1.2k) so a
                       huge commit can't widen the column; exact figures ride on the title. -->
                  <span
                    class="mono flex items-center justify-end gap-1 overflow-hidden pl-2 text-[10.5px] whitespace-nowrap"
                    :title="statTitle(item.commit!)"
                  >
                    <template v-if="hasStat(item.commit!)">
                      <span class="text-success">+{{ compactN(item.commit!.stat!.addedLines) }}</span>
                      <span class="text-destructive">−{{ compactN(item.commit!.stat!.removedLines) }}</span>
                      <span class="inline-flex items-center gap-0.5 text-muted-foreground/70">
                        <Files :size="9" />{{ compactN(item.commit!.stat!.filesChanged) }}
                      </span>
                    </template>
                    <span v-else class="text-muted-foreground/35">·</span>
                  </span>
                  <span class="pl-2 text-right text-[11px] whitespace-nowrap text-muted-foreground">{{ fromNow(item.commit!.date) }}</span>
                  <span class="truncate pl-2 text-[11.5px] text-muted-foreground" :title="item.commit!.authorEmail">{{ item.commit!.authorName }}</span>
                  <button
                    type="button"
                    class="mono pl-2 text-right text-[11px] text-info/80 outline-none hover:underline focus-visible:underline"
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
                    <!-- no room for a column here, so the totals ride on the meta line instead -->
                    <template v-if="hasStat(item.commit!)">
                      ·
                      <span class="mono text-success">+{{ compactN(item.commit!.stat!.addedLines) }}</span>
                      <span class="mono text-destructive">−{{ compactN(item.commit!.stat!.removedLines) }}</span>
                      <span class="mono inline-flex items-center gap-0.5 text-muted-foreground/70">
                        <Files :size="9" />{{ compactN(item.commit!.stat!.filesChanged) }}
                      </span>
                    </template>
                  </div>
                </div>
              </div>

              <!-- commit detail (files + bounded diff), indented past the gutter -->
              <Transition name="expand">
                <div v-if="expandedCommit === item.commit!.hash" class="expand-grid">
                  <div class="min-h-0 overflow-hidden">
                    <div
                      class="mb-1 mt-0.5 rounded-md border-l-2 py-1.5 pl-2.5 pr-2"
                      :style="{ marginLeft: `${gutterW}px`, borderColor: laneColor(item.row.node.color) }"
                    >
                <div v-if="loadingCommit === item.commit!.hash" class="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 :size="13" class="animate-spin" />{{ $t("repo.history.loading") }}
                </div>
                <template v-else-if="expandedDetail?.ok">
                  <!-- meta: short hash + copy · parents -->
                  <div class="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span class="mono text-muted-foreground">{{ expandedDetail.shortHash }}</span>
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <button
                          type="button"
                          class="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                          :aria-label="$t('repo.history.copyHash')"
                          @click.stop="copyHash(expandedDetail.hash)"
                        >
                          <Copy :size="12" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{{ $t("repo.history.copyHash") }}</TooltipContent>
                    </Tooltip>
                    <template v-if="expandedDetail.parents.length">
                      <span class="ml-1 text-muted-foreground/70">{{ $t("repo.history.parents") }}:</span>
                      <button
                        v-for="p in expandedDetail.parents"
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
                      {{ expandedDetail.authorName }} · {{ fromNow(expandedDetail.date) }}
                    </div>
                    <div
                      v-if="expandedDetail.committerName && expandedDetail.committerName !== expandedDetail.authorName"
                    >
                      <span class="text-muted-foreground/70">{{ $t("repo.history.committer") }}:</span>
                      {{ expandedDetail.committerName }} · {{ fromNow(expandedDetail.committerDate) }}
                    </div>
                  </div>
                  <!-- commit message (subject + body). A long body is clamped to a few lines with
                       a Show more toggle: a generated or template-heavy message would otherwise
                       push the changed-files list off the bottom of the card. -->
                  <div class="mb-2 rounded bg-secondary/20 px-2 py-1.5">
                    <div class="whitespace-pre-wrap text-[12px] font-medium text-foreground">{{ expandedDetail.subject }}</div>
                    <template v-if="expandedDetail.body">
                      <div
                        ref="bodyEl"
                        class="commit-body mt-1 whitespace-pre-wrap text-[11px] leading-snug text-muted-foreground"
                        :class="bodyOverflows && !bodyOpen && 'is-clamped'"
                        :style="{ maxHeight: bodyMaxHeight }"
                      >{{ expandedDetail.body }}</div>
                      <button
                        v-if="bodyOverflows"
                        type="button"
                        class="mt-1 flex items-center gap-1 rounded-sm text-[11px] font-medium text-info outline-none transition-colors hover:text-info/80 focus-visible:ring-2 focus-visible:ring-ring/40"
                        :aria-expanded="bodyOpen"
                        @click.stop="bodyOpen = !bodyOpen"
                      >
                        <ChevronDown
                          :size="12"
                          class="transition-transform duration-200"
                          :class="bodyOpen && 'rotate-180'"
                        />
                        {{ bodyOpen ? $t("repo.history.showLess") : $t("repo.history.showMore") }}
                      </button>
                    </template>
                  </div>
                  <!-- changed files — folder tree or flat list (Appearance → "History files as
                       folder tree"); either way a click opens the shared Monaco viewer with the
                       file's diff AT this commit. -->
                  <div v-if="detailFiles.length && historyFilesView === 'tree'" class="overflow-hidden rounded-md border border-border py-0.5">
                    <CommitFilesTree
                      :nodes="detailTree"
                      @open="(n) => openCommitFile({ status: n.status ?? 'M', path: n.path, adds: 0, dels: 0 })"
                      @editor="editFile"
                      @reveal="revealFile"
                      @copy-path="copyFilePath"
                    />
                  </div>
                  <div v-else-if="detailFiles.length" class="overflow-hidden rounded-md border border-border">
                    <ContextMenu v-for="f in detailFiles" :key="f.path">
                      <ContextMenuTrigger as-child>
                        <button
                          type="button"
                          class="flex w-full items-center gap-2 border-b border-border px-2 py-1 text-left transition-colors last:border-b-0 hover:bg-accent/40"
                          :class="isViewing(props.repoId, f.path, item.commit!.hash) && 'bg-accent/60'"
                          :title="f.from ? `${f.from} → ${f.path}` : f.path"
                          @click.stop="openCommitFile(f)"
                        >
                          <span class="mono shrink-0 text-[11px] font-bold" :style="{ color: statusColor(f.status) }">{{ f.status }}</span>
                          <span class="mono min-w-0 flex-1 truncate text-[11.5px]">
                            <span class="text-foreground">{{ splitPath(f.path).name }}</span><span v-if="splitPath(f.path).dir" class="ml-1.5 text-muted-foreground/55">{{ splitPath(f.path).dir.replace(/\/+$/, "") }}</span>
                          </span>
                          <span v-if="f.adds" class="mono shrink-0 text-[10.5px] text-success">+{{ f.adds }}</span>
                          <span v-if="f.dels" class="mono shrink-0 text-[10.5px] text-destructive">−{{ f.dels }}</span>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent class="w-52">
                        <ContextMenuItem @select="openCommitFile(f)">
                          <Eye :size="15" /><span>{{ $t("repo.history.ctxOpenAtCommit") }}</span>
                        </ContextMenuItem>
                        <ContextMenuItem @select="editFile(f.path)">
                          <SquarePen :size="15" /><span>{{ $t("repo.changes.ctxEditor") }}</span>
                        </ContextMenuItem>
                        <ContextMenuItem @select="revealFile(f.path)">
                          <FolderOpen :size="15" /><span>{{ $t("repo.changes.revealAction") }}</span>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem @select="copyFilePath(f.path)">
                          <Copy :size="15" /><span>{{ $t("repo.changes.ctxCopyPath") }}</span>
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </div>
                  <div v-else class="text-[11px] text-muted-foreground">{{ $t("repo.history.noChanges") }}</div>
                  <!-- Same key + plural the worktree section's 60-file cap uses (line ~594). -->
                  <p v-if="expandedDetail.filesTotal > detailFiles.length" class="mt-1 text-[11px] text-muted-foreground">
                    {{ $t("repo.history.moreFiles", { count: expandedDetail.filesTotal - detailFiles.length }) }}
                  </p>
                </template>
                <div v-else class="text-[12px] text-muted-foreground">
                  {{ expandedDetail?.message || $t("repo.history.detailUnavailable") }}
                </div>
                    </div>
                  </div>
                </div>
              </Transition>
            </template>
          </div>
          <!-- infinite-scroll sentinel: fetch the next page as it nears view (no "Load more" button) -->
          <div
            v-if="logResult.hasMore"
            ref="sentinelEl"
            class="flex items-center justify-center gap-1.5 py-2 text-[12px] text-muted-foreground"
          >
            <Loader2 v-if="loadingLog" :size="13" class="animate-spin" />
            <span v-if="loadingLog">{{ $t("repo.history.loading") }}</span>
          </div>
        </div>
      </template>
    </div>
    </div>
    </div>
    </Transition>
  </div>
</template>

<style scoped>
/* Smooth height animation for a commit's detail expand/collapse (grid-rows technique — animates
   0fr↔1fr with no need to measure the content height; the inner min-h-0/overflow-hidden clips it). */
.expand-grid {
  display: grid;
  grid-template-rows: 1fr;
}
.expand-enter-active,
.expand-leave-active {
  transition: grid-template-rows 0.2s ease;
}
.expand-enter-from,
.expand-leave-to {
  grid-template-rows: 0fr;
}

/* Clamped commit body. max-height animates between the clamp and the measured full height;
   the fade at the bottom signals there is more text without needing an ellipsis. */
.commit-body {
  overflow: hidden;
  transition: max-height 0.24s ease;
}
.commit-body.is-clamped {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 1.2em), transparent 100%);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 1.2em), transparent 100%);
}
@media (prefers-reduced-motion: reduce) {
  .commit-body {
    transition: none;
  }
}

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
