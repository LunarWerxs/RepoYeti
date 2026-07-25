import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { useAi } from "@/store/ai";
import type { ActionName, ActionResult, AiSettings } from "@/types";

const settings: AiSettings = {
  providers: {
    compatible: {
      configured: true,
      model: "acme/chat",
      baseUrl: "https://models.example.test/v1",
    },
  },
  defaultProvider: "compatible",
  style: "conventional",
  diffDetail: "lean",
  yolo: false,
  commitEnabled: true,
};

function aiStore() {
  return useAi(
    {} as Record<string, ActionName | undefined>,
    async () => {},
    (error): ActionResult => ({
      ok: false,
      code: "ERROR",
      message: String(error),
    }),
  );
}

describe("AI store — OpenAI-compatible provider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes the base URL and manual model once while keeping the key out of state", async () => {
    const connect = vi.spyOn(api.ai, "connect").mockResolvedValue({
      ok: true,
      models: [{ id: "acme/chat", label: "acme/chat" }],
      discoveryAvailable: false,
      settings,
    });
    const store = aiStore();

    await expect(
      store.connectProvider("compatible", "secret-key", {
        baseUrl: "https://models.example.test/v1",
        model: "acme/chat",
      }),
    ).resolves.toEqual({
      models: [{ id: "acme/chat", label: "acme/chat" }],
      discoveryAvailable: false,
    });
    expect(connect).toHaveBeenCalledWith("compatible", "secret-key", {
      baseUrl: "https://models.example.test/v1",
      model: "acme/chat",
    });
    expect(store.aiSettings.value).toEqual(settings);
    expect(JSON.stringify(store.aiSettings.value)).not.toContain("secret-key");
  });

  it("preserves the discovery availability returned with a model refresh", async () => {
    vi.spyOn(api.ai, "models").mockResolvedValue({
      ok: true,
      models: [{ id: "acme/chat", label: "acme/chat" }],
      discoveryAvailable: false,
    });
    const store = aiStore();

    await expect(store.listProviderModels("compatible")).resolves.toEqual({
      models: [{ id: "acme/chat", label: "acme/chat" }],
      discoveryAvailable: false,
    });
  });
});
