import { describe, expect, test } from "bun:test";
import { GetVideoPoster, InternalError, NotFound, registry, toErrorBody } from "@pirate/contracts";
import type { VideoPosterStreamServices } from "@pirate/platform-cf/video-poster-stream";
import { Effect } from "effect";
import { binaryEndpointResponse } from "./binary-response.ts";
import type { DecodedRequest } from "./transport.ts";
import { makeVideoPosterHandler } from "./video-poster-handler.ts";

function fixture(allowed = true, missing = false) {
  const calls: string[] = [];
  const key = "video-analysis/op-1/v1/a1/poster.jpg";
  const artifactRef = `media://derived/${key}`;
  const document = {
    post: { id: "post-1", community: "community-1", post_type: "video", status: "published" },
    video: {
      soundtrack: { kind: "original_audio" },
      thumbnail: { status: "ready", artifact_ref: artifactRef },
    },
  } as Effect.Success<ReturnType<VideoPosterStreamServices["contentStore"]["getPost"]>>;
  const services: VideoPosterStreamServices = {
    contentStore: {
      resolvePost: () => Effect.succeed({ postId: "post-1", communityId: "community-1" }),
      getPost: () => Effect.succeed(document),
    },
    authorizePublication: ({ viewerUserId }) =>
      Effect.sync(() => {
        calls.push(`authorize:${viewerUserId ?? "anonymous"}`);
        return allowed;
      }),
    resolveArtifact: () =>
      Effect.sync(() => {
        calls.push("authority");
        return {
          key,
          artifactRef,
          sha256: "a".repeat(64),
          sourceSha256: "b".repeat(64),
          policyRevision: "1",
        };
      }),
    bucket: {
      get: async () => {
        calls.push("object");
        if (missing) return null;
        return {
          key,
          size: 4,
          httpEtag: '"sealed"',
          httpMetadata: { contentType: "image/jpeg" },
          customMetadata: {
            sha256: "a".repeat(64),
            sourceSha256: "b".repeat(64),
            policyRevision: "1",
          },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([255, 216, 255, 217]));
            },
            pull(controller) {
              controller.close();
            },
            cancel() {
              calls.push("cancel");
            },
          }),
        };
      },
    },
  };
  const handler = makeVideoPosterHandler(services);
  const request: DecodedRequest = {
    params: { postId: "post-1" },
    body: undefined,
    query: {},
    principal: null,
  };
  return { calls, handler, request };
}

describe("prepared poster handler and serializer, not registered-router acceptance", () => {
  test("does not register an endpoint or change the client release early", () => {
    expect(registry).not.toHaveProperty("GetVideoPoster");
  });
  test("anonymous authorized access yields only JPEG bytes and private headers", async () => {
    const f = fixture();
    const result = await f.handler(f.request);
    const response = await binaryEndpointResponse(
      GetVideoPoster,
      result.body,
      result.status ?? 0,
      new Headers(result.responseHeaders),
    );
    expect(result.body).toBe(response.body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(JSON.stringify([...response.headers])).not.toContain("video-analysis");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([255, 216, 255, 217]),
    );
    expect(f.calls).toEqual(["authorize:anonymous", "authority", "object"]);
  });
  test("matching ETag still checks the viewer and cancels unused bytes before 304", async () => {
    const f = fixture();
    const result = await f.handler({
      ...f.request,
      principal: { kind: "user", subject: "viewer" },
      headers: { "if-none-match": '"sealed"' },
    });
    expect(result.status).toBe(304);
    expect(result.body).toBeNull();
    expect(f.calls).toEqual(["authorize:viewer", "authority", "object", "cancel"]);
  });
  test("denied matching ETag reads no artifact and differs from an eligible missing artifact", async () => {
    const denied = fixture(false);
    const missing = fixture(true, true);
    const failure = (f: ReturnType<typeof fixture>) =>
      f
        .handler({ ...f.request, headers: { "if-none-match": '"sealed"' } })
        .catch((error: unknown) => toErrorBody(error));
    expect(await failure(denied)).toEqual(
      toErrorBody(new NotFound({ message: "Video not found" })),
    );
    expect(denied.calls).toEqual(["authorize:anonymous"]);
    expect(await failure(missing)).toEqual(
      toErrorBody(new InternalError({ message: "Video delivery unavailable" })),
    );
  });
  test("non-viewer principals fail before reading policy or storage", async () => {
    const f = fixture();
    await expect(
      f.handler({ ...f.request, principal: { kind: "agent", subject: "agent" } }),
    ).rejects.toThrow("Authorization failed");
    expect(f.calls).toEqual([]);
  });
});
