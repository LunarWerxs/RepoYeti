// The "All files" browse tree (RepoFileTree.vue) — the panel that shows the WHOLE working tree
// rather than only the changed files.
//
// What matters here is that it stays lazy (a folder nobody opened is never fetched), that a file
// which IS changed keeps its git status letter so switching modes loses no signal, and that an
// unchanged file opens on Content rather than an empty diff.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { i18n } from "@/i18n";

const tree = vi.hoisted(() => vi.fn());
vi.mock("@/api", () => ({ api: { tree } }));
vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

import RepoFileTree from "@/components/RepoFileTree.vue";
import { provideFileBrowser, type FileBrowserApi } from "@/lib/file-browser";
import { fileViewer, viewerMode } from "@/lib/file-viewer";
import type { ChangedFile, RepoTreeEntry } from "@/types";

const entry = (name: string, type: "dir" | "file", path = name) => ({ name, path, type });

/** Mount the tree under a real provider, exactly as RepoCardChanges does. */
function mountTree(changed?: Map<string, ChangedFile>) {
  let browser!: FileBrowserApi;
  const wrapper = mount(
    defineComponent({
      setup() {
        browser = provideFileBrowser("repo-1");
        return () => h(RepoFileTree, { repoId: "repo-1", changed });
      },
    }),
    { global: { plugins: [i18n] } },
  );
  return { wrapper, browser: () => browser };
}

describe("RepoFileTree", () => {
  beforeEach(() => {
    tree.mockReset();
    fileViewer.open = false;
    fileViewer.target = null;
    viewerMode.value = "diff"; // the sticky default the app ships with
  });

  it("renders the root listing with folders before files", async () => {
    tree.mockResolvedValue({
      path: "",
      entries: [entry("src", "dir"), entry("readme.md", "file")],
    });
    const { wrapper, browser } = mountTree();
    await browser().load("");
    await nextTick();

    expect(wrapper.text()).toContain("src");
    expect(wrapper.text()).toContain("readme.md");
  });

  it("fetches a folder's children only when that folder is opened", async () => {
    tree.mockResolvedValueOnce({ path: "", entries: [entry("src", "dir")] });
    const { wrapper, browser } = mountTree();
    await browser().load("");
    await nextTick();
    expect(tree).toHaveBeenCalledTimes(1);

    tree.mockResolvedValueOnce({
      path: "src",
      entries: [entry("index.ts", "file", "src/index.ts")],
    });
    await wrapper.get("button[aria-expanded]").trigger("click");
    await vi.waitFor(() => expect(tree).toHaveBeenCalledTimes(2));
    expect(tree).toHaveBeenLastCalledWith("repo-1", "src");
  });

  it("keeps the git status letter for a file that is also changed", async () => {
    tree.mockResolvedValue({
      path: "",
      entries: [entry("edited.ts", "file"), entry("untouched.ts", "file")],
    });
    const changed = new Map<string, ChangedFile>([
      ["edited.ts", { path: "edited.ts", status: "M", staged: false }],
    ]);
    const { wrapper, browser } = mountTree(changed);
    await browser().load("");
    await nextTick();

    const rows = wrapper.findAll("button").filter((b) => b.text().includes(".ts"));
    const edited = rows.find((r) => r.text().includes("edited.ts"));
    const untouched = rows.find((r) => r.text().includes("untouched.ts"));

    expect(edited?.text()).toContain("M");
    expect(untouched?.text()).not.toContain("M");
  });

  it("opens an UNCHANGED file on Content — an empty diff is not an answer", async () => {
    tree.mockResolvedValue({ path: "", entries: [entry("clean.ts", "file")] });
    const { wrapper, browser } = mountTree(new Map());
    await browser().load("");
    await nextTick();

    await wrapper.findAll("button").find((b) => b.text().includes("clean.ts"))!.trigger("click");
    await nextTick();

    expect(viewerMode.value).toBe("content");
    expect(fileViewer.target).toMatchObject({ repoId: "repo-1", path: "clean.ts" });
    expect(fileViewer.open).toBe(true);
  });

  it("leaves the sticky viewer tab alone for a file that IS changed", async () => {
    tree.mockResolvedValue({ path: "", entries: [entry("edited.ts", "file")] });
    const changed = new Map<string, ChangedFile>([
      ["edited.ts", { path: "edited.ts", status: "M", staged: true }],
    ]);
    const { wrapper, browser } = mountTree(changed);
    await browser().load("");
    await nextTick();

    await wrapper.findAll("button").find((b) => b.text().includes("edited.ts"))!.trigger("click");
    await nextTick();

    expect(viewerMode.value).toBe("diff"); // untouched
    expect(fileViewer.target).toMatchObject({ path: "edited.ts", status: "M", staged: true });
  });

  it("says so when the server capped an oversized folder", async () => {
    tree.mockResolvedValue({
      path: "",
      entries: [entry("a.ts", "file")],
      truncated: true,
      total: 12_000,
    });
    const { wrapper, browser } = mountTree();
    await browser().load("");
    await nextTick();

    // Plain digits, matching the changed-files truncation notice — the two sit in the same panel
    // and a group separator on only one of them would read as a different kind of number.
    expect(wrapper.text()).toContain("Showing 1 of 12000 entries");
  });

  it("does not claim a folder is empty before it has been read", async () => {
    // An unrequested directory has no state; "This folder is empty" would be a false statement.
    let settle!: (v: unknown) => void;
    tree.mockReturnValueOnce(new Promise((r) => (settle = r)));
    const { wrapper, browser } = mountTree();

    expect(wrapper.text()).not.toContain("empty");

    const pending = browser().load("");
    await nextTick();
    expect(wrapper.text()).not.toContain("empty");

    settle({ path: "", entries: [] });
    await pending;
    await nextTick();
    expect(wrapper.text()).toContain("empty");
  });

  it("dims what git is ignoring, and leaves everything else at full strength", async () => {
    tree.mockResolvedValue({
      path: "",
      entries: [
        { name: "node_modules", path: "node_modules", type: "dir", ignored: true },
        { name: "src", path: "src", type: "dir" },
      ],
    });
    const { wrapper, browser } = mountTree();
    await browser().load("");
    await nextTick();

    const rowClass = (label: string) =>
      wrapper.findAll("button").find((b) => b.text().includes(label))!.html();

    expect(rowClass("node_modules")).toContain("/45");
    expect(rowClass("src")).not.toContain("/45");
  });

  it("surfaces a listing failure instead of rendering an empty folder", async () => {
    tree.mockRejectedValue(new Error("EPERM: permission denied"));
    const { wrapper, browser } = mountTree();
    await browser().load("");
    await nextTick();

    expect(wrapper.text()).toContain("permission denied");
  });
});

describe("RepoFileTree search results", () => {
  beforeEach(() => {
    tree.mockReset();
    tree.mockResolvedValue({ path: "", entries: [] });
    fileViewer.open = false;
    fileViewer.target = null;
  });

  /** Mount in results mode — `results` non-null is what puts the tree into a flat list. */
  function mountResults(results: RepoTreeEntry[]) {
    const onGoToFolder = vi.fn();
    const wrapper = mount(
      defineComponent({
        setup() {
          provideFileBrowser("repo-1");
          return () =>
            h(RepoFileTree, { repoId: "repo-1", results, onGoToFolder });
        },
      }),
      { global: { plugins: [i18n] } },
    );
    return { wrapper, onGoToFolder };
  }

  it("renders a flat list with each hit's folder shown after the name", () => {
    const { wrapper } = mountResults([
      { name: "widget.ts", path: "src/deep/widget.ts", type: "file" },
    ]);

    expect(wrapper.text()).toContain("widget.ts");
    expect(wrapper.text()).toContain("src/deep");
  });

  it("does not fetch directory listings while showing results", () => {
    mountResults([{ name: "a.ts", path: "x/a.ts", type: "file" }]);

    // A result list is the answer already; walking folders again would be pure waste.
    expect(tree).not.toHaveBeenCalled();
  });

  it("a folder hit asks the panel to jump to it rather than expanding in place", async () => {
    const folder: RepoTreeEntry = { name: "api", path: "src/api", type: "dir" };
    const { wrapper, onGoToFolder } = mountResults([folder]);

    const row = wrapper.findAll("button").find((b) => b.text().includes("api"))!;
    // No disclosure chevron in results mode — there is no subtree here to open.
    expect(row.attributes("aria-expanded")).toBeUndefined();

    await row.trigger("click");
    expect(onGoToFolder).toHaveBeenCalledWith(folder);
  });

  it("still opens a file hit in the viewer", async () => {
    const { wrapper } = mountResults([
      { name: "found.ts", path: "deep/found.ts", type: "file" },
    ]);

    await wrapper.findAll("button").find((b) => b.text().includes("found.ts"))!.trigger("click");
    await nextTick();

    expect(fileViewer.target).toMatchObject({ repoId: "repo-1", path: "deep/found.ts" });
  });

  it("does not show the directory listing's empty/loading copy in results mode", () => {
    const { wrapper } = mountResults([]);

    // "No files match" belongs to the panel, which owns the query; this component must not
    // claim the FOLDER is empty when what is empty is a search.
    expect(wrapper.text()).not.toContain("This folder is empty");
    expect(wrapper.text()).not.toContain("Loading files");
  });
});
