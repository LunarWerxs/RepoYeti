import { expect, test } from "bun:test";
import { renameReplacing } from "../src/service/files.ts";

// A save renames its temp file over the target. On Windows that rename fails with EPERM while a
// git child or an antivirus scan still has the target open (the regression: the PUT answered 400
// ERROR for a handle that closes milliseconds later). Transient codes are retried; others are not.

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: test`), { code });
}

test("renameReplacing retries a rename held off by a transient Windows share violation", async () => {
  let calls = 0;
  const flaky = (): void => {
    calls++;
    if (calls <= 2) throw errno("EPERM");
  };
  await renameReplacing("a.tmp", "a.md", flaky);
  expect(calls).toBe(3);
});

test("renameReplacing gives up after its last attempt and throws the original error", async () => {
  let calls = 0;
  const stuck = (): void => {
    calls++;
    throw errno("EBUSY");
  };
  await expect(renameReplacing("a.tmp", "a.md", stuck)).rejects.toThrow("EBUSY");
  expect(calls).toBe(8);
});

test("renameReplacing does not retry an error that a pause cannot fix", async () => {
  let calls = 0;
  const missing = (): void => {
    calls++;
    throw errno("ENOENT");
  };
  await expect(renameReplacing("a.tmp", "a.md", missing)).rejects.toThrow("ENOENT");
  expect(calls).toBe(1);
});
