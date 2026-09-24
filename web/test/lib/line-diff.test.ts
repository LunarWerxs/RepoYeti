import { describe, expect, it } from "vitest";
import { diffLineChanges, MAX_LCS_CELLS } from "@/lib/line-diff";

describe("diffLineChanges", () => {
  it("returns nothing for identical text", () => {
    expect(diffLineChanges("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
    expect(diffLineChanges("", "")).toEqual([]);
  });

  it("marks inserted lines as add", () => {
    // two lines inserted after line 1
    expect(diffLineChanges("a\nb", "a\nx\ny\nb")).toEqual([{ startLine: 2, endLine: 3, kind: "add" }]);
  });

  it("marks a pure deletion with a boundary marker", () => {
    // line 2 removed; the marker sits where it was (now line 2 = old line 3)
    const changes = diffLineChanges("a\nb\nc", "a\nc");
    expect(changes).toEqual([{ startLine: 2, endLine: 2, kind: "delete" }]);
  });

  it("handles multiple independent regions", () => {
    const original = "1\n2\n3\n4\n5\n6";
    const modified = "1\nX\n3\n4\nY\n6"; // line 2 and line 5 changed
    expect(diffLineChanges(original, modified)).toEqual([
      { startLine: 2, endLine: 2, kind: "modify" },
      { startLine: 5, endLine: 5, kind: "modify" },
    ]);
  });

  it("treats a whole-new file as add", () => {
    expect(diffLineChanges("", "a\nb\nc")).toEqual([{ startLine: 1, endLine: 3, kind: "add" }]);
  });

  it("falls back before an individually-valid pair can exceed the matrix work budget", () => {
    const side = Math.floor(Math.sqrt(MAX_LCS_CELLS)) + 1;
    const original = Array.from({ length: side }, (_, i) => `old-${i}`).join("\n");
    const modified = Array.from({ length: side }, (_, i) => `new-${i}`).join("\n");

    expect(diffLineChanges(original, modified)).toEqual([
      { startLine: 1, endLine: side, kind: "modify" },
    ]);
  });
});
