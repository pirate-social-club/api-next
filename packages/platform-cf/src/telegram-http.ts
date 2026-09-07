/** Provider bodies are bounded while streaming, including chunked responses. */
export async function telegramResponseBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (
    !response.body ||
    (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit))
  ) {
    await response.body?.cancel();
    throw new Error("Provider response unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("Provider response unavailable");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function telegramObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Provider response unavailable");
  return value as Record<string, unknown>;
}
