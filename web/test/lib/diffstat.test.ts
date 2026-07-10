import { describe, it, expect } from "vitest";
import { fmtCount } from "@/lib/diffstat";

describe("fmtCount", () => {
  it("renders small numbers verbatim", () => {
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(42)).toBe("42");
  });

  it("group-separates large numbers (locale toLocaleString)", () => {
    // en-US groups by thousands; assert structurally so it doesn't hard-fail under another locale.
    expect(fmtCount(1234)).toMatch(/^1[.,\s]?234$/);
  });
});
