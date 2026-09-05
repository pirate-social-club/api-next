import { describe, expect, test } from "bun:test";
import type { LocalizedPostDocument } from "@pirate/application";
import { InternalError, NotFound, toErrorBody } from "@pirate/contracts";
import { Effect } from "effect";
import { streamVideoPoster, type VideoPosterStreamServices } from "./video-poster-stream.ts";

function fixture() {
  const calls: string[] = [];
  const key = "video-analysis/op-1/v1/a1/poster.jpg";
  const artifactRef = `media://derived/${key}`;
  const bytes = new Uint8Array([255, 216, 255, 217]);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    pull(controller) {
      controller.close();
    },
    cancel() {
      calls.push("cancel");
    },
  });
  const object = {
    key,
    size: bytes.length,
    httpEtag: '"sealed"',
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: { sha256: "a".repeat(64), sourceSha256: "b".repeat(64), policyRevision: "1" },
    body,
  };
  const document = {
    post: { id: "post-1", community: "community-1", post_type: "video", status: "published" },
    video: {
      soundtrack: { kind: "original_audio" },
      thumbnail: { status: "ready", artifact_ref: artifactRef },
    },
  } as LocalizedPostDocument;
  const services: VideoPosterStreamServices = {
    contentStore: {
      resolvePost: () => Effect.succeed({ postId: "post-1", communityId: "community-1" }),
      getPost: () => Effect.succeed(document),
    },
    authorizePublication: () =>
      Effect.sync(() => {
        calls.push("authorize");
        return true;
      }),
    resolveArtifact: () =>
      Effect.sync(() => {
        calls.push("authority");
        return {
          artifactRef,
          key,
          sha256: "a".repeat(64),
          sourceSha256: "b".repeat(64),
          policyRevision: "1",
        };
      }),
    bucket: {
      get: async (requested) => {
        calls.push("get");
        expect(requested).toBe(key);
        return object;
      },
    },
  };
  const run = (ifNoneMatch?: string, overrides: Partial<VideoPosterStreamServices> = {}) =>
    Effect.runPromise(
      streamVideoPoster(
        { postId: "post-1", ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }) },
        { ...services, ...overrides },
      ),
    );
  return { calls, object, bytes, services, run };
}

describe("sealed poster response adapter, not yet a registered HTTP route", () => {
  test("streams the existing body without reading or copying it", async () => {
    const f = fixture();
    const response = await f.run();
    expect(response.status).toBe(200);
    expect(response.body).toBe(f.object.body);
    expect(f.calls).toEqual(["authorize", "authority", "get"]);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(JSON.stringify([...response.headers])).not.toContain("video-analysis");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.bytes);
  });
  test("304 follows authorization and artifact validation, and cancels unused bytes", async () => {
    const f = fixture();
    const response = await f.run('W/"sealed"');
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(f.calls).toEqual(["authorize", "authority", "get", "cancel"]);
  });
  test("denial skips both artifact authority and R2 even with a matching ETag", async () => {
    const f = fixture();
    const result = await f
      .run('"sealed"', { authorizePublication: () => Effect.succeed(false) })
      .catch((error: unknown) => toErrorBody(error));
    expect(result).toEqual(toErrorBody(new NotFound({ message: "Video not found" })));
    expect(f.calls).toEqual([]);
    await f.object.body.cancel();
  });
  test.each(["missing-authority", "missing-object", "unreadable"])(
    "eligible %s is a redacted system failure, including with a matching ETag",
    async (failure) => {
      const f = fixture();
      const overrides: Partial<VideoPosterStreamServices> =
        failure === "missing-authority"
          ? { resolveArtifact: () => Effect.succeed(null) }
          : {
              bucket: {
                get: async () => {
                  if (failure === "unreadable") throw new Error("secret bucket detail");
                  return null;
                },
              },
            };
      const result = await f
        .run('"sealed"', overrides)
        .catch((error: unknown) => toErrorBody(error));
      expect(result).toEqual(
        toErrorBody(new InternalError({ message: "Video delivery unavailable" })),
      );
      await f.object.body.cancel();
    },
  );
  test.each(["digest", "source", "policy", "type", "size", "key", "etag"])(
    "rejects %s mismatch before bytes or 304 and cancels the body",
    async (mismatch) => {
      const f = fixture();
      if (mismatch === "digest") f.object.customMetadata.sha256 = "c".repeat(64);
      if (mismatch === "source") f.object.customMetadata.sourceSha256 = "c".repeat(64);
      if (mismatch === "policy") f.object.customMetadata.policyRevision = "2";
      if (mismatch === "type") f.object.httpMetadata.contentType = "text/html";
      if (mismatch === "size") f.object.size = 512 * 1024 + 1;
      if (mismatch === "key") f.object.key = "wrong-object";
      if (mismatch === "etag") f.object.httpEtag = "unquoted";
      const result = await f.run('"sealed"').catch((error: unknown) => toErrorBody(error));
      expect(result).toEqual(
        toErrorBody(new InternalError({ message: "Video delivery unavailable" })),
      );
      expect(f.calls).toEqual(["authorize", "authority", "get", "cancel"]);
    },
  );
});
