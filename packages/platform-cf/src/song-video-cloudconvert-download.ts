import { MAX_SONG_VIDEO_MASTER_BYTES } from "./song-video-master-verifier/master-structure.ts";

/** No redirects or CloudConvert bearer token are sent to the signed export URL. */
export async function downloadSongVideoCloudConvertMaster(
  input: Readonly<{
    exportUrl: string;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    deadlineMs?: number;
    now?: () => number;
  }>,
): Promise<Readonly<{ bytes: Uint8Array; sha256: string }>> {
  let url: URL;
  try {
    url = new URL(input.exportUrl);
  } catch {
    throw new Error("invalid CloudConvert export URL (phase=url error=Error)");
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "storage.cloudconvert.com" &&
      url.hostname !== "us-east.storage.cloudconvert.com") ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid CloudConvert export URL (phase=url error=Error)");
  }
  const controller = new AbortController();
  const remaining =
    input.deadlineMs === undefined ? 120_000 : input.deadlineMs - (input.now ?? Date.now)();
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new Error("CloudConvert export deadline expired (phase=deadline error=Error)");
  const timer = setTimeout(() => controller.abort(), Math.min(120_000, remaining));
  let phase = "fetch";
  let status: number | undefined;
  let declaredBytes: number | undefined;
  let observedBytes = 0;
  try {
    const send = input.fetch;
    const response = await send(input.exportUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    phase = "response";
    status = response.status;
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      throw new Error("CloudConvert export unavailable");
    }
    phase = "declared-length";
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
    declaredBytes = expected ?? undefined;
    phase = "body-read";
    const bytes = new Uint8Array(expected ?? MAX_SONG_VIDEO_MASTER_BYTES);
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        observedBytes = size + next.value.byteLength;
        if (observedBytes > bytes.byteLength) {
          phase = "length-mismatch";
          throw new Error("CloudConvert export exceeds admitted length");
        }
        bytes.set(next.value, size);
        size += next.value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    phase = "length-mismatch";
    if (size === 0 || (expected !== null && size !== expected))
      throw new Error("CloudConvert export length mismatch");
    const result = bytes.subarray(0, size);
    phase = "digest";
    const digest = await crypto.subtle.digest("SHA-256", result as unknown as ArrayBuffer);
    return {
      bytes: result,
      sha256: Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join(""),
    };
  } catch (error) {
    // Only fixed phases, numeric bounds and allowlisted classes survive. Never
    // include exception messages, signed URLs, headers or provider bodies.
    const errorClass =
      error instanceof Error &&
      ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError"].includes(error.name)
        ? error.name
        : "Error";
    const responseStatus =
      status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
        ? ` status=${status}`
        : "";
    const length = declaredBytes === undefined ? "" : ` declaredBytes=${declaredBytes}`;
    throw new Error(
      `CloudConvert export unavailable or invalid (phase=${phase} error=${errorClass}${responseStatus}${length} observedBytes=${observedBytes})`,
    );
  } finally {
    clearTimeout(timer);
  }
}
