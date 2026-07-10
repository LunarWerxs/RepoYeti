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
});
