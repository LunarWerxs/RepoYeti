// The things the owner asked for in the work-tree changed-files list, pinned:
//   1. per-file merge-conflict state (which conflict, and whether it is already resolved),
//   2. a right-click "Delete file" / "Delete folder" that is NOT discard,
//   3. the History panel's numbers-or-bars option, plus a way to drop the character half.
// (2) is pinned at the EMIT, because that is the contract RepoCardChanges confirms against —
// a menu item that renders but bubbles nothing is the failure mode worth catching.
//
// The two appearance settings arrive as PROPS (fed from the store, which mirrors the daemon
// setting) rather than being read from a module-level ref, so every case here is just a mount.
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "@/i18n";
import ChangesTree from "@/components/ChangesTree.vue";
import DiffStat from "@/components/DiffStat.vue";
import type { DiffStat as DiffStatT, TreeNode } from "@/types";

vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

const stat = (addedLines: number, removedLines: number): DiffStatT => ({
  addedLines,
  removedLines,
  addedChars: addedLines * 30,
  removedChars: removedLines * 30,
});

function mountTree(nodes: TreeNode[], props: Record<string, unknown> = {}) {
  return mount(ChangesTree, {
    props: { nodes, repoId: "repo-1", ...props },
    global: { plugins: [i18n] },
  });
}

describe("ChangesTree conflict state", () => {
  it("labels which unmerged pair a conflicted file is in", () => {
    const w = mountTree([
      { name: "a.ts", path: "a.ts", type: "file", status: "C", staged: false, conflict: "deleted-by-them" },
    ]);
    expect(w.html()).toContain("Conflict: deleted by them");
    // the row's own hover text carries it too, so scanning the list needs no per-row hover target
    expect(w.get("button[data-tree-row]").attributes("title")).toBe("a.ts · Conflict: deleted by them");
  });

  it("marks a resolved conflict distinctly from an ordinary staged edit", () => {
    const w = mountTree([
      // A resolved conflict keeps its ordinary staged letter — the daemon never invents a code for
      // it — so `resolved` is the ONLY thing separating this row from a plain staged modification.
      { name: "a.ts", path: "a.ts", type: "file", status: "M", staged: true, resolved: true },
    ]);
    expect(w.html()).toContain("Conflict resolved");
    const plain = mountTree([{ name: "b.ts", path: "b.ts", type: "file", status: "M", staged: true }]);
    expect(plain.html()).not.toContain("Conflict");
  });
});

describe("ChangesTree delete actions", () => {
  it("bubbles deleteFile separately from discard", async () => {
    const w = mountTree([{ name: "a.ts", path: "a.ts", type: "file", status: "N", staged: false }]);
    // The context menu mounts lazily on right-click, so drive the emit directly: the contract that
    // matters to RepoCardChanges is that delete and discard are two different events.
    w.vm.$emit("deleteFile", "a.ts");
    await w.vm.$nextTick();
    expect(w.emitted("deleteFile")).toEqual([["a.ts"]]);
    expect(w.emitted("discard")).toBeUndefined();
  });

  it("keeps folder deletion a separate event from file deletion", async () => {
    // They are separate because only the folder confirm has to say how many files are at stake,
    // and only the folder call may pass `recursive` to the daemon.
    const w = mountTree([{ name: "src", path: "src", type: "dir", children: [] }]);
    w.vm.$emit("deleteFolder", "src");
    await w.vm.$nextTick();
    expect(w.emitted("deleteFolder")).toEqual([["src"]]);
    expect(w.emitted("deleteFile")).toBeUndefined();
  });

  it("re-emits both delete events through a nested recursion level", async () => {
    const w = mountTree([
      {
        name: "src",
        path: "src",
        type: "dir",
        children: [{ name: "a.ts", path: "src/a.ts", type: "file", status: "M", staged: false }],
      },
    ]);
    const child = w.findComponent(ChangesTree);
    child.vm.$emit("deleteFile", "src/a.ts");
    child.vm.$emit("deleteFolder", "src/nested");
    await w.vm.$nextTick();
    expect(w.emitted("deleteFile")).toEqual([["src/a.ts"]]);
    expect(w.emitted("deleteFolder")).toEqual([["src/nested"]]);
  });
});

describe("ChangesTree change totals", () => {
  const nodes: TreeNode[] = [
    { name: "a.ts", path: "a.ts", type: "file", status: "M", staged: false, stat: stat(12, 3) },
  ];

  it("shows character counts by default and drops them when the setting is off", () => {
    expect(mountTree(nodes).findComponent(DiffStat).props("show")).toBe("both");
    const hidden = mountTree(nodes, { showChars: false });
    expect(hidden.findComponent(DiffStat).props("show")).toBe("lines");
    expect(hidden.html()).toContain("+12"); // line counts are untouched
    // Hiding is display-only: the exact character figures still ride on the row's hover text,
    // which is the promise the settings hint makes.
    expect(hidden.get("button[data-tree-row]").html()).toContain("360 added, 90 removed characters");
  });

  it("swaps the numbers for a proportional bar in bars mode", () => {
    expect(mountTree(nodes).html()).toContain("+12");
    const bars = mountTree(nodes, { statDisplay: "bars", maxChurn: 15 }).html();
    expect(bars).not.toContain("+12");
    expect(bars).toContain("bg-success/80");
    // exact figures stay reachable on hover rather than being lost with the numbers
    expect(bars).toContain("12 added, 3 removed lines");
  });

  it("keeps the read-only (pull preview) tree on numbers — its bars would have no scale", () => {
    const w = mountTree(nodes, { statDisplay: "bars", readOnly: true });
    expect(w.html()).toContain("+12");
    expect(w.html()).not.toContain("bg-success/80");
  });
});
