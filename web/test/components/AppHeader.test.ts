import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import AppHeader from "@/components/AppHeader.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Repo } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const repo = (patch: Partial<Repo> = {}): Repo => ({
  id: "repo-1",
  name: "repo-1",
  absPath: "C:/repo-1",
  source: "pinned",
  vcs: "git",
  isSubmodule: false,
  identityId: null,
  hidden: false,
  pinned: false,
  starred: false,
  status: null,
  updatedAt: 0,
  ...patch,
});

let activeWrapper: ReturnType<typeof mount> | undefined;

function mountHeader() {
  activeWrapper = mount(
    {
      components: { AppHeader, TooltipProvider },
      setup: () => ({ repoCount: useStore().repos.length }),
      template: '<TooltipProvider><AppHeader :connected="false" :repo-count="repoCount" /></TooltipProvider>',
    },
    {
    global: { plugins: [i18n] },
    attachTo: document.body,
    },
  );
  return activeWrapper;
}

async function openActions(wrapper: ReturnType<typeof mount>): Promise<void> {
  // Target the actions (⋯) menu specifically — other header controls (the notifications bell,
  // the account switcher) also carry aria-haspopup="menu", so a generic selector is ambiguous.
  await wrapper.find('[aria-label="More actions"]').trigger("click");
  await wrapper.vm.$nextTick();
}

async function clickFetchAll(wrapper: ReturnType<typeof mount>): Promise<void> {
  await openActions(wrapper);
  const fetchButton = wrapper.findAll("button").find((b) => b.text().includes("Fetch all"));
  expect(fetchButton).toBeTruthy();
  await fetchButton!.trigger("click");
  await flush();
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("AppHeader.vue fetch all feedback", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    // The vue-sonner mock is module-level, so its call history outlives restoreAllMocks() and
    // one test's toast would otherwise be visible to the next one's "was not called" assertion.
    vi.clearAllMocks();
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("does not call the API and explains the no-repos state", async () => {
    const store = useStore();
    const startSpy = vi.spyOn(store, "startFetchAll");
    const wrapper = mountHeader();

    await clickFetchAll(wrapper);

    expect(startSpy).not.toHaveBeenCalled();
    expect(toast.message).toHaveBeenCalledWith("There are no repositories to fetch yet");
  });

  it("only awaits the acknowledgement: the summary is not the response any more", async () => {
    const store = useStore();
    store.repos.push(repo());
    const startSpy = vi.spyOn(store, "startFetchAll").mockResolvedValue(undefined);
    const wrapper = mountHeader();

    await clickFetchAll(wrapper);

    expect(startSpy).toHaveBeenCalled();
    // Nothing is reported yet. The sweep is running; what it did arrives over SSE.
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("keeps the backend error message when the start itself fails", async () => {
    const store = useStore();
    store.repos.push(repo());
    vi.spyOn(store, "startFetchAll").mockRejectedValue(new Error("daemon is not reachable"));
    const wrapper = mountHeader();

    await clickFetchAll(wrapper);

    expect(toast.error).toHaveBeenCalledWith("Couldn't fetch", {
      description: "daemon is not reachable",
    });
  });

  it("shows what it is fetching, and offers a way out", async () => {
    const store = useStore();
    store.repos.push(repo());
    const cancelSpy = vi.spyOn(store, "cancelFetchAll").mockResolvedValue(undefined);
    const wrapper = mountHeader();
    store.fetchingAll = true;
    store.fetchAllCurrent = "alpha";
    store.fetchAllDone = 2;
    store.fetchAllTotal = 7;
    await openActions(wrapper);

    expect(wrapper.text()).toContain("Fetching alpha (2 of 7)");
    const stop = wrapper.findAll("button").find((b) => b.text() === "Stop");
    expect(stop, "a running sweep must offer a Stop").toBeTruthy();

    await stop!.trigger("click");
    await flush();
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("says Stopping… until the daemon confirms, and does not ask twice", async () => {
    const store = useStore();
    store.repos.push(repo());
    const cancelSpy = vi.spyOn(store, "cancelFetchAll").mockResolvedValue(undefined);
    const wrapper = mountHeader();
    store.fetchingAll = true;
    store.fetchAllCancelRequested = true;
    await openActions(wrapper);

    expect(wrapper.text()).toContain("Stopping…");
    const stopping = wrapper.findAll("button").find((b) => b.text() === "Stopping…");
    expect(stopping!.attributes("disabled")).toBeDefined();
    await stopping!.trigger("click");
    await flush();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("reports the finished sweep, whoever started it", async () => {
    const store = useStore();
    mountHeader();
    // A run that finished cleanly, announced over SSE rather than returned to this tab's request.
    store.fetchAllSummary = {
      jobId: "j1",
      total: 3,
      ok: 3,
      failed: [],
      skipped: 0,
      cancelled: false,
      done: 3,
      current: null,
      running: false,
    };
    await flush();
    expect(toast.success).toHaveBeenCalledWith("Fetched 3 repos");
  });

  it("names the first failure when a sweep only partly worked", async () => {
    const store = useStore();
    mountHeader();
    store.fetchAllSummary = {
      jobId: "j2",
      total: 3,
      ok: 1,
      failed: [
        { id: "a", name: "alpha", code: "AUTH_FAILED" },
        { id: "b", name: "beta", code: "ERROR" },
      ],
      skipped: 0,
      cancelled: false,
      done: 3,
      current: null,
      running: false,
    };
    await flush();
    expect(toast.warning).toHaveBeenCalled();
    const [line, opts] = (toast.warning as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(line).toContain("1");
    expect((opts as { description?: string }).description).toContain("alpha");
  });

  it("says a stopped sweep was stopped, not that it failed", async () => {
    const store = useStore();
    mountHeader();
    store.fetchAllSummary = {
      jobId: "j3",
      total: 9,
      ok: 2,
      failed: [],
      skipped: 7,
      cancelled: true,
      done: 2,
      current: null,
      running: false,
    };
    await flush();
    expect(toast.message).toHaveBeenCalledWith("Stopped after 2 of 9");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("surfaces a run that ended by throwing", async () => {
    const store = useStore();
    mountHeader();
    store.fetchAllSummary = {
      jobId: "j4",
      total: 4,
      ok: 1,
      failed: [],
      skipped: 3,
      cancelled: false,
      done: 1,
      current: null,
      running: false,
      error: "the network went away",
    };
    await flush();
    expect(toast.error).toHaveBeenCalledWith("Couldn't fetch", { description: "the network went away" });
  });
});
