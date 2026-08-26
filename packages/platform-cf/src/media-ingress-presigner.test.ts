import { mediaIngressUploadPresignRequest } from "@pirate/application";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { makeR2MediaIngressPresigner } from "./media-ingress-presigner.ts";

const options = {
  accountId: "0123456789abcdef0123456789abcdef",
  bucket: "pirate-media-ingress-staging",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  now: () => new Date("2026-08-26T12:34:56.000Z"),
} as const;

describe("R2 media ingress presigner", () => {
  test("signs only the fixed ingress target and exact content type", async () => {
    const result = await Effect.runPromise(
      makeR2MediaIngressPresigner(options).presign(
        mediaIngressUploadPresignRequest({
          serverOwnedObjectKey: "media/ingress/reservation-1/audio",
          contentType: "audio/mpeg",
        }),
      ),
    );
    const url = new URL(result.url);
    expect(url.origin).toBe("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/pirate-media-ingress-staging/media/ingress/reservation-1/audio");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260826T123456Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.requiredHeaders).toEqual([{ name: "content-type", value: "audio/mpeg" }]);
    expect(result.expiresAt).toBe("2026-08-26T12:49:56.000Z");
  });

  test("fails closed for foreign keys and placeholder credentials", async () => {
    await expect(
      Effect.runPromise(
        makeR2MediaIngressPresigner(options).presign(
          mediaIngressUploadPresignRequest({
            serverOwnedObjectKey: "foreign/object",
            contentType: "audio/mpeg",
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "MediaIngressUploadPresignFailed", reason: "invalid-target" });

    await expect(
      Effect.runPromise(
        makeR2MediaIngressPresigner({ ...options, secretAccessKey: "PENDING" }).presign(
          mediaIngressUploadPresignRequest({
            serverOwnedObjectKey: "media/ingress/reservation-1/audio",
            contentType: "audio/mpeg",
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "MediaIngressUploadPresignFailed", reason: "invalid-target" });
  });
});
