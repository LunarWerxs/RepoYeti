import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import ScanProjects from "@/components/ScanProjects.vue";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

let activeWrapper: ReturnType<typeof mount> | undefined;

// The modal content is teleported to <body> via DialogPortal, so query the document, not the wrapper.
function mountScan() {
  activeWrapper = mount(ScanProjects, {
    props: { open: true },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  return activeWrapper;
}

function buttonWithText(text: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLElement | undefined;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("ScanProjects.vue", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    document.body.innerHTML = ""; // drop any teleported portal leftovers between tests
    vi.restoreAllMocks();
  });

  it("does not auto-scan when opened (Start button is present, no scan kicked off)", async () => {
    const store = useStore();
    store.roots = ["/tmp/code"];
    const startSpy = vi.spyOn(store, "startScan").mockResolvedValue(undefined);
    mountScan();
    await flush();
    expect(startSpy).not.toHaveBeenCalled();
    expect(buttonWithText("Start scan")).toBeTruthy();
  });

  it("runs startScan when the Start scan button is clicked", async () => {
    const store = useStore();
    store.roots = ["/tmp/code"];
    const startSpy = vi.spyOn(store, "startScan").mockResolvedValue(undefined);
    mountScan();
    await flush();
    buttonWithText("Start scan")!.click();
    await flush();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("shows a Stop (X) control while scanning that cancels the scan", async () => {
    const store = useStore();
    store.roots = ["/tmp/code"];
    store.scanning = true;
    const cancelSpy = vi.spyOn(store, "cancelScan").mockResolvedValue(undefined);
    mountScan();
    await flush();
    const stop = document.body.querySelector('[aria-label="Stop scan"]') as HTMLElement | null;
    expect(stop).toBeTruthy();
    stop!.click();
    await flush();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(buttonWithText("Start scan")).toBeFalsy(); // Start is hidden while a scan runs
  });
});
