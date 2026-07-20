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
import { TooltipProvider } from "@/components/ui/tooltip";
import { fileViewer } from "@/lib/file-viewer";
import { historyFilesView } from "@/lib/history-view";
import type { CommitDetail } from "@/types";

// CommitFilesTree resolves per-file glyphs via @/lib/file-icons, which imports ~icons/* virtual
// modules (unplugin-icons) — a plugin the test pipeline deliberately omits (see vitest.config.ts).
// Stub the lookup with a bare <span>; the tests assert structure and behavior, not glyphs.
vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

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
    filesTotal: 0,
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

    // Click the commit row (toggleCommit) → fetch #1.
    const row = outer.findAll("div[aria-expanded]")[0]!;
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
    await wrapper.findAll("div[aria-expanded]")[0]!.trigger("click");
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
    await wrapper.findAll("div[aria-expanded]")[0]!.trigger("click");
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
    await wrapper.findAll("div[aria-expanded]")[0]!.trigger("click");
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
});

// Small helper to let the toggleCommit async handler's awaited api call resolve and its
// follow-up reactive update flush before assertions.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
