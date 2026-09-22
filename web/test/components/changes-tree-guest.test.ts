// F005: the per-file selection exists only to drive "Commit selected", which is control-tier
// (RepoCardCommit is wrapped in `<template v-if="store.canControl">`). The checkboxes and the
// "Clear selection" chip were previously gated only on `readOnly`, so a share-link guest whose
// perm is not "control" could tick files and folders, see the checked / mixed / indeterminate
// visuals and the destructive-tinted clear chip, and persist that selection to localStorage —
// none of which anything on their path could ever commit. These tests pin that the whole
// selection surface is hidden for a view-tier guest and unchanged for the owner.
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import ChangesTree from "@/components/ChangesTree.vue";
import RepoCardChanges from "@/components/repo-card/RepoCardChanges.vue";
import { i18n } from "@/i18n";
import { provideTreeSelection, type TreeSelectionApi } from "@/lib/changes-selection";
import { clearChangesOverride, setChangesPanelMode } from "@/lib/changes-view";
import { useStore } from "@/store";
import type { Repo, TreeNode } from "@/types";

vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

const repoId = "guest-selection-repo";
const repo: Repo = {
  id: repoId,
  name: "guest-selection-repo",
  displayName: null,
  absPath: "C:/guest-selection-repo",
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

const file = (path: string): TreeNode => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  type: "file",
  status: "M",
  staged: false,
});
const nodes: TreeNode[] = [
  { name: "src", path: "src", type: "dir", children: [file("src/a.ts"), file("src/b.ts")] },
  file("root.ts"),
];

// ChangesTree is self-recursive and each level injects the shared selection, so the host has to
// provide one — exactly like RepoCard does in the app (see ChangesTreeFolderSelect.test.ts).
function mountTree(props: Record<string, unknown> = {}) {
  const Host = defineComponent({
    setup() {
      provideTreeSelection(repoId);
      return () => h(ChangesTree, { nodes, repoId, forceExpand: true, ...props });
    },
  });
  return mount(Host, { global: { plugins: [i18n] }, attachTo: document.body });
}

const boxes = (wrapper: { findAll: (selector: string) => unknown[] }): number =>
  wrapper.findAll('button[role="checkbox"]').length;

const passThrough = { template: "<div><slot /></div>" };
const inlinePassThrough = { template: "<span><slot /></span>" };
const expandTransition = {
  props: ["open"],
  template: '<div v-if="open"><slot /></div>',
};

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Mount RepoCardChanges with the REAL ChangesTree (the sibling test stubs it) and a provided
// selection, so both the tree's checkboxes and the toolbar's clear chip are observable.
function mountCardWithSelection(): { wrapper: ReturnType<typeof mountCard>; api: TreeSelectionApi } {
  let api!: TreeSelectionApi;
  const Host = defineComponent({
    setup() {
      api = provideTreeSelection(repoId);
      return () =>
        h(RepoCardChanges, {
          repo,
          treeQuery: "",
          contentMode: false,
          "onUpdate:treeQuery": () => {},
          "onUpdate:contentMode": () => {},
        });
    },
  });
  const wrapper = mount(Host, {
    global: {
      plugins: [i18n],
      stubs: {
        BranchPanel: true,
        RepoFileTree: true,
        RepoCardMenu: true,
        ExpandTransition: expandTransition,
        Tooltip: passThrough,
        TooltipTrigger: inlinePassThrough,
        TooltipContent: inlinePassThrough,
      },
    },
  });
  return { wrapper, api };
}

describe("ChangesTree guest selection gating", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it("renders no selection checkboxes for a control-less guest", () => {
    const wrapper = mountTree({ canControl: false });
    expect(boxes(wrapper)).toBe(0);
    wrapper.unmount();
  });

  it("keeps the checkboxes for an owner (default canControl)", () => {
    const wrapper = mountTree();
    expect(boxes(wrapper)).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it("hides the clear-selection chip from a guest and shows it to the owner", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    try {
      setChangesPanelMode(repoId, "changes");
      const store = useStore();
      store.changesByRepo[repoId] = [{ path: "src/a.ts", status: "M", staged: false }];
      store.shareViewer = { label: "link", perm: "view", expiresAt: null, collaborative: false };
      expect(store.canControl).toBe(false);

      const guest = mountCardWithSelection();
      // Seed a selection: the old UI would still surface the clear chip over it even though the
      // guest can never commit it.
      guest.api.setMany(["src/a.ts"], true);
      await nextTick();
      expect(guest.wrapper.find('[aria-label="Clear selection"]').exists()).toBe(false);
      // Scoped to the tree itself: the toolbar's "search inside files" toggle is also a
      // role="checkbox", and it stays for every tier (it only filters).
      expect(guest.wrapper.findAll('.changes-tree-content button[role="checkbox"]').length).toBe(0);
      guest.wrapper.unmount();

      store.shareViewer = null; // back to the owner
      expect(store.canControl).toBe(true);
      const owner = mountCardWithSelection();
      owner.api.setMany(["src/a.ts"], true);
      await nextTick();
      expect(owner.wrapper.find('[aria-label="Clear selection"]').exists()).toBe(true);
      owner.wrapper.unmount();
    } finally {
      vi.unstubAllGlobals();
      clearChangesOverride(repoId);
      setChangesPanelMode(repoId, "changes");
    }
  });
});
