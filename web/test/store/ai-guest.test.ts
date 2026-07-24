import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { useAi } from "@/store/ai";

describe("guest AI availability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("enables generation from the owner's two-bit capability projection", async () => {
    vi.spyOn(api.ai, "availability").mockResolvedValue({
      usable: true,
      commitEnabled: true,
    });
    const settings = vi.spyOn(api.ai, "settings");
    const ai = useAi({}, async () => {}, () => ({ ok: false, code: "ERROR" }));

    await ai.loadAiAvailability();

    expect(ai.aiUsable.value).toBe(true);
    expect(ai.aiCommitEnabled.value).toBe(true);
    expect(ai.aiReady.value).toBe(true);
    expect(settings).not.toHaveBeenCalled();
  });
});
