// The folder checkbox: one tick selects every file beneath a folder, recursively, and the box
// reports back what its descendants actually are (all / some / none) rather than storing a
// separate folder-level flag that could disagree with them.
//
// ChangesTree is self-recursive and each level injects the selection, so the shared state only
// exists when an OWNER provides it (RepoCard does in the app). Mounting ChangesTree bare gives
// every level its own private selection and a parent can never see a child's tick, so these tests
// mount through a tiny host that calls provideTreeSelection, exactly like the real card.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { i18n } from "@/i18n";
import ChangesTree from "@/components/ChangesTree.vue";
import { provideTreeSelection } from "@/lib/changes-selection";
import type { TreeNode } from "@/types";

vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

const file = (path: string): TreeNode => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  type: "file",
  status: "M",
  staged: false,
});

// src/ { a.ts, deep/ { b.ts, c.ts } } plus a repo-root file that must stay untouched.
const nodes: TreeNode[] = [
  {
    name: "src",
    path: "src",
    type: "dir",
    children: [
      file("src/a.ts"),
      {
        name: "deep",
        path: "src/deep",
        type: "dir",
        children: [file("src/deep/b.ts"), file("src/deep/c.ts")],
      },
    ],
  },
  file("root.ts"),
];

let seq = 0;

function mountTree(props: Record<string, unknown> = {}) {
  const repoId = `repo-folder-select-${++seq}`;
  const Host = defineComponent({
    setup() {
      provideTreeSelection(repoId);
      return () => h(ChangesTree, { nodes, repoId, forceExpand: true, ...props });
    },
  });
  return mount(Host, { global: { plugins: [i18n] }, attachTo: document.body });
}

/** Every checkbox in depth-first render order: src, src/a.ts, src/deep, b.ts, c.ts, root.ts. */
const boxes = (wrapper: ReturnType<typeof mountTree>) =>
  wrapper.findAll<HTMLElement>('button[role="checkbox"]');
const state = (wrapper: ReturnType<typeof mountTree>, i: number) =>
  boxes(wrapper)[i]!.attributes("aria-checked");

const SRC = 0;
const SRC_A = 1;
const DEEP = 2;
const ROOT_TS = 5;

describe("ChangesTree folder selection", () => {
  beforeEach(() => localStorage.clear());

  it("ticks every descendant file, including nested ones, from the top folder", async () => {
    const wrapper = mountTree();
    expect(boxes(wrapper).length).toBe(6);
    expect(state(wrapper, SRC)).toBe("false");

    await boxes(wrapper)[SRC]!.trigger("click");

    // Everything under src reads checked; the sibling root.ts is not under src, so it is not.
    expect(boxes(wrapper).slice(0, 5).map((b) => b.attributes("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
      "true",
      "true",
    ]);
    expect(state(wrapper, ROOT_TS)).toBe("false");

    wrapper.unmount();
  });

  it("reports mixed when only part of the subtree is selected", async () => {
    const wrapper = mountTree();
    await boxes(wrapper)[SRC_A]!.trigger("click"); // one of src's three files

    expect(state(wrapper, SRC)).toBe("mixed");
    expect(state(wrapper, SRC_A)).toBe("true");
    expect(state(wrapper, DEEP)).toBe("false");

    wrapper.unmount();
  });

  it("rolls a nested folder up into its parent's mixed state", async () => {
    const wrapper = mountTree();
    await boxes(wrapper)[DEEP]!.trigger("click"); // both files under src/deep

    expect(state(wrapper, DEEP)).toBe("true");
    expect(state(wrapper, SRC)).toBe("mixed"); // src/a.ts is still unticked
    expect(state(wrapper, SRC_A)).toBe("false");

    wrapper.unmount();
  });

  it("fills a partial selection up rather than clearing it", async () => {
    const wrapper = mountTree();
    await boxes(wrapper)[DEEP]!.trigger("click");
    expect(state(wrapper, SRC)).toBe("mixed");

    await boxes(wrapper)[SRC]!.trigger("click"); // clicking a mixed box completes it

    expect(state(wrapper, SRC)).toBe("true");
    expect(state(wrapper, SRC_A)).toBe("true");

    wrapper.unmount();
  });

  it("clears the subtree when it was already fully selected", async () => {
    const wrapper = mountTree();
    await boxes(wrapper)[SRC]!.trigger("click");
    expect(state(wrapper, SRC)).toBe("true");

    await boxes(wrapper)[SRC]!.trigger("click");

    expect(boxes(wrapper).every((b) => b.attributes("aria-checked") === "false")).toBe(true);

    wrapper.unmount();
  });

  it("renders no checkboxes at all in a read-only tree", () => {
    // The pull preview has nothing to commit, so offering to tick files there would be a lie.
    const wrapper = mountTree({ readOnly: true });
    expect(boxes(wrapper).length).toBe(0);
    wrapper.unmount();
  });
});
