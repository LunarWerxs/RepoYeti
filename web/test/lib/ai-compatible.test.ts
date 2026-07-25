import { describe, expect, it } from "vitest";
import {
  OPENAI_COMPATIBLE_PRESETS,
  compatiblePresetForUrl,
  compatiblePresetUrl,
  displayCompatibleBaseUrl,
  isLoopbackCompatibleBaseUrl,
} from "@/lib/ai-compatible";

describe("OpenAI-compatible endpoint presets", () => {
  it("contains only the requested URL fillers plus Custom", () => {
    expect(OPENAI_COMPATIBLE_PRESETS).toEqual([
      {
        id: "hugging-face",
        label: "Hugging Face Router",
        baseUrl: "https://router.huggingface.co/v1",
      },
      {
        id: "dashscope-us",
        label: "DashScope US",
        baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      },
      {
        id: "dashscope-singapore",
        label: "DashScope Singapore",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
      {
        id: "dashscope-china",
        label: "DashScope China",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      { id: "custom", label: "Custom", baseUrl: null },
    ]);
  });

  it("treats presets as simple base-URL lookups", () => {
    expect(compatiblePresetUrl("hugging-face")).toBe("https://router.huggingface.co/v1");
    expect(compatiblePresetUrl("custom")).toBeNull();
    expect(compatiblePresetUrl("unknown")).toBeNull();
  });

  it("matches a pasted preset URL without changing custom URLs", () => {
    expect(compatiblePresetForUrl(" https://router.huggingface.co/v1/ ")).toBe("hugging-face");
    expect(compatiblePresetForUrl("https://models.example.test/v1")).toBe("custom");
    expect(displayCompatibleBaseUrl(" https://models.example.test/v1/// ")).toBe(
      "https://models.example.test/v1",
    );
  });

  it("recognizes only HTTP(S) localhost, localhost subdomains, 127/8, and IPv6 loopback", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "https://models.localhost/v1",
      "http://127.0.0.1:8080/v1",
      "https://127.255.10.2/v1",
      "http://[::1]:1234/v1",
      "https://[0:0:0:0:0:0:0:1]/v1",
    ]) {
      expect(isLoopbackCompatibleBaseUrl(url), url).toBe(true);
    }

    for (const url of [
      "",
      "localhost:11434/v1",
      "ftp://localhost/v1",
      "https://localhost.example.com/v1",
      "https://127.0.0.1.example.com/v1",
      "https://128.0.0.1/v1",
      "https://[::2]/v1",
      "https://models.example.test/v1",
    ]) {
      expect(isLoopbackCompatibleBaseUrl(url), url).toBe(false);
    }
  });
});
