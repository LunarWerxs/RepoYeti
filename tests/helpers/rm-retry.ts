// Remove a directory tree on Windows, retrying while another process still holds a handle in it.
//
// Bun's node:fs rmSync ACCEPTS maxRetries and retryDelay and then ignores both (measured on Bun
// 1.4.3, Windows, 2026-10-17: maxRetries: 10 threw EBUSY after 0 ms on a folder a child process
// still sat in). Windows keeps a folder busy for a moment after the processes in it exit, so a
// single rmSync run by Bun fails under load while looking correct. The retry therefore lives in
// this loop, not in those options. Do not "simplify" it back to them.
//
// Only EBUSY, EPERM and ENOTEMPTY are retried. Anything else is a real error and is rethrown at
// once, and the last busy error is rethrown after the final attempt so a stuck folder is loud.
// Bun.sleepSync blocks, which is what a synchronous cleanup needs; rmrf() in tests/rmrf.ts is the
// async variant that stays quiet on the last try, for test teardown.
import { rmSync } from "node:fs";

const BUSY = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const ATTEMPTS = 50;
const DELAY_MS = 100;

export function rmRetry(path: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !BUSY.has(code) || attempt >= ATTEMPTS) throw err;
      Bun.sleepSync(DELAY_MS);
    }
  }
}
