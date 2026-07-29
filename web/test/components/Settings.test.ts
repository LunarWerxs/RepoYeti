import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import Settings from "@/components/Settings.vue";
import { i18n } from "@/i18n";

const lazySections = vi.hoisted(() => {
  const loads: Record<string, number> = {};
  const mounts: Record<string, number> = {};
  return {
    loads,
    mounts,
    module(name: string) {
      loads[name] = (loads[name] ?? 0) + 1;
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

describe("Settings lazy tabs", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    for (const values of [lazySections.loads, lazySections.mounts]) {
      for (const key of Object.keys(values)) delete values[key];
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("loads and mounts only the active tab's sections", async () => {
    const wrapper = mount(Settings, {
      props: { open: true },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await settleAsyncSections();

    expect(document.body.querySelector('[data-settings-tab="general"]')).not.toBeNull();
    expect(lazySections.loads).toEqual({ appearance: 1, discovery: 1, updates: 1 });
    expect(lazySections.mounts).toEqual({ appearance: 1, discovery: 1, updates: 1 });

    const automation = tabButton(i18n.global.t("settings.tabs.automation"));
    expect(automation).toBeDefined();
    automation!.click();
    await settleAsyncSections();

    const generalPanel = document.body.querySelector<HTMLElement>('[data-settings-tab="general"]');
    const automationPanel = document.body.querySelector<HTMLElement>('[data-settings-tab="automation"]');
    expect(generalPanel?.style.display).toBe("none");
    expect(automationPanel?.style.display).not.toBe("none");
    expect(lazySections.loads).toEqual({
      appearance: 1,
      discovery: 1,
      updates: 1,
      "auto-commit": 1,
      "background-sync": 1,
      "ai-providers": 1,
    });
    expect(lazySections.mounts).toEqual(lazySections.loads);

    // Returning to a visited tab reuses its mounted forms: module and mount counts stay put.
    tabButton(i18n.global.t("settings.tabs.general"))!.click();
    await settleAsyncSections();
    expect(generalPanel?.style.display).not.toBe("none");
    expect(automationPanel?.style.display).toBe("none");
    expect(lazySections.mounts).toEqual(lazySections.loads);

    wrapper.unmount();
  });

  it("honors a deep-link when first mounted open without loading the default tab", async () => {
    const wrapper = mount(Settings, {
      props: { open: true, targetTab: "automation" },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await settleAsyncSections();

    expect(document.body.querySelector('[data-settings-tab="general"]')).toBeNull();
    expect(document.body.querySelector('[data-settings-tab="automation"]')).not.toBeNull();
    // The async wrapper may already have cached its resolved module from the previous test, but
    // only the deep-linked tab's component instances may mount.
    expect(lazySections.mounts).toEqual({
      "auto-commit": 1,
      "background-sync": 1,
      "ai-providers": 1,
    });

    wrapper.unmount();
  });

  it("keeps experimental servers behind the lazy Advanced tab", async () => {
    const wrapper = mount(Settings, {
      props: { open: true },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await settleAsyncSections();
    expect(lazySections.mounts["experimental-servers"]).toBeUndefined();

    tabButton(i18n.global.t("settings.tabs.advanced"))!.click();
    await settleAsyncSections();

    expect(document.body.querySelector('[data-settings-tab="advanced"]')).not.toBeNull();
    expect(lazySections.mounts["experimental-servers"]).toBe(1);

    wrapper.unmount();
  });
});
