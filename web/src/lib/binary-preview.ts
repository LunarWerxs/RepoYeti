import type { ViewerTarget } from "@/lib/file-viewer";
import { isPreviewableImage } from "@/lib/image-preview";

export type BinaryPreviewKind = "image" | "pdf" | "audio" | "video";

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "oga", "ogg", "opus", "flac", "m4a"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "ogv"]);

function extension(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function binaryPreviewKind(path: string): BinaryPreviewKind | null {
  if (isPreviewableImage(path)) return "image";
  const ext = extension(path);
  if (ext === "pdf") return "pdf";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

/** Same authenticated route as the text viewer, with an explicit representation query. */
export function binaryPreviewUrl(target: ViewerTarget, kind: BinaryPreviewKind): string {
  const repo = encodeURIComponent(target.repoId);
  const path = encodeURIComponent(target.path);
  if (target.commit) {
    return `/api/repos/${repo}/commit/${encodeURIComponent(target.commit)}/file?path=${path}&preview=${kind}`;
  }
  return `/api/repos/${repo}/file?path=${path}&preview=${kind}`;
}
