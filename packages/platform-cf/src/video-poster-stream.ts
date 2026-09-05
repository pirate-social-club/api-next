import type { VideoAccessAuthorizationServices } from "@pirate/application/video/access-authorization";
import { getVideoPosterAccess } from "@pirate/application/video/poster-access";
import { InternalError } from "@pirate/contracts";
import { Effect } from "effect";
import type { VideoPosterAuthority, VideoPosterIdentity } from "./video-poster-authority.ts";
import { matchesSealedVideoPoster } from "./video-poster-object.ts";

interface PosterObject {
  readonly key: string;
  readonly size: number;
  readonly httpEtag: string;
  readonly httpMetadata?: { readonly contentType?: string; readonly contentEncoding?: string };
  readonly customMetadata?: Record<string, string>;
  readonly body: ReadableStream<Uint8Array>;
}

export interface VideoPosterStreamServices extends VideoAccessAuthorizationServices {
  readonly resolveArtifact: (
    input: VideoPosterIdentity,
  ) => Effect.Effect<VideoPosterAuthority | null, unknown>;
  readonly bucket: { get(key: string): Promise<PosterObject | null> };
}

/** Internal response adapter; not a separately registered or unauthenticated route. */
export const streamVideoPoster = Effect.fn("streamVideoPoster")(function* (
  input: Readonly<{ postId: string; viewerUserId?: string; ifNoneMatch?: string }>,
  services: VideoPosterStreamServices,
) {
  // Request-local ownership: unused bodies are cancelled on denial, 304 or failure.
  let object: PosterObject | null = null;
  let handedOff = false;
  return yield* Effect.gen(function* () {
    const access = yield* getVideoPosterAccess(input, {
      ...services,
      resolvePoster: Effect.fn("readSealedVideoPoster")(function* (identity) {
        const authority = yield* services.resolveArtifact(identity);
        if (authority === null) return null;
        if (authority.artifactRef !== identity.artifactRef)
          return yield* Effect.fail(new Error("Invalid poster identity"));
        const found = yield* Effect.tryPromise(() => services.bucket.get(authority.key));
        object = found;
        if (found === null) return null;
        if (!matchesSealedVideoPoster(found, authority))
          return yield* Effect.fail(new Error("Invalid sealed poster"));
        return { artifactRef: authority.artifactRef, etag: found.httpEtag };
      }),
    });
    const headers = new Headers({
      "Cache-Control": access.cacheControl,
      ETag: access.etag,
      "X-Content-Type-Options": "nosniff",
    });
    if (access.status === 304) return new Response(null, { status: 304, headers });
    const readable: PosterObject | null = object;
    if (readable === null)
      return yield* new InternalError({ message: "Video delivery unavailable" });
    headers.set("Content-Type", "image/jpeg");
    headers.set("Content-Length", String(readable.size));
    const response = new Response(readable.body, { status: 200, headers });
    handedOff = true;
    return response;
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise(async () => {
        if (!handedOff && object !== null) await object.body.cancel();
      }).pipe(Effect.catch(() => Effect.void)),
    ),
  );
});
