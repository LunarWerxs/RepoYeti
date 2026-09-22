// Covers review finding F001: the commit-message clamp was only measured on
// expandedCommit/bodyOpen/commitCache changes, never on resize. A body that fit the 8-line clamp
// at the old width was pinned to its measured `${full}px`, so narrowing the panel re-wrapped it
// taller than that max-height — clipped, with bodyOverflows still false (no fade, no "Show more").

import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import LogPanel from "@/components/LogPanel.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import {
  historyActivityEnabled,
  historyActivityScale,
  historyChangesDisplay,
  historyGraphEnabled,
} from "@/lib/history-appearance";
import { historyFilesView } from "@/lib/history-view";
import { useStore } from "@/store";
import type { CommitDetail, LogResult } from "@/types";

vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

const repoId = "repo-1";
enableAutoUnmount(afterEach);

function entry(hash: string, subject: string): LogResult["commits"][number] {
  return { hash, shortHash: hash.slice(0, 7), subject, authorName: "a", authorEmail: "e", date: 0, refs: "", parents: [], isMerge: false };
}

function detailFor(hash: string): CommitDetail {
  return {
    ok: true,
    code: "OK",
    hash,
    shortHash: hash.slice(0, 7),
    subject: "s",
    body: "line one\nline two",
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

describe("LogPanel.vue commit-message clamp", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    historyActivityEnabled.value = false;
    historyActivityScale.value = "hourly";
    historyGraphEnabled.value = true;
    historyChangesDisplay.value = "numbers";
    historyFilesView.value = "list";
    vi.spyOn(api, "historyActivity").mockResolvedValue({
      ok: true, code: "OK", scale: "hourly", bucketUnit: "hour", windowCount: 24, windowHours: 24,
      since: 0, until: 0, commits: 0, commitsLastHour: 0, contributors: 0, filesChanged: 0,
      addedLines: 0, removedLines: 0, authors: [], buckets: [], truncated: false,
      commitsTruncated: false, changeStatsTruncated: false,
    });
    vi.spyOn(api, "log").mockImplementation(async (id) => {
      const cached = useStore().logByRepo[id];
      return cached
        ? { ...cached, commits: [...cached.commits] }
        : { ok: true, code: "OK", commits: [], hasMore: false };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("re-measures the clamp when the panel width changes, so a re-wrapped body regains 'Show more'", async () => {
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [entry("abc123def", "first")],
    };
    vi.spyOn(api, "commitDetail").mockResolvedValue(detailFor("abc123def"));

    // Capture (don't auto-fire) the panel's ResizeObserver so the test drives widths by hand.
    const observers: { cb: ResizeObserverCallback; el: Element | null }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          this.cb = callback;
        }
        private cb: ResizeObserverCallback;
        observe(el: Element): void {
          observers.push({ cb: this.cb, el });
        }
        disconnect(): void {}
        unobserve(): void {}
      },
    );

    const wrapper = mount(
      {
        components: { LogPanel, TooltipProvider },
        props: ["repoId"],
        template: '<TooltipProvider><LogPanel :repo-id="repoId" /></TooltipProvider>',
      },
      { props: { repoId }, global: { plugins: [i18n] } },
    );

    const panel = observers.find((o) => o.el === wrapper.findComponent(LogPanel).element);
    expect(panel).toBeTruthy();
    const resize = (width: number): void =>
      panel!.cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    resize(900); // establish the wide panel width
    await flush();

    // Open History and expand the commit so the body element exists.
    await wrapper.findAll("button").find((b) => b.text().includes("History"))!.trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button[data-history-disclosure]")[0]!.trigger("click");
    await flush();

    const body = wrapper.get(".commit-body").element as HTMLElement;
    // jsdom/happy-dom do no layout: drive the "full text height" (which scrollHeight reports even
    // while max-height clips) so the measurement has something real to read.
    let fullHeight = 100; // fits the 8-line clamp at the wide width
    Object.defineProperty(body, "scrollHeight", {
      configurable: true,
      get: () => fullHeight,
    });

    resize(820); // same fit, slightly different width — body still fits
    await flush();
    expect(wrapper.find(".commit-body").classes()).not.toContain("is-clamped");
    expect(wrapper.findAll("button").some((b) => b.text().includes("Show more"))).toBe(false);

    // Narrow the panel: the same text re-wraps to more lines than the clamp.
    fullHeight = 300;
    resize(700);
    await flush();

    // The fix: the width change re-ran measureBody, so the overflow is now detected — the body is
    // clamped (fade mask) and the "Show more" control reappears, instead of staying silently cut.
    expect(wrapper.find(".commit-body").classes()).toContain("is-clamped");
    expect(wrapper.findAll("button").some((b) => b.text().includes("Show more"))).toBe(true);

    // Expanding shows the full measured height.
    await wrapper.findAll("button").find((b) => b.text().includes("Show more"))!.trigger("click");
    await flush();
    expect(wrapper.find(".commit-body").classes()).not.toContain("is-clamped");
    expect(wrapper.findAll("button").some((b) => b.text().includes("Show less"))).toBe(true);
  });
});

// Let the awaited api calls resolve and the reactive/template updates (incl. nextTick measure) flush.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
