import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DiffStat from "@/components/DiffStat.vue";

const stat = { addedLines: 3, removedLines: 1, addedChars: 40, removedChars: 8 };

describe("DiffStat.vue", () => {
  it("renders nothing when stat is absent (callers bind possibly-null stats)", () => {
    const wrapper = mount(DiffStat, { props: { stat: null } });
    expect(wrapper.find("span").exists()).toBe(false);
  });

  it("shows both line and char deltas by default", () => {
    const wrapper = mount(DiffStat, { props: { stat } });
    const text = wrapper.text();
    expect(text).toContain("+3"); // added lines
    expect(text).toContain("1"); // removed lines
    expect(text).toContain("+40"); // added chars
    expect(text).toContain("8"); // removed chars
  });

  it("show=lines hides the character breakdown", () => {
    const wrapper = mount(DiffStat, { props: { stat, show: "lines" } });
    const text = wrapper.text();
    expect(text).toContain("+3");
    expect(text).not.toContain("40"); // chars suppressed
  });

  it("drops a zero half instead of printing −0", () => {
    // A pure append: nothing removed on either axis. Intra-line char counting makes this the
    // common case, and a file list full of "−0" reads like a list of errors.
    const append = { addedLines: 9, removedLines: 0, addedChars: 120, removedChars: 0 };
    const text = mount(DiffStat, { props: { stat: append } }).text();
    expect(text).toContain("+9");
    expect(text).toContain("+120");
    expect(text).not.toContain("−");
  });

  it("drops a whole pair when both its halves are zero", () => {
    // Whitespace-only reflow: lines move, characters don't. The char pair (and its glyph) goes.
    const reflow = { addedLines: 2, removedLines: 2, addedChars: 0, removedChars: 0 };
    const wrapper = mount(DiffStat, { props: { stat: reflow } });
    expect(wrapper.text()).toBe("+2−2");
    // Both glyphs are gone too — they only exist to tell two rendered pairs apart.
    expect(wrapper.findAll("svg")).toHaveLength(0);
  });

  it("renders nothing at all when every count is zero", () => {
    const empty = { addedLines: 0, removedLines: 0, addedChars: 0, removedChars: 0 };
    expect(mount(DiffStat, { props: { stat: empty } }).find("span").exists()).toBe(false);
  });
});
