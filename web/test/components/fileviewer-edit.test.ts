// The viewer has two "edit-affordance" controls that used to lie about being usable.
//
// The Edit menu item was rendered whenever the viewer merely LOOKED editable (`showEditControls`:
// a content/diff text view), but `startEdit()` bails on `canEdit`, which also rejects truncated /
// binary / deleted (HEAD-fallback) files and a tunnel session with remote editing off. So on a
// deleted file you got a fully enabled Edit that did nothing.
//
// The Save button had the mirror-image bug: start editing over the tunnel, then the owner turns
// remote editing off from another device, and `canEdit` flips false mid-edit while the button
// stays enabled and dirty — every click returned at `save()`'s first line with no request.
//
// Both now gate on `canEdit` and carry the block reason as their `title`.
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import FileViewerInner from "@/components/FileViewerInner.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n, t } from "@/i18n";
import { viewerMode } from "@/lib/file-viewer";
import { useStore } from "@/store";

// FileViewerInner async-imports MonacoViewer/MonacoDiffViewer; their import of monaco-setup pulls
// in the whole monaco-editor package. Mocking it (like FileViewerInner.test.ts) resolves the lazy
// chain from the registry instead, keeping this file's environment teardown-safe.
vi.mock("@/lib/monaco-setup", () => ({
  getMonaco: vi.fn(async () => ({}) as never),
  monacoThemeFor: vi.fn(() => "vs-dark"),
}));

// unplugin-icons' `~icons/...` virtual modules aren't resolvable in this Vitest environment, so
// stub the icon lookup the same way FileViewerInner.test.ts does.
vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

interface ViewerVm {
  startEdit(): void;
  editing: boolean;
  dirty: boolean;
  canEdit: boolean;
  editBlockedReason: string | null;
}

const Host = {
  components: { FileViewerInner, TooltipProvider },
  props: ["target"],
  template: '<TooltipProvider><FileViewerInner :target="target" /></TooltipProvider>',
};

/** Mount inside a TooltipProvider (App.vue supplies one at the app root) and return the viewer's
 *  component wrapper — its internals are reached through `vm` since the public surface is props. */
async function mountViewer(target: { repoId: string; path: string; status?: string }) {
  vi.spyOn(api, "editors").mockResolvedValue({
    platform: "test",
    defaultEditor: null,
    effectiveDefault: "",
    editors: [],
  });
  const wrapper = mount(Host, {
    props: { target },
    attachTo: document.body,
    global: { plugins: [i18n], stubs: { MonacoViewer: true, MonacoDiffViewer: true } },
  });
  await flushPromises();
  const viewer = wrapper.findComponent(FileViewerInner);
  return { wrapper, viewer, vm: viewer.vm as unknown as ViewerVm };
}

/** The overflow menu content is teleported into <body>, so items are queried there. One
 *  pointerdown + click is what reka's trigger needs to actually open it in jsdom. */
async function openMenuGetItems(wrapper: VueWrapper) {
  const trigger = wrapper.get('[aria-label="View options"]');
  await trigger.trigger("pointerdown", { button: 0, ctrlKey: false });
  await trigger.trigger("click");
  await flushPromises();
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe("FileViewerInner edit affordances", () => {
  beforeEach(() => {
    viewerMode.value = "content";
    setActivePinia(createPinia());
    const store = useStore();
    store.canContinueLocal = true;
    store.remoteEditing = true;
  });
  afterEach(() => {
    viewerMode.value = "content";
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("offers Edit enabled for an ordinary, editable working-tree file", async () => {
    vi.spyOn(api, "fileContent").mockResolvedValue({
      ok: true,
      code: "OK",
      path: "notes.txt",
      content: "hello",
      ref: "work",
      hash: "hash-1",
    } as Awaited<ReturnType<typeof api.fileContent>>);
    const { wrapper } = await mountViewer({ repoId: "repo-1", path: "notes.txt", status: "M" });

    const editItem = (await openMenuGetItems(wrapper)).find((el) =>
      el.textContent?.includes("Edit"),
    );
    expect(editItem).toBeDefined();
    expect(editItem!.getAttribute("aria-disabled")).toBeNull();
    wrapper.unmount();
  });

  it("renders Edit disabled with the reason when the file is a truncated preview", async () => {
    vi.spyOn(api, "fileContent").mockResolvedValue({
      ok: true,
      code: "OK",
      path: "big.txt",
      content: "x",
      ref: "work",
      truncated: true,
      hash: "hash-1",
    } as Awaited<ReturnType<typeof api.fileContent>>);
    const { wrapper } = await mountViewer({ repoId: "repo-1", path: "big.txt", status: "M" });

    const editItem = (await openMenuGetItems(wrapper)).find((el) =>
      el.textContent?.includes("Edit"),
    );
    expect(editItem).toBeDefined();
    // Enabled-looking-but-dead is exactly the reported bug.
    expect(editItem!.getAttribute("aria-disabled")).toBe("true");
    expect(editItem!.getAttribute("title")).toBe(t("fileViewer.editBlockedTruncated"));
    wrapper.unmount();
  });

  it("disables Save with the reason once canEdit flips false mid-edit", async () => {
    vi.spyOn(api, "fileContent").mockResolvedValue({
      ok: true,
      code: "OK",
      path: "notes.txt",
      content: "hello",
      ref: "work",
      hash: "hash-1",
    } as Awaited<ReturnType<typeof api.fileContent>>);
    const { wrapper, vm } = await mountViewer({ repoId: "repo-1", path: "notes.txt", status: "M" });

    vm.startEdit();
    await flushPromises();
    vm.dirty = true;
    await flushPromises();

    const saveButton = () => wrapper.findAll("button").find((b) => b.text().includes("Save"));
    expect(saveButton()!.attributes("disabled")).toBeUndefined();

    // The owner turns remote editing off from another device: canEdit goes false, but the local
    // `editing`/`dirty` state (and any click on Save) survives.
    const store = useStore();
    store.canContinueLocal = false;
    store.remoteEditing = false;
    await flushPromises();

    expect(vm.canEdit).toBe(false);
    expect(saveButton()!.attributes("disabled")).toBeDefined();
    expect(saveButton()!.attributes("title")).toBe(t("fileViewer.editBlockedRemote"));
    wrapper.unmount();
  });
});
