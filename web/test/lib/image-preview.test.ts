import { describe, expect, it } from "vitest";
import { isPreviewableImage } from "@/lib/image-preview";

describe("image preview classification", () => {
  it.each([
    "a.png",
    "A.JPEG",
    "anim.gif",
    "x.webp",
    "x.avif",
    "x.bmp",
    "x.ico",
    "x.apng",
    "x.SVG",
    "x.SVGZ",
  ])(
    "accepts browser-native image %s",
    (path) => {
      expect(isPreviewableImage(path)).toBe(true);
    },
  );

  it.each(["vector.eps", "art.ai", "drawing.emf", "scan.tiff", "photo.heic", "archive.bin", "png"])(
    "leaves unsupported or unsafe format %s in the normal viewer",
    (path) => {
      expect(isPreviewableImage(path)).toBe(false);
    },
  );
});
