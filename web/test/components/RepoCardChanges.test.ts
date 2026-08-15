import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import RepoCardChanges from "@/components/repo-card/RepoCardChanges.vue";
import { i18n } from "@/i18n";
import {
  changesTreeStyle,
  changesViewSize,
  clearChangesOverride,
  setChangesPanelMode,
} from "@/lib/changes-view";
import { useStore } from "@/store";
import type { Repo } from "@/types";

// ChangesTree's icon lookup imports ~icons/* virtual modules, while the deliberately small test
// Vite config omits unplugin-icons. Glyph choice is irrelevant to resize behavior.
vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

const repoId = "resize-repo";
const repo: Repo = {
  id: repoId,
  name: "resize-repo",
  displayName: null,
  absPath: "C:/resize-repo",
  source: "auto",
  vcs: "git",
  isSubmodule: false,
  identityId: null,
  syncAccountHost: null,
  syncAccountLogin: null,
  hidden: false,
  pinned: false,
  starred: false,
  autoCommit: false,
  status: {
    branch: "main",
    detached: false,
    dirty: 1,
    ahead: 0,
    behind: 0,
    remote: null,
    error: null,
    fetchedAt: null,
    updatedAt: 0,
  },
  updatedAt: 0,
};

const passThrough = { template: "<div><slot /></div>" };
const inlinePassThrough = { template: "<span><slot /></span>" };
const expandTransition = {
  props: ["open"],
  template: '<div v-if="open"><slot /></div>',
};

let wrapper: ReturnType<typeof mount> | undefined;
let resizeCallback: ResizeObserverCallback | undefined;

class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function mountChanges() {
  return mount(RepoCardChanges, {
    props: {
      repo,
      treeQuery: "",
      contentMode: false,
      "onUpdate:treeQuery": () => {},
      "onUpdate:contentMode": () => {},
    },
    global: {
      plugins: [i18n],
      stubs: {
        BranchPanel: true,
        ChangesTree: true,
        RepoCardMenu: true,
        ExpandTransition: expandTransition,
        Tooltip: passThrough,
        TooltipTrigger: inlinePassThrough,
        TooltipContent: inlinePassThrough,
        Dialog: passThrough,
        DialogContent: passThrough,
        DialogHeader: passThrough,
        DialogTitle: passThrough,
        DialogDescription: passThrough,
        DialogFooter: passThrough,
      },
    },
  });
}

function notifyContentResize(): void {
  resizeCallback?.([], {} as ResizeObserver);
}

describe("RepoCardChanges changed-files resize grip", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    resizeCallback = undefined;
    setActivePinia(createPinia());
    clearChangesOverride(repoId);
    changesViewSize.value = "medium";
    localStorage.clear();
    const store = useStore();
    store.changesByRepo[repoId] = [{ path: "only-file.ts", status: "M", staged: false }];
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    clearChangesOverride(repoId);
    vi.unstubAllGlobals();
  });

  it("drags beyond short content, persists the exact height, and double-click resets it", async () => {
    wrapper = mountChanges();

    const scroller = wrapper.find<HTMLElement>(".scroll-slim");
    const content = wrapper.find<HTMLElement>(".changes-tree-content");
    const grip = wrapper.find<HTMLButtonElement>('button[aria-label="Resize changes list"]');
    expect(scroller.exists()).toBe(true);
    expect(grip.exists()).toBe(true);
    expect(content.classes()).toContain("pb-2.5");

    // Model a very short tree. The regression clamped the resize to this scrollHeight, so a
    // downward drag could never create a taller workspace.
    Object.defineProperty(scroller.element, "clientHeight", { configurable: true, value: 120 });
    Object.defineProperty(scroller.element, "scrollHeight", { configurable: true, value: 120 });

    grip.element.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientY: 100,
        isPrimary: true,
        pointerId: 7,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        buttons: 1,
        clientY: 2_100,
        isPrimary: true,
        pointerId: 7,
      }),
    );
    await nextTick();

    expect(scroller.attributes("style")).toContain("height: 2120px");
    expect(scroller.classes()).toContain("changes-tree-viewport--dragging");

    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        buttons: 0,
        clientY: 2_100,
        isPrimary: true,
        pointerId: 7,
      }),
    );
    await nextTick();

    expect(changesTreeStyle(repoId)).toEqual({ height: "2120px" });
    expect(scroller.attributes("style")).toContain("height: 2120px");
    expect(scroller.classes()).not.toContain("changes-tree-viewport--dragging");

    await grip.trigger("dblclick");
    expect(changesTreeStyle(repoId)).toEqual({ maxHeight: "340px" });
    expect(scroller.attributes("style")).toContain("max-height: 340px");
    expect(scroller.attributes("style")).not.toContain("height: 2120px");
  });

  it("automatically grows and shrinks with rendered rows up to the Appearance preset", async () => {
    wrapper = mountChanges();
    await nextTick();

    const scroller = wrapper.find<HTMLElement>(".scroll-slim");
    const content = wrapper.find<HTMLElement>(".changes-tree-content");
    let contentHeight = 120;
    Object.defineProperty(content.element, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });

    notifyContentResize();
    await nextTick();
    expect(scroller.attributes("style")).toContain("height: 120px");
    expect(scroller.attributes("style")).toContain("max-height: 340px");

    contentHeight = 280;
    notifyContentResize();
    await nextTick();
    expect(scroller.attributes("style")).toContain("height: 280px");

    contentHeight = 500;
    notifyContentResize();
    await nextTick();
    expect(scroller.attributes("style")).toContain("height: 340px");

    contentHeight = 96;
    notifyContentResize();
    await nextTick();
    expect(scroller.attributes("style")).toContain("height: 96px");
  });
});

// ── changes ⇄ all-files panel ────────────────────────────────────────────────
// Exactly ONE of the three bodies may be on screen at a time: the changed-files tree, the
// clean-repo "No changes" line, or the all-files browser. Written after driving the real app
// showed "No changes" sitting under a rendered file tree — which turned out to be a stalled
// leave-transition in a non-compositing browser pane rather than a logic fault, but the
// condition was worth pinning either way: nothing else asserts the three are exclusive.
describe("RepoCardChanges changes ⇄ all-files panel", () => {
  const cleanRepo: Repo = { ...repo, status: { ...repo.status!, dirty: 0 } };

  function mountFor(r: Repo) {
    return mount(RepoCardChanges, {
      props: {
        repo: r,
        treeQuery: "",
        contentMode: false,
        "onUpdate:treeQuery": () => {},
        "onUpdate:contentMode": () => {},
      },
      global: {
        plugins: [i18n],
        stubs: {
          BranchPanel: true,
          ChangesTree: true,
          RepoFileTree: true,
          RepoCardMenu: true,
          ExpandTransition: expandTransition,
          Tooltip: passThrough,
          TooltipTrigger: inlinePassThrough,
          TooltipContent: inlinePassThrough,
          Dialog: passThrough,
          DialogContent: passThrough,
          DialogHeader: passThrough,
          DialogTitle: passThrough,
          DialogDescription: passThrough,
          DialogFooter: passThrough,
        },
      },
    });
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    setActivePinia(createPinia());
    localStorage.clear();
    setChangesPanelMode(repoId, "changes");
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    setChangesPanelMode(repoId, "changes");
    vi.unstubAllGlobals();
  });

  it("shows the clean-repo line on a clean repo, and the toggle to leave it", () => {
    wrapper = mountFor(cleanRepo);

    expect(wrapper.text()).toContain("No changes");
    expect(wrapper.find('[aria-label="Browse all files"]').exists()).toBe(true);
    expect(wrapper.findComponent({ name: "RepoFileTree" }).exists()).toBe(false);
  });

  it("replaces the clean-repo line with the browser once browsing", async () => {
    wrapper = mountFor(cleanRepo);

    await wrapper.get('[aria-label="Browse all files"]').trigger("click");
    await nextTick();

    // The bug this pins: a file tree with "No changes" printed underneath it.
    expect(wrapper.text()).not.toContain("No changes");
    expect(wrapper.findComponent({ name: "RepoFileTree" }).exists()).toBe(true);
    expect(wrapper.find('[aria-label="Back to changed files"]').exists()).toBe(true);
  });

  it("replaces the changed-files tree too, on a DIRTY repo", async () => {
    wrapper = mountFor(repo); // dirty: 1
    expect(wrapper.findComponent({ name: "ChangesTree" }).exists()).toBe(true);

    await wrapper.get('[aria-label="Browse all files"]').trigger("click");
    await nextTick();

    expect(wrapper.findComponent({ name: "ChangesTree" }).exists()).toBe(false);
    expect(wrapper.findComponent({ name: "RepoFileTree" }).exists()).toBe(true);
  });

  it("hides the browse toggle from a share-link guest", () => {
    const store = useStore();
    // `isGuest` is a computed over shareViewer, so the viewer is what has to be set.
    store.shareViewer = { label: "link", perm: "view", expiresAt: null, collaborative: false };
    expect(store.isGuest).toBe(true);
    wrapper = mountFor(cleanRepo);

    // Both tree routes are owner-only, so the button would only ever offer a guest a 403.
    expect(wrapper.find('[aria-label="Browse all files"]').exists()).toBe(false);
  });

  it("hides it on a REMOTE session once browsing over the tunnel is off", () => {
    const store = useStore();
    store.canContinueLocal = false; // i.e. this request did not come from loopback
    store.remoteBrowse = false;
    wrapper = mountFor(cleanRepo);

    expect(wrapper.find('[aria-label="Browse all files"]').exists()).toBe(false);
  });

  it("keeps it on a LOCAL session even when remote browsing is off", () => {
    const store = useStore();
    store.canContinueLocal = true;
    store.remoteBrowse = false;
    wrapper = mountFor(cleanRepo);

    // The switch is about the tunnel. It must never lock the owner out of their own machine.
    expect(wrapper.find('[aria-label="Browse all files"]').exists()).toBe(true);
  });

  it("falls back to the changed files if browsing is revoked while 'all' is persisted", () => {
    setChangesPanelMode(repoId, "all");
    const store = useStore();
    store.canContinueLocal = false;
    store.remoteBrowse = false;

    wrapper = mountFor(cleanRepo);

    // The preference syncs across devices, so it can arrive on a session that may not use it.
    // Stranding someone in a panel that can only 403 would be worse than ignoring the pref.
    expect(wrapper.findComponent({ name: "RepoFileTree" }).exists()).toBe(false);
    expect(wrapper.text()).toContain("No changes");
  });

  it("comes back to the changed files when toggled off", async () => {
    wrapper = mountFor(cleanRepo);
    await wrapper.get('[aria-label="Browse all files"]').trigger("click");
    await nextTick();

    await wrapper.get('[aria-label="Back to changed files"]').trigger("click");
    await nextTick();

    expect(wrapper.text()).toContain("No changes");
    expect(wrapper.findComponent({ name: "RepoFileTree" }).exists()).toBe(false);
  });
});
