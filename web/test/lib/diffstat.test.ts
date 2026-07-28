import { describe, it, expect } from "vitest";
import { barShare, barWidth, churn, compactN, fmtCount } from "@/lib/diffstat";

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

describe("compactN", () => {
  it("abbreviates only past a thousand, with a shrinking decimal", () => {
    expect(compactN(0)).toBe("0");
    expect(compactN(999)).toBe("999");
    expect(compactN(1234)).toBe("1.2k");
    expect(compactN(20_500)).toBe("21k");
  });
});

// The change-bar scaling maths, lifted out of LogPanel so the work-tree changed-files list could
// draw the same bars. Pinned because two callers now depend on it, and the sqrt + floor is exactly
// the sort of thing a later "simplification" would linearise straight back into uselessness.
const pct = (s: string): number => Number.parseFloat(s);

describe("barWidth", () => {
  it("is empty for a zero-churn row", () => {
    expect(barWidth(churn(0, 0), 100)).toBe("0%");
  });

  it("fills the track at the list maximum", () => {
    expect(pct(barWidth(100, 100))).toBe(100);
  });

  it("keeps a small change visible next to an enormous one", () => {
    // The whole reason for square-root scaling: linear puts a 10-line edit at 0.1% of a
    // 10,000-line generated-file commit, i.e. invisible. Sqrt lifts it, and the 7% floor then
    // guarantees it draws at all — while a mid-sized change still ranks visibly above it.
    const tiny = pct(barWidth(10, 10_000));
    const mid = pct(barWidth(2_500, 10_000));
    expect(tiny).toBe(7);
    expect(mid).toBeGreaterThan(tiny);
    expect(mid).toBeLessThan(100);
  });

  it("never divides by zero, and never overflows the track, when max is stale or zero", () => {
    // `max` is computed by the caller over its own list, so a row CAN arrive bigger than it.
    expect(pct(barWidth(5, 0))).toBe(100);
    expect(pct(barWidth(10_000, 10))).toBe(100);
  });
});

describe("barShare", () => {
  it("splits the bar by each side's proportion", () => {
    expect(barShare(3, 1, "added")).toBe("75%");
    expect(barShare(3, 1, "removed")).toBe("25%");
  });

  it("is empty when nothing changed", () => {
    expect(barShare(0, 0, "added")).toBe("0%");
  });
});
