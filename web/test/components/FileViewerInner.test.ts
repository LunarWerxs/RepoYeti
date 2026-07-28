import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import FileViewerInner from "@/components/FileViewerInner.vue";
import MarkdownPreview from "@/components/MarkdownPreview.vue";
import { i18n } from "@/i18n";
import { viewerMode } from "@/lib/file-viewer";

vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));
vi.mock("@/lib/binary-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/binary-preview")>()),
  binaryPreviewUrl: (_target: unknown, kind: string) =>
    kind === "image" ? "data:image/png;base64,iVBORw0KGgo=" : "",
}));

describe("FileViewerInner rich previews", () => {
  beforeEach(() => {
    viewerMode.value = "content";
    vi.spyOn(api, "editors").mockResolvedValue({
      platform: "test",
      defaultEditor: null,
      effectiveDefault: "",
      editors: [],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders SVG directly without requesting a text or diff model", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const content = vi.spyOn(api, "fileContent");
    const diff = vi.spyOn(api, "fileDiff");

    const wrapper = shallowMount(FileViewerInner, {
      props: {
        target: { repoId: "repo one", path: "art/diagram.SVG", status: "M" },
      },
      global: { plugins: [pinia, i18n] },
    });
    await flushPromises();

    expect(content).not.toHaveBeenCalled();
    expect(diff).not.toHaveBeenCalled();
    expect(wrapper.get("img").attributes("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(wrapper.text()).not.toContain("Binary file: preview not available");
  });

  it("shows a preview fallback when the browser cannot decode the response", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = shallowMount(FileViewerInner, {
      props: {
        target: { repoId: "repo", path: "broken.webp" },
      },
      global: { plugins: [pinia, i18n] },
    });

    await wrapper.get("img").trigger("error");

    expect(wrapper.text()).toContain("This file couldn't be previewed");
    expect(wrapper.find("img").exists()).toBe(false);
  });

  it.each([
    ["manual.pdf", "iframe"],
    ["song.mp3", "audio"],
    ["clip.webm", "video"],
  ])("renders %s with its native browser element", async (path, selector) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const content = vi.spyOn(api, "fileContent");
    const diff = vi.spyOn(api, "fileDiff");

    const wrapper = shallowMount(FileViewerInner, {
      props: { target: { repoId: "repo", path } },
      global: { plugins: [pinia, i18n] },
    });

    expect(wrapper.find(selector).exists()).toBe(true);
    expect(content).not.toHaveBeenCalled();
    expect(diff).not.toHaveBeenCalled();
    wrapper.unmount();
    await flushPromises();
  });

  it("renders Markdown in Content mode after loading the source", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.spyOn(api, "fileContent").mockResolvedValue({
      ok: true,
      code: "OK",
      path: "README.md",
      content: "# Project\n\nRendered documentation.",
      ref: "work",
    });

    const wrapper = shallowMount(FileViewerInner, {
      props: { target: { repoId: "repo", path: "README.md", status: "M" } },
      global: { plugins: [pinia, i18n] },
    });
    await flushPromises();

    expect(wrapper.getComponent(MarkdownPreview).props("source")).toBe(
      "# Project\n\nRendered documentation.",
    );
  });
});

// ── "always side-by-side", moved out of Settings into this viewer ──
// The point of the move is that someone staring at a compact patch can get the real diff without
// knowing a Settings row exists. Two things must hold: the notice offers the way out, and taking
// it RE-FETCHES — the daemon decides patch vs whole sides per request, so flipping the setting
// alone would leave the same patch on screen.
describe("FileViewerInner compact-diff escape hatch", () => {
  beforeEach(() => {
    viewerMode.value = "diff";
    vi.spyOn(api, "editors").mockResolvedValue({
      platform: "test",
      defaultEditor: null,
      effectiveDefault: "",
      editors: [],
    });
  });
  afterEach(() => {
    viewerMode.value = "content";
    vi.restoreAllMocks();
  });

  async function mountPatched() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const diff = vi.spyOn(api, "fileDiff").mockResolvedValue({
      ok: true,
      code: "OK",
      path: "big.ts",
      mode: "patch",
      patch: "@@ -1 +1 @@\n-a\n+b\n",
      original: "",
      modified: "",
    } as Awaited<ReturnType<typeof api.fileDiff>>);
    const wrapper = shallowMount(FileViewerInner, {
      props: { target: { repoId: "repo-1", path: "big.ts", status: "M" } },
      global: { plugins: [pinia, i18n] },
    });
    await flushPromises();
    return { wrapper, diff };
  }

  it("offers a way out of the compact-diff notice", async () => {
    const { wrapper } = await mountPatched();
    expect(wrapper.text()).toContain("Show side-by-side");
  });

  it("re-fetches the file after flipping the setting, not just flips it", async () => {
    const { wrapper, diff } = await mountPatched();
    expect(diff).toHaveBeenCalledTimes(1);

    const setDiffPatchEnabled = vi
      .spyOn(wrapper.vm.store, "setDiffPatchEnabled")
      .mockResolvedValue(undefined);
    const wayOut = wrapper
      .findAll("button")
      .find((b) => b.text().includes("Show side-by-side"));
    expect(wayOut).toBeDefined();
    await wayOut!.trigger("click");
    await flushPromises();

    // false = "don't use the compact patch", i.e. always side-by-side.
    expect(setDiffPatchEnabled).toHaveBeenCalledWith(false);
    // …and the viewer asked the daemon again, which is the half that actually changes the screen.
    expect(diff).toHaveBeenCalledTimes(2);
  });
});
