// The in-place "view options" popover that replaced six Settings → Appearance rows. Pinned
// because the whole point of the move is discoverability: if the trigger stops rendering in a
// panel toolbar, or a row stops reporting its change, the option becomes unreachable ENTIRELY —
// there is no Settings row left to fall back on.
import { describe, expect, it } from "vitest";
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

describe("ViewOptions trigger", () => {
  it("labels the trigger with a NATIVE title, never a nested reka Tooltip", () => {
    const w = mountOptions();
    const trigger = w.get("button");
    expect(trigger.attributes("aria-label")).toBe("History view options");
    // This is the regression guard for "the menu doesn't open". Wrapping the PopoverTrigger in a
    // TooltipTrigger stacks two `as-child` triggers on one element: both write `data-state` and
    // both bind pointer handlers, and the popover stopped opening on a real click. The label is a
    // plain title now, exactly like the ⋮ menu in FileViewerInner.
    expect(trigger.attributes("title")).toBe("History view options");
    expect(w.findAll('[data-slot="tooltip-trigger"]')).toHaveLength(0);
    w.unmount();
  });

  it("keeps the native title regardless of the app-wide tooltip switch", () => {
    const w = mountOptions({ tooltips: false });
    expect(w.get("button").attributes("title")).toBe("History view options");
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

  it("carries each row's explanatory hint, so moving it out of Settings loses no words", async () => {
    const w = await open();
    expect(document.body.innerHTML).toContain("why it exists");
    w.unmount();
  });
});
