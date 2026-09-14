import { expect, test } from "bun:test";
import type { SealedMediaObject } from "./telegram-poster-bytes.ts";
import {
  makeTelegramVideoSourceBytes,
  TELEGRAM_VIDEO_UPLOAD_MAX_BYTES,
} from "./telegram-video-source-bytes.ts";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const payload = new Uint8Array([1, 2, 3, 4, 5]);
const source = {
  physicalKey: "immutable/operation-1/video/1",
  canonicalSha256: await sha256Hex(payload),
  rights: "original" as const,
};

function object(overrides: Partial<SealedMediaObject> = {}): SealedMediaObject {
  return {
    key: source.physicalKey,
    size: payload.byteLength,
    httpMetadata: { contentType: "video/mp4" },
    arrayBuffer: async () => payload.slice().buffer,
    ...overrides,
  };
}

test("reads an accepted source whose bytes match the canonical hash", async () => {
  const reader = makeTelegramVideoSourceBytes({ get: async () => object() });
  const read = await reader(source);
  expect(read?.contentType).toBe("video/mp4");
  expect(new Uint8Array(read?.bytes ?? [])).toEqual(payload);
});

test("hash, size, type, ceiling, interruption and outage all return null", async () => {
  const cases: Partial<SealedMediaObject>[] = [
    { key: "immutable/other" },
    { httpMetadata: { contentType: "image/jpeg" } },
    { size: payload.byteLength + 1 },
    { size: TELEGRAM_VIDEO_UPLOAD_MAX_BYTES + 1 },
    { arrayBuffer: async () => new Uint8Array([9, 9]).buffer },
  ];
  for (const overrides of cases) {
    const reader = makeTelegramVideoSourceBytes({ get: async () => object(overrides) });
    expect(await reader(source)).toBeNull();
  }
  const interrupted = makeTelegramVideoSourceBytes({
    get: async () => ({
      key: source.physicalKey,
      size: payload.byteLength,
      httpMetadata: { contentType: "video/mp4" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(payload.slice(0, 2));
          controller.error(new Error("interrupted"));
        },
      }),
    }),
  });
  expect(await interrupted(source)).toBeNull();
  expect(await makeTelegramVideoSourceBytes({ get: async () => null })(source)).toBeNull();
  const unavailable = makeTelegramVideoSourceBytes({
    get: async () => {
      throw new Error("storage unavailable");
    },
  });
  expect(await unavailable(source)).toBeNull();
});

test("a stream-shaped object is read within its declared size", async () => {
  const reader = makeTelegramVideoSourceBytes({
    get: async () => ({
      key: source.physicalKey,
      size: payload.byteLength,
      httpMetadata: { contentType: "video/mp4" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload.slice(0, 2));
          controller.enqueue(payload.slice(2));
          controller.close();
        },
      }),
    }),
  });
  expect(new Uint8Array((await reader(source))?.bytes ?? [])).toEqual(payload);
});
