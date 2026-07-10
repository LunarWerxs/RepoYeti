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

async function clickFetchAll(wrapper: ReturnType<typeof mount>): Promise<void> {
  // Target the actions (⋯) menu specifically — other header controls (the notifications bell,
  // the account switcher) also carry aria-haspopup="menu", so a generic selector is ambiguous.
  await wrapper.find('[aria-label="More actions"]').trigger("click");
  await wrapper.vm.$nextTick();
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
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("does not call the API and explains the no-repos state", async () => {
    const store = useStore();
    const fetchSpy = vi.spyOn(store, "fetchAll");
    const wrapper = mountHeader();

    await clickFetchAll(wrapper);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toast.message).toHaveBeenCalledWith("There are no repositories to fetch yet");
  });

  it("explains when repos exist but none have remotes", async () => {
    const store = useStore();
    store.repos.push(repo());
    vi.spyOn(store, "fetchAll").mockResolvedValue({ total: 0, ok: 0, failed: [] });
    const wrapper = mountHeader();

    await clickFetchAll(wrapper);

    expect(toast.message).toHaveBeenCalledWith("No repos with a remote to fetch");
  });

  it("keeps the backend error message on request failure", async () => {
    const store = useStore();
    store.repos.push(repo());
    vi.spyOn(store, "fetchAll").mockRejectedValue(new Error("daemon is not reachable"));
    const wrapper = mountHeader();

    await clickFetchAll(wrapper);

    expect(toast.error).toHaveBeenCalledWith("Couldn't fetch", {
      description: "daemon is not reachable",
    });
  });
});
