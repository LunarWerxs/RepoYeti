import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkdn", "mkd", "mdwn"]);
const renderer = new Renderer();

// Repository Markdown does not need an arbitrary-HTML escape hatch. Dropping raw HTML and images
// before sanitization also prevents embedded frames or tracking pixels from ever reaching the DOM.
renderer.html = () => "";
renderer.image = () => "";

export function isPreviewableMarkdown(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Render repository-authored Markdown without giving its raw HTML an execution surface. Images
 * are omitted for now: relative paths do not map to an authenticated repo asset URL, and remote
 * images would create an unexpected tracking request from every viewer. */
export function renderMarkdown(source: string): string {
  const raw = marked.parse(source, {
    async: false,
    gfm: true,
    breaks: false,
    renderer,
  }) as string;
  const safe = DOMPurify.sanitize(raw, {
    FORBID_TAGS: [
      "script",
      "style",
      "svg",
      "math",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "img",
    ],
    FORBID_ATTR: ["style"],
  });
  const template = document.createElement("template");
  template.innerHTML = safe;
  for (const link of template.content.querySelectorAll("a")) {
    const href = link.getAttribute("href")?.replace(/[\p{Cc}\s]+/gu, "") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else if (!href.startsWith("#")) {
      link.removeAttribute("href");
    }
  }
  return template.innerHTML;
}
