import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import { i18n } from "@/i18n";
import { api } from "@/api";
import { useStore } from "@/store";
import type { Repo } from "@/types";
import RepoManage from "@/components/RepoManage.vue";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
import { toast } from "vue-sonner";

// The daemon has answered POST /api/repos/:id/tag/push since the tag-push account fix, and until
// this the dashboard had no way to call it: a tag created locally whose push failed could only be
// pushed from a terminal. These pin the two ways the dialog now reaches it.

const TAG = { name: "v1.2.0", subject: "release", date: 1_700_000_000 };

let wrapper: ReturnType<typeof mount> | undefined;

async function mountDialog(remote: string | null = "git@github.com:me/repo.git") {
  wrapper = mount(RepoManage, {
    props: { repoId: "repo-1", remote, open: false },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  await wrapper.setProps({ open: true });
  await vi.waitFor(() => expect(api.tags).toHaveBeenCalled());
  await nextTick();
  return wrapper;
}

function buttonsIn(root: ParentNode, text: string): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")].filter((b) => b.textContent?.includes(text)) as HTMLButtonElement[];
}

describe("RepoManage.vue tag push", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    // The store drops reads for a repo it does not hold, so the dialog's repo has to be listed.
    useStore().repos.push({ id: "repo-1", name: "repo-1", absPath: "D:/repo-1", vcs: "git", status: null } as unknown as Repo);
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("pushes one listed tag through the push route", async () => {
    vi.spyOn(api, "tags").mockResolvedValue({ ok: true, code: "OK", tags: [TAG] } as never);
    const push = vi.spyOn(api, "pushTag").mockResolvedValue({ ok: true, code: "OK", message: "tag pushed" } as never);
    await mountDialog();

    const button = await vi.waitFor(() => {
      const b = buttonsIn(document.body, "Push")[0];
      expect(b).toBeTruthy();
      return b!;
    });
    expect(button.getAttribute("aria-label")).toBe("Push v1.2.0 to origin");
    button.click();
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("repo-1", "v1.2.0"));
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Tag pushed"));
  });

  it("offers no per-tag push when the repo has no remote", async () => {
    vi.spyOn(api, "tags").mockResolvedValue({ ok: true, code: "OK", tags: [TAG] } as never);
    await mountDialog(null);
    await vi.waitFor(() => expect(document.body.textContent).toContain("v1.2.0"));
    expect(buttonsIn(document.body, "Push")).toHaveLength(0);
  });

  it("a create whose push half failed offers Retry push, and the retry pushes that tag", async () => {
    // The first list is empty; after the create the reload shows the tag, i.e. the local half landed.
    vi.spyOn(api, "tags")
      .mockResolvedValueOnce({ ok: true, code: "OK", tags: [] } as never)
      .mockResolvedValue({ ok: true, code: "OK", tags: [TAG] } as never);
    vi.spyOn(api, "createTag").mockResolvedValue({
      ok: false,
      code: "NETWORK_TIMEOUT",
      message: "tag created locally, but push failed: timed out",
    } as never);
    const push = vi.spyOn(api, "pushTag").mockResolvedValue({ ok: true, code: "OK" } as never);
    await mountDialog();

    const name = document.body.querySelector('input[placeholder="v1.0.0"]') as HTMLInputElement;
    name.value = "v1.2.0";
    name.dispatchEvent(new Event("input"));
    const checkbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await nextTick();
    (document.body.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit"));

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [message, opts] = vi.mocked(toast.error).mock.calls[0]! as [string, { action?: { label: string; onClick: () => void } }];
    expect(message).toContain("push failed");
    expect(opts.action?.label).toBe("Retry push");
    opts.action!.onClick();
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("repo-1", "v1.2.0"));
  });

  it("a create that failed outright offers no retry", async () => {
    vi.spyOn(api, "tags").mockResolvedValue({ ok: true, code: "OK", tags: [] } as never);
    vi.spyOn(api, "createTag").mockResolvedValue({ ok: false, code: "INVALID_REF_NAME", message: "invalid tag name" } as never);
    await mountDialog();

    const name = document.body.querySelector('input[placeholder="v1.0.0"]') as HTMLInputElement;
    name.value = "bad..name";
    name.dispatchEvent(new Event("input"));
    await nextTick();
    (document.body.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit"));

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    const opts = vi.mocked(toast.error).mock.calls[0]![1] as { action?: unknown } | undefined;
    expect(opts?.action).toBeUndefined();
  });
});
