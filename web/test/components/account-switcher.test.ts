import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { autoAnimatePlugin } from "@formkit/auto-animate/vue";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import AccountSwitcher from "@/components/AccountSwitcher.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { GhAccount } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

let activeWrapper: ReturnType<typeof mount> | undefined;

function mountSwitcher() {
  activeWrapper = mount(
    {
      components: { AccountSwitcher, TooltipProvider },
      template: "<TooltipProvider><AccountSwitcher /></TooltipProvider>",
    },
    {
      global: { plugins: [autoAnimatePlugin, i18n] },
      attachTo: document.body,
    },
  );
  return activeWrapper;
}

function account(partial: Partial<GhAccount> & Pick<GhAccount, "host" | "login">): GhAccount {
  return {
    active: false,
    gitProtocol: "https",
    scopes: [],
    identityId: null,
    ...partial,
  };
}

/** The per-row disclosure buttons, in v-for order. */
function toggles(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll("button").filter((b) => b.attributes("aria-label") === "Show commit-identity picker");
}

describe("AccountSwitcher.vue", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("keeps one login on two hosts' pickers independent", async () => {
    // gh reports the same login authenticated on github.com and a GHE host as two accounts, but
    // the disclosure map was keyed by login, so both rows' pickers opened together.
    const store = useStore();
    store.ghAvailable = true;
    store.accountsReady = true;
    store.identityUiForced = true; // identitiesRelevant even with nothing saved yet
    store.identities.push({ id: "id-1", displayName: "Work", gitUsername: "me", gitEmail: "me@work.example", sshKeyPath: null });
    store.ghAccounts.push(
      account({ host: "github.com", login: "octo", active: true }),
      account({ host: "ghe.example.com", login: "octo" }),
    );

    const wrapper = mountSwitcher();
    await wrapper.vm.$nextTick();

    const [first, second] = toggles(wrapper);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    await first!.trigger("click");
    await wrapper.vm.$nextTick();

    expect(first!.attributes("aria-expanded")).toBe("true");
    expect(second!.attributes("aria-expanded")).toBe("false");
    expect(wrapper.findAll(".kit-expand-grid").length).toBe(1);
  });

  it("does not report a real link as 'Not set' while identities are unloaded", async () => {
    const store = useStore();
    store.ghAvailable = true;
    store.accountsReady = true;
    store.identityUiForced = true;
    store.ghAccounts.push(account({ host: "github.com", login: "octo", active: true, identityId: "id-1" }));

    const wrapper = mountSwitcher();
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain("Not set");
    // The picker stays reachable so the link can be inspected/cleared rather than silently hidden.
    const toggle = toggles(wrapper);
    expect(toggle.length).toBe(1);
    await toggle[0]!.trigger("click");
    await wrapper.vm.$nextTick();
    expect(toggle[0]!.attributes("aria-expanded")).toBe("true");
  });

  it("resolves the linked identity's name once identities load", async () => {
    const store = useStore();
    store.ghAvailable = true;
    store.accountsReady = true;
    store.identityUiForced = true;
    store.identities.push({ id: "id-1", displayName: "Work", gitUsername: "me", gitEmail: "me@work.example", sshKeyPath: null });
    store.ghAccounts.push(account({ host: "github.com", login: "octo", active: true, identityId: "id-1" }));

    const wrapper = mountSwitcher();
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("Work");
  });
});
