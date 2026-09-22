import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vue-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "vue-sonner";
import { ApiError } from "@/lib/httpClient";
import { toastUpdateFailure, updateFailureLog } from "@/lib/update-failure";

// A failed self-update used to reach the owner as one toast line (RepoYeti issue #24). The daemon
// now answers with the build transcript, and both update entry points offer it as "Copy build log".

const t = (key: string) => key;

describe("update failure transcript", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the transcript the daemon sent back", () => {
    const e = new ApiError(500, "build failed", {
      code: "ERROR",
      body: { ok: false, code: "ERROR", message: "build failed", output: ["$ git pull\nok", "$ bun run build\nerror: boom"] },
    });
    expect(updateFailureLog(e)).toBe("$ git pull\nok\n\n$ bun run build\nerror: boom");
  });

  it("has nothing to offer for a transport error or an empty transcript", () => {
    expect(updateFailureLog(new Error("offline"))).toBeNull();
    expect(updateFailureLog(new ApiError(500, "x", { body: { output: [] } }))).toBeNull();
    expect(updateFailureLog(new ApiError(500, "x", { body: { message: "x" } }))).toBeNull();
  });

  it("offers a copy action only when there is a transcript, and copying it works", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const e = new ApiError(500, "build failed", { body: { output: ["$ bun run build\nerror: boom"] } });
    toastUpdateFailure("title", e, t);
    const opts = vi.mocked(toast.error).mock.calls[0]![1] as { description?: string; action?: { onClick: () => void } };
    expect(opts.description).toBe("build failed");
    opts.action!.onClick();
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("notify.updateLogCopied"));
    expect(writeText).toHaveBeenCalledWith("$ bun run build\nerror: boom");

    vi.clearAllMocks();
    toastUpdateFailure("title", new Error("offline"), t);
    const plain = vi.mocked(toast.error).mock.calls[0]![1] as { action?: unknown };
    expect(plain.action).toBeUndefined();
  });
});
