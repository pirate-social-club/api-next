import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeAvatarStorage } from "../../packages/platform-cf/src/avatar-storage.ts";

const bindings = env as unknown as {
  AVATAR_TEST_INGRESS: R2Bucket;
  AVATAR_TEST_SEALED: R2Bucket;
  AVATAR_TEST_IMAGES: ImagesBinding;
};
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
describe("avatar storage in workerd", () => {
  it("decodes a real PNG, stores a static JPEG and keeps it immutable", async () => {
    const id = `avatar-${crypto.randomUUID()}`;
    const asset = {
      assetId: id,
      ownerId: "owner",
      purpose: "community" as const,
      contentType: "image/png" as const,
      byteLength: png.length,
      ingressKey: `ingress/${id}`,
      sealedKey: `sealed/${id}.jpg`,
      uploadExpiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    const storage = makeAvatarStorage({
      ingress: bindings.AVATAR_TEST_INGRESS,
      sealed: bindings.AVATAR_TEST_SEALED,
      images: bindings.AVATAR_TEST_IMAGES,
      signing: {
        accountId: "a".repeat(32),
        bucket: "test-avatar-ingress",
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    });
    await bindings.AVATAR_TEST_INGRESS.put(asset.ingressKey, png, {
      httpMetadata: { contentType: "image/png" },
    });
    const first = await Effect.runPromise(storage.seal(asset));
    expect(first.width).toBeLessThanOrEqual(512);
    expect(first.height).toBeLessThanOrEqual(512);
    const stored = await bindings.AVATAR_TEST_SEALED.get(asset.sealedKey);
    expect(stored).not.toBeNull();
    if (!stored) throw new Error("Missing normalized image");
    expect(await bindings.AVATAR_TEST_IMAGES.info(stored.body)).toMatchObject({
      format: "image/jpeg",
    });
    await bindings.AVATAR_TEST_INGRESS.put(asset.ingressKey, "overwritten");
    expect(await Effect.runPromise(storage.seal(asset))).toEqual(first);
    await Effect.runPromise(storage.delete(asset.ingressKey));
    await Effect.runPromise(storage.delete(asset.sealedKey));
  });
});
