import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  MEDIA_INGRESS_UPLOAD_CONTENT_TYPE_HEADER,
  MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS,
  MEDIA_INGRESS_UPLOAD_METHOD,
  MediaIngressUploadPresigner,
  mediaIngressUploadPresignRequest,
} from "./ports.ts";

describe("MediaIngressUploadPresigner port", () => {
  test("constructs only the fixed PUT, content-type, and short expiry boundary", () => {
    const request = mediaIngressUploadPresignRequest({
      serverOwnedObjectKey: "reservations/reservation_1/source",
      contentType: "audio/mpeg",
    });

    expect(request).toEqual({
      serverOwnedObjectKey: "reservations/reservation_1/source",
      method: MEDIA_INGRESS_UPLOAD_METHOD,
      requiredSignedHeaders: [
        {
          name: MEDIA_INGRESS_UPLOAD_CONTENT_TYPE_HEADER,
          value: "audio/mpeg",
        },
      ],
      expiresInSeconds: MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS,
    });
    expect(MEDIA_INGRESS_UPLOAD_METHOD).toBe("PUT");
    expect(MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS).toBe(900);
    expect(request).not.toHaveProperty("bucket");
    expect(request).not.toHaveProperty("endpoint");
    expect(request).not.toHaveProperty("operation");
  });

  test("returns only the opaque URL, required headers, and deadline", async () => {
    const calls: unknown[] = [];
    const service: MediaIngressUploadPresigner["Service"] = {
      presign: (request) => {
        calls.push(request);
        return Effect.succeed({
          url: "opaque-presigned-url",
          requiredHeaders: request.requiredSignedHeaders,
          expiresAt: "2026-08-25T11:15:00.000Z",
        });
      },
    };
    const request = mediaIngressUploadPresignRequest({
      serverOwnedObjectKey: "reservations/reservation_2/source",
      contentType: "audio/wav",
    });
    const program = Effect.gen(function* () {
      const presigner = yield* MediaIngressUploadPresigner;
      return yield* presigner.presign(request);
    });
    const result = await Effect.runPromise(
      Effect.provideService(program, MediaIngressUploadPresigner, service),
    );

    expect(calls).toEqual([request]);
    expect(result).toEqual({
      url: "opaque-presigned-url",
      requiredHeaders: [{ name: "content-type", value: "audio/wav" }],
      expiresAt: "2026-08-25T11:15:00.000Z",
    });
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "requiredHeaders", "url"]);
  });

  test("does not expose arbitrary signing or caller-selected storage coordinates", () => {
    type ServiceKeys = keyof MediaIngressUploadPresigner["Service"];
    type RequestKeys = keyof ReturnType<typeof mediaIngressUploadPresignRequest>;
    type Exactly<Actual, Expected> =
      Exclude<Actual, Expected> extends never
        ? Exclude<Expected, Actual> extends never
          ? true
          : false
        : false;
    const serviceIsClosed: Exactly<ServiceKeys, "presign"> = true;
    const requestIsClosed: Exactly<
      RequestKeys,
      "serverOwnedObjectKey" | "method" | "requiredSignedHeaders" | "expiresInSeconds"
    > = true;
    const serviceKeys: readonly ServiceKeys[] = ["presign"];
    const requestKeys: readonly RequestKeys[] = [
      "serverOwnedObjectKey",
      "method",
      "requiredSignedHeaders",
      "expiresInSeconds",
    ];

    expect(serviceIsClosed).toBe(true);
    expect(requestIsClosed).toBe(true);
    expect(serviceKeys).toEqual(["presign"]);
    expect(requestKeys).not.toContain("bucket");
    expect(requestKeys).not.toContain("endpoint");
    expect(requestKeys).not.toContain("payload");
  });
});
