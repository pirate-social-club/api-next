import { describe, expect, test } from "bun:test";
import { AvatarFailure, type AvatarReservation } from "@pirate/application/avatars/ports";
import { Effect } from "effect";
import { stripAvatarJpegMetadata } from "./avatar-jpeg.ts";
import { type AvatarBucket, type AvatarImages, makeAvatarStorage } from "./avatar-storage.ts";

const jpeg = new Uint8Array([
  255, 216, 255, 225, 0, 6, 71, 80, 83, 33, 255, 218, 0, 2, 12, 255, 0, 33, 255, 217,
]);
const asset: AvatarReservation = {
  assetId: "avatar-11111111-1111-4111-8111-111111111111",
  ownerId: "owner",
  purpose: "community",
  contentType: "image/png",
  byteLength: 3,
  ingressKey: "ingress/avatar-11111111-1111-4111-8111-111111111111",
  sealedKey: "sealed/avatar-11111111-1111-4111-8111-111111111111.jpg",
  uploadExpiresAt: new Date(Date.now() + 590000).toISOString(),
};
function fixture(
  options: { sourceSize?: number; format?: string; width?: number; codecFailure?: boolean } = {},
) {
  let sourceReads = 0,
    seals = 0;
  const values = new Map<
    string,
    {
      bytes: Uint8Array<ArrayBuffer>;
      customMetadata: Record<string, string>;
      httpMetadata: { contentType: string };
    }
  >();
  const sealed: AvatarBucket = {
    head: async (key) => {
      const v = values.get(key);
      return v ? { ...v, size: v.bytes.length } : null;
    },
    get: async (key) => {
      const v = values.get(key);
      return v ? { ...v, size: v.bytes.length, body: new Blob([v.bytes]).stream() } : null;
    },
    put: async (key, bytes, metadata) => {
      if (values.has(key)) return null;
      seals++;
      values.set(key, { bytes, ...metadata });
      return { size: bytes.length, ...metadata };
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  const ingress: AvatarBucket = {
    ...sealed,
    get: async () => {
      sourceReads++;
      return {
        size: options.sourceSize ?? 3,
        httpMetadata: { contentType: "image/png" },
        body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
      };
    },
  };
  const images: AvatarImages = {
    info: async (stream) => {
      if (options.codecFailure) throw { code: 9412 };
      const size = (await new Response(stream).arrayBuffer()).byteLength;
      return size === 3
        ? { format: options.format ?? "image/png", width: options.width ?? 512, height: 512 }
        : { format: "image/jpeg", width: 512, height: 512 };
    },
    input: () => ({
      transform: () => ({
        output: async (settings) => {
          expect(settings.anim).toBe(false);
          return { image: () => new Blob([jpeg]).stream() };
        },
      }),
    }),
  };
  return {
    storage: makeAvatarStorage({
      ingress,
      sealed,
      images,
      signing: {
        accountId: "a".repeat(32),
        bucket: "avatar-test",
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
      },
    }),
    values,
    sealed,
    counts: () => ({ sourceReads, seals }),
  };
}
describe("avatar normalization and sealing", () => {
  test("strips metadata and never rereads mutable ingress after sealing", async () => {
    const f = fixture();
    const first = await Effect.runPromise(f.storage.seal(asset));
    expect(first.width).toBe(512);
    expect(first.digest).toHaveLength(64);
    expect(Array.from(f.values.get(asset.sealedKey)?.bytes ?? [])).not.toContain(71);
    expect(await Effect.runPromise(f.storage.seal(asset))).toEqual(first);
    expect(f.counts()).toEqual({ sourceReads: 1, seals: 1 });
  });
  test.each([
    { sourceSize: 5242881 },
    { sourceSize: 2 },
    { format: "image/svg+xml" },
    { format: "image/webp" },
    { width: 100000 },
  ])("rejects invalid source %j", async (options) => {
    const f = fixture(options);
    expect(await Effect.runPromise(f.storage.seal(asset).pipe(Effect.flip))).toBeInstanceOf(
      AvatarFailure,
    );
    expect(f.counts().seals).toBe(0);
  });
  test("classifies invalid codec input without accepting an object", async () => {
    const f = fixture({ codecFailure: true });
    expect(await Effect.runPromise(f.storage.seal(asset).pipe(Effect.flip))).toMatchObject({
      reason: "invalid",
    });
    expect(f.counts().seals).toBe(0);
  });
  test("rejects corrupt sealed metadata on retry", async () => {
    const f = fixture();
    await Effect.runPromise(f.storage.seal(asset));
    const value = f.values.get(asset.sealedKey);
    if (!value) throw new Error("Missing sealed fixture");
    value.customMetadata.width = "NaN";
    expect(await Effect.runPromise(f.storage.seal(asset).pipe(Effect.flip))).toMatchObject({
      reason: "unavailable",
    });
    expect(f.counts()).toEqual({ sourceReads: 1, seals: 1 });
  });
  test("delivers a sealed avatar with upload bindings absent", async () => {
    const f = fixture();
    await Effect.runPromise(f.storage.seal(asset));
    const delivery = makeAvatarStorage({ sealed: f.sealed });
    const expected = f.values.get(asset.sealedKey);
    if (!expected) throw new Error("Missing sealed fixture");
    expect(
      await new Response(await Effect.runPromise(delivery.read(asset.sealedKey))).arrayBuffer(),
    ).toEqual(expected.bytes.buffer);
    expect(await Effect.runPromise(delivery.presign(asset).pipe(Effect.flip))).toMatchObject({
      reason: "unavailable",
    });
  });
  test("signs exact bytes and content type without browser credentials", async () => {
    const upload = await Effect.runPromise(fixture().storage.presign(asset));
    expect(new URL(upload.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host",
    );
    expect(upload.requiredHeaders).toEqual([{ name: "content-type", value: "image/png" }]);
    expect(upload.url).not.toContain("test-secret");
  });
  test("removes metadata between scans, strips trailers, and rejects truncated JPEG", () => {
    const multiple = new Uint8Array([
      ...jpeg.slice(0, -2),
      255,
      254,
      0,
      5,
      71,
      80,
      83,
      255,
      218,
      0,
      2,
      15,
      255,
      217,
      71,
      80,
      83,
    ]);
    expect(Array.from(stripAvatarJpegMetadata(multiple))).not.toContain(71);
    expect(() => stripAvatarJpegMetadata(jpeg.slice(0, -1))).toThrow();
    expect(() => stripAvatarJpegMetadata(new Uint8Array([1, 2]))).toThrow();
  });
});
