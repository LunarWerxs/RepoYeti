import type { ChangedFile, TreeNode } from "@/types";
import { t } from "@/i18n";

/**
 * Build a folder tree from a flat changed-file list, compressing single-child folder
 * chains into one row (e.g. `docs/todo/jacob-do-me`) — the VS Code / GitHub look.
 */
export function buildChangeTree(files: ChangedFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };

  // Per-directory `name → child` index so each path-segment lookup is O(1). The old
  // `children.find()` made a wide dirty tree (thousands of files in a few folders) O(n²)
  // to build. Files and dirs of the same name stay distinct via the f:/d: key prefix.
  const childIndex = new Map<TreeNode, Map<string, TreeNode>>();
  const indexFor = (n: TreeNode): Map<string, TreeNode> => {
    let m = childIndex.get(n);
    if (!m) childIndex.set(n, (m = new Map()));
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
          ? { name: part, path: f.path, type: "file", status: f.status, staged: f.staged, stat: f.stat }
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
      if (!kids || kids.length !== 1) break;
      const only: TreeNode | undefined = kids[0];
      if (!only || only.type !== "dir") break;
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
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t("time.secondsAgo", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t("time.minutesAgo", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  return t("time.daysAgo", { n: Math.round(h / 24) });
}
