// Regression for F049: the dirty-diff gutter colours were declared in a `:root` block inside
// `<style scoped>`, which Vue scopes to `:root[data-v-…]` — a selector that never matches <html>,
// so `var(--color-3fb950)` & co. resolved to nothing and the markers rendered transparent. The
// tokens must live on an element Monaco's decoration nodes actually descend from (the host div).
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileStyle } from "@vue/compiler-sfc";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import MonacoViewer from "@/components/MonacoViewer.vue";

const monacoMock = vi.hoisted(() => {
  const state: { value: string; alternativeVersion: number; listener?: () => void } = {
    value: "initial",
    alternativeVersion: 1,
  };
  const model = {
    getValue: vi.fn(() => state.value),
    setValue: vi.fn((value: string) => {
      state.value = value;
      state.alternativeVersion++;
      state.listener?.();
    }),
    getAlternativeVersionId: vi.fn(() => state.alternativeVersion),
    setEOL: vi.fn(),
    dispose: vi.fn(),
  };
  const editor = {
    onDidChangeModelContent: vi.fn((listener: () => void) => {
      state.listener = listener;
      return { dispose: vi.fn() };
    }),
    deltaDecorations: vi.fn(() => []),
    updateOptions: vi.fn(),
    setModel: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
  };
  const api = {
    Uri: { file: vi.fn((path: string) => ({ path })) },
    Range: class {},
    editor: {
      OverviewRulerLane: { Left: 1 },
      getModel: vi.fn(() => null),
      createModel: vi.fn(() => model),
      create: vi.fn(() => editor),
      setTheme: vi.fn(),
    },
  };
  return { state, api };
});

vi.mock("@/lib/monaco-setup", () => ({
  getMonaco: vi.fn(async () => monacoMock.api),
  monacoThemeFor: vi.fn(() => "vs-dark"),
}));

const SOURCE = readFileSync(resolve(__dirname, "../../src/components/MonacoViewer.vue"), "utf8");
const STYLE = /<style[^>]*>([\s\S]*?)<\/style>/.exec(SOURCE)?.[1] ?? "";

describe("MonacoViewer dirty-diff gutter colours", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the colour tokens to the editor host, not to a dead :root selector", () => {
    const { code } = compileStyle({
      source: STYLE,
      filename: "MonacoViewer.vue",
      id: "data-v-gutter",
      scoped: true,
    });
    const selectors = code.replace(/\/\*[\s\S]*?\*\//g, ""); // drop comments; only selectors matter
    // `:root` inside a scoped block becomes `:root[data-v-…]`, which matches no element.
    expect(selectors).not.toMatch(/:root/);
    expect(selectors).toMatch(/\.dirty-gutter-host\[data-v-gutter\]\s*\{[^}]*--color-3fb950:\s*#3fb950/);
    expect(selectors).toContain("--color-58a6ff: #58a6ff");
    expect(selectors).toContain("--color-f85149: #f85149");
  });

  it("puts the token-declaring class on the element Monaco decorations live inside", async () => {
    const wrapper = mount(MonacoViewer, {
      props: { value: "initial", filename: "x.ts", theme: "dark", changedLines: [] },
    });
    await vi.waitFor(() => {
      expect(monacoMock.api.editor.create).toHaveBeenCalled();
    });
    const host = wrapper.find(".dirty-gutter-host");
    expect(host.exists()).toBe(true);
    expect(host.attributes("class")).toContain("dirty-gutter-host");
    wrapper.unmount();
  });
});
