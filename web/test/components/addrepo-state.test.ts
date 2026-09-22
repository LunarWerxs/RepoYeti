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

function modeItem(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll('[data-slot="toggle-group-item"]')).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLElement | undefined;
}

const selectedMode = (): string | null =>
  Array.from(document.body.querySelectorAll('[data-slot="toggle-group-item"]'))
    .find((b) => b.getAttribute("data-state") === "on")
    ?.textContent?.trim() ?? null;

function submitButton(): HTMLButtonElement {
  return document.body.querySelector(
    '[data-slot="dialog-footer"] button:last-of-type',
  ) as HTMLButtonElement;
}

function scanButton(): HTMLElement {
  return Array.from(document.body.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Scan for projects"),
  ) as HTMLElement;
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  return document.body.querySelector(
    `input[placeholder="${placeholder}"]`,
  ) as HTMLInputElement;
}

// The URL field's placeholder interpolates with vue-i18n, so match it by a stable fragment.
function cloneUrlInput(): HTMLInputElement {
  return document.body.querySelector('input[placeholder*="github.com"]') as HTMLInputElement;
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await flush();
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("AddRepo state (F080/F081)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    // Opening the dialog kicks off three lazy loads. Nothing here depends on their results, but
    // left real they reach for a daemon that isn't running and surface as unhandled rejections.
    const store = useStore();
    store.roots = ["/tmp/code"];
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

  // F080: the Lore tab used to keep a `loreServerUrl` that was no longer in store.servers, so a
  // server deleted in Settings kept being the clone source (and, with none left, the UI claimed
  // there were no servers while still cloning from the removed one).
  it("re-derives the Lore server when the selected one is removed from the store", async () => {
    const store = useStore();
    store.servers = [{ id: "a", name: "Server A", url: "https://a.example" }];
    mountAdd();
    await flush();

    modeItem("From Lore")!.click();
    await flush();

    // Server A was picked; now Settings removes it and B takes its place.
    store.servers = [{ id: "b", name: "Server B", url: "https://b.example" }];
    await flush();

    const cloneSpy = vi
      .spyOn(store, "cloneFromServer")
      .mockResolvedValue({ name: "proj" } as never);

    await setInput(inputByPlaceholder("my-project"), "proj");
    submitButton().click();
    await flush();

    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(cloneSpy.mock.calls[0]![0].url).toBe("https://b.example/proj");
  });

  it("disables the Lore submit and shows the empty state once every server is gone", async () => {
    const store = useStore();
    store.servers = [{ id: "a", name: "Server A", url: "https://a.example" }];
    mountAdd();
    await flush();

    modeItem("From Lore")!.click();
    await flush();
    await setInput(inputByPlaceholder("my-project"), "proj");
    expect(submitButton().disabled).toBe(false);

    store.servers = [];
    await flush();

    expect(document.body.textContent).toContain("No Lore servers registered yet");
    expect(submitButton().disabled).toBe(true);
  });

  // F081: the close watcher skips resetForm for a Scan hand-off, and the Scan modal's X (unlike
  // Back) never returned to AddRepo — so the next unrelated open resumed the abandoned form.
  it("returns to the base view when the Scan detour is dismissed, not handed back", async () => {
    const store = useStore();
    mountAdd();
    await flush();

    modeItem("Clone")!.click();
    await flush();
    await setInput(cloneUrlInput(), "git@github.com:acme/repo.git");

    scanButton().click();
    await flush();
    expect(store.scanOpen).toBe(true);
    expect(store.scanReturnToAdd).toBe(true);

    // ScanProjects.close(): the X / Close button, i.e. an outright dismissal of the flow.
    store.scanReturnToAdd = false;
    store.scanOpen = false;
    await flush();

    await setOpen(true);
    await flush();

    expect(selectedMode()).toBe("Point to folder");
    expect(document.body.querySelector('input[placeholder*="github.com"]')).toBeNull();
  });

  it("keeps the form when the Scan modal's Back arrow returns to AddRepo", async () => {
    const store = useStore();
    mountAdd();
    await flush();

    modeItem("Clone")!.click();
    await flush();
    await setInput(cloneUrlInput(), "git@github.com:acme/repo.git");

    scanButton().click();
    await flush();

    // ScanProjects.back(): hands control back to AddRepo instead of abandoning it.
    store.scanReturnToAdd = false;
    store.scanOpen = false;
    store.addRepoOpen = true;
    await flush();

    await setOpen(true);
    await flush();

    expect(selectedMode()).toBe("Clone");
    expect(cloneUrlInput().value).toBe(
      "git@github.com:acme/repo.git",
    );
  });
});
