import { test, expect } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { $ } from "bun";
import type { RepoYetiConfig } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import {
  readFileContent,
  readImagePreview,
  readCommitImagePreview,
  readBinaryPreview,
  readFileDiff,
  getDiffPatchBytes,
  setDiffPatchBytes,
  getDiffPatchEnabled,
  setDiffPatchEnabled,
} from "../src/service/index.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SVG_IMAGE = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported vector -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <style>rect { fill: #663399; }</style>
  <script>throw new Error("must stay inert")</script>
  <rect width="10" height="10"/>
</svg>`,
);

async function gitRepo(): Promise<string> {
  const dir = mkScratchDir("gm-file-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("reads a working-tree file's contents", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "hello.ts"), "export const x = 1;\n");
  const id = mustUpsertRepo(dir, "repo", "auto", false);

  const res = await readFileContent(id, "hello.ts");

  expect(res.ok).toBe(true);
  expect(res.content).toBe("export const x = 1;\n");
  expect(res.binary).toBe(false);
  expect(res.ref).toBe("work");
});

test("flags a binary file instead of dumping its bytes", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00]));
  const id = mustUpsertRepo(dir, "repo-bin", "auto", false);

  const res = await readFileContent(id, "blob.bin");

  expect(res.ok).toBe(true);
  expect(res.binary).toBe(true);
  expect(res.content).toBe("");
});

test("serves a supported raster image as bytes with a locked content type", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "pixel.PNG"), PNG_1X1);
  const id = mustUpsertRepo(dir, "repo-image", "auto", false);

  const serviceResult = await readImagePreview(id, "pixel.PNG");
  expect(serviceResult.ok).toBe(true);
  expect(serviceResult.contentType).toBe("image/png");
  expect(Buffer.from(serviceResult.bytes ?? [])).toEqual(PNG_1X1);

  const response = await createApp(localCfg()).request(
    `/api/repos/${id}/file?path=pixel.PNG&preview=image`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_1X1);
});

test("recognizes every advertised browser-native image format", async () => {
  const dir = await gitRepo();
  const fixtures = [
    ["image.apng", PNG_1X1, "image/png"],
    ["image.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["image.gif", Buffer.from("GIF89a"), "image/gif"],
    ["image.webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]), "image/webp"],
    ["image.avif", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypavif")]), "image/avif"],
    ["image.bmp", Buffer.from("BM"), "image/bmp"],
    ["image.ico", Buffer.from([0, 0, 1, 0]), "image/x-icon"],
    ["image.svg", SVG_IMAGE, "image/svg+xml"],
  ] as const;
  for (const [name, bytes] of fixtures) writeFileSync(join(dir, name), bytes);
  const id = mustUpsertRepo(dir, "repo-image-formats", "auto", false);

  for (const [name, , contentType] of fixtures) {
    expect(await readImagePreview(id, name)).toMatchObject({ ok: true, contentType });
  }
});

test("serves SVG only as a sandboxed image response", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "diagram.SVG"), SVG_IMAGE);
  const id = mustUpsertRepo(dir, "repo-svg", "auto", false);

  const response = await createApp(localCfg()).request(
    `/api/repos/${id}/file?path=diagram.SVG&preview=image`,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(SVG_IMAGE);
});

test("decompresses and serves SVGZ through the same inert SVG image path", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "diagram.svgz"), gzipSync(SVG_IMAGE));
  const id = mustUpsertRepo(dir, "repo-svgz", "auto", false);

  const serviceResult = await readImagePreview(id, "diagram.svgz");
  expect(serviceResult).toMatchObject({ ok: true, contentType: "image/svg+xml" });
  expect(Buffer.from(serviceResult.bytes ?? [])).toEqual(SVG_IMAGE);

  const response = await createApp(localCfg()).request(
    `/api/repos/${id}/file?path=diagram.svgz&preview=image`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(SVG_IMAGE);
});

test("serves common browser-native document, audio, and video formats", async () => {
  const dir = await gitRepo();
  const fixtures = [
    ["manual.pdf", Buffer.from("%PDF-1.7\npreview\n"), "pdf", "application/pdf"],
    ["song.mp3", Buffer.from("ID3\u0004\u0000\u0000"), "audio", "audio/mpeg"],
    ["sound.wav", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]), "audio", "audio/wav"],
    ["sound.oga", Buffer.from("OggS\u0000\u0002"), "audio", "audio/ogg"],
    ["sound.ogg", Buffer.from("OggS\u0000\u0002"), "audio", "audio/ogg"],
    ["sound.opus", Buffer.from("OggS\u0000\u0002OpusHead"), "audio", "audio/ogg"],
    ["sound.flac", Buffer.from("fLaC\u0000"), "audio", "audio/flac"],
    ["sound.m4a", Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypM4A ")]), "audio", "audio/mp4"],
    ["clip.mp4", Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom")]), "video", "video/mp4"],
    ["clip.m4v", Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypM4V ")]), "video", "video/mp4"],
    ["clip.webm", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm")]), "video", "video/webm"],
    ["clip.ogv", Buffer.from("OggS\u0000\u0002"), "video", "video/ogg"],
  ] as const;
  for (const [name, bytes] of fixtures) writeFileSync(join(dir, name), bytes);
  const id = mustUpsertRepo(dir, "repo-native-media", "auto", false);

  for (const [name, bytes, kind, contentType] of fixtures) {
    const result = await readBinaryPreview(id, name, kind);
    expect(result).toMatchObject({ ok: true, contentType });
    expect(Buffer.from(result.bytes ?? [])).toEqual(bytes);
  }
});

test("binary preview supports single byte ranges and rejects invalid ranges", async () => {
  const dir = await gitRepo();
  const pdf = Buffer.from("%PDF-1.7\n0123456789\n");
  writeFileSync(join(dir, "manual.pdf"), pdf);
  const id = mustUpsertRepo(dir, "repo-pdf-range", "auto", false);
  const url = `/api/repos/${id}/file?path=manual.pdf&preview=pdf`;

  const full = await createApp(localCfg()).request(url);
  expect(full.status).toBe(200);
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(full.headers.get("content-security-policy")).toBeNull();
  expect(Buffer.from(await full.arrayBuffer())).toEqual(pdf);

  for (const [range, start, end] of [
    ["bytes=2-5", 2, 5],
    ["bytes=5-", 5, pdf.length - 1],
    ["bytes=-4", pdf.length - 4, pdf.length - 1],
    ["bytes=2-999", 2, pdf.length - 1],
  ] as const) {
    const response = await createApp(localCfg()).request(url, { headers: { Range: range } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${pdf.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf.subarray(start, end + 1));
  }

  for (const range of ["bytes=999-", "bytes=0-1,3-4", "bytes=-0"]) {
    const response = await createApp(localCfg()).request(url, { headers: { Range: range } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${pdf.length}`);
  }
});

test("document and media previews reject mismatched signatures or kinds", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "renamed.pdf"), "<html>not a PDF</html>");
  writeFileSync(join(dir, "renamed.mp3"), PNG_1X1);
  writeFileSync(join(dir, "actual.mp4"), Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom")]));
  const id = mustUpsertRepo(dir, "repo-media-reject", "auto", false);

  expect(await readBinaryPreview(id, "renamed.pdf", "pdf")).toMatchObject({
    ok: false,
    code: "UNSUPPORTED",
  });
  expect(await readBinaryPreview(id, "renamed.mp3", "audio")).toMatchObject({
    ok: false,
    code: "UNSUPPORTED",
  });
  expect(await readBinaryPreview(id, "actual.mp4", "audio")).toMatchObject({
    ok: false,
    code: "UNSUPPORTED",
  });
});

test("image preview rejects unsupported extensions and mismatched signatures", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "pixel.tiff"), PNG_1X1);
  writeFileSync(join(dir, "renamed.png"), "<script>alert(1)</script>");
  writeFileSync(join(dir, "renamed.svg"), "<html>not an image</html>");
  writeFileSync(
    join(dir, "doctype.svg"),
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "https://example.com/svg.dtd"><svg/>',
  );
  writeFileSync(
    join(dir, "stylesheet.svg"),
    '<?xml-stylesheet href="https://example.com/a.css"?><svg/>',
  );
  const id = mustUpsertRepo(dir, "repo-image-reject", "auto", false);

  expect(await readImagePreview(id, "pixel.tiff")).toMatchObject({
    ok: false,
    code: "UNSUPPORTED",
  });
  expect(await readImagePreview(id, "renamed.png")).toMatchObject({
    ok: false,
    code: "UNSUPPORTED",
  });
  expect(await readImagePreview(id, "renamed.svg")).toMatchObject({
    ok: false,
    code: "UNSUPPORTED",
  });
  expect(await readImagePreview(id, "doctype.svg")).toMatchObject({
    ok: false,
    code: "UNSUPPORTED",
  });
  expect(await readImagePreview(id, "stylesheet.svg")).toMatchObject({
    ok: false,
    code: "UNSUPPORTED",
  });
});

test("image preview falls back for deleted worktree and historical files", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "gone.png"), PNG_1X1);
  await $`git -C ${dir} add gone.png`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m image`.quiet();
  const hash = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  rmSync(join(dir, "gone.png"));
  const id = mustUpsertRepo(dir, "repo-image-history", "auto", false);

  const deleted = await readImagePreview(id, "gone.png");
  const historical = await readCommitImagePreview(id, hash, "gone.png");

  expect(Buffer.from(deleted.bytes ?? [])).toEqual(PNG_1X1);
  expect(Buffer.from(historical.bytes ?? [])).toEqual(PNG_1X1);
});

test("a deleted working-tree file falls back to its last-committed version", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "gone.txt"), "committed body\n");
  await $`git -C ${dir} add gone.txt`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m add`.quiet();
  rmSync(join(dir, "gone.txt"));
  const id = mustUpsertRepo(dir, "repo-del", "auto", false);

  const res = await readFileContent(id, "gone.txt");

  expect(res.ok).toBe(true);
  expect(res.ref).toBe("head");
  expect(res.content).toBe("committed body\n");
});

test("refuses a path that escapes the repository", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "ok.txt"), "ok");
  const id = mustUpsertRepo(dir, "repo-esc", "auto", false);

  const res = await readFileContent(id, "../../../etc/passwd");

  expect(res.ok).toBe(false);
  expect(res.code).toBe("ERROR");
});

test("refuses working-tree reads through a junction that resolves outside the repository", async () => {
  const dir = await gitRepo();
  const outside = mkScratchDir("gm-file-outside-");
  writeFileSync(join(outside, "secret.txt"), "owner-only secret\n");
  symlinkSync(outside, join(dir, "linked"), "junction");
  const id = mustUpsertRepo(dir, "repo-link-escape", "auto", false);

  const content = await readFileContent(id, "linked/secret.txt");
  const diff = await readFileDiff(id, "linked/secret.txt");

  expect(content.ok).toBe(false);
  expect(content.code).toBe("ERROR");
  expect(content.message).toContain("escapes the repository");
  expect(content.content).toBeUndefined();
  expect(diff.ok).toBe(false);
  expect(diff.code).toBe("ERROR");
  expect(diff.message).toContain("escapes the repository");
  expect(diff.modified).toBeUndefined();
});

test("still reads through an internal junction whose real target remains inside the repository", async () => {
  const dir = await gitRepo();
  mkdirSync(join(dir, "real"));
  writeFileSync(join(dir, "real", "inside.txt"), "safe internal target\n");
  symlinkSync(join(dir, "real"), join(dir, "linked"), "junction");
  const id = mustUpsertRepo(dir, "repo-link-inside", "auto", false);

  const res = await readFileContent(id, "linked/inside.txt");

  expect(res.ok).toBe(true);
  expect(res.content).toBe("safe internal target\n");
});

test("refuses direct reads from the repository's private .git directory", async () => {
  const dir = await gitRepo();
  const id = mustUpsertRepo(dir, "repo-dotgit-read", "auto", false);

  const content = await readFileContent(id, ".git/config");
  const diff = await readFileDiff(id, ".git/config");
  const mixedCase = await readFileContent(id, ".GIT/config");

  expect(content.ok).toBe(false);
  expect(content.message).toContain(".git");
  expect(diff.ok).toBe(false);
  expect(diff.message).toContain(".git");
  expect(mixedCase.ok).toBe(false);
  expect(mixedCase.message).toContain(".git");
});

test("unknown repo id is NOT_FOUND", async () => {
  const res = await readFileContent("nope", "anything.txt");

  expect(res.ok).toBe(false);
  expect(res.code).toBe("NOT_FOUND");
});

test("diff of a modified file gives HEAD as original and working tree as modified", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "f.ts"), "const a = 1;\n");
  await $`git -C ${dir} add f.ts`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m add`.quiet();
  writeFileSync(join(dir, "f.ts"), "const a = 2;\n");
  const id = mustUpsertRepo(dir, "repo-diff", "auto", false);

  const res = await readFileDiff(id, "f.ts");

  expect(res.ok).toBe(true);
  expect(res.mode).toBe("models"); // small file → full side-by-side pair
  expect(res.original).toBe("const a = 1;\n");
  expect(res.modified).toBe("const a = 2;\n");
});

test("a large modified file comes back as a compact patch, not both whole sides", async () => {
  const dir = await gitRepo();
  // Comfortably over DIFF_PATCH_BYTES (512 KB) so readFileDiff takes the patch path.
  const filler = "x".repeat(60);
  const lines = Array.from({ length: 12_000 }, (_, i) => `line ${i} ${filler}`);
  writeFileSync(join(dir, "big.txt"), `${lines.join("\n")}\n`);
  await $`git -C ${dir} add big.txt`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m add`.quiet();
  lines[5] = `line 5 CHANGED ${filler}`;
  writeFileSync(join(dir, "big.txt"), `${lines.join("\n")}\n`);
  const id = mustUpsertRepo(dir, "repo-big-diff", "auto", false);

  const res = await readFileDiff(id, "big.txt");

  expect(res.ok).toBe(true);
  expect(res.mode).toBe("patch");
  expect(res.patch).toContain("@@"); // a real unified-diff hunk header
  expect(res.patch).toContain("line 5 CHANGED");
  // The whole-file pair is NOT shipped in patch mode — that's the point.
  expect(res.original).toBeUndefined();
  expect(res.modified).toBeUndefined();
});

test("the diff-patch threshold is configurable — raising it sends a 'large' file back to models", async () => {
  const dir = await gitRepo();
  const filler = "x".repeat(60);
  const lines = Array.from({ length: 12_000 }, (_, i) => `line ${i} ${filler}`); // ~0.8 MB
  writeFileSync(join(dir, "big.txt"), `${lines.join("\n")}\n`);
  await $`git -C ${dir} add big.txt`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m add`.quiet();
  lines[5] = `line 5 CHANGED ${filler}`;
  writeFileSync(join(dir, "big.txt"), `${lines.join("\n")}\n`);
  const id = mustUpsertRepo(dir, "repo-thresh", "auto", false);

  const prev = getDiffPatchBytes();
  try {
    setDiffPatchBytes(2_000_000); // above the file size → patch mode should NOT trigger
    const res = await readFileDiff(id, "big.txt");
    expect(res.mode).toBe("models");
    expect(res.modified).toContain("line 5 CHANGED");
  } finally {
    setDiffPatchBytes(prev); // restore the module-level mirror for other tests
  }
});

test("turning compact diff off forces a large modified file back to side-by-side", async () => {
  const dir = await gitRepo();
  const filler = "x".repeat(60);
  const lines = Array.from({ length: 12_000 }, (_, i) => `line ${i} ${filler}`); // ~0.8 MB
  writeFileSync(join(dir, "big.txt"), `${lines.join("\n")}\n`);
  await $`git -C ${dir} add big.txt`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m add`.quiet();
  lines[5] = `line 5 CHANGED ${filler}`;
  writeFileSync(join(dir, "big.txt"), `${lines.join("\n")}\n`);
  const id = mustUpsertRepo(dir, "repo-nopatch", "auto", false);

  const prev = getDiffPatchEnabled();
  try {
    setDiffPatchEnabled(false); // "always side-by-side"
    const res = await readFileDiff(id, "big.txt");
    expect(res.mode).toBe("models");
    expect(res.modified).toContain("line 5 CHANGED");
  } finally {
    setDiffPatchEnabled(prev);
  }
});

test("a large ADDED file stays on the model path (the diff IS the whole file)", async () => {
  const dir = await gitRepo();
  const filler = "y".repeat(60);
  const big = `${Array.from({ length: 12_000 }, (_, i) => `row ${i} ${filler}`).join("\n")}\n`;
  writeFileSync(join(dir, "fresh.txt"), big); // untracked, never committed
  const id = mustUpsertRepo(dir, "repo-big-add", "auto", false);

  const res = await readFileDiff(id, "fresh.txt");

  expect(res.ok).toBe(true);
  expect(res.mode).toBe("models"); // one side empty → nothing smaller to send
  expect(res.original).toBe("");
  expect(res.modified).toBe(big);
});

test("diff of an untracked file has empty original (all added)", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "new.ts"), "export const fresh = true;\n");
  const id = mustUpsertRepo(dir, "repo-add", "auto", false);

  const res = await readFileDiff(id, "new.ts");

  expect(res.ok).toBe(true);
  expect(res.original).toBe("");
  expect(res.modified).toBe("export const fresh = true;\n");
});

test("diff of a deleted file has empty modified (all removed)", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "old.ts"), "export const bye = 1;\n");
  await $`git -C ${dir} add old.ts`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m add`.quiet();
  rmSync(join(dir, "old.ts"));
  const id = mustUpsertRepo(dir, "repo-del-diff", "auto", false);

  const res = await readFileDiff(id, "old.ts");

  expect(res.ok).toBe(true);
  expect(res.original).toBe("export const bye = 1;\n");
  expect(res.modified).toBe("");
});
