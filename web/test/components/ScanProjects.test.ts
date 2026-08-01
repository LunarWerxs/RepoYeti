import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import ScanProjects from "@/components/ScanProjects.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

let activeWrapper: ReturnType<typeof mount> | undefined;

// The modal content is teleported to <body> via DialogPortal, so query the document, not the wrapper.
function mountScan() {
  activeWrapper = mount(
    {
      components: { ScanProjects, TooltipProvider },
      props: ["open"],
      template: '<TooltipProvider><ScanProjects :open="open" /></TooltipProvider>',
    },
    {
      props: { open: true },
      global: { plugins: [i18n] },
      attachTo: document.body,
    },
  );
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

  // A scan used to report "Found 51 projects · 7 new" and stop there: no way to see WHICH seven
  // it had just added to your dashboard, and no way to undo any of them from here.
  describe("post-scan review list", () => {
    const found = (n: number) => ({
      id: `r${n}`,
      name: `project-${n}`,
      absPath: `D:/code/project-${n}`,
    });

    it("names every new project, not just how many", async () => {
      const store = useStore();
      store.scanDone = true;
      store.scanFound = 51;
      store.scanNew = 2;
      store.scanNewRepos = [found(1), found(2)];
      mountScan();
      await flush();

      const text = document.body.textContent ?? "";
      expect(text).toContain("Found 51 projects");
      expect(text).toContain("2 new projects added");
      expect(text).toContain("project-1");
      expect(text).toContain("D:/code/project-1");
      expect(text).toContain("project-2");
    });

    it("shows no review list when the scan found nothing new", async () => {
      const store = useStore();
      store.scanDone = true;
      store.scanFound = 51;
      store.scanNew = 0;
      store.scanNewRepos = [];
      mountScan();
      await flush();

      expect(document.body.textContent ?? "").not.toContain("projects added");
    });

    it("discards an unwanted project and drops it from the list", async () => {
      const store = useStore();
      store.scanDone = true;
      store.scanNewRepos = [found(1), found(2)];
      const removeSpy = vi.spyOn(store, "removeRepo").mockResolvedValue(null);
      mountScan();
      await flush();

      const discards = Array.from(
        document.body.querySelectorAll('[aria-label="Discard"]'),
      ) as HTMLElement[];
      expect(discards).toHaveLength(2);
      discards[0]!.click();
      await flush();

      expect(removeSpy).toHaveBeenCalledWith("r1");
      expect(store.scanNewRepos.map((r) => r.id)).toEqual(["r2"]);
    });

    it("keeps the project listed when the discard fails", async () => {
      const store = useStore();
      store.scanDone = true;
      store.scanNewRepos = [found(1)];
      vi.spyOn(store, "removeRepo").mockRejectedValue(new Error("busy"));
      mountScan();
      await flush();

      (document.body.querySelector('[aria-label="Discard"]') as HTMLElement).click();
      await flush();

      expect(store.scanNewRepos.map((r) => r.id)).toEqual(["r1"]);
    });
  });

  // Reaching Scan from "Add a repository" used to be a one-way door — the only exits were Close
  // and Escape, both of which dropped you on the dashboard.
  describe("route back to Add a repository", () => {
    it("offers no Back control when opened straight from the header", async () => {
      const store = useStore();
      store.scanReturnToAdd = false;
      mountScan();
      await flush();

      expect(document.body.querySelector('[aria-label="Back to Add a repository"]')).toBeNull();
    });

    it("hands back to Add a repository when it was reached from there", async () => {
      const store = useStore();
      store.scanReturnToAdd = true;
      store.addRepoOpen = false;
      mountScan();
      await flush();

      const back = document.body.querySelector(
        '[aria-label="Back to Add a repository"]',
      ) as HTMLElement | null;
      expect(back).toBeTruthy();
      back!.click();
      await flush();

      expect(store.addRepoOpen).toBe(true);
      expect(store.scanReturnToAdd).toBe(false);
    });

    it("plain Close leaves Add a repository shut", async () => {
      const store = useStore();
      store.scanReturnToAdd = true;
      store.addRepoOpen = false;
      mountScan();
      await flush();

      buttonWithText("Close")!.click();
      await flush();

      expect(store.addRepoOpen).toBe(false);
      expect(store.scanReturnToAdd).toBe(false);
    });
  });
});
