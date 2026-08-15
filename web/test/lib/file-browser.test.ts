// The "All files" browse mode's lazy per-directory state (@/lib/file-browser).
//
// The behaviour worth pinning is the laziness itself: this mode exists to browse a working tree
// that is 200,000+ files once ignored paths are counted, so "a folder nobody opened is never
// fetched" is a correctness property, not an optimisation.
import { beforeEach, describe, expect, it, vi } from "vitest";

const tree = vi.hoisted(() => vi.fn());
vi.mock("@/api", () => ({ api: { tree } }));

import { provideFileBrowser, type FileBrowserApi } from "@/lib/file-browser";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";

/** Mount a throwaway owner so provide/inject runs exactly as it does in RepoCardChanges. */
function makeBrowser(repoId = "repo-1"): FileBrowserApi {
  let api!: FileBrowserApi;
  mount(
    defineComponent({
      setup() {
        api = provideFileBrowser(repoId);
        return () => h("div");
      },
    }),
  );
  return api;
}

const listing = (...names: string[]) => ({
  path: "",
  entries: names.map((n) => ({
    name: n.replace(/\/$/, ""),
    path: n.replace(/\/$/, ""),
    type: n.endsWith("/") ? "dir" : "file",
  })),
});

describe("file browser (All files mode)", () => {
  beforeEach(() => {
    tree.mockReset();
    tree.mockResolvedValue(listing("src/", "readme.md"));
  });

  it("starts with everything collapsed and nothing fetched", () => {
    const b = makeBrowser();

    expect(b.open.size).toBe(0);
    expect(b.dirs.size).toBe(0);
    expect(tree).not.toHaveBeenCalled();
  });

  it("fetches a folder's children the first time it opens, and not again after", async () => {
    const b = makeBrowser();
    await b.load("");
    tree.mockClear();

    b.toggle("src");
    await vi.waitFor(() => expect(b.dirs.get("src")?.loading).toBe(false));
    expect(tree).toHaveBeenCalledTimes(1);
    expect(tree).toHaveBeenCalledWith("repo-1", "src");

    // Collapse and re-open: the cached listing is reused, no second request.
    b.toggle("src");
    b.toggle("src");
    await Promise.resolve();
    expect(tree).toHaveBeenCalledTimes(1);
  });

  it("never fetches a folder nobody opened — the whole point of the mode", async () => {
    const b = makeBrowser();
    await b.load("");

    expect(b.dirs.has("src")).toBe(false);
    expect(tree).toHaveBeenCalledTimes(1);
    expect(tree).toHaveBeenCalledWith("repo-1", "");
  });

  it("collapses concurrent requests for the same folder", async () => {
    const b = makeBrowser();
    let settle!: (v: unknown) => void;
    tree.mockReturnValueOnce(new Promise((r) => (settle = r)));

    const first = b.load("src");
    const second = b.load("src"); // arrives while the first is still in flight

    settle(listing("a.ts"));
    await Promise.all([first, second]);

    expect(tree).toHaveBeenCalledTimes(1);
  });

  it("records a failed listing as an error, and retries on the next open", async () => {
    const b = makeBrowser();
    tree.mockRejectedValueOnce(new Error("EPERM: permission denied"));

    await b.load("locked");
    expect(b.dirs.get("locked")?.error).toContain("permission denied");
    expect(b.dirs.get("locked")?.loading).toBe(false);

    // An errored folder is not treated as cached — asking again really re-requests.
    tree.mockResolvedValueOnce(listing("a.ts"));
    await b.load("locked");
    expect(b.dirs.get("locked")?.error).toBeNull();
    expect(tree).toHaveBeenCalledTimes(2);
  });

  it("carries the server's truncation notice through", async () => {
    tree.mockResolvedValueOnce({ ...listing("a.ts"), truncated: true, total: 12_000 });
    const b = makeBrowser();

    await b.load("many");

    expect(b.dirs.get("many")?.truncated).toBe(true);
    expect(b.dirs.get("many")?.total).toBe(12_000);
  });

  it("reset drops every cached listing, folds everything up, and re-reads the root", async () => {
    const b = makeBrowser();
    await b.load("");
    b.toggle("src");
    await vi.waitFor(() => expect(b.dirs.has("src")).toBe(true));
    tree.mockClear();

    b.reset();

    expect(b.open.size).toBe(0);
    await vi.waitFor(() => expect(tree).toHaveBeenCalledWith("repo-1", ""));
    expect(b.dirs.has("src")).toBe(false);
  });

  it("revealPath expands and loads every folder down to a FILE, but not the file itself", async () => {
    const b = makeBrowser();

    await b.revealPath("src/deep/leaf.ts", "file");

    expect([...b.open]).toEqual(["src", "src/deep"]);
    // Loading "src/deep/leaf.ts" would answer "not a directory" and park an error on a folder
    // that is perfectly fine.
    expect(tree.mock.calls.map((c) => c[1])).toEqual(["", "src", "src/deep"]);
  });

  it("revealPath includes the target itself when it IS a folder", async () => {
    const b = makeBrowser();

    await b.revealPath("src/api", "dir");

    expect([...b.open]).toEqual(["src", "src/api"]);
    expect(tree.mock.calls.map((c) => c[1])).toEqual(["", "src", "src/api"]);
  });

  it("revealPath handles a root-level target without asking for an empty folder twice", async () => {
    const b = makeBrowser();

    await b.revealPath("readme.md", "file");

    expect(b.open.size).toBe(0);
    expect(tree.mock.calls.map((c) => c[1])).toEqual([""]);
  });

  it("busy() reports an in-flight request", async () => {
    const b = makeBrowser();
    let settle!: (v: unknown) => void;
    tree.mockReturnValueOnce(new Promise((r) => (settle = r)));

    const pending = b.load("");
    expect(b.busy()).toBe(true);

    settle(listing("a.ts"));
    await pending;
    expect(b.busy()).toBe(false);
  });
});
