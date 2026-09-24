import { describe, expect, it } from "vitest";
import { diffModels, parsePatch } from "@/lib/unified-diff";

describe("parsePatch header/hunk disambiguation", () => {
  it("keeps a deleted line whose content starts with '-- ' (body line '--- note')", () => {
    const patch = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1 +1 @@",
      "--- note",
      "+-- kept",
    ].join("\n");
    expect(parsePatch(patch)).toEqual([
      { kind: "meta", text: "@@ -1 +1 @@" },
      { kind: "del", text: "-- note" },
      { kind: "add", text: "-- kept" },
    ]);
  });

  it("keeps an added line whose content starts with '++ ' (body line '+++ x')", () => {
    const patch = [
      "@@ -1 +1 @@",
      "-old",
      "+++ x",
    ].join("\n");
    expect(parsePatch(patch)).toEqual([
      { kind: "meta", text: "@@ -1 +1 @@" },
      { kind: "del", text: "old" },
      { kind: "add", text: "++ x" },
    ]);
  });

});

describe("splitLines CRLF handling", () => {
  it("does not leave a trailing CR on the last line of a CRLF file", () => {
    const rows = diffModels("a\r\nb\r\n", "a\r\nB\r\n")!;
    expect(rows).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
    ]);
    expect(rows.every((r) => !r.text.includes("\r"))).toBe(true);
  });
});
