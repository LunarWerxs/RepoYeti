import { describe, expect, it } from "vitest";
import { isPreviewableMarkdown, renderMarkdown } from "@/lib/markdown-preview";

describe("Markdown preview classification", () => {
  it.each(["README.md", "notes.MARKDOWN", "guide.mdown", "file.mkdn", "file.mkd", "file.mdwn"])(
    "accepts %s",
    (path) => expect(isPreviewableMarkdown(path)).toBe(true),
  );

  it.each(["component.mdx", "README", "notes.txt"])("does not render %s", (path) => {
    expect(isPreviewableMarkdown(path)).toBe(false);
  });
});

describe("renderMarkdown", () => {
  it("renders common GFM content", () => {
    const html = renderMarkdown("# Heading\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("Heading");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<table>");
  });

  it("removes active, embedded, styled, and tracking content", () => {
    const html = renderMarkdown(
      [
        '<script>alert("x")</script>',
        "",
        '<iframe src="https://example.com"></iframe>',
        "",
        '<div style="color:red" onclick="alert(1)">discarded HTML</div>',
        "",
        "safe text",
        "",
        "![tracker](https://example.com/pixel.png)",
        "",
        "[bad](javascript:alert(1))",
      ].join("\n"),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("safe text");
  });

  it("opens links outside the app without exposing the opener", () => {
    const html = renderMarkdown("[docs](https://example.com/docs)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
