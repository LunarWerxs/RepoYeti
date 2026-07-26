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
