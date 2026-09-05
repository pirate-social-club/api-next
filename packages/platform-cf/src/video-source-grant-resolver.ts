import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import { videoSourceCapabilityDigest } from "./video-source-capability.ts";
import type { VideoSourceGrantResolver } from "./video-source-gateway.ts";

type GrantRow = {
  physical_key: string;
  object_version: string;
  etag: string;
  size_bytes: number | string;
  content_type: "video/mp4" | "video/quicktime";
  canonical_sha256: string;
  expires_at: Date;
};

export function makeVideoSourceGrantResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoSourceGrantResolver {
  return {
    async resolve(capability, signal) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) return null;
      const digest = await videoSourceCapabilityDigest(capability);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.execute<GrantRow>({
            label: "video-source.resolve",
            readonly: true,
            text: `SELECT physical_key,object_version,etag,size_bytes,content_type,canonical_sha256,expires_at
          FROM media_video_source_grants WHERE capability_sha256=$1
            AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
            values: [digest],
          });
        }).pipe(Effect.provide(runtime)),
        { signal },
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        expiresAtMs: row.expires_at.getTime(),
        object: {
          key: row.physical_key,
          version: row.object_version,
          etag: row.etag,
          size: Number(row.size_bytes),
          contentType: row.content_type,
          canonicalSha256: row.canonical_sha256,
        },
      };
    },
  };
}
