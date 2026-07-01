// Covers audit finding #20: LogPanel's per-commit detail cache. Tapping a commit fetches
// api.commitDetail once; collapsing and re-expanding the SAME commit must be a cache hit (no
// second fetch); a DIFFERENT commit must still fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import { api } from "@/api";
import LogPanel from "@/components/LogPanel.vue";
import type { CommitDetail } from "@/types";

const repoId = "repo-1";

function detailFor(hash: string): CommitDetail {
  return {
    ok: true,
    code: "OK",
    hash,
    shortHash: hash.slice(0, 7),
    subject: "s",
    authorName: "a",
    authorEmail: "e",
    date: 0,
    files: [],
    diff: "d",
    truncated: false,
  };
}

describe("LogPanel.vue", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("#20 fetches commitDetail on first expand, and caches on collapse/re-expand", async () => {
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [
        { hash: "abc123def", shortHash: "abc123d", subject: "first", authorName: "a", date: 0 },
      ],
    };
    const detailSpy = vi
      .spyOn(api, "commitDetail")
      .mockResolvedValue(detailFor("abc123def"));

    const wrapper = mount(LogPanel, {
      props: { repoId },
      global: { plugins: [i18n] },
    });

    // Open the History section.
    const historyBtn = wrapper.findAll("button").find((b) => b.text().includes("History"))!;
    await historyBtn.trigger("click");
    await wrapper.vm.$nextTick();

    // Click the commit's subject button (toggleCommit) → fetch #1.
    const subjectBtn = wrapper.findAll("button").find((b) => b.text().includes("first"))!;
    await subjectBtn.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledOnce();
    expect(detailSpy).toHaveBeenCalledWith(repoId, "abc123def");

    // Click again to collapse — no fetch.
    await subjectBtn.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledOnce();

    // Click again to re-expand — cache hit, still no second fetch.
    await subjectBtn.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledOnce();
  });

  it("#20 fetches again for a different commit", async () => {
    const store = useStore();
    store.logByRepo[repoId] = {
      ok: true,
      code: "OK",
      hasMore: false,
      commits: [
        { hash: "aaa111", shortHash: "aaa111", subject: "first", authorName: "a", date: 0 },
        { hash: "bbb222", shortHash: "bbb222", subject: "second", authorName: "a", date: 0 },
      ],
    };
    const detailSpy = vi.spyOn(api, "commitDetail").mockImplementation(async (_id, hash) =>
      detailFor(hash),
    );

    const wrapper = mount(LogPanel, {
      props: { repoId },
      global: { plugins: [i18n] },
    });

    const historyBtn = wrapper.findAll("button").find((b) => b.text().includes("History"))!;
    await historyBtn.trigger("click");
    await wrapper.vm.$nextTick();

    const firstBtn = wrapper.findAll("button").find((b) => b.text().includes("first"))!;
    await firstBtn.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledTimes(1);
    expect(detailSpy).toHaveBeenLastCalledWith(repoId, "aaa111");

    const secondBtn = wrapper.findAll("button").find((b) => b.text().includes("second"))!;
    await secondBtn.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledTimes(2);
    expect(detailSpy).toHaveBeenLastCalledWith(repoId, "bbb222");
  });
});

// Small helper to let the toggleCommit async handler's awaited api call resolve and its
// follow-up reactive update flush before assertions.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
