import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/api";
import AgentApprovalCard from "@/components/AgentApprovalCard.vue";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import type { ApprovalDetails, PendingApproval } from "@/types";

// ⭐ Agent Safety Rail, audit item 13: the card's summary line clips every argument at 80
// characters while the tool runs with the full original arguments, so an owner approving from the
// summary alone can't actually see what they're approving. These cover the on-demand full-request
// panel: it must not fetch until the owner asks for it, must fetch only once, and must degrade
// gracefully (the underlying call may already have resolved) without losing Approve/Deny.

function approval(patch: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "req-1",
    tool: "git_commit",
    repo: "RepoYeti",
    argsSummary: "message: fix the bug",
    requestedAt: Date.now(),
    expiresAt: 0,
    autoAction: null,
    ...patch,
  };
}

function approvalDetails(patch: Partial<ApprovalDetails> = {}): ApprovalDetails {
  const base = approval();
  return {
    ...base,
    request: { tool: base.tool, args: {}, truncated: false, hidden: [] },
    ...patch,
  };
}

function mountCard() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useStore();
  return { store, wrapper: mount(AgentApprovalCard, { global: { plugins: [pinia, i18n] } }) };
}

describe("AgentApprovalCard full-request detail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the summary and the show-request toggle without fetching the full request", async () => {
    const { store, wrapper } = mountCard();
    const details = vi.spyOn(api, "approvalDetails");
    store.pendingApprovals.push(approval());
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("fix the bug");
    const toggle = wrapper.findAll("button").find((b) => b.text() === i18n.global.t("approvals.showRequest"));
    expect(toggle).toBeDefined();
    expect(details).not.toHaveBeenCalled();
  });

  it("fetches once on first expand and renders a long value in full plus a hidden field and the truncated note", async () => {
    const { store, wrapper } = mountCard();
    const longMessage = `${"x".repeat(90)} end-of-message`;
    expect(longMessage.length).toBeGreaterThan(80);
    const details = vi.spyOn(api, "approvalDetails").mockResolvedValue(
      approvalDetails({
        request: {
          tool: "git_commit",
          args: { message: longMessage, token: "[hidden]" },
          truncated: true,
          hidden: ["token"],
        },
      }),
    );
    store.pendingApprovals.push(approval());
    await wrapper.vm.$nextTick();

    const toggle = () =>
      wrapper.findAll("button").find((b) => b.text() === i18n.global.t("approvals.showRequest") || b.text() === i18n.global.t("approvals.hideRequest"))!;
    await toggle().trigger("click");
    await flushPromises();

    expect(details).toHaveBeenCalledTimes(1);
    expect(details).toHaveBeenCalledWith("req-1");
    expect(wrapper.text()).toContain(longMessage);
    expect(wrapper.text()).toContain(i18n.global.t("approvals.hiddenValue"));
    expect(wrapper.text()).not.toContain("[hidden]");
    expect(wrapper.text()).toContain(i18n.global.t("approvals.truncated"));

    // Collapsing and re-expanding must not re-fetch.
    await toggle().trigger("click");
    await toggle().trigger("click");
    await flushPromises();
    expect(details).toHaveBeenCalledTimes(1);
  });

  it("shows the unavailable message on a failed fetch, keeping Approve/Deny", async () => {
    const { store, wrapper } = mountCard();
    vi.spyOn(api, "approvalDetails").mockRejectedValue(new ApiError(404, "Not Found", { code: "NOT_FOUND" }));
    store.pendingApprovals.push(approval());
    await wrapper.vm.$nextTick();

    const toggle = wrapper.findAll("button").find((b) => b.text() === i18n.global.t("approvals.showRequest"))!;
    await toggle.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain(i18n.global.t("approvals.requestUnavailable"));
    expect(wrapper.text()).toContain(i18n.global.t("approvals.approve"));
    expect(wrapper.text()).toContain(i18n.global.t("approvals.deny"));
  });
});
