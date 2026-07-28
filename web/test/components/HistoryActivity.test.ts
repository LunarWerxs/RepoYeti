import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import HistoryActivityView from "@/components/HistoryActivity.vue";
import type { HistoryActivity, HistoryActivityScale, LogAuthorFilter } from "@/types";

const messages = {
  en: {
    repo: {
      history: {
        activityOneHour: "1h commits",
        activityTwentyFourHours: "24h commits",
        activityToday: "Today commits",
        activityThirtyDays: "30d commits",
        activityThisMonth: "This month commits",
        activityTwelveMonths: "12mo commits",
        activityContributors: "People",
        activityLinesChanged: "Lines changed",
        activityAveragePerHour: "Avg lines/hour",
        activityAveragePerDay: "Avg lines/day",
        activityAveragePerMonth: "Avg lines/month",
        activityTopAuthors: "By person",
        activityLoading: "Loading activity",
        activityEmptyHourly: "No commits in the last 24 hours",
        activityEmptyDaily: "No commits in the last 30 days",
        activityEmptyMonthly: "No commits in the last 12 months",
        activityError: "Activity is unavailable",
        activityTruncated: "Partial",
        activityChangeStatsTruncated: "Line totals partial; commits exact",
        activityMinimumValue: "At least {count}",
        activityScaleLabel: "Activity interval",
        activityScaleHourly: "Hourly",
        activityScaleDaily: "Daily",
        activityScaleMonthly: "Monthly",
        activityChartTitleHourly: "Hourly activity",
        activityChartTitleDaily: "Daily activity",
        activityChartTitleMonthly: "Monthly activity",
        activityAdded: "Added",
        activityRemoved: "Removed",
        activityCommitsLegend: "Commits",
        activityChartLabelHourly: "Hourly activity over 24 hours",
        activityChartLabelDaily: "Daily activity over 30 days",
        activityChartLabelMonthly: "Monthly activity over 12 months",
        activityCommitCount: "{count} commit | {count} commits",
        activityFileCount: "{count} file | {count} files",
        activityBucketPartialStats: "line stats cover {covered} of {total} commits",
        activityAuthorSummary:
          "{name} ({email}) · {commits} · +{added} −{removed}",
        activityFilterAuthor:
          "Show only History commits by {name}; {commits} in this activity range",
        activityClearAuthorFilter:
          "Clear History author filter for {name}; {commits} in this activity range",
        activityBucketSummary:
          "{time} · {commits} · {files} · +{added} −{removed}",
      },
    },
  },
};

const start = Date.UTC(2026, 6, 23, 18);

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockTooltipGeometry({
  panel = domRect(100, 200, 600, 100),
  chart = domRect(106, 226, 588, 74),
  tooltip = domRect(0, 0, 230, 68),
  viewportWidth = 800,
  viewportHeight = 600,
} = {}) {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewportWidth);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(viewportHeight);
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    const element = this as Element;
    if (element.getAttribute("data-testid") === "history-activity-chart-panel") return panel;
    if (element.getAttribute("data-testid") === "history-activity-chart") return chart;
    if (element.getAttribute("data-testid") === "history-activity-tooltip") return tooltip;
    return domRect(0, 0, 0, 0);
  });
}

function makeActivity(overrides: Partial<HistoryActivity> = {}): HistoryActivity {
  return {
    ok: true,
    code: "OK",
    scale: "hourly",
    bucketUnit: "hour",
    windowCount: 24,
    windowHours: 24,
    since: start,
    until: start + 24 * 60 * 60 * 1000,
    commits: 8,
    commitsLastHour: 2,
    contributors: 3,
    filesChanged: 17,
    addedLines: 120,
    removedLines: 48,
    authors: [
      { name: "Ada Lovelace", email: "ada@example.test", commits: 3, addedLines: 30, removedLines: 8 },
      { name: "Grace Hopper", email: "grace@example.test", commits: 5, addedLines: 90, removedLines: 40 },
    ],
    buckets: Array.from({ length: 24 }, (_, index) => ({
      start: start + index * 60 * 60 * 1000,
      end: start + (index + 1) * 60 * 60 * 1000,
      commits: index === 10 ? 3 : index === 23 ? 2 : 0,
      filesChanged: index === 10 ? 5 : index === 23 ? 4 : 0,
      addedLines: index === 10 ? 120 : 0,
      removedLines: index === 10 ? 30 : index === 23 ? 18 : 0,
    })),
    truncated: false,
    commitsTruncated: false,
    changeStatsTruncated: false,
    ...overrides,
  };
}

function render(props: {
  activity: HistoryActivity | null;
  loading?: boolean;
  scale?: HistoryActivityScale;
  selectedAuthor?: LogAuthorFilter | null;
}) {
  const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages,
  });
  return mount(HistoryActivityView, {
    props: { loading: false, scale: "hourly", ...props },
    global: { plugins: [i18n] },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HistoryActivity.vue", () => {
  it("renders all five KPIs and orders author chips by commit count", () => {
    const wrapper = render({ activity: makeActivity() });

    expect(wrapper.get('[data-activity-kpi="recent"] .activity-kpi-value').text()).toBe("2");
    expect(wrapper.get('[data-activity-kpi="window"] .activity-kpi-value').text()).toBe("8");
    expect(wrapper.get('[data-activity-kpi="contributors"] .activity-kpi-value').text()).toBe("3");
    expect(wrapper.get('[data-activity-kpi="lines"] .activity-kpi-value').text()).toBe("168");
    // (120 additions + 48 removals) / 24 hours.
    expect(wrapper.get('[data-activity-kpi="average"] .activity-kpi-value').text()).toBe("7.0");

    const kpis = wrapper.findAll("[data-activity-kpi]");
    expect(kpis).toHaveLength(5);
    expect(kpis.every((kpi) => kpi.find("[data-activity-kpi-icon]").exists())).toBe(true);
    // THREE hues across five tiles, on purpose: the metrics group into commits / people / churn,
    // and one colour per tile implied five unrelated things while costing the row any structure.
    // Asserting the grouping, not just the count, so a future "let's give each its own colour"
    // has to argue with this test.
    const hueOf = (i: number) => kpis[i]!.attributes("style");
    expect(new Set(kpis.map((kpi) => kpi.attributes("style"))).size).toBe(3);
    expect(hueOf(0)).toBe(hueOf(1)); // recent + window are both commit counts
    expect(hueOf(3)).toBe(hueOf(4)); // lines + average are both line churn
    expect(hueOf(2)).not.toBe(hueOf(0)); // contributors stands apart

    const authors = wrapper.findAll("[data-activity-author]");
    expect(authors).toHaveLength(2);
    expect(authors[0]!.text()).toContain("Grace Hopper");
    expect(authors[0]!.text()).toContain("5");
    expect(authors[1]!.text()).toContain("Ada Lovelace");
  });

  it("exposes author chips as accessible pressed toggles and emits the exact identity", async () => {
    const wrapper = render({ activity: makeActivity() });
    const grace = wrapper.findAll<HTMLButtonElement>("[data-activity-author]")[0]!;

    expect(grace.element.tagName).toBe("BUTTON");
    expect(grace.attributes("type")).toBe("button");
    expect(grace.attributes("aria-pressed")).toBe("false");
    expect(grace.attributes("aria-label")).toContain(
      "Show only History commits by Grace Hopper",
    );
    expect(grace.attributes("aria-label")).toContain("5 commits");

    await grace.trigger("click");
    expect(wrapper.emitted("selectAuthor")).toEqual([
      [
        {
          name: "Grace Hopper",
          email: "grace@example.test",
          commits: 5,
          addedLines: 90,
          removedLines: 40,
        },
      ],
    ]);

    await wrapper.setProps({
      selectedAuthor: { name: "Grace Hopper", email: "GRACE@example.test" },
    });
    expect(grace.attributes("aria-pressed")).toBe("true");
    expect(grace.attributes("data-selected")).toBe("true");
    expect(grace.attributes("aria-label")).toContain(
      "Clear History author filter for Grace Hopper",
    );
  });

  it("keeps a completed snapshot mounted during refresh with stable transition hooks", () => {
    const wrapper = render({
      activity: makeActivity(),
      loading: true,
      // The selected tab may already point at the replacement request while the rendered data
      // remains the last complete hourly snapshot.
      scale: "daily",
    });
    const activity = wrapper.get('[data-testid="history-activity"]');

    expect(activity.attributes("data-state")).toBe("ready");
    expect(activity.attributes("data-refreshing")).toBe("true");
    expect(activity.attributes("aria-busy")).toBe("true");
    expect(activity.get('[data-activity-kpi="window"] .activity-kpi-value').text()).toBe("8");
    expect(activity.get('[data-testid="history-activity-chart"]').exists()).toBe(true);
    expect(activity.get('[data-activity-scale="daily"]').attributes("aria-selected")).toBe("true");
    expect(activity.findAll('[data-activity-transition="value"]')).toHaveLength(5);
    expect(activity.findAll('[data-activity-transition="label"]')).toHaveLength(5);
    expect(activity.get('[data-activity-transition="authors"]').exists()).toBe(true);
    expect(activity.get('[data-activity-transition="chart"]').exists()).toBe(true);
  });

  it("draws stacked line-change bars and a commit line, with exact focus details", async () => {
    const wrapper = render({ activity: makeActivity() });

    expect(wrapper.findAll('[data-series="added"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-series="removed"]')).toHaveLength(2);
    expect(wrapper.get('[data-series="commits"]').attributes("points")).not.toBe("");

    await wrapper.get('[data-activity-bucket="10"]').trigger("focus");
    const tooltip = wrapper.get('[data-testid="history-activity-tooltip"]');
    expect(tooltip.text()).toContain("3 commits");
    expect(tooltip.text()).toContain("5 files");
    expect(tooltip.text()).toContain("+120");
    expect(tooltip.text()).toContain("−30");
    const tooltipMetrics = {
      commits: "--tooltip-color: var(--info)",
      files: "--tooltip-color: var(--warning)",
      added: "--tooltip-color: var(--success)",
      removed: "--tooltip-color: var(--destructive)",
    };
    for (const [metric, color] of Object.entries(tooltipMetrics)) {
      const pill = tooltip.get(`[data-activity-tooltip-metric="${metric}"]`);
      expect(pill.classes()).toContain("activity-tooltip-metric");
      expect(pill.attributes("style")).toContain(color);
    }
    expect(tooltip.find("[data-activity-tooltip-coverage]").exists()).toBe(false);

    await wrapper.get('[data-activity-bucket="10"]').trigger("blur");
    expect(wrapper.find('[data-testid="history-activity-tooltip"]').exists()).toBe(false);
  });

  it("keeps the hover tooltip outside the plot and clamps it at both chart edges", async () => {
    mockTooltipGeometry();
    const wrapper = render({ activity: makeActivity() });
    const firstBucket = wrapper.get('[data-activity-bucket="0"]');

    await firstBucket.trigger("mouseenter", { clientX: 108, clientY: 250 });
    const firstTooltip = wrapper.get('[data-testid="history-activity-tooltip"]');
    expect(firstTooltip.attributes("data-placement")).toBe("top");
    expect(firstTooltip.attributes("style")).toContain("left: 6px");
    expect(firstTooltip.attributes("style")).toContain("top: -52px");
    expect(firstTooltip.classes()).toContain("activity-tooltip-ready");
    expect(firstBucket.attributes("aria-describedby")).toBe(firstTooltip.attributes("id"));

    await wrapper
      .get('[data-activity-bucket="23"]')
      .trigger("mouseenter", { clientX: 692, clientY: 250 });
    const lastTooltip = wrapper.get('[data-testid="history-activity-tooltip"]');
    expect(lastTooltip.attributes("style")).toContain("left: 364px");
    // The entire 230px popup remains inside the 600px panel with a 6px inset.
    expect(Number.parseFloat(lastTooltip.attributes("style").match(/left: ([\d.-]+)px/)?.[1] ?? "") + 230)
      .toBeLessThanOrEqual(594);
  });

  it("flips below the plot near the viewport top and positions keyboard/touch activation", async () => {
    mockTooltipGeometry({
      panel: domRect(20, 0, 600, 100),
      chart: domRect(26, 4, 588, 74),
      tooltip: domRect(0, 0, 220, 60),
      viewportWidth: 660,
      viewportHeight: 240,
    });
    const wrapper = render({ activity: makeActivity() });
    const keyboardBucket = wrapper.get('[data-activity-bucket="10"]');

    await keyboardBucket.trigger("focus");
    let tooltip = wrapper.get('[data-testid="history-activity-tooltip"]');
    expect(tooltip.attributes("data-placement")).toBe("bottom");
    expect(tooltip.attributes("style")).toContain("top: 88px");
    expect(keyboardBucket.attributes("aria-describedby")).toBe(tooltip.attributes("id"));

    await keyboardBucket.trigger("blur");
    expect(wrapper.find('[data-testid="history-activity-tooltip"]').exists()).toBe(false);

    const touchBucket = wrapper.get('[data-activity-bucket="0"]');
    await touchBucket.trigger("click", { clientX: 28, clientY: 40 });
    tooltip = wrapper.get('[data-testid="history-activity-tooltip"]');
    expect(tooltip.attributes("data-placement")).toBe("bottom");
    expect(tooltip.attributes("style")).toContain("left: 6px");
  });

  it("switches ranges and adapts daily metrics, labels, and bucket dates", async () => {
    const day = 24 * 60 * 60 * 1000;
    const dailyStart = new Date(2026, 6, 23).getTime();
    const dailyBuckets = Array.from({ length: 30 }, (_, index) => ({
      start: dailyStart + index * day,
      end: dailyStart + (index + 1) * day,
      commits: index === 29 ? 6 : 0,
      filesChanged: index === 29 ? 4 : 0,
      addedLines: index === 29 ? 120 : 0,
      removedLines: index === 29 ? 48 : 0,
    }));
    const wrapper = render({
      scale: "daily",
      activity: makeActivity({
        scale: "daily",
        bucketUnit: "day",
        windowCount: 30,
        windowHours: 30 * 24,
        since: dailyStart,
        until: dailyStart + 30 * day,
        commits: 23,
        buckets: dailyBuckets,
      }),
    });

    const scaleTabs = wrapper.findAll("[data-activity-scale]");
    expect(scaleTabs).toHaveLength(3);
    expect(wrapper.get('[data-activity-scale="daily"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.get('[data-activity-kpi="recent"]').text()).toContain("Today commits");
    expect(wrapper.get('[data-activity-kpi="recent"] .activity-kpi-value').text()).toBe("6");
    expect(wrapper.get('[data-activity-kpi="window"]').text()).toContain("30d commits");
    expect(wrapper.get('[data-activity-kpi="average"]').text()).toContain("Avg lines/day");
    expect(wrapper.get('[data-activity-kpi="average"] .activity-kpi-value').text()).toBe("5.6");
    expect(wrapper.text()).toContain("Daily activity");
    expect(wrapper.get('[data-testid="history-activity-chart"]').attributes("aria-label")).toBe(
      "Daily activity over 30 days",
    );

    await wrapper.get('[data-activity-bucket="29"]').trigger("focus");
    expect(wrapper.get('[data-testid="history-activity-tooltip"]').text()).toContain("Aug 21, 2026");

    await wrapper.get('[data-activity-scale="monthly"]').trigger("click");
    expect(wrapper.emitted("selectScale")).toEqual([["monthly"]]);
  });

  it("formats a monthly bucket as a calendar month", async () => {
    const wrapper = render({
      scale: "monthly",
      activity: makeActivity({
        scale: "monthly",
        bucketUnit: "month",
        windowCount: 12,
        windowHours: 365 * 24,
        buckets: [
          {
            start: new Date(2026, 0, 1).getTime(),
            end: new Date(2026, 1, 1).getTime(),
            commits: 1,
            filesChanged: 1,
            addedLines: 4,
            removedLines: 0,
          },
        ],
      }),
    });

    await wrapper.get('[data-activity-bucket="0"]').trigger("focus");
    expect(wrapper.get('[data-testid="history-activity-tooltip"]').text()).toContain(
      "January 2026",
    );
  });

  it("uses singular commit and file labels when a bucket contains one of each", async () => {
    const wrapper = render({
      activity: makeActivity({
        authors: [
          {
            name: "Solo Coder",
            email: "solo@example.test",
            commits: 1,
            addedLines: 4,
            removedLines: 2,
          },
        ],
        buckets: [
          {
            start,
            commits: 1,
            filesChanged: 1,
            addedLines: 4,
            removedLines: 2,
          },
        ],
      }),
    });

    await wrapper.get('[data-activity-bucket="0"]').trigger("focus");
    const tooltip = wrapper.get('[data-testid="history-activity-tooltip"]').text();
    expect(tooltip).toContain("1 commit");
    expect(tooltip).toContain("1 file");
    expect(tooltip).not.toContain("1 commits");
    expect(tooltip).not.toContain("1 files");
    const authorTitle = wrapper.get("[data-activity-author]").attributes("title");
    expect(authorTitle).toContain("1 commit");
    expect(authorTitle).not.toContain("1 commits");
  });

  it("keeps loading, empty, and error states compact and explicit", () => {
    const loading = render({ activity: null, loading: true });
    expect(loading.get('[data-testid="history-activity"]').attributes("data-state")).toBe("loading");
    expect(loading.text()).toContain("Loading activity");
    expect(loading.findAll("[data-activity-scale]")).toHaveLength(3);

    const empty = render({
      activity: makeActivity({
        commits: 0,
        commitsLastHour: 0,
        contributors: 0,
        filesChanged: 0,
        addedLines: 0,
        removedLines: 0,
        authors: [],
        buckets: [],
      }),
    });
    expect(empty.get('[data-testid="history-activity"]').attributes("data-state")).toBe("empty");
    expect(empty.text()).toContain("No commits in the last 24 hours");
    expect(empty.findAll("[data-activity-scale]")).toHaveLength(3);

    const error = render({
      activity: makeActivity({ ok: false, code: "GIT_FAILED", message: "History unavailable" }),
    });
    expect(error.get('[data-testid="history-activity"]').attributes("data-state")).toBe("error");
    expect(error.text()).toContain("History unavailable");
    expect(error.findAll("[data-activity-scale]")).toHaveLength(3);
  });

  it("lets the owner select another range while loading or after an error", async () => {
    const loading = render({ activity: null, loading: true, scale: "daily" });
    expect(loading.get('[data-activity-scale="daily"]').attributes("aria-selected")).toBe("true");
    await loading.get('[data-activity-scale="monthly"]').trigger("click");
    expect(loading.emitted("selectScale")).toEqual([["monthly"]]);

    const error = render({
      activity: makeActivity({
        ok: false,
        code: "GIT_FAILED",
        message: "History unavailable",
        scale: "monthly",
      }),
      scale: "monthly",
    });
    await error.get('[data-activity-scale="hourly"]').trigger("click");
    expect(error.emitted("selectScale")).toEqual([["hourly"]]);
  });

  it("renders sampled change bars across the full Daily range", async () => {
    const day = 24 * 60 * 60 * 1000;
    const dailyStart = new Date(2026, 6, 1).getTime();
    const activeBuckets = new Set([0, 14, 29]);
    const buckets = Array.from({ length: 30 }, (_, index) => ({
      start: dailyStart + index * day,
      end: dailyStart + (index + 1) * day,
      commits: activeBuckets.has(index) ? 2 : 0,
      filesChanged: activeBuckets.has(index) ? 1 : 0,
      addedLines: activeBuckets.has(index) ? 10 + index : 0,
      removedLines: activeBuckets.has(index) ? 2 : 0,
      changeStatsCommits: activeBuckets.has(index) ? 1 : 0,
    }));
    const wrapper = render({
      scale: "daily",
      activity: makeActivity({
        scale: "daily",
        bucketUnit: "day",
        windowCount: 30,
        windowHours: 30 * 24,
        since: dailyStart,
        until: dailyStart + 30 * day,
        commits: 6,
        buckets,
        truncated: true,
        changeStatsTruncated: true,
      }),
    });

    for (const index of activeBuckets) {
      expect(
        wrapper.get(`[data-activity-bucket="${index}"]`).find('[data-series="added"]').exists(),
      ).toBe(true);
    }
    expect(wrapper.get('[data-series="commits"]').attributes("points")).not.toBe("");
    await wrapper.get('[data-activity-bucket="0"]').trigger("focus");
    const tooltip = wrapper.get('[data-testid="history-activity-tooltip"]');
    expect(tooltip.text()).toContain(
      "line stats cover 1 of 2 commits",
    );
    expect(tooltip.get("[data-activity-tooltip-coverage]").classes()).toContain(
      "text-muted-foreground",
    );
  });

  it("marks partial line statistics without implying commit totals are partial", async () => {
    const activity = makeActivity({ truncated: true, changeStatsTruncated: true });
    activity.buckets[10] = {
      ...activity.buckets[10]!,
      changeStatsCommits: 1,
    };
    const wrapper = render({
      activity,
    });
    expect(wrapper.get('[data-testid="history-activity"]').attributes("data-state")).toBe("ready");
    expect(wrapper.get('[data-activity-kpi="window"] .activity-kpi-value').text()).toBe("8");
    expect(wrapper.get('[data-activity-kpi="lines"] .activity-kpi-value').text()).toBe("168+");
    expect(wrapper.get('[data-activity-kpi="average"] .activity-kpi-value').text()).toBe("7.0+");
    expect(wrapper.text()).toContain("!");
    expect(wrapper.get('[aria-label="Line totals partial; commits exact"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="history-activity-chart"]').exists()).toBe(true);
    await wrapper.get('[data-activity-bucket="10"]').trigger("focus");
    expect(wrapper.get('[data-testid="history-activity-tooltip"]').text()).toContain(
      "line stats cover 1 of 3 commits",
    );
  });
});
