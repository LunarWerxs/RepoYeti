<script setup lang="ts">
// A compact, dependency-free visual summary for the History panel. The backend owns the
// aggregation so this view stays correct even though the commit table itself is paginated.
// Bars show line churn (green additions + red removals); the blue line independently scales
// commit count. Exact values are always available from each keyboard-focusable
// bucket, so the small chart remains useful without turning into a dashboard of axis labels.
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from "vue";
import { useI18n } from "vue-i18n";
import {
  Clock3,
  FileDiff,
  Gauge,
  GitCommitHorizontal,
  UsersRound,
} from "@lucide/vue";
import type {
  HistoryActivity,
  HistoryActivityAuthor,
  HistoryActivityBucket,
  HistoryActivityScale,
  LogAuthorFilter,
} from "@/types";

const props = withDefaults(defineProps<{
  activity: HistoryActivity | null;
  loading: boolean;
  scale: HistoryActivityScale;
  selectedAuthor?: LogAuthorFilter | null;
}>(), {
  selectedAuthor: null,
});
const emit = defineEmits<{
  selectScale: [scale: HistoryActivityScale];
  selectAuthor: [author: HistoryActivityAuthor];
}>();
const { t, locale } = useI18n();

const CHART_W = 600;
const CHART_H = 74;
const PLOT_TOP = 8;
const BASE_Y = 64;
const PLOT_H = BASE_Y - PLOT_TOP;
const TOOLTIP_GAP = 10;
const TOOLTIP_PANEL_MARGIN = 6;
const TOOLTIP_VIEWPORT_MARGIN = 8;
const scaleOptions: HistoryActivityScale[] = ["hourly", "daily", "monthly"];

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function defaultWindowCount(scale: HistoryActivityScale): number {
  if (scale === "daily") return 30;
  if (scale === "monthly") return 12;
  return 24;
}

const resolvedScale = computed<HistoryActivityScale>(
  () => props.activity?.scale ?? props.scale,
);
const windowCount = computed(
  () =>
    safeCount(props.activity?.windowCount ?? 0) ||
    defaultWindowCount(resolvedScale.value),
);

function scaleLabel(scale: HistoryActivityScale): string {
  if (scale === "daily") return t("repo.history.activityScaleDaily");
  if (scale === "monthly") return t("repo.history.activityScaleMonthly");
  return t("repo.history.activityScaleHourly");
}

const chartTitle = computed(() => {
  if (resolvedScale.value === "daily") return t("repo.history.activityChartTitleDaily");
  if (resolvedScale.value === "monthly") return t("repo.history.activityChartTitleMonthly");
  return t("repo.history.activityChartTitleHourly");
});
const chartAriaLabel = computed(() => {
  if (resolvedScale.value === "daily") return t("repo.history.activityChartLabelDaily");
  if (resolvedScale.value === "monthly") return t("repo.history.activityChartLabelMonthly");
  return t("repo.history.activityChartLabelHourly");
});
const emptyLabel = computed(() => {
  if (resolvedScale.value === "daily") return t("repo.history.activityEmptyDaily");
  if (resolvedScale.value === "monthly") return t("repo.history.activityEmptyMonthly");
  return t("repo.history.activityEmptyHourly");
});

const compactFormatter = computed(
  () =>
    new Intl.NumberFormat(locale.value, {
      notation: "compact",
      maximumFractionDigits: 1,
    }),
);
const rateFormatter = computed(
  () =>
    new Intl.NumberFormat(locale.value, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
);

function compactCount(value: number): string {
  return compactFormatter.value.format(safeCount(value));
}

function compactRate(value: number): string {
  const n = safeCount(value);
  if (n === 0) return "0";
  return n >= 1000 ? compactCount(n) : rateFormatter.value.format(n);
}

const totalLines = computed(() => {
  const activity = props.activity;
  return activity ? safeCount(activity.addedLines) + safeCount(activity.removedLines) : 0;
});
const commitCountsPartial = computed(() => !!props.activity?.commitsTruncated);
const changeStatsPartial = computed(
  () =>
    !!(
      props.activity?.changeStatsTruncated ||
      props.activity?.commitsTruncated ||
      (props.activity?.truncated &&
        props.activity.commitsTruncated == null &&
        props.activity.changeStatsTruncated == null)
    ),
);
const truncationMessage = computed(() =>
  commitCountsPartial.value
    ? t("repo.history.activityTruncated")
    : t("repo.history.activityChangeStatsTruncated"),
);
const averageLinesPerBucket = computed(() => {
  return totalLines.value / windowCount.value;
});

function recentMetricLabel(scale: HistoryActivityScale): string {
  if (scale === "daily") return t("repo.history.activityToday");
  if (scale === "monthly") return t("repo.history.activityThisMonth");
  return t("repo.history.activityOneHour");
}

function windowMetricLabel(scale: HistoryActivityScale): string {
  if (scale === "daily") return t("repo.history.activityThirtyDays");
  if (scale === "monthly") return t("repo.history.activityTwelveMonths");
  return t("repo.history.activityTwentyFourHours");
}

function averageMetricLabel(scale: HistoryActivityScale): string {
  if (scale === "daily") return t("repo.history.activityAveragePerDay");
  if (scale === "monthly") return t("repo.history.activityAveragePerMonth");
  return t("repo.history.activityAveragePerHour");
}

// Three hues, grouped by what the metric MEASURES, not five for five tiles: commit counts, people,
// line churn. The two commit tiles are the same number over different ranges and the two churn
// tiles likewise, so giving each its own colour implied five unrelated things and cost the row any
// scannable structure. All three are the app's OWN semantic tokens — the previous purple and teal
// came from the CHART palette, which is why the row looked like it belonged to a different product.
const METRIC_COMMITS = "var(--primary)";
const METRIC_PEOPLE = "var(--info)";
const METRIC_CHURN = "var(--warning)";

const metrics = computed(() => {
  const activity = props.activity;
  if (!activity) return [];
  const scale = resolvedScale.value;
  const recentCommits =
    scale === "hourly"
      ? safeCount(activity.commitsLastHour)
      : safeCount(buckets.value.at(-1)?.commits ?? 0);
  return [
    {
      id: "recent",
      label: recentMetricLabel(scale),
      value: compactCount(recentCommits),
      exact: String(recentCommits),
      icon: Clock3,
      color: METRIC_COMMITS,
      partial: commitCountsPartial.value,
    },
    {
      id: "window",
      label: windowMetricLabel(scale),
      value: compactCount(activity.commits),
      exact: String(safeCount(activity.commits)),
      icon: GitCommitHorizontal,
      color: METRIC_COMMITS,
      partial: commitCountsPartial.value,
    },
    {
      id: "contributors",
      label: t("repo.history.activityContributors"),
      value: compactCount(activity.contributors),
      exact: String(safeCount(activity.contributors)),
      icon: UsersRound,
      color: METRIC_PEOPLE,
      partial: commitCountsPartial.value,
    },
    {
      id: "lines",
      label: t("repo.history.activityLinesChanged"),
      value: `${compactCount(totalLines.value)}${changeStatsPartial.value ? "+" : ""}`,
      exact: changeStatsPartial.value
        ? t("repo.history.activityMinimumValue", { count: totalLines.value })
        : String(totalLines.value),
      icon: FileDiff,
      color: METRIC_CHURN,
      partial: changeStatsPartial.value,
    },
    {
      id: "average",
      label: averageMetricLabel(scale),
      value: `${compactRate(averageLinesPerBucket.value)}${changeStatsPartial.value ? "+" : ""}`,
      exact: changeStatsPartial.value
        ? t("repo.history.activityMinimumValue", {
            count: rateFormatter.value.format(averageLinesPerBucket.value),
          })
        : rateFormatter.value.format(averageLinesPerBucket.value),
      icon: Gauge,
      color: METRIC_CHURN,
      partial: changeStatsPartial.value,
    },
  ];
});

function authorLabel(author: HistoryActivityAuthor): string {
  return author.name.trim() || author.email.trim() || "—";
}

function authorInitials(author: HistoryActivityAuthor): string {
  const words = authorLabel(author)
    .replace(/@.*$/, "")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "•";
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase(locale.value);
}

function authorSummary(author: HistoryActivityAuthor): string {
  const commits = safeCount(author.commits);
  return t("repo.history.activityAuthorSummary", {
    name: authorLabel(author),
    email: author.email,
    commits: t("repo.history.activityCommitCount", { count: commits }, commits),
    added: safeCount(author.addedLines),
    removed: safeCount(author.removedLines),
  });
}

function authorIdentityKey(author: Pick<HistoryActivityAuthor, "name" | "email">): string {
  const email = author.email.trim().toLowerCase();
  return email ? `email:${email}` : `name:${author.name.trim().toLowerCase()}`;
}

function isAuthorSelected(author: HistoryActivityAuthor): boolean {
  return !!props.selectedAuthor &&
    authorIdentityKey(author) === authorIdentityKey(props.selectedAuthor);
}

function authorActionLabel(author: HistoryActivityAuthor): string {
  const commits = safeCount(author.commits);
  const values = {
    name: authorLabel(author),
    commits: t("repo.history.activityCommitCount", { count: commits }, commits),
  };
  return isAuthorSelected(author)
    ? t("repo.history.activityClearAuthorFilter", values)
    : t("repo.history.activityFilterAuthor", values);
}

const sortedAuthors = computed(() =>
  [...(props.activity?.authors ?? [])].sort(
    (a, b) =>
      safeCount(b.commits) - safeCount(a.commits) ||
      safeCount(b.addedLines) +
        safeCount(b.removedLines) -
        safeCount(a.addedLines) -
        safeCount(a.removedLines) ||
      authorLabel(a).localeCompare(authorLabel(b)),
  ),
);
const shownAuthors = computed(() => sortedAuthors.value.slice(0, 5));
const hiddenAuthorCount = computed(() =>
  Math.max(
    0,
    safeCount(props.activity?.contributors ?? 0) - shownAuthors.value.length,
    sortedAuthors.value.length - shownAuthors.value.length,
  ),
);
const hiddenAuthorTitle = computed(() =>
  sortedAuthors.value
    .slice(shownAuthors.value.length)
    .map(authorLabel)
    .join(", "),
);

const buckets = computed(() =>
  [...(props.activity?.buckets ?? [])].sort((a, b) => a.start - b.start),
);

interface RenderBucket {
  bucket: HistoryActivityBucket;
  index: number;
  x: number;
  center: number;
  hitX: number;
  hitWidth: number;
  barWidth: number;
  addedY: number;
  addedHeight: number;
  removedY: number;
  removedHeight: number;
  commitY: number;
}

const renderBuckets = computed<RenderBucket[]>(() => {
  const source = buckets.value;
  if (!source.length) return [];

  const slot = CHART_W / source.length;
  const barWidth = Math.min(18, slot * 0.62);
  const maxChurn = Math.max(
    1,
    ...source.map((bucket) => safeCount(bucket.addedLines) + safeCount(bucket.removedLines)),
  );
  const maxCommits = Math.max(1, ...source.map((bucket) => safeCount(bucket.commits)));

  return source.map((bucket, index) => {
    const added = safeCount(bucket.addedLines);
    const removed = safeCount(bucket.removedLines);
    const churn = added + removed;
    // Square-root scaling keeps one generated-file commit from flattening every normal commit.
    // The split inside each bar remains proportional, while the tooltip carries exact values.
    const totalHeight = churn ? Math.max(3, Math.sqrt(churn / maxChurn) * PLOT_H) : 0;
    let addedHeight = churn ? totalHeight * (added / churn) : 0;
    let removedHeight = totalHeight - addedHeight;
    if (added > 0 && removed > 0) {
      if (addedHeight < 1) {
        addedHeight = 1;
        removedHeight = totalHeight - 1;
      } else if (removedHeight < 1) {
        removedHeight = 1;
        addedHeight = totalHeight - 1;
      }
    }
    const center = slot * index + slot / 2;

    return {
      bucket,
      index,
      x: center - barWidth / 2,
      center,
      hitX: slot * index + 1,
      hitWidth: Math.max(1, slot - 2),
      barWidth,
      addedY: BASE_Y - addedHeight,
      addedHeight,
      removedY: BASE_Y - addedHeight - removedHeight,
      removedHeight,
      commitY: BASE_Y - (safeCount(bucket.commits) / maxCommits) * PLOT_H,
    };
  });
});

const commitLinePoints = computed(() =>
  renderBuckets.value.map((item) => `${item.center},${item.commitY}`).join(" "),
);
const hasCommitLine = computed(() =>
  renderBuckets.value.some((item) => safeCount(item.bucket.commits) > 0),
);
// `until` changes on every fresh snapshot, while the totals make this robust to a test fixture or
// backend that intentionally reuses its window boundary. The key lets Vue briefly cross-fade the
// old and new SVGs instead of patching dozens of bars in one visually noisy frame.
const activityDataKey = computed(() => {
  const activity = props.activity;
  if (!activity) return "none";
  return [
    activity.scale,
    activity.since,
    activity.until,
    activity.commits,
    activity.addedLines,
    activity.removedLines,
    activity.buckets.length,
    activity.buckets
      .map(
        (bucket) =>
          `${bucket.start},${bucket.commits},${bucket.filesChanged},${bucket.addedLines},${bucket.removedLines}`,
      )
      .join(";"),
  ].join(":");
});

const dateTimeFormatter = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
);
const timeFormatter = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      hour: "numeric",
      minute: "2-digit",
    }),
);
const dayFormatter = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
);
const monthFormatter = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      year: "numeric",
      month: "long",
    }),
);

function bucketEnd(index: number): number {
  const bucket = buckets.value[index];
  if (!bucket) return 0;
  const explicitEnd =
    Number.isFinite(bucket.end) && (bucket.end ?? 0) >= bucket.start
      ? (bucket.end as number)
      : undefined;
  const next =
    explicitEnd ?? buckets.value[index + 1]?.start ?? props.activity?.until ?? bucket.start;
  const until = props.activity?.until ?? next;
  return Math.max(bucket.start, Math.min(next, until));
}

function bucketTime(index: number): string {
  const bucket = buckets.value[index];
  if (!bucket || !Number.isFinite(bucket.start)) return "—";
  if (resolvedScale.value === "daily") {
    return dayFormatter.value.format(new Date(bucket.start));
  }
  if (resolvedScale.value === "monthly") {
    return monthFormatter.value.format(new Date(bucket.start));
  }
  return `${dateTimeFormatter.value.format(new Date(bucket.start))} – ${timeFormatter.value.format(
    new Date(bucketEnd(index)),
  )}`;
}

function bucketSummary(item: RenderBucket): string {
  const commits = safeCount(item.bucket.commits);
  const files = safeCount(item.bucket.filesChanged);
  const summary = t("repo.history.activityBucketSummary", {
    time: bucketTime(item.index),
    commits: t("repo.history.activityCommitCount", { count: commits }, commits),
    files: t("repo.history.activityFileCount", { count: files }, files),
    added: safeCount(item.bucket.addedLines),
    removed: safeCount(item.bucket.removedLines),
  });
  const covered = safeCount(item.bucket.changeStatsCommits ?? commits);
  return covered < commits
    ? `${summary} · ${t("repo.history.activityBucketPartialStats", {
        covered,
        total: commits,
      })}`
    : summary;
}

const activeIndex = ref<number | null>(null);
const chartPanelEl = ref<HTMLElement | null>(null);
const chartSvgEl = ref<SVGSVGElement | null>(null);
const tooltipEl = ref<HTMLElement | null>(null);
const tooltipId = `history-activity-tooltip-${useId()}`;
const tooltipAnchorX = ref<number | null>(null);
const tooltipReady = ref(false);
const tooltipPosition = ref({
  left: 0,
  top: 0,
  placement: "top" as "top" | "bottom",
});
let tooltipPositionRequest = 0;

watch(activityDataKey, () => {
  // A focused/hovered bucket index belongs to the previous dataset. Keeping it would make the
  // tooltip jump to an unrelated day after an interval change.
  activeIndex.value = null;
  tooltipAnchorX.value = null;
  tooltipReady.value = false;
});
const activeBucket = computed(() =>
  activeIndex.value == null ? null : (renderBuckets.value[activeIndex.value] ?? null),
);
const tooltipStyle = computed(() => {
  return {
    left: `${tooltipPosition.value.left}px`,
    top: `${tooltipPosition.value.top}px`,
    maxWidth: `min(calc(100% - ${TOOLTIP_PANEL_MARGIN * 2}px), calc(100vw - ${TOOLTIP_VIEWPORT_MARGIN * 2}px))`,
  };
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function bucketAnchorX(index: number): number | null {
  const chart = chartSvgEl.value;
  const item = renderBuckets.value[index];
  if (!chart || !item) return null;
  const chartRect = chart.getBoundingClientRect();
  return chartRect.left + (item.center / CHART_W) * chartRect.width;
}

function eventClientX(event: MouseEvent | FocusEvent | undefined): number | null {
  if (!event || !("clientX" in event)) return null;
  return Number.isFinite(event.clientX) ? event.clientX : null;
}

function updateTooltipPosition(): void {
  const panel = chartPanelEl.value;
  const chart = chartSvgEl.value;
  const tooltip = tooltipEl.value;
  if (!panel || !chart || !tooltip || !activeBucket.value) return;

  const panelRect = panel.getBoundingClientRect();
  const chartRect = chart.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const tooltipWidth = tooltipRect.width || tooltip.offsetWidth;
  const tooltipHeight = tooltipRect.height || tooltip.offsetHeight;
  if (!tooltipWidth || !tooltipHeight) return;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let boundaryLeft = Math.max(
    TOOLTIP_VIEWPORT_MARGIN,
    panelRect.left + TOOLTIP_PANEL_MARGIN,
  );
  let boundaryRight = Math.min(
    viewportWidth - TOOLTIP_VIEWPORT_MARGIN,
    panelRect.right - TOOLTIP_PANEL_MARGIN,
  );
  // Very narrow or horizontally clipped cards should still keep the popup in the viewport.
  if (boundaryRight - boundaryLeft < tooltipWidth) {
    boundaryLeft = TOOLTIP_VIEWPORT_MARGIN;
    boundaryRight = viewportWidth - TOOLTIP_VIEWPORT_MARGIN;
  }

  const anchorX =
    tooltipAnchorX.value ?? bucketAnchorX(activeBucket.value.index) ?? chartRect.left;
  const maximumLeft = Math.max(boundaryLeft, boundaryRight - tooltipWidth);
  const clientLeft = clamp(
    anchorX - tooltipWidth / 2,
    boundaryLeft,
    maximumLeft,
  );

  // Keep the popup wholly outside the plot so it cannot hide the pointer, focused bucket,
  // bars, or commit line. Prefer above, then flip below near the top edge.
  const aboveTop = chartRect.top - TOOLTIP_GAP - tooltipHeight;
  const belowTop = chartRect.bottom + TOOLTIP_GAP;
  const aboveFits = aboveTop >= TOOLTIP_VIEWPORT_MARGIN;
  const belowFits =
    belowTop + tooltipHeight <= viewportHeight - TOOLTIP_VIEWPORT_MARGIN;
  let placement: "top" | "bottom";
  let clientTop: number;
  if (aboveFits || !belowFits) {
    placement = "top";
    clientTop = aboveTop;
  } else {
    placement = "bottom";
    clientTop = belowTop;
  }
  clientTop = clamp(
    clientTop,
    TOOLTIP_VIEWPORT_MARGIN,
    Math.max(TOOLTIP_VIEWPORT_MARGIN, viewportHeight - TOOLTIP_VIEWPORT_MARGIN - tooltipHeight),
  );

  tooltipPosition.value = {
    left: clientLeft - panelRect.left,
    top: clientTop - panelRect.top,
    placement,
  };
  tooltipReady.value = true;
}

async function scheduleTooltipPosition(): Promise<void> {
  const request = ++tooltipPositionRequest;
  await nextTick();
  if (request !== tooltipPositionRequest || activeIndex.value == null) return;
  updateTooltipPosition();
}

function showBucket(
  index: number,
  event?: MouseEvent | FocusEvent,
  preferPointer = false,
): void {
  const changed = activeIndex.value !== index;
  activeIndex.value = index;
  const pointerX = preferPointer ? eventClientX(event) : null;
  tooltipAnchorX.value = pointerX ?? bucketAnchorX(index);
  if (changed) tooltipReady.value = false;
  void scheduleTooltipPosition();
}

function moveBucket(index: number, event: MouseEvent): void {
  if (activeIndex.value !== index) return;
  const pointerX = eventClientX(event);
  if (pointerX == null) return;
  tooltipAnchorX.value = pointerX;
  void scheduleTooltipPosition();
}

function hideBucket(index: number): void {
  if (activeIndex.value === index) {
    activeIndex.value = null;
    tooltipAnchorX.value = null;
    tooltipReady.value = false;
    tooltipPositionRequest += 1;
  }
}

function repositionVisibleTooltip(): void {
  if (activeIndex.value != null) void scheduleTooltipPosition();
}

onMounted(() => {
  window.addEventListener("resize", repositionVisibleTooltip);
  window.addEventListener("scroll", repositionVisibleTooltip, true);
});

onBeforeUnmount(() => {
  tooltipPositionRequest += 1;
  window.removeEventListener("resize", repositionVisibleTooltip);
  window.removeEventListener("scroll", repositionVisibleTooltip, true);
});
</script>

<template>
  <section
    class="relative"
    data-testid="history-activity"
    :data-state="loading && !activity ? 'loading' : !activity ? 'empty' : !activity.ok ? 'error' : activity.commits ? 'ready' : 'empty'"
    :data-refreshing="loading && !!activity ? 'true' : 'false'"
    :aria-busy="loading"
  >
    <!-- Initial load mirrors the final geometry, avoiding a jump when the data arrives. -->
    <div v-if="loading && !activity" class="space-y-1.5">
      <span role="status" class="sr-only">{{ $t("repo.history.activityLoading") }}</span>
      <div class="grid grid-cols-5 gap-px overflow-hidden rounded-md border border-border/50 bg-border/40">
        <div v-for="n in 5" :key="n" class="bg-background/90 px-2 py-1.5">
          <div class="mx-auto h-4 w-8 animate-pulse rounded bg-muted" />
          <div class="mx-auto mt-1 h-2 w-12 animate-pulse rounded bg-muted/70" />
        </div>
      </div>
      <div class="rounded-md border border-border/50 bg-secondary/15 px-1.5 pb-1 pt-1">
        <div class="flex min-h-5 items-center gap-2 px-0.5 text-[9px] leading-none text-muted-foreground/65">
          <span class="font-medium text-muted-foreground">{{ chartTitle }}</span>
          <span class="inline-flex items-center gap-1 text-info">
            <i class="block size-1.5 animate-pulse rounded-full bg-info" aria-hidden="true" />
          </span>
          <div
            class="ml-auto inline-flex shrink-0 items-center rounded border border-border/60 bg-background/55 p-0.5"
            role="tablist"
            :aria-label="$t('repo.history.activityScaleLabel')"
            data-testid="history-activity-scale"
          >
            <button
              v-for="option in scaleOptions"
              :key="option"
              type="button"
              role="tab"
              :aria-selected="scale === option"
              :data-activity-scale="option"
              class="rounded-sm px-1.5 py-0.5 text-[8.5px] font-medium leading-none outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/60"
              :class="scale === option
                ? 'bg-primary/15 text-primary shadow-sm'
                : 'text-muted-foreground/75 hover:bg-accent/45 hover:text-foreground'"
              @click="emit('selectScale', option)"
            >
              {{ scaleLabel(option) }}
            </button>
          </div>
        </div>
        <div class="h-[74px] animate-pulse rounded bg-muted/30" />
      </div>
    </div>

    <div
      v-else-if="!activity"
      class="rounded-md border border-dashed border-border/60 bg-secondary/15 px-1.5 pb-1 pt-1 text-[11.5px] text-muted-foreground"
    >
      <div class="flex min-h-5 items-center gap-2 px-0.5 text-[9px] leading-none">
        <span class="font-medium text-muted-foreground">{{ chartTitle }}</span>
        <div
          class="ml-auto inline-flex shrink-0 items-center rounded border border-border/60 bg-background/55 p-0.5"
          role="tablist"
          :aria-label="$t('repo.history.activityScaleLabel')"
          data-testid="history-activity-scale"
        >
          <button
            v-for="option in scaleOptions"
            :key="option"
            type="button"
            role="tab"
            :aria-selected="scale === option"
            :data-activity-scale="option"
            class="rounded-sm px-1.5 py-0.5 text-[8.5px] font-medium leading-none outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/60"
            :class="scale === option
              ? 'bg-primary/15 text-primary shadow-sm'
              : 'text-muted-foreground/75 hover:bg-accent/45 hover:text-foreground'"
            @click="emit('selectScale', option)"
          >
            {{ scaleLabel(option) }}
          </button>
        </div>
      </div>
      <div role="status" class="flex h-[74px] items-center justify-center px-3">
        {{ emptyLabel }}
      </div>
    </div>

    <div
      v-else-if="!activity.ok"
      class="rounded-md border border-destructive/25 bg-destructive/5 px-1.5 pb-1 pt-1 text-[11.5px] text-destructive"
      :title="activity.message"
    >
      <div class="flex min-h-5 items-center gap-2 px-0.5 text-[9px] leading-none">
        <span class="font-medium text-destructive/80">{{ chartTitle }}</span>
        <div
          class="ml-auto inline-flex shrink-0 items-center rounded border border-border/60 bg-background/55 p-0.5"
          role="tablist"
          :aria-label="$t('repo.history.activityScaleLabel')"
          data-testid="history-activity-scale"
        >
          <button
            v-for="option in scaleOptions"
            :key="option"
            type="button"
            role="tab"
            :aria-selected="scale === option"
            :data-activity-scale="option"
            class="rounded-sm px-1.5 py-0.5 text-[8.5px] font-medium leading-none outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/60"
            :class="scale === option
              ? 'bg-primary/15 text-primary shadow-sm'
              : 'text-muted-foreground/75 hover:bg-accent/45 hover:text-foreground'"
            @click="emit('selectScale', option)"
          >
            {{ scaleLabel(option) }}
          </button>
        </div>
      </div>
      <div role="alert" class="flex min-h-12 items-center justify-center px-3 py-2">
        {{ activity.message || $t("repo.history.activityError") }}
      </div>
    </div>

    <div v-else class="space-y-1.5">
      <!-- Five glanceable answers, intentionally noun-light: the labels are short enough to
           survive the narrow repo-card layout while their title retains the exact value. -->
      <div class="grid grid-cols-5 gap-px overflow-hidden rounded-md border border-border/50 bg-border/40">
        <div
          v-for="metric in metrics"
          :key="metric.id"
          class="activity-kpi min-w-0 px-1.5 py-1.5 text-center"
          :data-activity-kpi="metric.id"
          :title="metric.exact"
          :style="{ '--metric-color': metric.color }"
        >
          <div class="flex min-w-0 items-center justify-center gap-1">
            <span
              class="activity-kpi-icon inline-flex size-4 shrink-0 items-center justify-center rounded-full"
              data-activity-kpi-icon
              aria-hidden="true"
            >
              <component :is="metric.icon" :size="10" :stroke-width="2.1" />
            </span>
            <span
              class="activity-value-slot min-w-0"
              data-activity-transition="value"
            >
              <Transition name="activity-value">
                <span
                  :key="metric.value"
                  class="mono activity-kpi-value truncate text-[13px] font-semibold leading-none tabular-nums"
                >
                  {{ metric.value }}
                </span>
              </Transition>
            </span>
            <span
              v-if="metric.partial"
              class="inline-flex size-3 shrink-0 items-center justify-center rounded-full bg-warning/12 text-[8px] font-bold text-warning"
              :title="truncationMessage"
              :aria-label="truncationMessage"
            >
              !
            </span>
          </div>
          <div
            class="activity-label-slot mt-1 min-w-0"
            data-activity-transition="label"
          >
            <Transition name="activity-label">
              <div
                :key="metric.label"
                class="truncate text-[9px] font-medium leading-none tracking-wide uppercase text-muted-foreground/70"
              >
                {{ metric.label }}
              </div>
            </Transition>
          </div>
        </div>
      </div>

      <!-- Commit counts by person: identity, contribution count, and exact churn in one hover.
           The cap keeps a many-author repository from turning the compact summary into a roster. -->
      <TransitionGroup
        v-if="shownAuthors.length"
        name="activity-author"
        tag="div"
        class="activity-authors relative flex min-w-0 items-center gap-1 overflow-hidden text-[10px]"
        data-testid="history-activity-authors"
        data-activity-transition="authors"
      >
        <span
          key="authors-label"
          class="mr-0.5 shrink-0 text-muted-foreground/65"
        >
          {{ $t("repo.history.activityTopAuthors") }}
        </span>
        <button
          v-for="author in shownAuthors"
          :key="`${author.email}\u0000${author.name}`"
          type="button"
          class="inline-flex min-w-0 shrink items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-1.5 outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring/45"
          :class="isAuthorSelected(author)
            ? 'border-info/45 bg-info/14 text-info ring-1 ring-inset ring-info/15'
            : 'border-border/50 bg-secondary/45 text-muted-foreground hover:border-info/30 hover:bg-info/8 hover:text-foreground'"
          :title="`${authorActionLabel(author)}\n${authorSummary(author)}`"
          :aria-label="authorActionLabel(author)"
          :aria-pressed="isAuthorSelected(author)"
          data-activity-author
          :data-selected="isAuthorSelected(author) ? 'true' : 'false'"
          @click="emit('selectAuthor', author)"
        >
          <span
            class="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold transition-colors"
            :class="isAuthorSelected(author)
              ? 'bg-info/20 text-info'
              : 'bg-primary/10 text-primary'"
            aria-hidden="true"
          >
            {{ authorInitials(author) }}
          </span>
          <span class="max-w-24 truncate text-foreground/80">{{ authorLabel(author) }}</span>
          <span class="activity-value-slot shrink-0">
            <Transition name="activity-value">
              <span
                :key="safeCount(author.commits)"
                class="mono tabular-nums text-info/80"
              >
                {{ safeCount(author.commits) }}
              </span>
            </Transition>
          </span>
        </button>
        <span
          v-if="hiddenAuthorCount"
          key="hidden-authors"
          class="mono shrink-0 rounded-full border border-border/50 px-1.5 py-0.5 text-muted-foreground"
          :title="hiddenAuthorTitle"
        >
          +{{ hiddenAuthorCount }}
        </span>
      </TransitionGroup>

      <div
        ref="chartPanelEl"
        class="relative overflow-visible rounded-md border border-border/50 bg-secondary/15 px-1.5 pb-1 pt-1"
        data-testid="history-activity-chart-panel"
      >
        <div class="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 px-0.5 text-[9px] leading-none text-muted-foreground/65">
          <span class="font-medium text-muted-foreground">{{ chartTitle }}</span>
          <span class="inline-flex items-center gap-1">
            <i class="block size-1.5 rounded-sm bg-success" aria-hidden="true" />
            {{ $t("repo.history.activityAdded") }}
          </span>
          <span class="inline-flex items-center gap-1">
            <i class="block size-1.5 rounded-sm bg-destructive" aria-hidden="true" />
            {{ $t("repo.history.activityRemoved") }}
          </span>
          <span class="inline-flex items-center gap-1">
            <i class="block h-px w-2 bg-info" aria-hidden="true" />
            {{ $t("repo.history.activityCommitsLegend") }}
          </span>
          <span
            v-if="activity.truncated || changeStatsPartial"
            class="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-warning/10 font-semibold text-warning"
            :title="truncationMessage"
            :aria-label="truncationMessage"
          >
            <span aria-hidden="true">!</span>
            <span class="sr-only">{{ truncationMessage }}</span>
          </span>
          <span v-if="loading" class="inline-flex items-center gap-1 text-info">
            <i class="block size-1.5 animate-pulse rounded-full bg-info" aria-hidden="true" />
            <span class="sr-only">{{ $t("repo.history.activityLoading") }}</span>
          </span>
          <div
            class="ml-auto inline-flex shrink-0 items-center rounded border border-border/60 bg-background/55 p-0.5"
            role="tablist"
            :aria-label="$t('repo.history.activityScaleLabel')"
            data-testid="history-activity-scale"
          >
            <button
              v-for="option in scaleOptions"
              :key="option"
              type="button"
              role="tab"
              :aria-selected="scale === option"
              :data-activity-scale="option"
              class="rounded-sm px-1.5 py-0.5 text-[8.5px] font-medium leading-none outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/60"
              :class="scale === option
                ? 'bg-primary/15 text-primary shadow-sm'
                : 'text-muted-foreground/75 hover:bg-accent/45 hover:text-foreground'"
              @click="emit('selectScale', option)"
            >
              {{ scaleLabel(option) }}
            </button>
          </div>
        </div>

        <div
          class="activity-chart-stage"
          data-activity-transition="chart"
        >
          <Transition name="activity-chart">
            <div
              v-if="!activity.commits"
              :key="`empty:${activityDataKey}`"
              role="status"
              class="flex h-[74px] items-center justify-center text-[11px] text-muted-foreground"
            >
              {{ emptyLabel }}
            </div>

            <svg
              v-else
              ref="chartSvgEl"
              :key="`chart:${activityDataKey}`"
              class="block h-[74px] w-full overflow-visible"
              :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
              preserveAspectRatio="none"
              role="group"
              :aria-label="chartAriaLabel"
              data-testid="history-activity-chart"
            >
          <line
            x1="0"
            :x2="CHART_W"
            :y1="PLOT_TOP + PLOT_H / 2"
            :y2="PLOT_TOP + PLOT_H / 2"
            stroke="var(--border)"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
            opacity="0.45"
          />
          <line
            x1="0"
            :x2="CHART_W"
            :y1="BASE_Y"
            :y2="BASE_Y"
            stroke="var(--border)"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />

          <g
            v-for="item in renderBuckets"
            :key="item.bucket.start"
            class="activity-bucket outline-none"
            role="button"
            tabindex="0"
             :aria-label="bucketSummary(item)"
             :aria-describedby="activeIndex === item.index ? tooltipId : undefined"
             :data-activity-bucket="item.index"
             @mouseenter="showBucket(item.index, $event, true)"
             @mousemove="moveBucket(item.index, $event)"
             @mouseleave="hideBucket(item.index)"
             @focus="showBucket(item.index, $event)"
             @blur="hideBucket(item.index)"
             @click="showBucket(item.index, $event, true)"
             @keydown.enter.prevent="showBucket(item.index)"
             @keydown.space.prevent="showBucket(item.index)"
             @keydown.escape.prevent="hideBucket(item.index)"
          >
            <rect
              v-if="item.addedHeight"
              :x="item.x"
              :y="item.addedY"
              :width="item.barWidth"
              :height="item.addedHeight"
              rx="1.25"
              fill="var(--success)"
              opacity="0.82"
              data-series="added"
            />
            <rect
              v-if="item.removedHeight"
              :x="item.x"
              :y="item.removedY"
              :width="item.barWidth"
              :height="item.removedHeight"
              rx="1.25"
              fill="var(--destructive)"
              opacity="0.82"
              data-series="removed"
            />
            <!-- Transparent full-height target: even a zero-change bucket can be focused to learn
                 that it contained a metadata-only/merge commit. -->
            <rect
              class="activity-hit"
              :x="item.hitX"
              y="1"
              :width="item.hitWidth"
              :height="CHART_H - 2"
              rx="2"
              fill="transparent"
              stroke="transparent"
              vector-effect="non-scaling-stroke"
            />
          </g>

          <polyline
            v-if="hasCommitLine"
            :points="commitLinePoints"
            fill="none"
            stroke="var(--info)"
            stroke-width="1.5"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
            opacity="0.9"
            pointer-events="none"
            data-series="commits"
          />
          <circle
            v-for="item in hasCommitLine ? renderBuckets : []"
            :key="`commit-${item.bucket.start}`"
            :cx="item.center"
            :cy="item.commitY"
            r="1.7"
            fill="var(--info)"
            stroke="var(--background)"
            stroke-width="0.8"
            vector-effect="non-scaling-stroke"
            opacity="0.95"
            pointer-events="none"
            aria-hidden="true"
          />
            </svg>
          </Transition>
        </div>

        <div
          v-if="activeBucket"
          :id="tooltipId"
          ref="tooltipEl"
          role="tooltip"
          class="activity-tooltip pointer-events-none absolute z-10 w-max rounded-md border border-border/80 bg-popover/95 px-2 py-1.5 text-[10.5px] leading-snug text-popover-foreground shadow-lg backdrop-blur"
          :class="tooltipReady ? 'activity-tooltip-ready' : 'activity-tooltip-pending'"
          :style="tooltipStyle"
          :data-placement="tooltipPosition.placement"
          data-testid="history-activity-tooltip"
        >
          <div
            class="mb-1 font-semibold text-popover-foreground"
            data-activity-tooltip-date
          >
            {{ bucketTime(activeBucket.index) }}
          </div>
          <div class="flex flex-wrap items-center gap-1">
            <span
              class="activity-tooltip-metric inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium"
              style="--tooltip-color: var(--info)"
              data-activity-tooltip-metric="commits"
            >
              <GitCommitHorizontal
                :size="10"
                :stroke-width="2.2"
                class="activity-tooltip-icon"
                aria-hidden="true"
              />
              {{
                $t(
                  "repo.history.activityCommitCount",
                  { count: safeCount(activeBucket.bucket.commits) },
                  safeCount(activeBucket.bucket.commits),
                )
              }}
            </span>
            <span
              class="activity-tooltip-metric inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium"
              style="--tooltip-color: var(--warning)"
              data-activity-tooltip-metric="files"
            >
              <FileDiff
                :size="10"
                :stroke-width="2.2"
                class="activity-tooltip-icon"
                aria-hidden="true"
              />
              {{
                $t(
                  "repo.history.activityFileCount",
                  { count: safeCount(activeBucket.bucket.filesChanged) },
                  safeCount(activeBucket.bucket.filesChanged),
                )
              }}
            </span>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-1">
            <span
              class="activity-tooltip-metric rounded border px-1.5 py-0.5 font-semibold"
              style="--tooltip-color: var(--success)"
              data-activity-tooltip-metric="added"
            >
              +{{ safeCount(activeBucket.bucket.addedLines) }}
              <span class="activity-tooltip-label font-medium">
                {{ $t("repo.history.activityAdded") }}
              </span>
            </span>
            <span
              class="activity-tooltip-metric rounded border px-1.5 py-0.5 font-semibold"
              style="--tooltip-color: var(--destructive)"
              data-activity-tooltip-metric="removed"
            >
              −{{ safeCount(activeBucket.bucket.removedLines) }}
              <span class="activity-tooltip-label font-medium">
                {{ $t("repo.history.activityRemoved") }}
              </span>
            </span>
          </div>
          <div
            v-if="safeCount(activeBucket.bucket.changeStatsCommits ?? activeBucket.bucket.commits) < safeCount(activeBucket.bucket.commits)"
            class="mt-1 border-t border-border/70 pt-1 text-[9px] text-muted-foreground"
            data-activity-tooltip-coverage
          >
            {{
              $t("repo.history.activityBucketPartialStats", {
                covered: safeCount(
                  activeBucket.bucket.changeStatsCommits ?? activeBucket.bucket.commits,
                ),
                total: safeCount(activeBucket.bucket.commits),
              })
            }}
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.activity-tooltip {
  opacity: 0;
  transition: opacity 90ms ease;
}

.activity-tooltip-ready {
  opacity: 1;
}

.activity-tooltip-pending {
  visibility: hidden;
}

.activity-tooltip-metric {
  color: color-mix(in oklab, var(--popover-foreground) 78%, var(--tooltip-color));
  border-color: color-mix(in oklab, var(--tooltip-color) 28%, var(--border));
  background: color-mix(in oklab, var(--tooltip-color) 11%, var(--popover));
}

.activity-tooltip-icon {
  color: color-mix(in oklab, var(--tooltip-color) 72%, var(--popover-foreground));
}

.activity-tooltip-label {
  color: color-mix(in oklab, var(--popover-foreground) 88%, var(--tooltip-color));
}

/*
 * FLAT, and mostly neutral. These five tiles used to be vertical gradients washed in per-metric
 * colour, with the big number tinted to match: four saturated hues (blue / green / purple / amber)
 * stacked in a row, which read as the loudest thing on the card and was the only gradient anywhere
 * in the app. Nothing else here paints that way — the rest of the UI states colour as a flat
 * `bg-x/10` tint over a border.
 *
 * So the surface is now one flat step off the card and the VALUE is plain foreground. The metric's
 * hue survives in exactly one place, the 16px icon chip, which is enough to tell the tiles apart at
 * a glance without any of them competing with the number it labels.
 */
.activity-kpi {
  background: color-mix(in oklab, var(--background) 97%, var(--metric-color));
  border: 1px solid color-mix(in oklab, var(--metric-color) 12%, var(--border));
  transition:
    background-color 140ms ease,
    border-color 140ms ease;
}

.activity-kpi:hover {
  background: color-mix(in oklab, var(--background) 93%, var(--metric-color));
  border-color: color-mix(in oklab, var(--metric-color) 24%, var(--border));
}

.activity-kpi-icon {
  color: color-mix(in oklab, var(--metric-color) 70%, var(--muted-foreground));
  background: color-mix(in oklab, var(--metric-color) 10%, transparent);
}

.activity-kpi-value {
  color: var(--foreground);
}

.activity-value-slot,
.activity-label-slot {
  display: grid;
}

.activity-value-slot > *,
.activity-label-slot > * {
  grid-area: 1 / 1;
}

.activity-value-enter-active,
.activity-value-leave-active,
.activity-label-enter-active,
.activity-label-leave-active {
  transition:
    opacity 140ms ease,
    transform 140ms ease;
}

.activity-value-enter-from,
.activity-label-enter-from {
  opacity: 0;
  transform: translateY(3px);
}

.activity-value-leave-to,
.activity-label-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}

.activity-author-enter-active,
.activity-author-leave-active,
.activity-author-move {
  transition:
    opacity 170ms ease,
    transform 190ms ease;
}

.activity-author-enter-from,
.activity-author-leave-to {
  opacity: 0;
  transform: translateY(3px) scale(0.96);
}

.activity-author-leave-active {
  position: absolute;
}

.activity-chart-stage {
  display: grid;
  height: 74px;
}

.activity-chart-stage > * {
  grid-area: 1 / 1;
}

.activity-chart-enter-active,
.activity-chart-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}

.activity-chart-enter-from {
  opacity: 0;
  transform: translateY(2px);
}

.activity-chart-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}

.activity-bucket:focus-visible .activity-hit {
  stroke: var(--ring);
  stroke-width: 1.5;
}

@media (prefers-reduced-motion: reduce) {
  .activity-kpi,
  .activity-value-enter-active,
  .activity-value-leave-active,
  .activity-label-enter-active,
  .activity-label-leave-active,
  .activity-author-enter-active,
  .activity-author-leave-active,
  .activity-author-move,
  .activity-chart-enter-active,
  .activity-chart-leave-active,
  .activity-tooltip {
    transition: none;
  }

  .animate-pulse {
    animation: none;
  }
}
</style>
