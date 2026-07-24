// Regression cover for the per-row "Copy link" button in SharingSection.vue.
//
// The copy button on an existing share row is how an owner gets back to a link they already handed
// out: the daemon retains the secret and returns a server-built URL on the owner-only list. So this
// button has two ways to fail silently:
//   · a row whose share predates URL retention (`url: null`) must show Copy DISABLED with the
//     "made before RepoYeti kept links" tooltip — if it renders enabled instead, clicking it
//     copies nothing (or worse, undefined) and the owner doesn't find out until they paste a
//     dead link at someone;
//   · clicking one row's button must copy THAT row's url and flip THAT row's icon to a check —
//     `copiedRow` is a single share id, not a boolean, precisely so two rows can never both look
//     "just copied." A mixed-up row here means the owner unknowingly sends the wrong link.
// A row is also disabled once its share has expired (`live: false`), even if it still carries a
// url — an expired share's copy button offering a "working" link would be its own kind of lie.
//
// Mounted the same way LogPanel.test.ts / AppHeader.test.ts wrap Tooltip-bearing components: a
// tiny host component supplies TooltipProvider, since SharingSection's row actions are Tooltip
// triggers, not plain buttons.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import { api } from "@/api";
import SharingSection from "@/components/settings/SharingSection.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Share } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

function share(patch: Partial<Share> = {}): Share {
  return {
    id: "s1",
    label: "share",
    perm: "view",
    collaborative: true,
    scopeAll: true,
    repoIds: [],
    createdAt: 0,
    expiresAt: null,
    lastUsedAt: null,
    useCount: 0,
    live: true,
    origin: "https://example.com",
    stale: false,
    url: "https://example.com/r/token",
    ...patch,
  };
}

// Three rows, one per way the Copy button can differ: a normal live link, a live link minted
// before the daemon retained secrets (`url: null`), and an expired link that still has a url.
const withUrl = share({ id: "s-live-url", label: "Live with URL", url: "https://example.com/r/live-url" });
const noUrl = share({ id: "s-live-no-url", label: "Live, no URL", url: null });
const expired = share({
  id: "s-expired",
  label: "Expired",
  live: false,
  url: "https://example.com/r/expired-url",
});

let activeWrapper: ReturnType<typeof mount> | undefined;

// `props: { open: true }` is load-bearing: SharingSection's loader is wired to a `watch(() =>
// props.open, ..., { immediate: true })` (see the component's own comment on why — the Settings
// sheet only mounts its content once already open), so this is what makes it call api.listShares()
// at all instead of sitting on "No share links yet."
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

/** Let the loader's awaited api.listShares() resolve and the resulting re-render settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** The row-level Copy buttons, in share-list order — picked out by aria-label so the neighbouring
 *  Edit/Regenerate/Revoke icon buttons on the same row never get swept in. */
function copyButtons(wrapper: ReturnType<typeof mountSharing>) {
  const copyLabel = i18n.global.t("share.copyLink");
  const unavailableLabel = i18n.global.t("share.copyUnavailable");
  return wrapper
    .findAll("button")
    .filter((b) => [copyLabel, unavailableLabel].includes(b.attributes("aria-label") ?? ""));
}

describe("SharingSection.vue — per-row Copy link button", () => {
  it("does not tell the owner a retained link is a one-shot secret", () => {
    expect(i18n.global.t("share.readyOnce")).toContain("use Copy link on this row");
    expect(i18n.global.t("share.readyOnce")).not.toContain("only time");
    expect(i18n.global.t("share.readyOnce")).not.toContain("revoke");
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(api, "collaborationLinks").mockResolvedValue({ links: [] });
    // Stubbed fresh each test: happy-dom has no real clipboard, and SharingSection calls
    // navigator.clipboard.writeText directly (see copyRowLink in the component).
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("shows the panel only in remote mode, and enables/disables each row's Copy button exactly per url + live state", async () => {
    const store = useStore();
    store.mode = "local"; // isRemote is false — the panel must not render its share list at all
    vi.spyOn(api, "listShares").mockResolvedValue({ shares: [withUrl, noUrl, expired] });

    const wrapper = mountSharing();
    await flush();

    expect(wrapper.text()).toContain(i18n.global.t("share.needsRemote"));
    expect(wrapper.text()).not.toContain(withUrl.label);
    expect(copyButtons(wrapper)).toHaveLength(0);
  });

  it("in remote mode: live+url enabled, live+no-url disabled, expired+url disabled", async () => {
    const store = useStore();
    store.mode = "remote";
    vi.spyOn(api, "listShares").mockResolvedValue({ shares: [withUrl, noUrl, expired] });

    const wrapper = mountSharing();
    await flush();

    // All three rows made it onto the page (sanity check before inspecting their buttons).
    expect(wrapper.text()).toContain(withUrl.label);
    expect(wrapper.text()).toContain(noUrl.label);
    expect(wrapper.text()).toContain(expired.label);

    const buttons = copyButtons(wrapper);
    expect(buttons).toHaveLength(3); // one Copy button per row, in list order

    const [liveUrlBtn, liveNoUrlBtn, expiredBtn] = buttons;

    // Live share with a url: enabled, labelled as a real copy action.
    expect((liveUrlBtn!.element as HTMLButtonElement).disabled).toBe(false);
    expect(liveUrlBtn!.attributes("aria-label")).toBe(i18n.global.t("share.copyLink"));

    // Live share minted before url retention: disabled, and the tooltip/aria-label says why —
    // must NOT just vanish (see SharingSection.vue's own comment on this exact point).
    expect((liveNoUrlBtn!.element as HTMLButtonElement).disabled).toBe(true);
    expect(liveNoUrlBtn!.attributes("aria-label")).toBe(i18n.global.t("share.copyUnavailable"));

    // Expired share that still carries a url: disabled by `!s.live`, even though it "has" a url —
    // an expired link isn't a real copy target.
    expect((expiredBtn!.element as HTMLButtonElement).disabled).toBe(true);
    expect(expiredBtn!.attributes("aria-label")).toBe(i18n.global.t("share.copyLink"));
  });

  it("clicking the enabled row copies exactly that row's url and flips only that row's icon to a check", async () => {
    const store = useStore();
    store.mode = "remote";
    vi.spyOn(api, "listShares").mockResolvedValue({ shares: [withUrl, noUrl, expired] });

    const wrapper = mountSharing();
    await flush();

    const [liveUrlBtn, liveNoUrlBtn, expiredBtn] = copyButtons(wrapper);

    // Before any click: every row still shows the plain Copy glyph.
    expect(liveUrlBtn!.find("svg.lucide-copy-icon").exists()).toBe(true);
    expect(liveUrlBtn!.find("svg.lucide-check-icon").exists()).toBe(false);

    await liveUrlBtn!.trigger("click");
    await flush();

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(withUrl.url);

    // Only the clicked row swapped to the check — copiedRow is a single share id, so the other
    // two rows (one disabled-no-url, one disabled-expired) must still show Copy, not Check.
    expect(liveUrlBtn!.find("svg.lucide-check-icon").exists()).toBe(true);
    expect(liveNoUrlBtn!.find("svg.lucide-check-icon").exists()).toBe(false);
    expect(liveNoUrlBtn!.find("svg.lucide-copy-icon").exists()).toBe(true);
    expect(expiredBtn!.find("svg.lucide-check-icon").exists()).toBe(false);
    expect(expiredBtn!.find("svg.lucide-copy-icon").exists()).toBe(true);
  });

  it("a disabled row's Copy button is inert — no click reaches the disabled-but-url-bearing expired row", async () => {
    const store = useStore();
    store.mode = "remote";
    vi.spyOn(api, "listShares").mockResolvedValue({ shares: [withUrl, noUrl, expired] });

    const wrapper = mountSharing();
    await flush();

    const [, , expiredBtn] = copyButtons(wrapper);
    await expiredBtn!.trigger("click");
    await flush();

    // A native `disabled` button doesn't dispatch click to its handler — nothing should have been
    // copied, and the row stays on the plain Copy glyph.
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(expiredBtn!.find("svg.lucide-check-icon").exists()).toBe(false);
  });
});
