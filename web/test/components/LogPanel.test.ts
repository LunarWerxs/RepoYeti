// Covers audit finding #20: LogPanel's per-commit detail cache. Tapping a commit fetches
// api.commitDetail once; collapsing and re-expanding the SAME commit must be a cache hit (no
// second fetch); a DIFFERENT commit must still fetch.

import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import DiffBar from "@/components/DiffBar.vue";
import LogPanel from "@/components/LogPanel.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { fileViewer } from "@/lib/file-viewer";
import {
  historyActivityEnabled,
  historyActivityScale,
  historyChangesDisplay,
  historyGraphEnabled,
} from "@/lib/history-appearance";
import { historyFilesView } from "@/lib/history-view";
import { useStore } from "@/store";
import type { CommitDetail, HistoryActivity, LogResult } from "@/types";

// CommitFilesTree resolves per-file glyphs via @/lib/file-icons, which imports ~icons/* virtual
// modules (unplugin-icons) — a plugin the test pipeline deliberately omits (see vitest.config.ts).
// Stub the lookup with a bare <span>; the tests assert structure and behavior, not glyphs.
vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

const repoId = "repo-1";
enableAutoUnmount(afterEach);

function detailFor(hash: string): CommitDetail {
  return {
    ok: true,
    code: "OK",
    hash,
    shortHash: hash.slice(0, 7),
    subject: "s",
    body: "",
    authorName: "a",
    authorEmail: "e",
    date: 0,
    parents: [],
    isMerge: false,
    committerName: "a",
    committerEmail: "e",
    committerDate: 0,
    files: [],
    filesTotal: 0,
  };
}

// A LogEntry as the graph view needs it (parents/isMerge/refs drive the DAG). Each commit row is
// a non-interactive group with a real disclosure button, so independent row controls never nest.
function entry(hash: string, subject: string) {
  return { hash, shortHash: hash.slice(0, 7), subject, authorName: "a", authorEmail: "e", date: 0, refs: "", parents: [], isMerge: false };
}

function activitySummary(): HistoryActivity {
  const until = Date.now();
  return {
    ok: true,
    code: "OK",
    scale: "hourly",
    bucketUnit: "hour",
    windowCount: 24,
    windowHours: 24,
    since: until - 24 * 60 * 60 * 1000,
    until,
    commits: 3,
    commitsLastHour: 1,
    contributors: 2,
    filesChanged: 7,
    addedLines: 120,
    removedLines: 24,
    authors: [
      { name: "Ada", email: "ada@example.com", commits: 2, addedLines: 100, removedLines: 20 },
      { name: "Sam", email: "sam@example.com", commits: 1, addedLines: 20, removedLines: 4 },
    ],
    buckets: Array.from({ length: 24 }, (_, i) => ({
      start: until - (24 - i) * 60 * 60 * 1000,
      end: until - (23 - i) * 60 * 60 * 1000,
      commits: i === 23 ? 1 : 0,
      filesChanged: i === 23 ? 2 : 0,
      addedLines: i === 23 ? 12 : 0,
      removedLines: i === 23 ? 3 : 0,
    })),
    truncated: false,
    commitsTruncated: false,
    changeStatsTruncated: false,
  };
}

describe("LogPanel.vue", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    historyActivityEnabled.value = false;
    historyActivityScale.value = "hourly";
    historyGraphEnabled.value = true;
    historyChangesDisplay.value = "numbers";
    vi.spyOn(api, "historyActivity").mockResolvedValue(activitySummary());
    vi.spyOn(api, "log").mockImplementation(async (id) => {
      const cached = useStore().logByRepo[id];
      return cached
        ? { ...cached, commits: [...cached.commits] }
        : { ok: true, code: "OK", commits: [], hasMore: false };
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("#20 fetches commitDetail on first expand, and caches on collapse/re-expand", async () => {
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("abc123def", "first")],
    };
    const detailSpy = vi
      .spyOn(api, "commitDetail")
      .mockResolvedValue(detailFor("abc123def"));

    const outer = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      {
        props: { repoId },
        global: { plugins: [i18n] },
      },
    );
    // Open the History section.
    const historyBtn = outer.findAll("button").find((b) => b.text().includes("History"))!;
    await historyBtn.trigger("click");
    await outer.vm.$nextTick();

    // Pointer users can still click the row background; the subject button is the equivalent
    // keyboard-accessible disclosure control.
    const row = outer.findAll("[data-history-row]")[0]!;
    const disclosure = row.get("button[data-history-disclosure]");
    await row.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledOnce();
    expect(detailSpy).toHaveBeenCalledWith(repoId, "abc123def");

    // Click again to collapse — no fetch.
    await disclosure.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledOnce();

    // Click again to re-expand — cache hit, still no second fetch.
    await disclosure.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledOnce();
  });

  it("#20 fetches again for a different commit", async () => {
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("aaa111", "first"), entry("bbb222", "second")],
    };
    const detailSpy = vi.spyOn(api, "commitDetail").mockImplementation(async (_id, hash) =>
      detailFor(hash),
    );

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      {
        props: { repoId },
        global: { plugins: [i18n] },
      },
    );

    const historyBtn = wrapper.findAll("button").find((b) => b.text().includes("History"))!;
    await historyBtn.trigger("click");
    await wrapper.vm.$nextTick();

    const rows = wrapper.findAll("button[data-history-disclosure]");
    await rows[0]!.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledTimes(1);
    expect(detailSpy).toHaveBeenLastCalledWith(repoId, "aaa111");

    await rows[1]!.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledTimes(2);
    expect(detailSpy).toHaveBeenLastCalledWith(repoId, "bbb222");
  });

  it("loads the scoped 24-hour activity overview when History opens", async () => {
    historyActivityEnabled.value = true;
    const store = useStore();
    store.repos.push({ id: repoId, status: null } as never);
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("abc123", "activity commit")],
    };
    const activitySpy = vi.mocked(api.historyActivity);
    activitySpy.mockClear();

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );

    await wrapper.findAll("button").find((b) => b.text().includes("History"))!.trigger("click");
    await flush();

    expect(activitySpy).toHaveBeenCalledOnce();
    expect(activitySpy).toHaveBeenCalledWith(repoId, "all", "hourly");
    const overview = wrapper.get('[data-testid="history-activity"]');
    expect(overview.text()).toContain("144");
    expect(overview.text()).toContain("Ada");
  });

  it("filters the real paginated History query from an author chip and provides a clear path", async () => {
    historyActivityEnabled.value = true;
    const store = useStore();
    const ada = {
      ...entry("ada111", "Ada authored this"),
      authorName: "Ada",
      authorEmail: "ada@example.com",
      refs: "HEAD -> main",
    };
    const sam = {
      ...entry("sam222", "Sam authored this"),
      authorName: "Sam",
      authorEmail: "sam@example.com",
    };
    const commits = [ada, sam];
    store.repos.push({ id: repoId, status: { dirty: 2 } } as never);
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits,
    };
    const logSpy = vi.mocked(api.log);
    logSpy.mockImplementation(async (_id, limit, skip, _refs, author) => {
      const matching = author
        ? commits.filter((commit) =>
            author.email.trim()
              ? commit.authorEmail.toLowerCase() === author.email.trim().toLowerCase()
              : commit.authorName.toLowerCase() === author.name.trim().toLowerCase(),
          )
        : commits;
      const page = matching.slice(skip, skip + limit);
      return {
        ok: true,
        code: "OK",
        commits: page,
        hasMore: page.length === limit,
      };
    });

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    await wrapper.findAll("button").find((button) => button.text().includes("History"))!.trigger("click");
    await flush();
    expect(wrapper.text()).toContain("Uncommitted changes (2)");

    const adaChip = wrapper
      .findAll("[data-activity-author]")
      .find((button) => button.text().includes("Ada"))!;
    await adaChip.trigger("click");
    await flush();

    expect(logSpy).toHaveBeenLastCalledWith(repoId, 50, 0, "all", {
      name: "Ada",
      email: "ada@example.com",
    });
    expect(store.logByRepo[repoId]?.commits.map((commit) => commit.hash)).toEqual(["ada111"]);
    expect(wrapper.get('[data-testid="history-author-filter"]').text()).toContain(
      "Showing commits by Ada",
    );
    expect(adaChip.attributes("aria-pressed")).toBe("true");
    expect(wrapper.text()).not.toContain("Sam authored this");
    expect(wrapper.text()).not.toContain("Uncommitted changes");
    expect(wrapper.get('[data-history-row="ada111"]').find("svg").exists()).toBe(false);

    await wrapper.get('[data-testid="history-author-filter-clear"]').trigger("click");
    await flush();

    expect(logSpy).toHaveBeenLastCalledWith(repoId, 50, 0, "all");
    expect(wrapper.find('[data-testid="history-author-filter"]').exists()).toBe(false);
    expect(store.logByRepo[repoId]?.commits.map((commit) => commit.hash)).toEqual([
      "ada111",
      "sam222",
    ]);
    expect(wrapper.text()).toContain("Uncommitted changes (2)");
    expect(wrapper.get('[data-history-row="ada111"]').find("svg").exists()).toBe(true);
  });

  it("requests the persisted activity scale when the range control changes", async () => {
    historyActivityEnabled.value = true;
    const store = useStore();
    store.repos.push({ id: repoId, status: null } as never);
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("abc123", "scaled activity")],
    };
    const activitySpy = vi.mocked(api.historyActivity);
    activitySpy.mockClear();

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    await wrapper.findAll("button").find((button) => button.text().includes("History"))!.trigger("click");
    await flush();
    activitySpy.mockClear();

    await wrapper.get('[data-activity-scale="daily"]').trigger("click");
    await flush();

    expect(historyActivityScale.value).toBe("daily");
    expect(activitySpy).toHaveBeenCalledOnce();
    expect(activitySpy).toHaveBeenCalledWith(repoId, "all", "daily");
  });

  it("keeps the old range visible while a replacement scale request is pending", async () => {
    historyActivityEnabled.value = true;
    const store = useStore();
    store.repos.push({ id: repoId, status: null } as never);
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("abc123", "scale transition")],
    };
    const activitySpy = vi.mocked(api.historyActivity);

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    await wrapper.findAll("button").find((button) => button.text().includes("History"))!.trigger("click");
    await flush();

    let resolveDaily!: (activity: HistoryActivity) => void;
    activitySpy.mockImplementationOnce(
      () =>
        new Promise<HistoryActivity>((resolve) => {
          resolveDaily = resolve;
        }),
    );

    await wrapper.get('[data-activity-scale="daily"]').trigger("click");
    await flush();

    const pending = wrapper.get('[data-testid="history-activity"]');
    expect(pending.attributes("data-state")).toBe("ready");
    expect(pending.attributes("data-refreshing")).toBe("true");
    expect(pending.get('[data-activity-kpi="window"] .activity-kpi-value').text()).toBe("3");
    expect(pending.get('[data-testid="history-activity-chart"]').exists()).toBe(true);
    expect(pending.findAll("[data-activity-scale]")).toHaveLength(3);
    expect(pending.get('[data-activity-scale="daily"]').attributes("aria-selected")).toBe("true");

    resolveDaily({
      ...activitySummary(),
      scale: "daily",
      bucketUnit: "day",
      windowCount: 30,
      windowHours: 30 * 24,
      commits: 27,
    });
    await flush();

    const ready = wrapper.get('[data-testid="history-activity"]');
    expect(ready.attributes("data-state")).toBe("ready");
    expect(ready.attributes("data-refreshing")).toBe("false");
    expect(ready.get('[data-activity-kpi="window"] .activity-kpi-value').text()).toBe("27");
    expect(ready.get('[data-activity-scale="daily"]').attributes("aria-selected")).toBe("true");
  });

  it("keeps activity and rows visible while a replacement scope request is pending", async () => {
    historyActivityEnabled.value = true;
    const store = useStore();
    store.repos.push({ id: repoId, status: null } as never);
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("old111", "all-scope commit")],
    };

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    await wrapper.findAll("button").find((button) => button.text().includes("History"))!.trigger("click");
    await flush();

    let resolveLocalLog!: (result: LogResult) => void;
    vi.mocked(api.log).mockImplementationOnce(
      () =>
        new Promise<LogResult>((resolve) => {
          resolveLocalLog = resolve;
        }),
    );
    let resolveLocalActivity!: (result: HistoryActivity) => void;
    vi.mocked(api.historyActivity).mockImplementationOnce(
      () =>
        new Promise<HistoryActivity>((resolve) => {
          resolveLocalActivity = resolve;
        }),
    );

    const localTab = wrapper
      .findAll('[role="tab"]')
      .find((button) => button.text().trim() === "Local")!;
    await localTab.trigger("click");
    await flush();

    const pendingActivity = wrapper.get('[data-testid="history-activity"]');
    const pendingRows = wrapper.get('[data-history-transition="rows"]');
    expect(pendingActivity.attributes("data-refreshing")).toBe("true");
    expect(pendingActivity.get('[data-activity-kpi="window"] .activity-kpi-value').text()).toBe("3");
    expect(pendingRows.attributes("data-refreshing")).toBe("true");
    expect(pendingRows.text()).toContain("all-scope commit");

    resolveLocalLog({
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("local222", "local-scope commit")],
    });
    resolveLocalActivity({
      ...activitySummary(),
      commits: 1,
      authors: [activitySummary().authors[0]!],
    });
    await flush();

    expect(wrapper.get('[data-history-transition="rows"]').attributes("data-refreshing")).toBe(
      "false",
    );
    expect(wrapper.get('[data-history-transition="rows"]').text()).toContain(
      "local-scope commit",
    );
    expect(wrapper.get('[data-testid="history-activity"]').attributes("data-refreshing")).toBe(
      "false",
    );
  });

  it("refreshes the rolling activity snapshot every time History reopens", async () => {
    historyActivityEnabled.value = true;
    const store = useStore();
    store.repos.push({ id: repoId, status: null } as never);
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("abc123", "freshness")],
    };
    const activitySpy = vi.mocked(api.historyActivity);
    const logSpy = vi.mocked(api.log);
    activitySpy.mockClear();
    logSpy.mockClear();

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    const historyButton = wrapper.findAll("button").find((button) =>
      button.text().includes("History"),
    )!;

    await historyButton.trigger("click");
    await flush();
    await historyButton.trigger("click");
    await historyButton.trigger("click");
    await flush();

    expect(activitySpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("coalesces history revision bursts into one live refresh", async () => {
    historyActivityEnabled.value = true;
    const store = useStore();
    store.repos.push({ id: repoId, status: null } as never);
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("abc123", "invalidation")],
    };
    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    const historyButton = wrapper.findAll("button").find((button) =>
      button.text().includes("History"),
    )!;
    await historyButton.trigger("click");
    await flush();

    const activitySpy = vi.mocked(api.historyActivity);
    const logSpy = vi.mocked(api.log);
    activitySpy.mockClear();
    logSpy.mockClear();

    store.historyRevisionByRepo[repoId] = 1;
    store.historyRevisionByRepo[repoId] = 2;
    store.historyRevisionByRepo[repoId] = 3;
    await wrapper.vm.$nextTick();
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();

    expect(activitySpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("pauses hidden-card invalidations and refreshes open History once on reactivation", async () => {
    historyActivityEnabled.value = true;
    const store = useStore();
    store.repos.push({ id: repoId, status: null } as never);
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("abc123", "kept alive while collapsed")],
    };
    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId", "active"],
        template:
          '<TooltipProvider><LogPanel :repo-id="repoId" :active="active" /></TooltipProvider>',
      },
      {
        props: { repoId, active: true },
        global: { plugins: [i18n] },
      },
    );
    await wrapper.findAll("button").find((button) => button.text().includes("History"))!.trigger("click");
    await flush();

    const activitySpy = vi.mocked(api.historyActivity);
    const logSpy = vi.mocked(api.log);
    activitySpy.mockClear();
    logSpy.mockClear();

    await wrapper.setProps({ active: false });
    store.historyRevisionByRepo[repoId] = 1;
    store.historyRevisionByRepo[repoId] = 2;
    historyActivityScale.value = "daily";
    await wrapper.vm.$nextTick();
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();

    expect(activitySpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    await wrapper.setProps({ active: true });
    await flush();

    expect(activitySpy).toHaveBeenCalledOnce();
    expect(activitySpy).toHaveBeenCalledWith(repoId, "all", "daily");
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("retains 275 paged-in rows across reopen and revision refreshes", async () => {
    const store = useStore();
    store.repos.push({ id: repoId, status: null } as never);
    const commits = Array.from({ length: 275 }, (_, index) =>
      entry(`commit-${String(index).padStart(3, "0")}`, `commit ${index}`),
    );
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: true,
      commits,
    };
    const logSpy = vi.mocked(api.log);
    logSpy.mockImplementation(async (_id, limit, skip) => {
      const page = commits.slice(skip, skip + limit);
      return {
        ok: true,
        code: "OK",
        commits: page,
        hasMore: page.length === limit,
      };
    });

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    const historyButton = wrapper.findAll("button").find((button) =>
      button.text().includes("History"),
    )!;

    await historyButton.trigger("click");
    await flush();
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenLastCalledWith(repoId, 275, 0, "all");
    expect(store.logByRepo[repoId]?.commits).toHaveLength(275);
    expect(wrapper.findAll("[data-history-row]")).toHaveLength(275);

    await historyButton.trigger("click");
    await historyButton.trigger("click");
    await flush();
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenLastCalledWith(repoId, 275, 0, "all");
    expect(store.logByRepo[repoId]?.commits).toHaveLength(275);
    expect(wrapper.findAll("[data-history-row]")).toHaveLength(275);

    logSpy.mockClear();
    store.historyRevisionByRepo[repoId] = 1;
    await wrapper.vm.$nextTick();
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenLastCalledWith(repoId, 275, 0, "all");
    expect(store.logByRepo[repoId]?.commits).toHaveLength(275);
    expect(wrapper.findAll("[data-history-row]")).toHaveLength(275);
  }, 15_000);

  it("removes the branch-map gutter when its appearance preference is off", async () => {
    historyGraphEnabled.value = false;
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("abc123", "text-only history")],
    };

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    await wrapper.findAll("button").find((b) => b.text().includes("History"))!.trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[role="group"][aria-label="Commit: text-only history"]').find("svg").exists()).toBe(false);
  });

  it("opens a commit-row context menu without toggling the row", async () => {
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [
        {
          ...entry("abc123def", "right-click me"),
          authorEmail: "ada@example.com",
          parents: ["parent123"],
        },
      ],
    };

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      {
        attachTo: document.body,
        props: { repoId },
        global: { plugins: [i18n] },
      },
    );
    await wrapper.findAll("button").find((b) => b.text().includes("History"))!.trigger("click");
    const row = wrapper.get('[role="group"][aria-label="Commit: right-click me"]');
    const disclosure = row.get("button[data-history-disclosure]");
    expect(disclosure.attributes("aria-expanded")).toBe("false");

    await row.trigger("contextmenu", { button: 2, clientX: 20, clientY: 20 });
    await flush();

    const menuText = [...document.body.querySelectorAll('[role="menuitem"]')]
      .map((item) => item.textContent ?? "")
      .join(" ");
    expect(menuText).toContain("View commit details");
    expect(menuText).toContain("Copy commit hash");
    expect(menuText).toContain("Copy commit message");
    expect(menuText).toContain("Copy author email");
    expect(menuText).toContain("Jump to parent parent12");
    expect(disclosure.attributes("aria-expanded")).toBe("false");
  });

  it("renders proportional additions/deletions bars in the wide Changes column", async () => {
    historyChangesDisplay.value = "bars";
    const detailSpy = vi
      .spyOn(api, "commitDetail")
      .mockResolvedValue(detailFor("abc123"));
    let resizeCallback: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe(): void {
          resizeCallback?.(
            [{ contentRect: { width: 900 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        disconnect(): void {}
        unobserve(): void {}
      },
    );
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [
        {
          ...entry("abc123", "visual changes"),
          stat: { filesChanged: 4, addedLines: 120, removedLines: 30 },
        },
      ],
    };

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    await wrapper.findAll("button").find((b) => b.text().includes("History"))!.trigger("click");
    await wrapper.vm.$nextTick();

    const cell = wrapper.get('[data-history-changes="bars"]');
    expect(cell.text()).toContain("4");
    expect(cell.find(".bg-success\\/80").exists()).toBe(true);
    expect(cell.find(".bg-destructive\\/75").exists()).toBe(true);
    const changeTrigger = cell.get("[aria-label]");
    expect(changeTrigger.attributes("aria-label")).toContain("120 added");

    // The row is a labelled group, not a synthetic button containing other focusable controls.
    // Keyboard events from the tooltip trigger and copy button must never toggle disclosure.
    const row = wrapper.get('[data-history-row="abc123"]');
    const disclosure = row.get('button[data-history-disclosure="abc123"]');
    const hashButton = row.get('button[title="Copy commit hash"]');
    expect(row.attributes("role")).toBe("group");
    expect(row.attributes("tabindex")).toBeUndefined();
    expect(row.attributes("aria-expanded")).toBeUndefined();
    expect(disclosure.attributes("aria-expanded")).toBe("false");
    expect(disclosure.attributes("aria-controls")).toBe("history-detail-abc123");

    await changeTrigger.trigger("keydown", { key: "Enter" });
    await changeTrigger.trigger("keydown", { key: " " });
    await hashButton.trigger("keydown", { key: "Enter" });
    await hashButton.trigger("keydown", { key: " " });
    await hashButton.trigger("click");
    await flush();

    expect(disclosure.attributes("aria-expanded")).toBe("false");
    expect(detailSpy).not.toHaveBeenCalled();
  });

  it("expanded detail shows the message + a file list that opens the Monaco viewer at this commit", async () => {
    historyFilesView.value = "list"; // this test pins the FLAT list; the tree has its own below
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("c1", "subject one")],
    };
    const detail: CommitDetail = {
      ...detailFor("c1"),
      subject: "subject one",
      body: "Extended body line.",
      files: [{ status: "M", path: "src/foo.ts", adds: 1, dels: 1 }],
      // 3 changed files but only 1 shipped — as if the daemon capped the list (COMMIT_FILES_CAP).
      filesTotal: 3,
    };
    vi.spyOn(api, "commitDetail").mockResolvedValue(detail);

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    const historyBtn = wrapper.findAll("button").find((b) => b.text().includes("History"))!;
    await historyBtn.trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button[data-history-disclosure]")[0]!.trigger("click");
    await flush();

    const text = wrapper.text();
    expect(text).toContain("Extended body line."); // commit message body rendered
    expect(text).toContain("foo.ts"); // file listed (rendered filename-first, dir shown separately)
    expect(text).toContain("+1"); // additions stat (from the file's server-side --numstat count)
    expect(text).toContain("and 2 more files"); // capped list → "…and N more files" note (filesTotal 3, 1 shipped)
    // No raw diff blob inline — the diff lives in the Monaco viewer on click.
    expect(wrapper.find("pre").exists()).toBe(false);

    // Clicking the file opens the shared viewer scoped to THIS commit.
    const fileBtn = wrapper.findAll("button").find((b) => b.text().includes("foo.ts"))!;
    await fileBtn.trigger("click");
    await flush();
    expect(fileViewer.open).toBe(true);
    expect(fileViewer.target).toMatchObject({ repoId, path: "src/foo.ts", commit: "c1" });
  });

  it("tree view (the default) nests files under collapsible folders and still opens at the commit", async () => {
    historyFilesView.value = "tree";
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("c2", "tree subject")],
    };
    const detail: CommitDetail = {
      ...detailFor("c2"),
      subject: "tree subject",
      files: [
        { status: "M", path: "src/deep/nested/alpha.ts", adds: 3, dels: 1 },
        { status: "A", path: "src/beta.ts", adds: 9, dels: 0 },
        { status: "M", path: "top.md", adds: 1, dels: 0 },
      ],
      filesTotal: 3,
    };
    vi.spyOn(api, "commitDetail").mockResolvedValue(detail);

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    const historyBtn = wrapper.findAll("button").find((b) => b.text().includes("History"))!;
    await historyBtn.trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button[data-history-disclosure]")[0]!.trigger("click");
    await flush();

    // Folder rows exist: "src" and the COMPRESSED single-child chain "deep/nested" (one row,
    // buildChangeTree's VS Code-style compression), each with aria-expanded.
    const folderRows = wrapper.findAll("button[aria-expanded]").filter((b) => b.text().trim().length > 0);
    const folderNames = folderRows.map((b) => b.text().trim());
    expect(folderNames).toContain("src");
    expect(folderNames).toContain("deep/nested");
    // Files render nested (name only, no dir suffix) with their numstat counts.
    expect(wrapper.text()).toContain("alpha.ts");
    expect(wrapper.text()).toContain("+3");
    expect(wrapper.text()).toContain("−1");
    // Collapsing "src" hides its files but keeps the root-level file visible.
    const srcRow = folderRows.find((b) => b.text().trim() === "src")!;
    await srcRow.trigger("click");
    await flush();
    expect(srcRow.attributes("aria-expanded")).toBe("false");
    // beta.ts sits under the now-collapsed "src" — its row unmounted with the fold.
    expect(wrapper.findAll("button").find((b) => b.text().includes("beta.ts"))).toBeUndefined();
    // Clicking a (still visible) tree file row opens the shared viewer AT this commit.
    const topBtn = wrapper.findAll("button").find((b) => b.text().includes("top.md"))!;
    await topBtn.trigger("click");
    await flush();
    expect(fileViewer.open).toBe(true);
    expect(fileViewer.target).toMatchObject({ repoId, path: "top.md", commit: "c2" });
  });

  it("a huge commit (>200 files) starts with every folder collapsed instead of a 700-row wall", async () => {
    historyFilesView.value = "tree";
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("c3", "generated churn")],
    };
    // 201 files across 10 folders trips COLLAPSE_ALL_ABOVE (200); every file is nested.
    const files = Array.from({ length: 201 }, (_, i) => ({
      status: "A",
      path: `gen/mod${i % 10}/f${String(i).padStart(3, "0")}.ts`,
      adds: 1,
      dels: 0,
    }));
    const detail: CommitDetail = { ...detailFor("c3"), subject: "generated churn", files, filesTotal: 201 };
    vi.spyOn(api, "commitDetail").mockResolvedValue(detail);

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    const historyBtn = wrapper.findAll("button").find((b) => b.text().includes("History"))!;
    await historyBtn.trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button[data-history-disclosure]")[0]!.trigger("click");
    await flush();

    // Folder rows render, all collapsed; not one nested file row is mounted.
    const folderRows = wrapper
      .findAll("button[aria-expanded]")
      .filter((b) => b.classes().includes("commit-tree-row"));
    expect(folderRows.length).toBeGreaterThan(0);
    expect(folderRows.every((b) => b.attributes("aria-expanded") === "false")).toBe(true);
    expect(wrapper.text()).not.toContain("f000.ts");
    // Drilling in still works: expand "gen", then its now-revealed "mod0" (nested dirs seeded
    // collapsed too), and mod0's files appear.
    await folderRows[0]!.trigger("click");
    await flush();
    expect(folderRows[0]!.attributes("aria-expanded")).toBe("true");
    expect(wrapper.text()).not.toContain("f000.ts"); // mod0 itself is still folded
    const mod0 = wrapper
      .findAll("button[aria-expanded]")
      .find((b) => b.classes().includes("commit-tree-row") && b.text().trim() === "mod0")!;
    await mod0.trigger("click");
    await flush();
    expect(wrapper.text()).toContain("f000.ts");
  });

  it("#18 compact row renders a DiffBar when the Changes display is 'bars'", async () => {
    historyChangesDisplay.value = "bars";
    stubNarrowResizeObserver();
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [
        {
          ...entry("compact1", "compact bars"),
          stat: { filesChanged: 4, addedLines: 120, removedLines: 30 },
        },
      ],
    };

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    await wrapper.findAll("button").find((b) => b.text().includes("History"))!.trigger("click");
    await wrapper.vm.$nextTick();

    const row = wrapper.get('[data-history-row="compact1"]');
    expect(row.findComponent(DiffBar).exists()).toBe(true);
    expect(row.text()).not.toContain("+120");
  });

  it("#18 compact row renders raw totals when the Changes display is 'numbers'", async () => {
    historyChangesDisplay.value = "numbers";
    stubNarrowResizeObserver();
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [
        {
          ...entry("compact2", "compact numbers"),
          stat: { filesChanged: 4, addedLines: 120, removedLines: 30 },
        },
      ],
    };

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );
    await wrapper.findAll("button").find((b) => b.text().includes("History"))!.trigger("click");
    await wrapper.vm.$nextTick();

    const row = wrapper.get('[data-history-row="compact2"]');
    expect(row.findComponent(DiffBar).exists()).toBe(false);
    expect(row.text()).toContain("+120");
  });
});

// Same ResizeObserver-stub approach the "wide Changes column" test above uses, just reporting a
// width under the compact breakpoint (640) instead of over it.
function stubNarrowResizeObserver(): void {
  let resizeCallback: ResizeObserverCallback | null = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe(): void {
        resizeCallback?.(
          [{ contentRect: { width: 320 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect(): void {}
      unobserve(): void {}
    },
  );
}

// Small helper to let the toggleCommit async handler's awaited api call resolve and its
// follow-up reactive update flush before assertions.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
