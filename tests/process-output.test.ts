import { expect, test } from "bun:test";
import { readTextStreamLimited } from "../src/process-output.ts";

test("bounded process reader stops retaining bytes at its cap", async () => {
  let limited = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(700, 97));
      controller.enqueue(Buffer.alloc(700, 98));
      controller.close();
    },
  });

  const result = await readTextStreamLimited(stream, 1_000, () => limited++);
  expect(Buffer.byteLength(result.text)).toBe(1_000);
  expect(result.truncated).toBe(true);
  expect(limited).toBe(1);
});

test("bounded process reader preserves complete output below the cap", async () => {
  const stream = new Blob(["hello"]).stream();
  expect(await readTextStreamLimited(stream, 100)).toEqual({
    text: "hello",
    truncated: false,
  });
});
