import { describe, expect, it } from "vitest";
import { binaryPreviewKind, binaryPreviewUrl } from "@/lib/binary-preview";

describe("binary preview classification", () => {
  it.each([
    ["image.SVGZ", "image"],
    ["manual.PDF", "pdf"],
    ["song.mp3", "audio"],
    ["sound.wav", "audio"],
    ["sound.ogg", "audio"],
    ["sound.flac", "audio"],
    ["sound.m4a", "audio"],
    ["clip.mp4", "video"],
    ["clip.webm", "video"],
    ["clip.ogv", "video"],
  ] as const)("classifies %s as %s", (path, kind) => {
    expect(binaryPreviewKind(path)).toBe(kind);
  });

  it.each(["movie.avi", "movie.mkv", "movie.mov", "sound.aac", "vector.eps", "file.bin"])(
    "leaves %s in the normal viewer",
    (path) => {
      expect(binaryPreviewKind(path)).toBeNull();
    },
  );
});

describe("binaryPreviewUrl", () => {
  it("uses the working-tree route and representation kind", () => {
    expect(
      binaryPreviewUrl({ repoId: "repo/id", path: "docs/my file.pdf" }, "pdf"),
    ).toBe("/api/repos/repo%2Fid/file?path=docs%2Fmy%20file.pdf&preview=pdf");
  });

  it("uses the history route for commit targets", () => {
    expect(
      binaryPreviewUrl(
        { repoId: "repo", path: "media/clip.webm", commit: "abc/123" },
        "video",
      ),
    ).toBe("/api/repos/repo/commit/abc%2F123/file?path=media%2Fclip.webm&preview=video");
  });
});
