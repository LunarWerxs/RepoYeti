/** Well-known OpenAI-compatible endpoints. Selecting one only fills the URL field. */
export const OPENAI_COMPATIBLE_PRESETS = [
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
  {
    id: "custom",
    label: "Custom",
    baseUrl: null,
  },
] as const;

export type CompatiblePresetId = (typeof OPENAI_COMPATIBLE_PRESETS)[number]["id"];

/** Keep the destination text readable while the daemon remains the source of truth for validation. */
export function displayCompatibleBaseUrl(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/** A typed lookup keeps presets as URL fillers, with no vendor-specific runtime behavior. */
export function compatiblePresetUrl(id: string): string | null {
  return OPENAI_COMPATIBLE_PRESETS.find((preset) => preset.id === id)?.baseUrl ?? null;
}

export function compatiblePresetForUrl(value: string): CompatiblePresetId {
  const url = displayCompatibleBaseUrl(value);
  return (
    OPENAI_COMPATIBLE_PRESETS.find(
      (preset) => preset.baseUrl !== null && displayCompatibleBaseUrl(preset.baseUrl) === url,
    )?.id ?? "custom"
  );
}

/**
 * UX-only mirror of the daemon's keyless-endpoint rule. The backend still validates the complete
 * URL before saving it; this only decides whether the Connect button may omit an API key.
 */
export function isLoopbackCompatibleBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    // URL.hostname retains IPv6 brackets in browsers/Node, so strip them before comparison.
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
    if (hostname === "::1") return true;

    const ipv4 = hostname.split(".");
    return (
      ipv4.length === 4 &&
      ipv4[0] === "127" &&
      ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    );
  } catch {
    return false;
  }
}
