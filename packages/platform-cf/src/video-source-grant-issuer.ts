import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import { mediaImmutableReferenceFromPhysicalKey } from "./media-immutable-object-key.ts";
import type { QencodeSourceGrantIssuer } from "./qencode-media-transform.ts";
import { videoSourceCapabilityDigest } from "./video-source-capability.ts";
import { makeVideoSourceUrl } from "./video-source-gateway.ts";

export function makeVideoSourceGrantIssuer(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  origin: string,
  consumer: "qencode" | "stream",
): QencodeSourceGrantIssuer {
  // Validate before any effect. The placeholder is not a capability that can be issued.
  makeVideoSourceUrl(origin, "a".repeat(43));
  return {
    async issue(input) {
      const immutableRef = mediaImmutableReferenceFromPhysicalKey(input.objectKey);
      if (
        !Number.isSafeInteger(input.expiresAtMs) ||
        input.expiresAtMs <= Date.now() ||
        input.expiresAtMs > 8.64e15
      )
        throw new Error("video source grant deadline expired or invalid");
      const expiresAt = new Date(input.expiresAtMs).toISOString();
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const capability = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      const digest = await videoSourceCapabilityDigest(capability);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.execute({
            label: "video-source.issue",
            readonly: false,
            text: `INSERT INTO media_video_source_grants
            (capability_sha256,request_id,consumer,immutable_ref,physical_key,object_version,etag,size_bytes,content_type,canonical_sha256,expires_at)
            SELECT $1,$2,$3,i.immutable_ref,$4,i.object_version,i.etag,i.size_bytes,i.content_type,i.canonical_sha256,$5::timestamptz
            FROM media_immutable_objects i WHERE i.immutable_ref=$6
              AND i.canonical_sha256=$7 AND i.size_bytes=$8 AND i.content_type=$9
              AND $5::timestamptz > clock_timestamp()
            RETURNING capability_sha256`,
            values: [
              digest,
              input.requestId,
              consumer,
              input.objectKey,
              expiresAt,
              immutableRef,
              input.sha256,
              input.byteLength,
              input.mediaType,
            ],
          });
        }).pipe(Effect.provide(runtime)),
      );
      if (result.rowCount !== 1)
        throw new Error("video source grant seal mismatch or expired deadline");
      if (input.expiresAtMs <= Date.now()) throw new Error("video source grant deadline expired");
      return { url: makeVideoSourceUrl(origin, capability), expiresAtMs: input.expiresAtMs };
    },
  };
}
