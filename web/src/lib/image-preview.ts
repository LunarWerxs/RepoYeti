/** Image formats decoded consistently by the browsers RepoYeti supports. SVG is loaded only through
 * an <img> from a CSP-sandboxed response, keeping repository-authored scripts inert. */
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  "png",
  "apng",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
  "svgz",
]);

export function isPreviewableImage(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && PREVIEWABLE_IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
