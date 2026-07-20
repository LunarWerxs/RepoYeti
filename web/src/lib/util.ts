import type { ChangedFile, TreeNode } from "@/types";
import { t } from "@/i18n";
import { formatAgo } from "@/lib/relativeTime";

/**
 * Build a folder tree from a flat changed-file list, compressing single-child folder
 * chains into one row (e.g. `docs/todo/jacob-do-me`) — the VS Code / GitHub look.
 * `from` (rename source) rides along when the caller has one (history commit trees).
 */
export function buildChangeTree(files: Array<ChangedFile & { from?: string }>): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };

  // Per-directory `name → child` index so each path-segment lookup is O(1). The old
  // `children.find()` made a wide dirty tree (thousands of files in a few folders) O(n²)
  // to build. Files and dirs of the same name stay distinct via the f:/d: key prefix.
  const childIndex = new Map<TreeNode, Map<string, TreeNode>>();
  const indexFor = (n: TreeNode): Map<string, TreeNode> => {
    let m = childIndex.get(n);
    if (!m) {
      m = new Map();
      childIndex.set(n, m);
    }
    return m;
  };

  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      node.children ??= [];
      const idx = indexFor(node);
      const key = (isFile ? "f:" : "d:") + part;
      let child = idx.get(key);
      if (!child) {
        child = isFile
          ? { name: part, path: f.path, type: "file", status: f.status, staged: f.staged, from: f.from, stat: f.stat }
          : { name: part, path: parts.slice(0, i + 1).join("/"), type: "dir", children: [] };
        node.children.push(child);
        idx.set(key, child);
      }
      node = child;
    });
  }

  const compress = (n: TreeNode): TreeNode => {
    if (!n.children) return n;
    n.children = n.children.map(compress);
    while (n.type === "dir") {
      const kids: TreeNode[] | undefined = n.children;
      if (kids?.length !== 1) break;
      const only: TreeNode | undefined = kids[0];
      if (only?.type !== "dir") break;
      n.name = n.name ? `${n.name}/${only.name}` : only.name;
      n.path = only.path;
      n.children = only.children;
    }
    return n;
  };
  const sort = (n: TreeNode): void => {
    n.children?.sort((a, b) =>
      a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    );
    n.children?.forEach(sort);
  };

  const top = (root.children ?? []).map(compress);
  top.forEach(sort);
  top.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
  return top;
}

/** Compact relative time, e.g. "12s ago", "4m ago", "2h ago" (localised). */
export function fromNow(ts: number): string {
  return formatAgo(Date.now(), ts, (key, params) => t(key, params));
}
