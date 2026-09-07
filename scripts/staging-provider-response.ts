export async function readBoundedProviderJson(response: Response, maximumBytes: number) {
  if (response.status !== 200 || response.body === null) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("provider_response");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maximumBytes);
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (count + next.value.byteLength > bytes.length) throw new Error("provider_size");
      bytes.set(next.value, count);
      count += next.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
