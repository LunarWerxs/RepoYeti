import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import Settings from "@/components/Settings.vue";
import { i18n } from "@/i18n";

const lazySections = vi.hoisted(() => {
  const mounts: Record<string, number> = {};
  return {
    mounts,
    module(name: string) {
      return {
        __esModule: true,
        default: {
          name: `${name}TestSection`,
          setup() {
            mounts[name] = (mounts[name] ?? 0) + 1;
            return () => name;
          },
        },
      };
    },
  };
});

vi.mock("@/components/settings/AppearanceSection.vue", () => lazySections.module("appearance"));
vi.mock("@/components/settings/DiscoverySection.vue", () => lazySections.module("discovery"));
vi.mock("@/components/settings/UpdatesSection.vue", () => lazySections.module("updates"));
vi.mock("@/components/settings/IdentitiesSection.vue", () => lazySections.module("identities"));
vi.mock("@/components/settings/AccessSection.vue", () => lazySections.module("access"));
vi.mock("@/components/settings/SharingSection.vue", () => lazySections.module("sharing"));
vi.mock("@/components/settings/CloudSyncSection.vue", () => lazySections.module("cloud-sync"));
vi.mock("@/components/settings/AutoCommitSection.vue", () => lazySections.module("auto-commit"));
vi.mock("@/components/settings/BackgroundSyncSection.vue", () => lazySections.module("background-sync"));
vi.mock("@/components/settings/AiProvidersSection.vue", () => lazySections.module("ai-providers"));
vi.mock("@/components/settings/EditorSection.vue", () => lazySections.module("editor"));
vi.mock("@/components/settings/HotkeysSection.vue", () => lazySections.module("hotkeys"));
vi.mock("@/components/settings/DiffTuningSection.vue", () => lazySections.module("diff-tuning"));
vi.mock("@/components/settings/AgentSafetySection.vue", () => lazySections.module("agent-safety"));
vi.mock("@/components/settings/IdentityFirewallSection.vue", () => lazySections.module("identity-firewall"));
vi.mock("@/components/settings/ExperimentalServersSection.vue", () =>
  lazySections.module("experimental-servers"),
);

async function settleAsyncSections(): Promise<void> {
  await vi.dynamicImportSettled();
  await flushPromises();
  await nextTick();
}

function tabButton(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent?.trim() === label,
  );
}

function panel(name: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-settings-tab="${name}"]`);
}

describe("Settings deep-link re-request", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    for (const key of Object.keys(lazySections.mounts)) delete lazySections.mounts[key];
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("retargets the requested tab when the same deep-link is requested again", async () => {
    const wrapper = mount(Settings, {
      props: { open: true, targetTab: "automation", navSeq: 0 },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await settleAsyncSections();

    expect(panel("automation")).not.toBeNull();

    // User pivots away from the deep-linked tab while the panel stays open...
    tabButton(i18n.global.t("settings.tabs.general"))!.click();
    await settleAsyncSections();
    expect(panel("automation")?.style.display).toBe("none");
    expect(panel("general")?.style.display).not.toBe("none");

    // ...then a second notification for the SAME tab fires. `targetTab` is unchanged, so only the
    // bumped `navSeq` can carry the request.
    await wrapper.setProps({ navSeq: 1 });
    await settleAsyncSections();
    expect(panel("automation")?.style.display).not.toBe("none");
    expect(panel("general")?.style.display).toBe("none");

    wrapper.unmount();
  });

  it("ignores a navSeq bump that arrives while the panel is closed", async () => {
    const wrapper = mount(Settings, {
      props: { open: false, targetTab: "automation", navSeq: 0 },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await settleAsyncSections();

    await wrapper.setProps({ navSeq: 1 });
    await settleAsyncSections();
    // Nothing is mounted while closed; the tab must stay on General for the next open.
    expect(panel("automation")).toBeNull();
    expect(panel("general")).toBeNull();

    wrapper.unmount();
  });
});
