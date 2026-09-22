// Regression cover for the "join another RepoYeti collaboration" flow in SharingSection.vue.
//
// Inspecting an invite seeds the "their repo" / "my repo" <select>s with a default pick. Those picks
// must be RESET on every inspect. Before the fix they were assigned with `||=`, so a pick left over
// from a previously inspected invite survived: inspecting invite B kept invite A's remote repo id,
// the <select> ended up bound to a value with no matching <option> (rendering blank), and clicking
// Join posted that stale id — which the daemon rejects as "not covered by this invitation" even
// though a perfectly valid repo was on screen a moment earlier.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import { api } from "@/api";
import SharingSection from "@/components/settings/SharingSection.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CollaborationInvitePreview, Repo } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const localRepo = { id: "local-1", name: "mine", displayName: "My checkout" } as Repo;

function preview(label: string, repoId: string): CollaborationInvitePreview {
  return {
    share: { label, perm: "write", collaborative: true },
    repos: [{ id: repoId, name: repoId, displayName: repoId }],
  };
}

const inviteA = preview("invite A", "remote-a");
const inviteB = preview("invite B", "remote-b");

let activeWrapper: ReturnType<typeof mount> | undefined;

function mountSharing() {
  activeWrapper = mount(
    {
      components: { SharingSection, TooltipProvider },
      template: '<TooltipProvider><SharingSection :open="true" /></TooltipProvider>',
    },
    { global: { plugins: [i18n] }, attachTo: document.body },
  );
  return activeWrapper;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function inspectButton(wrapper: ReturnType<typeof mountSharing>) {
  const label = i18n.global.t("collaboration.inspect");
  return wrapper.findAll("button").find((b) => b.text().includes(label))!;
}

async function setInviteUrl(wrapper: ReturnType<typeof mountSharing>, url: string): Promise<void> {
  await wrapper.find(`input[aria-label="${i18n.global.t("collaboration.inviteLabel")}"]`).setValue(url);
}

describe("SharingSection.vue — re-inspecting an invite resets the repo picks", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(api, "collaborationLinks").mockResolvedValue({ links: [] });
    vi.spyOn(api, "listShares").mockResolvedValue({ shares: [] });
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("seeds 'their repo' from each newly inspected invite instead of keeping the previous one", async () => {
    const store = useStore();
    store.mode = "remote";
    store.repos = [localRepo];
    vi.spyOn(api, "inspectCollaboration").mockResolvedValueOnce(inviteA).mockResolvedValueOnce(inviteB);

    const wrapper = mountSharing();
    await flush();

    await setInviteUrl(wrapper, "https://example.com/r/a");
    await inspectButton(wrapper).trigger("click");
    await flush();
    expect((wrapper.findAll("select")[0]!.element as HTMLSelectElement).value).toBe("remote-a");

    // Paste a DIFFERENT invite without joining the first — the old `||=` would keep "remote-a".
    await setInviteUrl(wrapper, "https://example.com/r/b");
    await inspectButton(wrapper).trigger("click");
    await flush();

    const remoteSelect = wrapper.findAll("select")[0]!.element as HTMLSelectElement;
    expect(remoteSelect.value).toBe("remote-b");
    expect(Array.from(remoteSelect.options).map((o) => o.value)).toContain("remote-b");
  });

  it("Join posts the repo id from the currently inspected invite, not a stale one", async () => {
    const store = useStore();
    store.mode = "remote";
    store.repos = [localRepo];
    vi.spyOn(api, "inspectCollaboration").mockResolvedValueOnce(inviteA).mockResolvedValueOnce(inviteB);
    const join = vi.spyOn(api, "joinCollaboration").mockResolvedValue({ ok: true, link: {} as never });

    const wrapper = mountSharing();
    await flush();

    await setInviteUrl(wrapper, "https://example.com/r/a");
    await inspectButton(wrapper).trigger("click");
    await flush();

    await setInviteUrl(wrapper, "https://example.com/r/b");
    await inspectButton(wrapper).trigger("click");
    await flush();

    const joinButton = wrapper.findAll("button").find((b) => b.text().includes(i18n.global.t("collaboration.join")))!;
    await joinButton.trigger("click");
    await flush();

    expect(join).toHaveBeenCalledWith({
      inviteUrl: "https://example.com/r/b",
      localRepoId: "local-1",
      remoteRepoId: "remote-b",
    });
  });
});
