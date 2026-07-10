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
import { fileViewer } from "@/lib/file-viewer";
import type { CommitDetail } from "@/types";

const repoId = "repo-1";

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
    diff: "d",
    truncated: false,
  };
}

// A LogEntry as the graph view needs it (parents/isMerge/refs drive the DAG). Commit rows are
// clickable <div>s (each carries aria-expanded), so we select them with `div[aria-expanded]`.
function entry(hash: string, subject: string) {
  return { hash, shortHash: hash.slice(0, 7), subject, authorName: "a", authorEmail: "e", date: 0, refs: "", parents: [], isMerge: false };
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
      commits: [entry("abc123def", "first")],
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

    // Click the commit row (toggleCommit) → fetch #1.
    const row = wrapper.findAll("div[aria-expanded]")[0]!;
    await row.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledOnce();
    expect(detailSpy).toHaveBeenCalledWith(repoId, "abc123def");

    // Click again to collapse — no fetch.
    await row.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledOnce();

    // Click again to re-expand — cache hit, still no second fetch.
    await row.trigger("click");
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

    const wrapper = mount(LogPanel, {
      props: { repoId },
      global: { plugins: [i18n] },
    });

    const historyBtn = wrapper.findAll("button").find((b) => b.text().includes("History"))!;
    await historyBtn.trigger("click");
    await wrapper.vm.$nextTick();

    const rows = wrapper.findAll("div[aria-expanded]");
    await rows[0]!.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledTimes(1);
    expect(detailSpy).toHaveBeenLastCalledWith(repoId, "aaa111");

    await rows[1]!.trigger("click");
    await flush();
    expect(detailSpy).toHaveBeenCalledTimes(2);
    expect(detailSpy).toHaveBeenLastCalledWith(repoId, "bbb222");
  });

  it("expanded detail shows the message + a file list that opens the Monaco viewer at this commit", async () => {
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
      files: [{ status: "M", path: "src/foo.ts" }],
      diff: "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old line\n+new line\n",
    };
    vi.spyOn(api, "commitDetail").mockResolvedValue(detail);

    const wrapper = mount(LogPanel, { props: { repoId }, global: { plugins: [i18n] } });
    const historyBtn = wrapper.findAll("button").find((b) => b.text().includes("History"))!;
    await historyBtn.trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.findAll("div[aria-expanded]")[0]!.trigger("click");
    await flush();

    const text = wrapper.text();
    expect(text).toContain("Extended body line."); // commit message body rendered
    expect(text).toContain("foo.ts"); // file listed (rendered filename-first, dir shown separately)
    expect(text).toContain("+1"); // additions stat (from splitUnifiedDiff)
    // No raw diff blob inline anymore — the diff lives in the Monaco viewer on click.
    expect(wrapper.find("pre").exists()).toBe(false);
    expect(text).not.toContain("old line");

    // Clicking the file opens the shared viewer scoped to THIS commit.
    const fileBtn = wrapper.findAll("button").find((b) => b.text().includes("foo.ts"))!;
    await fileBtn.trigger("click");
    await flush();
    expect(fileViewer.open).toBe(true);
    expect(fileViewer.target).toMatchObject({ repoId, path: "src/foo.ts", commit: "c1" });
  });
});

// Small helper to let the toggleCommit async handler's awaited api call resolve and its
// follow-up reactive update flush before assertions.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
