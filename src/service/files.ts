/**
 * File-viewer backend: read one changed file's contents, write an edited file back to the
 * working tree, and the Diff-tab models/patch reader. All untrusted-path safe — every
 * request path is normalised and confined to the repo (no `../` escapes). Plus the runtime
 * settings for the patch-vs-models diff threshold (mirrored from the owner config at boot).
 */
import { lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathWithin, normalizeRelPath } from "../paths.ts";
import { getRepo } from "../db.ts";
import { gitFor, safeGitEnv } from "../git.ts";
import { backendFor } from "../vcs/index.ts";

/** A single file's contents for the read-only source-control viewer. */
export interface FileContentResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  /** Repo-relative path (normalised to forward slashes). */
  path?: string;
  /** UTF-8 text, or "" when binary. Truncated to MAX_FILE_BYTES if oversized. */
  content?: string;
  /** True when the bytes look binary — `content` is empty and the UI shows a notice. */
  binary?: boolean;
  /** True when the file exceeded the size cap and `content` is only its head. */
  truncated?: boolean;
  /** Byte size of the source (working-tree file, or the HEAD blob). */
  size?: number;
  /** Which revision the bytes came from — "head" means the working file was gone (deleted). */
  ref?: "work" | "head";
}

/** Cap how much we ship to the browser editor — big enough for real source, small
 *  enough that Monaco stays snappy and we never stream a multi-MB blob to a phone. */
const MAX_FILE_BYTES = 2_000_000;

/** A NUL byte in the head of the file is the cheap, git-style "this is binary" signal. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Browser-native image formats the viewer can safely serve through an <img>. TIFF/HEIC are not
 * decoded consistently enough across supported browsers. SVG is kept in image context and served
 * with a sandboxed CSP by the HTTP route, so repository-authored scripts cannot execute. */
const IMAGE_PREVIEW_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  apng: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  svgz: "image/svg+xml",
};

export type BinaryPreviewKind = "image" | "pdf" | "audio" | "video";

interface PreviewDescriptor {
  kind: BinaryPreviewKind;
  contentType: string;
}

const DOCUMENT_MEDIA_PREVIEW_TYPES: Readonly<Record<string, PreviewDescriptor>> = {
  pdf: { kind: "pdf", contentType: "application/pdf" },
  mp3: { kind: "audio", contentType: "audio/mpeg" },
  wav: { kind: "audio", contentType: "audio/wav" },
  oga: { kind: "audio", contentType: "audio/ogg" },
  ogg: { kind: "audio", contentType: "audio/ogg" },
  opus: { kind: "audio", contentType: "audio/ogg" },
  flac: { kind: "audio", contentType: "audio/flac" },
  m4a: { kind: "audio", contentType: "audio/mp4" },
  mp4: { kind: "video", contentType: "video/mp4" },
  m4v: { kind: "video", contentType: "video/mp4" },
  webm: { kind: "video", contentType: "video/webm" },
  ogv: { kind: "video", contentType: "video/ogg" },
};

/** Binary previews bypass Monaco, so keep the bytes bounded before shipping them to a browser.
 * SVGZ is also bounded after decompression. */
const MAX_BINARY_PREVIEW_BYTES = 25 * 1024 * 1024;

function pathExtension(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function imagePreviewType(path: string): string | null {
  return IMAGE_PREVIEW_TYPES[pathExtension(path)] ?? null;
}

function binaryPreviewDescriptor(path: string, expectedKind: BinaryPreviewKind): PreviewDescriptor | null {
  const imageType = imagePreviewType(path);
  const descriptor = imageType
    ? { kind: "image" as const, contentType: imageType }
    : DOCUMENT_MEDIA_PREVIEW_TYPES[pathExtension(path)];
  return descriptor?.kind === expectedKind ? descriptor : null;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    let head = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, Math.min(bytes.length, 16_384)))
      .replace(/^\uFEFF/, "")
      .trimStart();
    // Keep the accepted subset deliberately image-like. DTD/entities and stylesheet processing
    // instructions are unnecessary for normal SVG art and create avoidable parser/network edges.
    if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(head)) return false;
    for (let i = 0; i < 32; i++) {
      const prefix =
        head.match(/^<\?xml(?:\s[\s\S]*?)?\?>\s*/i)?.[0] ??
        head.match(/^<!--[\s\S]*?-->\s*/)?.[0];
      if (!prefix) break;
      head = head.slice(prefix.length);
    }
    return /^<svg(?:\s|>)/i.test(head);
  } catch {
    return false;
  }
}

/** Do not trust an extension alone. Besides preventing renamed HTML from being served under an
 * image MIME, this turns corrupt/partial images into a clear unsupported-preview response. */
function matchesImageSignature(bytes: Uint8Array, contentType: string): boolean {
  switch (contentType) {
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        asciiAt(bytes, 1, "PNG") &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a");
    case "image/webp":
      return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP");
    case "image/avif": {
      if (!asciiAt(bytes, 4, "ftyp")) return false;
      const brands = new TextDecoder("ascii").decode(bytes.subarray(8, Math.min(bytes.length, 40)));
      return brands.includes("avif") || brands.includes("avis");
    }
    case "image/bmp":
      return asciiAt(bytes, 0, "BM");
    case "image/x-icon":
      return (
        bytes.length >= 4 &&
        bytes[0] === 0 &&
        bytes[1] === 0 &&
        bytes[2] === 1 &&
        bytes[3] === 0
      );
    case "image/svg+xml":
      return looksLikeSvg(bytes);
    default:
      return false;
  }
}

function hasIsoBmffType(bytes: Uint8Array): boolean {
  return asciiAt(bytes, 4, "ftyp");
}

function matchesDocumentMediaSignature(bytes: Uint8Array, contentType: string): boolean {
  switch (contentType) {
    case "application/pdf":
      return new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 1024))).includes("%PDF-");
    case "audio/mpeg":
      return (
        asciiAt(bytes, 0, "ID3") ||
        (bytes.length >= 2 &&
          bytes[0] === 0xff &&
          (bytes[1]! & 0xe0) === 0xe0 &&
          (bytes[1]! & 0x06) !== 0)
      );
    case "audio/wav":
      return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE");
    case "audio/ogg":
    case "video/ogg":
      return asciiAt(bytes, 0, "OggS");
    case "audio/flac":
      return asciiAt(bytes, 0, "fLaC");
    case "audio/mp4":
    case "video/mp4":
      return hasIsoBmffType(bytes);
    case "video/webm":
      return (
        bytes.length >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3 &&
        new TextDecoder("ascii")
          .decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
          .toLowerCase()
          .includes("webm")
      );
    default:
      return false;
  }
}

/** Windows resolves path segments case-insensitively, so `.GIT/config` reaches `.git/config`.
 *  Keep the metadata boundary in one helper so every read/write/move route applies it equally. */
function insideGitMetadata(clean: string): boolean {
  return clean.split("/").some((segment) => segment.toLowerCase() === ".git");
}

/** Contents of a path at an arbitrary git rev (`git show <rev>:<path>`). A missing blob — the
 *  path doesn't exist at that rev (a deletion, an add-from-nothing, or a root commit's parent) —
 *  comes back NOT_FOUND. Binary/oversized blobs are flagged + capped, like the working-tree reader. */
async function readBlobAtRev(absPath: string, rev: string, clean: string): Promise<FileContentResult> {
  try {
    const content = await gitFor(absPath).raw(["show", `${rev}:${clean}`]);
    const binary = content.includes("\u0000");
    const size = Buffer.byteLength(content, "utf8");
    const truncated = size > MAX_FILE_BYTES;
    return {
      ok: true,
      code: "OK",
      path: clean,
      ref: "head",
      size,
      binary,
      truncated,
      content: binary ? "" : truncated ? content.slice(0, MAX_FILE_BYTES) : content,
    };
  } catch {
    return { ok: false, code: "NOT_FOUND", message: "file not found" };
  }
}

/** Last-committed (HEAD) contents of a path — the deleted-file fallback for the working-tree viewer. */
async function readFromHead(absPath: string, clean: string): Promise<FileContentResult> {
  return readBlobAtRev(absPath, "HEAD", clean);
}

interface TextRead {
  content: string;
  binary: boolean;
  truncated: boolean;
  size: number;
}

interface SafeWorkFile {
  real: string;
  size: number;
}

export interface BinaryPreviewResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "UNSUPPORTED" | "TOO_LARGE";
  message?: string;
  path?: string;
  contentType?: string;
  bytes?: Uint8Array;
  size?: number;
}

/**
 * Resolve an existing working-tree file through every symlink/junction and prove the final
 * target is still inside the real repository root. A lexical `../` check is not enough here:
 * Bun.file follows links, so a repository could otherwise expose an arbitrary owner-readable
 * file through the share-link viewer.
 */
function resolveReadableWorkFile(repoRoot: string, abs: string): SafeWorkFile | null {
  try {
    lstatSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }

  const realRoot = realpathSync(repoRoot);
  const real = realpathSync(abs);
  if (!pathWithin(realRoot, real)) throw new Error("path escapes the repository through a link");
  const st = statSync(real);
  if (!st.isFile()) throw new Error("path is not a regular file");
  return { real, size: st.size };
}

interface RawPreviewBytes {
  bytes: Uint8Array;
  size: number;
}

/** Read a working-tree preview through the same realpath boundary as the text viewer. */
async function readWorkPreview(repoRoot: string, abs: string): Promise<RawPreviewBytes | null> {
  const safe = resolveReadableWorkFile(repoRoot, abs);
  if (!safe) return null;
  if (safe.size > MAX_BINARY_PREVIEW_BYTES) {
    throw new RangeError(`file exceeds the ${MAX_BINARY_PREVIEW_BYTES}-byte preview limit`);
  }
  // Slice even after stat: if the file grows concurrently, the read remains bounded.
  const bytes = new Uint8Array(
    await Bun.file(safe.real)
      .slice(0, MAX_BINARY_PREVIEW_BYTES + 1)
      .arrayBuffer(),
  );
  if (bytes.length > MAX_BINARY_PREVIEW_BYTES) {
    throw new RangeError(`file exceeds the ${MAX_BINARY_PREVIEW_BYTES}-byte preview limit`);
  }
  return { bytes, size: bytes.length };
}

/** Read an immutable Git blob as bytes. Resolve rev:path to an object id first so HEAD moving
 * between the size probe and byte read cannot swap in a larger object. */
async function readPreviewBlobAtRev(absPath: string, rev: string, clean: string): Promise<RawPreviewBytes | null> {
  try {
    const oid = (await gitFor(absPath).raw(["rev-parse", "--verify", `${rev}:${clean}`])).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(oid)) return null;
    const size = Number((await gitFor(absPath).raw(["cat-file", "-s", oid])).trim());
    if (!Number.isSafeInteger(size) || size < 0) return null;
    if (size > MAX_BINARY_PREVIEW_BYTES) {
      throw new RangeError(`file exceeds the ${MAX_BINARY_PREVIEW_BYTES}-byte preview limit`);
    }

    const proc = Bun.spawn(["git", "cat-file", "blob", oid], {
      cwd: absPath,
      env: safeGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buffer, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim() || "could not read preview blob");
    const bytes = new Uint8Array(buffer);
    if (bytes.length > MAX_BINARY_PREVIEW_BYTES) {
      throw new RangeError(`file exceeds the ${MAX_BINARY_PREVIEW_BYTES}-byte preview limit`);
    }
    return { bytes, size: bytes.length };
  } catch (e) {
    if (e instanceof RangeError) throw e;
    return null;
  }
}

async function gunzipPreview(raw: RawPreviewBytes): Promise<RawPreviewBytes> {
  const source = raw.bytes.buffer.slice(
    raw.bytes.byteOffset,
    raw.bytes.byteOffset + raw.bytes.byteLength,
  ) as ArrayBuffer;
  const reader = new Blob([source])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BINARY_PREVIEW_BYTES) {
        throw new RangeError(`file exceeds the ${MAX_BINARY_PREVIEW_BYTES}-byte preview limit`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, size };
}

async function checkedImageResult(
  clean: string,
  raw: RawPreviewBytes,
  contentType: string,
): Promise<BinaryPreviewResult> {
  let normalized = raw;
  if (pathExtension(clean) === "svgz") {
    try {
      normalized = await gunzipPreview(raw);
    } catch (e) {
      if (e instanceof RangeError) throw e;
      return {
        ok: false,
        code: "UNSUPPORTED",
        message: "file contents do not match a supported image format",
      };
    }
  }
  if (!matchesImageSignature(normalized.bytes, contentType)) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: "file contents do not match a supported image format",
    };
  }
  return {
    ok: true,
    code: "OK",
    path: clean,
    contentType,
    bytes: normalized.bytes,
    size: normalized.size,
  };
}

function checkedDocumentMediaResult(
  clean: string,
  raw: RawPreviewBytes,
  descriptor: PreviewDescriptor,
): BinaryPreviewResult {
  if (!matchesDocumentMediaSignature(raw.bytes, descriptor.contentType)) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: "file contents do not match the requested preview format",
    };
  }
  return {
    ok: true,
    code: "OK",
    path: clean,
    contentType: descriptor.contentType,
    bytes: raw.bytes,
    size: raw.size,
  };
}

/**
 * Browser-native image bytes for the working-tree viewer. A deleted path falls back to HEAD just
 * like readFileContent. Only an allowlisted extension with a matching file signature is returned.
 */
export async function readImagePreview(
  repoId: string,
  relPath: string,
  ref: "work" | "head" = "work",
): Promise<BinaryPreviewResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  if (insideGitMetadata(r.clean)) {
    return { ok: false, code: "ERROR", message: "refusing to read inside a .git directory" };
  }
  const contentType = imagePreviewType(r.clean);
  if (!contentType) {
    return { ok: false, code: "UNSUPPORTED", message: "image format is not supported for preview" };
  }

  try {
    let raw = ref === "work" ? await readWorkPreview(repo.absPath, r.abs) : null;
    if (!raw) raw = await readPreviewBlobAtRev(repo.absPath, "HEAD", r.clean);
    if (!raw) return { ok: false, code: "NOT_FOUND", message: "file not found" };
    return await checkedImageResult(r.clean, raw, contentType);
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, code: "TOO_LARGE", message: e.message };
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Image bytes at one historical commit. A deletion falls back to the first parent so the Content
 * view can still show the image that commit removed.
 */
export async function readCommitImagePreview(
  repoId: string,
  hash: string,
  relPath: string,
): Promise<BinaryPreviewResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    return { ok: false, code: "ERROR", message: "invalid commit hash" };
  }
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  if (insideGitMetadata(r.clean)) {
    return { ok: false, code: "ERROR", message: "refusing to read inside a .git directory" };
  }
  if (!backendFor(repo.vcs).capabilities.fileModels) {
    return { ok: false, code: "ERROR", message: "commit file view isn't available for this repository" };
  }
  const contentType = imagePreviewType(r.clean);
  if (!contentType) {
    return { ok: false, code: "UNSUPPORTED", message: "image format is not supported for preview" };
  }

  try {
    const raw =
      (await readPreviewBlobAtRev(repo.absPath, hash, r.clean)) ??
      (await readPreviewBlobAtRev(repo.absPath, `${hash}^`, r.clean));
    if (!raw) return { ok: false, code: "NOT_FOUND", message: "file not found in this commit" };
    return await checkedImageResult(r.clean, raw, contentType);
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, code: "TOO_LARGE", message: e.message };
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** PDF/audio/video bytes for the working-tree viewer. Uses the same confinement, cap, signature
 * checks, and deleted-file HEAD fallback as image previews. */
export async function readBinaryPreview(
  repoId: string,
  relPath: string,
  kind: Exclude<BinaryPreviewKind, "image">,
  ref: "work" | "head" = "work",
): Promise<BinaryPreviewResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  if (insideGitMetadata(r.clean)) {
    return { ok: false, code: "ERROR", message: "refusing to read inside a .git directory" };
  }
  const descriptor = binaryPreviewDescriptor(r.clean, kind);
  if (!descriptor) {
    return { ok: false, code: "UNSUPPORTED", message: `${kind} format is not supported for preview` };
  }

  try {
    let raw = ref === "work" ? await readWorkPreview(repo.absPath, r.abs) : null;
    if (!raw) raw = await readPreviewBlobAtRev(repo.absPath, "HEAD", r.clean);
    if (!raw) return { ok: false, code: "NOT_FOUND", message: "file not found" };
    return checkedDocumentMediaResult(r.clean, raw, descriptor);
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, code: "TOO_LARGE", message: e.message };
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** PDF/audio/video bytes at one commit; a deletion falls back to the first parent. */
export async function readCommitBinaryPreview(
  repoId: string,
  hash: string,
  relPath: string,
  kind: Exclude<BinaryPreviewKind, "image">,
): Promise<BinaryPreviewResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    return { ok: false, code: "ERROR", message: "invalid commit hash" };
  }
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  if (insideGitMetadata(r.clean)) {
    return { ok: false, code: "ERROR", message: "refusing to read inside a .git directory" };
  }
  if (!backendFor(repo.vcs).capabilities.fileModels) {
    return { ok: false, code: "ERROR", message: "commit file view isn't available for this repository" };
  }
  const descriptor = binaryPreviewDescriptor(r.clean, kind);
  if (!descriptor) {
    return { ok: false, code: "UNSUPPORTED", message: `${kind} format is not supported for preview` };
  }

  try {
    const raw =
      (await readPreviewBlobAtRev(repo.absPath, hash, r.clean)) ??
      (await readPreviewBlobAtRev(repo.absPath, `${hash}^`, r.clean));
    if (!raw) return { ok: false, code: "NOT_FOUND", message: "file not found in this commit" };
    return checkedDocumentMediaResult(r.clean, raw, descriptor);
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, code: "TOO_LARGE", message: e.message };
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Working-tree text for an absolute path (read straight off disk), or null if it's gone. */
async function readWorkText(repoRoot: string, abs: string): Promise<TextRead | null> {
  const safe = resolveReadableWorkFile(repoRoot, abs);
  if (!safe) return null;
  const file = Bun.file(safe.real);
  const size = safe.size;
  const slice = size > MAX_FILE_BYTES ? file.slice(0, MAX_FILE_BYTES) : file;
  const bytes = new Uint8Array(await slice.arrayBuffer());
  if (looksBinary(bytes)) return { content: "", binary: true, truncated: false, size };
  return {
    content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    binary: false,
    truncated: size > MAX_FILE_BYTES,
    size,
  };
}

/** Normalise + confine an untrusted request path to the repo (blocks `../` escapes). */
export function resolveRepoPath(
  absPath: string,
  relPath: string,
): { clean: string; abs: string } | { error: string } {
  const clean = normalizeRelPath(relPath);
  if (!clean) return { error: "path is required" };
  const abs = resolve(absPath, clean);
  if (!pathWithin(absPath, abs)) return { error: "path escapes the repository" };
  return { clean, abs };
}

/**
 * Read one changed file's contents for the viewer drawer. Read-only and untrusted-path
 * safe: the request's path is normalised and confined to the repo (no traversal). The
 * working-tree version is read straight off disk (fast, no git); a path that's gone from
 * the working tree (a deletion) falls back to its last-committed blob so it's still
 * viewable. Binary files and oversized files come back flagged rather than dumped.
 */
export async function readFileContent(
  repoId: string,
  relPath: string,
  ref: "work" | "head" = "work",
): Promise<FileContentResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  if (insideGitMetadata(r.clean)) {
    return { ok: false, code: "ERROR", message: "refusing to read inside a .git directory" };
  }

  try {
    if (ref === "work") {
      const work = await readWorkText(repo.absPath, r.abs);
      if (work) return { ok: true, code: "OK", path: r.clean, ref: "work", ...work };
      // deleted from the working tree → fall through to the committed version
    }
    const head = await readFromHead(repo.absPath, r.clean);
    return head.ok ? head : { ok: false, code: "NOT_FOUND", message: "file not found" };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Result of writing an edited file back to the working tree (the viewer's Edit mode). */
export interface WriteFileResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "TOO_LARGE" | "IS_BINARY" | "NOT_WRITABLE";
  message?: string;
  /** Repo-relative path that was written (normalised to forward slashes). */
  path?: string;
  /** Byte size written. */
  size?: number;
}

/**
 * Overwrite a working-tree file with edited text from the viewer's Edit mode. Untrusted-path
 * safe: the request path is normalised and confined to the repo exactly like readFileContent
 * (no `../` escapes). Refuses NUL-bearing (binary) content, content over the size cap, and
 * non-regular targets — a symlink (which could redirect the write outside the repo) or a
 * directory. The watcher and the route's forceRefresh then surface the change to the UI.
 */
export async function writeFileContent(
  repoId: string,
  relPath: string,
  content: string,
): Promise<WriteFileResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };

  // Never let an edit reach a .git directory — writing .git/hooks/* would be arbitrary code
  // execution on the next git command. The UI only opens tracked changes, but the endpoint is
  // directly reachable, so guard it here. (Covers submodule .git dirs too.)
  if (insideGitMetadata(r.clean)) {
    return { ok: false, code: "NOT_WRITABLE", message: "refusing to write inside a .git directory" };
  }

  // A NUL byte means the text isn't really text — refuse so we don't write a corrupt blob.
  if (content.includes(String.fromCharCode(0))) {
    return { ok: false, code: "IS_BINARY", message: "refusing to write binary content" };
  }
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_BYTES) {
    return { ok: false, code: "TOO_LARGE", message: `file exceeds the ${MAX_FILE_BYTES}-byte edit limit` };
  }

  // If what's already on disk is bigger than we ever ship to the editor, the incoming text is
  // necessarily a truncated view — refuse so we don't lop off the file's tail. (Mirrors the
  // client's canEdit gate at the server, in case a crafted request bypasses the UI.)
  const onDisk = Bun.file(r.abs);
  if ((await onDisk.exists()) && onDisk.size > MAX_FILE_BYTES) {
    return { ok: false, code: "TOO_LARGE", message: "the file on disk is larger than the edit limit" };
  }

  // Resolve symlinks for real: the *real* parent dir must sit inside the *real* repo root,
  // so a symlinked parent can't redirect the write outside the repo.
  try {
    if (!pathWithin(realpathSync(repo.absPath), realpathSync(dirname(r.abs)))) {
      return { ok: false, code: "NOT_WRITABLE", message: "path escapes the repository" };
    }
  } catch {
    return { ok: false, code: "NOT_FOUND", message: "parent directory does not exist" };
  }
  // Refuse a symlink or directory at the leaf itself; otherwise a fresh write is fine.
  try {
    const st = lstatSync(r.abs);
    if (st.isSymbolicLink()) return { ok: false, code: "NOT_WRITABLE", message: "refusing to write through a symlink" };
    if (st.isDirectory()) return { ok: false, code: "NOT_WRITABLE", message: "path is a directory" };
  } catch {
    /* nothing at the leaf yet — a fresh write is fine */
  }

  // Atomic replace: write a sibling temp file, then rename over the target. rename() never
  // follows a symlink at the destination (closing the lstat→write TOCTOU window), and a crash
  // mid-write can't leave a half-written source file.
  const tmp = `${r.abs}.repoyeti-${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(tmp, content);
    renameSync(tmp, r.abs);
    return { ok: true, code: "OK", path: r.clean, size };
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup of the temp file */
    }
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Result of moving a working-tree file into another folder (the changes-tree drag-and-drop). */
export interface MoveFileResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR" | "EXISTS" | "NOT_WRITABLE";
  message?: string;
  /** Repo-relative source path that was moved (normalised to forward slashes). */
  from?: string;
  /** Repo-relative destination path (normalised to forward slashes). */
  to?: string;
}

/**
 * Move a working-tree file into another folder (the changes-tree drag-and-drop). `toDir` is a
 * repo-relative directory ("" = repo root); the file keeps its basename. Untrusted-path safe:
 * both the source and the COMPUTED destination are normalised + confined to the repo (no `../`
 * escapes) and neither may sit inside a `.git` dir; the destination's REAL parent must resolve
 * inside the real repo root, so a symlinked folder can't redirect the move outside the repo.
 * Never overwrites an existing file. Tracked git files move via `git mv` (a staged rename);
 * untracked files (and non-git backends) are renamed on disk. The watcher + the route's
 * forceRefresh then surface the change to the UI.
 */
export async function moveFile(repoId: string, from: string, toDir: string): Promise<MoveFileResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };

  const src = resolveRepoPath(repo.absPath, from);
  if ("error" in src) return { ok: false, code: "ERROR", message: src.error };

  // Destination = <toDir>/<basename(src)>. A blank/"." toDir means the repo root.
  const name = src.clean.split("/").pop() ?? src.clean;
  const dir = normalizeRelPath(toDir);
  const dst = resolveRepoPath(repo.absPath, dir && dir !== "." ? `${dir}/${name}` : name);
  if ("error" in dst) return { ok: false, code: "ERROR", message: dst.error };

  // Never move into/out of a .git dir — a file placed under .git/hooks would run on the next git
  // command. (The UI only drags tracked changes, but the endpoint is directly reachable.)
  if (insideGitMetadata(src.clean) || insideGitMetadata(dst.clean)) {
    return { ok: false, code: "NOT_WRITABLE", message: "refusing to move inside a .git directory" };
  }
  if (dst.clean === src.clean) {
    return { ok: false, code: "ERROR", message: "the file is already in that folder" };
  }

  // Source must be an existing regular file; refuse to move a folder.
  try {
    if (lstatSync(src.abs).isDirectory()) {
      return { ok: false, code: "NOT_WRITABLE", message: "only files can be moved, not folders" };
    }
  } catch {
    return { ok: false, code: "NOT_FOUND", message: "the file no longer exists" };
  }
  // Never overwrite something already at the destination.
  try {
    lstatSync(dst.abs);
    return { ok: false, code: "EXISTS", message: "a file already exists at the destination" };
  } catch {
    /* nothing at the destination — good */
  }

  // Create the destination folder, then verify its REAL path is still inside the REAL repo root
  // (a symlinked parent can't redirect the move outside the repo).
  const dstParent = dirname(dst.abs);
  try {
    mkdirSync(dstParent, { recursive: true });
    if (!pathWithin(realpathSync(repo.absPath), realpathSync(dstParent))) {
      return { ok: false, code: "NOT_WRITABLE", message: "destination escapes the repository" };
    }
  } catch {
    return { ok: false, code: "ERROR", message: "could not prepare the destination folder" };
  }

  // A tracked git file moves with `git mv` so the rename is staged; untracked files (and non-git
  // backends) just get renamed on disk (git/lore then see the move on the next status read).
  const isGit = repo.vcs !== "lore";
  let tracked = false;
  if (isGit) {
    try {
      await gitFor(repo.absPath).raw(["ls-files", "--error-unmatch", src.clean]);
      tracked = true;
    } catch {
      /* not tracked — fall back to a plain rename */
    }
  }

  try {
    if (tracked) await gitFor(repo.absPath).raw(["mv", src.clean, dst.clean]);
    else renameSync(src.abs, dst.abs);
    return { ok: true, code: "OK", from: src.clean, to: dst.clean };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Both sides of a changed file's diff for the viewer's Diff tab (mirrors web/src/types.ts). */
export interface FileDiffResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  path?: string;
  /** How the diff is shipped: "models" (default) = the original+modified pair for a rich
   *  side-by-side editor · "patch" = a single unified `git diff`, used for large modified
   *  files so we send only the hunks instead of both whole copies. */
  mode?: "models" | "patch";
  /** Last-committed (HEAD) text — "" for a newly-added/untracked file. ("models" mode.) */
  original?: string;
  /** Working-tree text — "" for a file deleted from the working tree. ("models" mode.) */
  modified?: string;
  /** Unified `git diff HEAD` text — present only in "patch" mode. */
  patch?: string;
  /** True when either side is binary — no textual diff is shown. */
  binary?: boolean;
  /** True when either side hit the size cap ("models"), or the patch did ("patch"). */
  truncated?: boolean;
}

/**
 * File-viewer Diff-tab threshold (bytes): a changed file bigger than this on either side
 * ships as a compact server-computed `git diff` (patch mode) instead of both whole files for
 * a rich side-by-side view. Owner setting (`cfg.diffPatchBytes`, surfaced in Settings),
 * mirrored here at runtime — set at boot + on the settings route, read by readFileDiff.
 * Clamped to [MIN, MAX]; values are powers of two so the Settings presets read as real KB/MB.
 */
export const DIFF_PATCH_BYTES_DEFAULT = 512 * 1024; // 512 KB
const DIFF_PATCH_BYTES_MIN = 64 * 1024; // 64 KB
const DIFF_PATCH_BYTES_MAX = 2 * 1024 * 1024; // 2 MB
let _diffPatchBytes = DIFF_PATCH_BYTES_DEFAULT;

export function getDiffPatchBytes(): number {
  return _diffPatchBytes;
}
/** Set the threshold, clamped to the safe range. Returns the value actually stored so the
 *  caller can persist the clamped number (not the raw, possibly out-of-range, input). */
export function setDiffPatchBytes(bytes: number): number {
  _diffPatchBytes = Math.min(DIFF_PATCH_BYTES_MAX, Math.max(DIFF_PATCH_BYTES_MIN, Math.round(bytes)));
  return _diffPatchBytes;
}

/**
 * Owner setting: when false the viewer NEVER switches large files to the compact patch —
 * every changed file loads as a full side-by-side diff (so a file past the read cap may be
 * truncated). Default true (patch mode on). Mirrored at runtime like the threshold above.
 */
let _diffPatchEnabled = true;
export function getDiffPatchEnabled(): boolean {
  return _diffPatchEnabled;
}
export function setDiffPatchEnabled(enabled: boolean): void {
  _diffPatchEnabled = enabled;
}

/** Cheap binary probe of a working-tree file — peek the head for a NUL byte (git's signal),
 *  without reading the whole (possibly large) file. */
async function workLooksBinary(repoRoot: string, abs: string): Promise<boolean> {
  const safe = resolveReadableWorkFile(repoRoot, abs);
  if (!safe) return false;
  const head = new Uint8Array(await Bun.file(safe.real).slice(0, 8000).arrayBuffer());
  return looksBinary(head);
}

/**
 * Both versions of a changed file for the Diff view: the HEAD blob (original) and the
 * working-tree file (modified). Added/untracked files have an empty original; deleted
 * files have an empty modified — so the diff reads naturally for every git status.
 */
export async function readFileDiff(repoId: string, relPath: string): Promise<FileDiffResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  if (insideGitMetadata(r.clean)) {
    return { ok: false, code: "ERROR", message: "refusing to read inside a .git directory" };
  }

  const backend = backendFor(repo.vcs);
  // Backends without whole-side reconstruction (Lore) only offer a unified patch — the viewer's
  // "patch" mode (`lore diff <path>` is working-vs-current-revision; no models view is possible).
  if (!backend.capabilities.fileModels) {
    const fp = await backend.filePatch(repo.absPath, r.clean);
    return fp.ok
      ? { ok: true, code: "OK", path: r.clean, mode: "patch", patch: fp.patch, truncated: fp.truncated }
      : { ok: false, code: "ERROR", message: fp.message ?? "diff failed" };
  }

  try {
    // Probe both sides' sizes cheaply (a working-tree stat + the HEAD blob size) BEFORE
    // reading megabytes off disk. A path that isn't in HEAD throws → it's newly added.
    const workFile = resolveReadableWorkFile(repo.absPath, r.abs);
    const inWork = workFile !== null;
    const workSize = workFile?.size ?? 0;
    let headSize = 0;
    let inHead = false;
    try {
      headSize = parseInt((await gitFor(repo.absPath).raw(["cat-file", "-s", `HEAD:${r.clean}`])).trim(), 10) || 0;
      inHead = true;
    } catch {
      /* not in HEAD → newly added / untracked */
    }

    // Large AND modified (present on BOTH sides) → compact diff: let git compute the patch
    // and ship only that. Added/deleted files stay on the model path — one side is empty
    // there, so the "diff" already IS the single file and there's nothing smaller to send.
    // Skipped entirely when the owner has turned patch mode off (always side-by-side).
    if (
      getDiffPatchEnabled() &&
      inWork &&
      inHead &&
      Math.max(workSize, headSize) > getDiffPatchBytes() &&
      !(await workLooksBinary(repo.absPath, r.abs))
    ) {
      const fp = await backend.filePatch(repo.absPath, r.clean);
      if (fp.ok && fp.patch.trim())
        return { ok: true, code: "OK", path: r.clean, mode: "patch", patch: fp.patch, truncated: fp.truncated };
      // empty patch (e.g. a mode-only change) → fall through to the model view
    }

    const [head, work] = await Promise.all([
      readFromHead(repo.absPath, r.clean),
      readWorkText(repo.absPath, r.abs),
    ]);
    if (!head.ok && !work) return { ok: false, code: "NOT_FOUND", message: "file not found" };
    return {
      ok: true,
      code: "OK",
      path: r.clean,
      mode: "models",
      original: head.ok ? (head.content ?? "") : "",
      modified: work?.content ?? "",
      binary: (head.binary ?? false) || (work?.binary ?? false),
      truncated: (head.truncated ?? false) || (work?.truncated ?? false),
    };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Both sides of a file's change AT ONE COMMIT — for the history viewer's "click a changed file →
 * open it in the Monaco diff". Same models shape as readFileDiff, but the two sides come from git
 * revs instead of HEAD↔working-tree: `original` = the file at the commit's FIRST PARENT (`<hash>^`),
 * `modified` = the file AT the commit (`<hash>`). A file added in the commit has no parent blob →
 * original ""; a deletion has no commit blob → modified ""; a root commit has no parent → original
 * "". Read-only + untrusted-path safe (path confined to the repo; hash shape-guarded before use).
 */
export async function readCommitFile(repoId: string, hash: string, relPath: string): Promise<FileDiffResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  // The hash is interpolated into a git rev — shape-guard it exactly like readCommit does.
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return { ok: false, code: "ERROR", message: "invalid commit hash" };
  const r = resolveRepoPath(repo.absPath, relPath);
  if ("error" in r) return { ok: false, code: "ERROR", message: r.error };
  if (insideGitMetadata(r.clean)) {
    return { ok: false, code: "ERROR", message: "refusing to read inside a .git directory" };
  }
  // Per-rev blob reconstruction is a git concept; Lore has no arbitrary-rev blob view.
  if (!backendFor(repo.vcs).capabilities.fileModels) {
    return { ok: false, code: "ERROR", message: "commit file view isn't available for this repository" };
  }
  try {
    const [parent, atCommit] = await Promise.all([
      readBlobAtRev(repo.absPath, `${hash}^`, r.clean),
      readBlobAtRev(repo.absPath, hash, r.clean),
    ]);
    if (!parent.ok && !atCommit.ok) return { ok: false, code: "NOT_FOUND", message: "file not found in this commit" };
    return {
      ok: true,
      code: "OK",
      path: r.clean,
      mode: "models",
      original: parent.ok ? (parent.content ?? "") : "",
      modified: atCommit.ok ? (atCommit.content ?? "") : "",
      binary: (parent.binary ?? false) || (atCommit.binary ?? false),
      truncated: (parent.truncated ?? false) || (atCommit.truncated ?? false),
    };
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}
