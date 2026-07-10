import { describe, it, expect } from "vitest";
import {
  parsePatch,
  diffModels,
  collapseContext,
  renderFileDiff,
  splitUnifiedDiff,
  MAX_MODELS_LINES,
} from "@/lib/unified-diff";

describe("parsePatch", () => {
  it("classifies +/-/space lines and keeps @@ headers, dropping file-header noise", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "index 111..222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parsePatch(patch)).toEqual([
      { kind: "meta", text: "@@ -1,3 +1,3 @@" },
      { kind: "ctx", text: "keep" },
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
    ]);
  });
});

describe("diffModels", () => {
  it("treats an empty original as an all-added (new) file", () => {
    expect(diffModels("", "a\nb")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("treats an empty modified as an all-removed (deleted) file", () => {
    expect(diffModels("a\nb", "")).toEqual([
      { kind: "del", text: "a" },
      { kind: "del", text: "b" },
    ]);
  });

  it("interleaves context, deletions and additions via LCS", () => {
    expect(diffModels("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "ctx", text: "c" },
    ]);
  });

  it("bails (null) when a side exceeds the browser-diff line cap", () => {
    const big = Array.from({ length: MAX_MODELS_LINES + 1 }, (_, i) => `l${i}`).join("\n");
    expect(diffModels(big, "x")).toBeNull();
  });
});

describe("collapseContext", () => {
  it("folds long unchanged runs into a single counted marker", () => {
    const rows = diffModels(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n"),
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "J"].join("\n"),
    )!;
    const collapsed = collapseContext(rows, 2);
    // The leading run of unchanged lines (a..g) is elided into one counted marker.
    const marker = collapsed.find((r) => r.kind === "meta" && r.collapsed);
    expect(marker?.collapsed).toBe(7);
    // The change survives with its context; j → J is a delete AND an add.
    expect(collapsed.filter((r) => r.kind === "del")).toEqual([{ kind: "del", text: "j" }]);
    expect(collapsed.filter((r) => r.kind === "add")).toEqual([{ kind: "add", text: "J" }]);
    // Exactly `context` (2) unchanged lines are kept before the change.
    expect(collapsed.filter((r) => r.kind === "ctx").map((r) => r.text)).toEqual(["h", "i"]);
  });
});

describe("renderFileDiff", () => {
  it("flags binary files instead of producing rows", () => {
    expect(renderFileDiff({ binary: true, mode: "models" })).toEqual({
      rows: [],
      binary: true,
      tooLarge: false,
    });
  });

  it("parses patch-mode payloads", () => {
    const r = renderFileDiff({ mode: "patch", patch: "@@ -1 +1 @@\n-a\n+b" });
    expect(r.binary).toBe(false);
    expect(r.tooLarge).toBe(false);
    expect(r.rows).toEqual([
      { kind: "meta", text: "@@ -1 +1 @@" },
      { kind: "del", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("reports tooLarge for an oversized models file", () => {
    const big = Array.from({ length: MAX_MODELS_LINES + 1 }, (_, i) => `l${i}`).join("\n");
    expect(renderFileDiff({ mode: "models", original: "", modified: big })).toEqual({
      rows: [],
      binary: false,
      tooLarge: true,
    });
  });
});

describe("splitUnifiedDiff", () => {
  const SAMPLE = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 111..222 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    " const c = 4;",
    "diff --git a/README.md b/README.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/README.md",
    "@@ -0,0 +1,2 @@",
    "+# Title",
    "+hello",
    "diff --git a/logo.png b/logo.png",
    "new file mode 100644",
    "Binary files /dev/null and b/logo.png differ",
  ].join("\n");

  it("splits a multi-file patch into per-file slices with add/del stats", () => {
    const files = splitUnifiedDiff(SAMPLE);
    expect(files.map((f) => f.path)).toEqual(["src/foo.ts", "README.md", "logo.png"]);

    const foo = files[0]!;
    expect(foo.adds).toBe(1);
    expect(foo.dels).toBe(1);
    expect(foo.binary).toBe(false);
    expect(foo.rows.some((r) => r.kind === "add" && r.text === "const b = 3;")).toBe(true);
    expect(foo.rows.some((r) => r.kind === "del" && r.text === "const b = 2;")).toBe(true);
    expect(foo.rows.some((r) => r.kind === "meta" && r.text.startsWith("@@"))).toBe(true);

    expect(files[1]!.adds).toBe(2);
    expect(files[1]!.dels).toBe(0);
    expect(files[2]!.binary).toBe(true);
  });

  it("returns [] for an empty / whitespace diff", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
    expect(splitUnifiedDiff("   \n ")).toEqual([]);
  });

  it("keeps a rename's new path and records the old one", () => {
    const renameOnly = [
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 100%",
      "rename from old/name.ts",
      "rename to new/name.ts",
    ].join("\n");
    const [f] = splitUnifiedDiff(renameOnly);
    expect(f!.path).toBe("new/name.ts");
    expect(f!.oldPath).toBe("old/name.ts");
    expect(f!.adds).toBe(0);
    expect(f!.dels).toBe(0);
  });
});
