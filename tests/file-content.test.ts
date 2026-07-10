import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { upsertRepo } from "../src/db.ts";
import {
  readFileContent,
  readFileDiff,
  getDiffPatchBytes,
  setDiffPatchBytes,
  getDiffPatchEnabled,
  setDiffPatchEnabled,
} from "../src/service/index.ts";

async function gitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-file-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("reads a working-tree file's contents", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "hello.ts"), "export const x = 1;\n");
  const id = upsertRepo(dir, "repo", "auto", false);

  const res = await readFileContent(id, "hello.ts");

  expect(res.ok).toBe(true);
  expect(res.content).toBe("export const x = 1;\n");
  expect(res.binary).toBe(false);
  expect(res.ref).toBe("work");
});

test("flags a binary file instead of dumping its bytes", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00]));
  const id = upsertRepo(dir, "repo-bin", "auto", false);

  const res = await readFileContent(id, "blob.bin");

  expect(res.ok).toBe(true);
  expect(res.binary).toBe(true);
  expect(res.content).toBe("");
});

test("a deleted working-tree file falls back to its last-committed version", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "gone.txt"), "committed body\n");
  await $`git -C ${dir} add gone.txt`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m add`.quiet();
  rmSync(join(dir, "gone.txt"));
  const id = upsertRepo(dir, "repo-del", "auto", false);

  const res = await readFileContent(id, "gone.txt");

  expect(res.ok).toBe(true);
  expect(res.ref).toBe("head");
  expect(res.content).toBe("committed body\n");
});

test("refuses a path that escapes the repository", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "ok.txt"), "ok");
  const id = upsertRepo(dir, "repo-esc", "auto", false);

  const res = await readFileContent(id, "../../../etc/passwd");

  expect(res.ok).toBe(false);
  expect(res.code).toBe("ERROR");
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
  const id = upsertRepo(dir, "repo-diff", "auto", false);

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
  const id = upsertRepo(dir, "repo-big-diff", "auto", false);

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
  const id = upsertRepo(dir, "repo-thresh", "auto", false);

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
  const id = upsertRepo(dir, "repo-nopatch", "auto", false);

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
  const id = upsertRepo(dir, "repo-big-add", "auto", false);

  const res = await readFileDiff(id, "fresh.txt");

  expect(res.ok).toBe(true);
  expect(res.mode).toBe("models"); // one side empty → nothing smaller to send
  expect(res.original).toBe("");
  expect(res.modified).toBe(big);
});

test("diff of an untracked file has empty original (all added)", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "new.ts"), "export const fresh = true;\n");
  const id = upsertRepo(dir, "repo-add", "auto", false);

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
  const id = upsertRepo(dir, "repo-del-diff", "auto", false);

  const res = await readFileDiff(id, "old.ts");

  expect(res.ok).toBe(true);
  expect(res.original).toBe("export const bye = 1;\n");
  expect(res.modified).toBe("");
});
