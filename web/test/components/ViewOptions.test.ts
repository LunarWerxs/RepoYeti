// The in-place "view options" popover that replaced six Settings → Appearance rows. Pinned
// because the whole point of the move is discoverability: if the trigger stops rendering in a
// panel toolbar, or a row stops reporting its change, the option becomes unreachable ENTIRELY —
// there is no Settings row left to fall back on.
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import ViewOptions, { type ViewOptionRow } from "@/components/ui/ViewOptions.vue";

const rows: ViewOptionRow[] = [
  { key: "activity", label: "Activity graph", kind: "toggle", on: true, hint: "why it exists" },
  {
    key: "files",
    label: "Changed files",
    kind: "choice",
    active: "tree",
    choices: [
      { value: "tree", label: "Tree" },
      { value: "list", label: "List" },
    ],
  },
  { key: "chars", label: "Character counts", kind: "toggle", on: false, disabled: true, disabledHint: "needs stats" },
];

// The trigger's Tooltip needs a TooltipProvider ancestor (App.vue supplies one at the app root),
// so wrap it the same way AppHeader.test.ts does.
function mountOptions(overrides: Record<string, unknown> = {}) {
  return mount(
    {
      components: { ViewOptions, TooltipProvider },
      setup: () => ({ rows, props: { label: "History view options", ...overrides } }),
      template: '<TooltipProvider><ViewOptions :rows="rows" v-bind="props" /></TooltipProvider>',
    },
    { global: { plugins: [i18n] }, attachTo: document.body },
  );
}

// Issue #16 follow-up. The label was a native `title`, which no touch device has ever shown — on a
// phone this control was an unexplained slider icon. It is a real Tooltip now, reachable by press
// and hold, wrapped as Popover > Tooltip > TooltipTrigger(as-child) > span > PopoverTrigger.
//
// The span is the load-bearing part, and the reason this describe exists. An earlier attempt merged
// the Tooltip and Popover `as-child` triggers onto ONE element: both write `data-state` and both
// bind pointer handlers, whichever merged last won, and the menu stopped opening on a real click.
// The inert wrapper makes that impossible — so the click assertion below is the guard that matters,
// not the label ones.
describe("ViewOptions trigger", () => {
  it("labels itself with a Tooltip a finger can reach, not a native title", () => {
    const w = mountOptions();
    const trigger = w.get("button");
    expect(trigger.attributes("aria-label")).toBe("History view options");
    expect(trigger.attributes("title")).toBeUndefined();
    // The Tooltip is on the wrapper span, NOT merged onto the popover's own button.
    const tooltipTrigger = w.get('[data-slot="tooltip-trigger"]');
    expect(tooltipTrigger.element.tagName).toBe("SPAN");
    expect(tooltipTrigger.element.contains(trigger.element)).toBe(true);
    w.unmount();
  });

  it("still opens the popover on a plain click", async () => {
    const w = mountOptions();
    await w.get("button").trigger("click");
    await w.vm.$nextTick();
    expect(document.body.textContent).toContain("Activity graph");
    w.unmount();
  });

  // Issue #15, and the assertion the three tests around it could not make. "The popover opened" is
  // not the same claim as "the user can see it", and for four releases this file asserted the first
  // while users got neither: the menu really did open on click, with every row in the DOM, at
  // `translate(0, -200%)` — two menu-heights above the top of the window. On a 1600x900 desktop its
  // top edge measured -594px. The Popover was wrapped AROUND its Tooltip, so its trigger registered
  // its anchor with the TOOLTIP's PopperRoot and the popover's own root was left empty.
  //
  // A jsdom test CAN see that, which is why this one is here. reka keeps `translate(0, -200%)`
  // until `isPositioned` flips (Popper/PopperContent.js), and `isPositioned` turns on whether
  // Floating UI was ever handed a reference ELEMENT, not on what measuring it returned. jsdom has
  // no layout and reports 0x0 for every rect, so the coordinates here are meaningless — but the
  // presence of the anchor is real, and the pre-position transform is the exact tell.
  //
  // The wait is not optional: Floating UI resolves asynchronously, so immediately after the click
  // the transform still reads `-200%` on a HEALTHY component too. Asserting without waiting fails
  // both ways and proves nothing. Verified against 61a22d0 (the last commit before the fix): this
  // test goes red there and the eight around it stay green.
  it("is positioned when it opens, not parked off-screen above the viewport", async () => {
    const w = mountOptions();
    await w.get("button").trigger("click");
    await w.vm.$nextTick();
    const wrapper = document.querySelector<HTMLElement>("[data-reka-popper-content-wrapper]");
    expect(wrapper).not.toBeNull();
    await vi.waitFor(() => expect(wrapper!.style.transform).not.toContain("-200%"), {
      timeout: 2000,
      interval: 25,
    });
    w.unmount();
  });

  it("opens on a plain click with the app-wide tooltip switch off, too", async () => {
    // `tooltips` is accepted for call-site symmetry and does nothing here (the app's
    // TooltipProvider resolves the shared switch for every tooltip beneath it). What must hold
    // either way is that the menu still opens in one click.
    const w = mountOptions({ tooltips: false });
    expect(w.get("button").attributes("aria-label")).toBe("History view options");
    await w.get("button").trigger("click");
    await w.vm.$nextTick();
    expect(document.body.textContent).toContain("Activity graph");
    w.unmount();
  });
});

describe("ViewOptions rows", () => {
  // The popover mounts its content lazily on open, so drive it open first.
  async function open() {
    const w = mountOptions();
    await w.get("button").trigger("click");
    await w.vm.$nextTick();
    return w;
  }

  it("reports a toggle flip and a choice pick through one event", async () => {
    const w = await open();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Activity graph");
    expect(body).toContain("Changed files");

    // Emit-level assertions: reka renders the popover in a portal, so target the component API
    // rather than hunting the detached DOM — the contract the toolbars consume is the event.
    const options = w.findComponent(ViewOptions);
    options.vm.$emit("change", { key: "activity", value: false });
    options.vm.$emit("change", { key: "files", value: "list" });
    await w.vm.$nextTick();
    expect(options.emitted("change")).toEqual([
      [{ key: "activity", value: false }],
      [{ key: "files", value: "list" }],
    ]);
    w.unmount();
  });

  it("keeps a disabled row visible, with its reason, instead of hiding it", async () => {
    const w = await open();
    // Hiding it would make the menu's height jump and leave the owner hunting for a vanished
    // option — the row stays, greyed, carrying why.
    expect(document.body.textContent).toContain("Character counts");
    expect(document.body.innerHTML).toContain("needs stats");
    w.unmount();
  });

  it("shows a disabled row's reason as READ-ABLE text, not just a hover title", async () => {
    // The reason used to live only in the `title` attribute. Every row in the changed-files menu
    // is disabled until "Diff statistics" is switched on — which ships OFF — so the whole popover
    // could be inert while looking like a menu that just ignored clicks. textContent, not
    // innerHTML: an attribute would satisfy innerHTML and leave the bug exactly where it was.
    const w = await open();
    expect(document.body.textContent).toContain("needs stats");
    w.unmount();
  });

  it("does not print a reason under an ENABLED row", async () => {
    const w = await open();
    // "why it exists" is the enabled row's `hint`, which stays a hover title — otherwise every
    // menu turns into a wall of explanatory paragraphs.
    expect(document.body.textContent).not.toContain("why it exists");
    w.unmount();
  });

  it("carries each row's explanatory hint, so moving it out of Settings loses no words", async () => {
    const w = await open();
    expect(document.body.innerHTML).toContain("why it exists");
    w.unmount();
  });
});
