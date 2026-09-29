import { MAX_SONG_VIDEO_MASTER_BYTES } from "./song-video-master-verifier/master-structure.ts";

/** No redirects or CloudConvert bearer token are sent to the signed export URL. */
export async function downloadSongVideoCloudConvertMaster(
  input: Readonly<{
    exportUrl: string;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
  }>,
): Promise<Readonly<{ bytes: Uint8Array; sha256: string }>> {
  let url: URL;
  try {
    url = new URL(input.exportUrl);
  } catch {
    throw new Error("invalid CloudConvert export URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "storage.cloudconvert.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid CloudConvert export URL");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await input.fetch(input.exportUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      throw new Error("CloudConvert export unavailable");
    }
    const declared = response.headers.get("content-length");
    const expected = declared === null ? null : Number(declared);
    if (
      (declared !== null && !/^\d+$/u.test(declared)) ||
      (expected !== null &&
        (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_SONG_VIDEO_MASTER_BYTES))
    ) {
      await response.body.cancel();
      throw new Error("CloudConvert export exceeds master bound");
    }
    const bytes = new Uint8Array(expected ?? MAX_SONG_VIDEO_MASTER_BYTES);
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (size + next.value.byteLength > MAX_SONG_VIDEO_MASTER_BYTES)
          throw new Error("CloudConvert export exceeds master bound");
        bytes.set(next.value, size);
        size += next.value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (size === 0 || (expected !== null && size !== expected))
      throw new Error("CloudConvert export length mismatch");
    const result = bytes.subarray(0, size);
    const digest = await crypto.subtle.digest("SHA-256", result as unknown as ArrayBuffer);
    return {
      bytes: result,
      sha256: Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join(""),
    };
  } catch {
    // Do not put the signed URL or provider response body in an error.
    throw new Error("CloudConvert export unavailable or invalid");
  } finally {
    clearTimeout(timer);
  }
}
