/**
 * Read a child-process text stream without allowing a noisy or malformed executable to retain
 * unbounded output in the daemon. The returned text contains at most `maxBytes` of UTF-8 input.
 */
export async function readBytesStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit?: () => void,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const limit = Math.max(0, Math.floor(maxBytes));
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = limit - bytes;
      if (remaining <= 0 || value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(Buffer.from(value.subarray(0, remaining)));
          bytes += remaining;
        }
        truncated = true;
        try {
          onLimit?.();
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        break;
      }
      chunks.push(Buffer.from(value));
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, bytes), truncated };
}

export async function readTextStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit?: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const result = await readBytesStreamLimited(stream, maxBytes, onLimit);
  return { text: result.bytes.toString("utf8"), truncated: result.truncated };
}
