import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import AddRepo from "@/components/AddRepo.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

let activeWrapper: ReturnType<typeof mount> | undefined;

// DialogPortal teleports the content to <body>, so query the document rather than the wrapper.
// `open` is bound two-way here because these tests are specifically about close→reopen behaviour.
function mountAdd() {
  activeWrapper = mount(
    {
      components: { AddRepo, TooltipProvider },
      data: () => ({ open: true }),
      template: '<TooltipProvider><AddRepo v-model:open="open" /></TooltipProvider>',
    },
    { global: { plugins: [i18n] }, attachTo: document.body },
  );
  return activeWrapper;
}

const setOpen = (open: boolean) => activeWrapper!.setData({ open });

function buttonWithText(text: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLElement | undefined;
}

function modeItem(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll('[data-slot="toggle-group-item"]')).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLElement | undefined;
}

const selectedMode = (): string | null =>
  Array.from(document.body.querySelectorAll('[data-slot="toggle-group-item"]'))
    .find((b) => b.getAttribute("data-state") === "on")
    ?.textContent?.trim() ?? null;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("AddRepo.vue", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    // Opening the dialog kicks off three lazy loads. Nothing here depends on their results, but
    // left real they reach for a daemon that isn't running and surface as unhandled rejections.
    const store = useStore();
    vi.spyOn(store, "loadRoots").mockResolvedValue(undefined);
    vi.spyOn(store, "loadServers").mockResolvedValue(undefined);
    vi.spyOn(store, "loadBuzzConfig").mockResolvedValue(undefined);
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("gives the selected mode a background the unselected ones do not have", async () => {
    mountAdd();
    await flush();

    // The mode switcher sits on a `bg-secondary` track, which the theme defines as the SAME colour
    // as `bg-muted`/`bg-accent`. If the kit ever paints hover or the on-state with one of those
    // again, all four modes collapse into one flat unclickable-looking block.
    const item = modeItem("Point to folder")!;
    expect(item.className).toContain("data-[state=on]:bg-background");
    expect(item.className).toContain("data-[state=off]:hover:bg-foreground/10");
    expect(item.className).not.toContain("hover:bg-muted");
    expect(item.className).not.toContain("data-[state=on]:bg-muted");
    expect(item.getAttribute("data-state")).toBe("on");
    expect(modeItem("Clone")!.getAttribute("data-state")).toBe("off");
  });

  // AppShell keeps this component mounted forever, so nothing resets its refs on its own:
  // closing a half-filled form and reopening used to resume it mid-flow.
  it("returns to the base view after closing without submitting", async () => {
    mountAdd();
    await flush();

    modeItem("Clone")!.click();
    await flush();
    expect(selectedMode()).toBe("Clone");
    const url = document.body.querySelector(
      'input[placeholder*="github.com"]',
    ) as HTMLInputElement;
    url.value = "git@github.com:acme/leftover.git";
    url.dispatchEvent(new Event("input"));
    await flush();

    buttonWithText("Cancel")!.click();
    await flush();
    await setOpen(true);
    await flush();

    expect(selectedMode()).toBe("Point to folder");
    expect(document.body.querySelector('input[placeholder*="github.com"]')).toBeNull();
  });

  it("clears a typed path when reopened", async () => {
    mountAdd();
    await flush();

    const path = document.body.querySelector("input") as HTMLInputElement;
    path.value = "D:/code/somewhere";
    path.dispatchEvent(new Event("input"));
    await flush();

    buttonWithText("Cancel")!.click();
    await flush();
    await setOpen(true);
    await flush();

    expect((document.body.querySelector("input") as HTMLInputElement).value).toBe("");
  });

  it("hands off to Scan with a flag that earns the Back control, and keeps the form", async () => {
    const store = useStore();
    mountAdd();
    await flush();

    modeItem("Clone")!.click();
    await flush();
    buttonWithText("Scan for projects")?.click() ??
      (
        Array.from(document.body.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("Scan for projects"),
        ) as HTMLElement
      ).click();
    await flush();

    expect(store.scanOpen).toBe(true);
    expect(store.scanReturnToAdd).toBe(true);

    // A detour is not a dismissal: coming back should land on the mode they were in.
    await setOpen(true);
    await flush();
    expect(selectedMode()).toBe("Clone");
  });
});
