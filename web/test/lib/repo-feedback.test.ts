import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";

// vue-sonner's toast is mocked so toastResult's success/error dispatch can be asserted (audit #19).
vi.mock("vue-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import { useRepoFeedback } from "@/lib/repo-feedback";

// useRepoFeedback() calls useI18n(), so it must run inside a component setup with the i18n plugin.
function feedback(): ReturnType<typeof useRepoFeedback> {
  let api!: ReturnType<typeof useRepoFeedback>;
  mount(
    defineComponent({
      setup() {
        api = useRepoFeedback();
        return () => null;
      },
    }),
    { global: { plugins: [i18n] } },
  );
  return api;
}

const T = (key: string) => i18n.global.t(key);

describe("useRepoFeedback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("friendly() maps every code the panels rely on to a non-empty translated sentence", () => {
    const { friendly } = feedback();
    const codes = [
      "DIRTY_WORKING_TREE",
      "NON_FAST_FORWARD",
      "NO_UPSTREAM",
      "BRANCH_EXISTS",
      "PROTECTED_BRANCH",
      "CANNOT_DELETE_CURRENT",
      "STASH_CONFLICT",
      "DISCARD_FAILED",
    ];
    for (const code of codes) expect(friendly(code).length).toBeGreaterThan(0);
    // and it's the actual translation, not just any non-empty string
    expect(friendly("PROTECTED_BRANCH")).toBe(T("repo.err.protectedBranch"));
  });

  it("friendly() returns '' for an unknown code (caller falls back to r.message)", () => {
    expect(feedback().friendly("SOME_UNKNOWN_CODE")).toBe("");
  });

  it("toastResult() shows the result message via toast.success on ok", () => {
    feedback().toastResult({ ok: true, code: "OK", message: "committed" }, "fallback");
    expect(toast.success).toHaveBeenCalledWith("committed");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toastResult() shows the FRIENDLY message via toast.error on failure (not the raw code)", () => {
    feedback().toastResult({ ok: false, code: "PROTECTED_BRANCH", message: "raw error" }, "s");
    expect(toast.error).toHaveBeenCalledWith(T("repo.err.protectedBranch"));
  });
});
