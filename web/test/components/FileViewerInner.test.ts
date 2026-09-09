import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "vue-sonner";
import { api, ApiError } from "@/api";
import FileViewerInner from "@/components/FileViewerInner.vue";
import MarkdownPreview from "@/components/MarkdownPreview.vue";
import { i18n } from "@/i18n";
import { viewerMode } from "@/lib/file-viewer";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));
// FileViewerInner async-imports MonacoViewer/MonacoDiffViewer (defineAsyncComponent), and their
// import of monaco-setup pulls in the whole monaco-editor package. That transform can finish AFTER
// this file's environment is torn down — an intermittent EnvironmentTeardownError in CI on commits
// that touched no web code. Mocking it resolves the lazy chain from the registry instead.
vi.mock("@/lib/monaco-setup", () => ({
  getMonaco: vi.fn(async () => ({}) as never),
  monacoThemeFor: vi.fn(() => "vs-dark"),
}));
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

// ── save() compare-and-swap: audit item 1 — no expectedHash meant two viewers could silently
// overwrite each other. The daemon now takes a `hash` on read and an `expectedHash` on write; the
// viewer's job is to remember what it last loaded/wrote and hand that back on every save.
describe("FileViewerInner save staleness (expectedHash)", () => {
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

  /** The slice of the component's instance these tests drive. `wrapper.vm` is typed as the public
   *  props surface only, so the internal refs/functions are reached through this shape. */
  interface ViewerVm {
    startEdit(): void;
    save(): Promise<void>;
    editorViewer: unknown;
    draft: string;
    dirty: boolean;
    content: string;
    editing: boolean;
  }

  /** Mounts in Content mode, waits for the load, then flips into edit mode. Returns `vm` so each
   *  test can seed the dirty buffer and call `save()` in one synchronous stretch (see `armSave`). */
  async function mountAndEdit(loadedHash: string) {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.spyOn(api, "fileContent").mockResolvedValue({
      ok: true,
      code: "OK",
      path: "notes.txt",
      content: "hello",
      ref: "work",
      hash: loadedHash,
    });
    const wrapper = shallowMount(FileViewerInner, {
      props: { target: { repoId: "repo-1", path: "notes.txt", status: "M" } },
      global: { plugins: [pinia, i18n] },
    });
    await flushPromises();
    const vm = wrapper.vm as unknown as ViewerVm;
    vm.startEdit();
    await flushPromises();
    return { wrapper, vm };
  }

  function armSave(vm: ViewerVm, draftValue: string): void {
    // shallowMount stubs MonacoViewer, and Vue rebinds the `ref="editorViewer"` template ref on
    // every render it patches — including the one still queued from entering edit mode — so
    // nulling it out only sticks for as long as nothing yields to that pending render. Set it
    // (plus the dirty buffer save() reads) and call save() in the SAME synchronous stretch, with
    // no `await` in between, so save()'s synchronous read of `editorViewer.value` still sees null
    // and falls back to `draft`, exactly as it would if Monaco had failed to load.
    vm.editorViewer = null;
    vm.draft = draftValue;
    vm.dirty = true;
  }

  it("sends the hash fileContent returned as save's 4th argument", async () => {
    const saveFile = vi
      .spyOn(api, "saveFile")
      .mockResolvedValue({ ok: true, code: "OK", path: "notes.txt", size: 11, hash: "hash-2" });
    const { vm } = await mountAndEdit("hash-1");

    armSave(vm, "hello world");
    await vm.save();
    await flushPromises();

    expect(saveFile).toHaveBeenCalledWith("repo-1", "notes.txt", "hello world", "hash-1");
  });

  it("shows the stale-file message on FILE_STALE and leaves the buffer untouched", async () => {
    vi.spyOn(api, "saveFile").mockRejectedValue(
      new ApiError(409, "stale on disk", { code: "FILE_STALE" }),
    );
    const { vm } = await mountAndEdit("hash-1");

    armSave(vm, "hello world");
    await vm.save();
    await flushPromises();

    expect(toast.error).toHaveBeenCalledWith(
      "This file changed on disk after you opened it. Reload it to see the current version, then re-apply your edit.",
    );
    // The generic failure toast must NOT also fire, and the loaded content/draft must survive —
    // overwriting either would throw away the edit a stale-file save is meant to protect.
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vm.content).toBe("hello");
    expect(vm.draft).toBe("hello world");
    expect(vm.dirty).toBe(true);
    expect(vm.editing).toBe(true);
  });

  it("sends the new hash from a successful save on the next save", async () => {
    const saveFile = vi
      .spyOn(api, "saveFile")
      .mockResolvedValueOnce({ ok: true, code: "OK", path: "notes.txt", size: 11, hash: "hash-2" });
    const { vm } = await mountAndEdit("hash-1");

    armSave(vm, "hello world");
    await vm.save();
    await flushPromises();
    expect(saveFile).toHaveBeenNthCalledWith(1, "repo-1", "notes.txt", "hello world", "hash-1");

    saveFile.mockResolvedValueOnce({ ok: true, code: "OK", path: "notes.txt", size: 16, hash: "hash-3" });
    armSave(vm, "hello world again");
    await vm.save();
    await flushPromises();

    expect(saveFile).toHaveBeenNthCalledWith(2, "repo-1", "notes.txt", "hello world again", "hash-2");
  });
});
