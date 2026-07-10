import { describe, it, expect } from "vitest";
import { buildChangeTree } from "@/lib/util";
import type { ChangedFile } from "@/types";

const f = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "M",
  staged: false,
  ...over,
});

describe("buildChangeTree", () => {
  it("returns an empty list for no files", () => {
    expect(buildChangeTree([])).toEqual([]);
  });

  it("renders a root-level file as a single file node", () => {
    const tree = buildChangeTree([f("README.md", { status: "A" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "README.md", path: "README.md", type: "file", status: "A" });
  });

  it("groups files under a shared folder, sorted alphabetically", () => {
    const tree = buildChangeTree([f("src/b.txt"), f("src/a.txt")]);
    expect(tree).toHaveLength(1);
    const dir = tree[0];
    expect(dir).toMatchObject({ name: "src", path: "src", type: "dir" });
    expect(dir.children?.map((c) => c.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("compresses single-child folder chains (VS Code / GitHub look)", () => {
    // a → b is a single-child dir chain, so it collapses into one "a/b" row holding c.txt.
    const tree = buildChangeTree([f("a/b/c.txt")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "a/b", path: "a/b", type: "dir" });
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children?.[0]).toMatchObject({ name: "c.txt", path: "a/b/c.txt", type: "file" });
  });

  it("does NOT compress a folder that holds more than one child", () => {
    const tree = buildChangeTree([f("a/b/c.txt"), f("a/d.txt")]);
    // "a" has two children (the "b" dir + the "d.txt" file) → not compressed.
    expect(tree[0]).toMatchObject({ name: "a", type: "dir" });
    const names = tree[0].children?.map((c) => c.name);
    expect(names).toContain("b"); // the nested dir
    expect(names).toContain("d.txt");
  });

  it("orders directories before files at every level", () => {
    const tree = buildChangeTree([f("z-root.txt"), f("src/a.txt")]);
    expect(tree.map((n) => n.type)).toEqual(["dir", "file"]); // src (dir) before z-root.txt (file)
    expect(tree.map((n) => n.name)).toEqual(["src", "z-root.txt"]);
  });

  it("preserves per-file status / staged / stat metadata on file nodes", () => {
    const stat = { addedLines: 3, removedLines: 1, addedChars: 40, removedChars: 8 };
    const tree = buildChangeTree([f("src/x.ts", { status: "A", staged: true, stat })]);
    const file = tree[0].children?.[0];
    expect(file).toMatchObject({ status: "A", staged: true, stat });
  });
});
