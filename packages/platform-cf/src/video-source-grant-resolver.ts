import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import { videoSourceCapabilityDigest } from "./video-source-capability.ts";
import type { VideoSourceGrantResolver } from "./video-source-gateway.ts";

type GrantRow = {
  physical_key: string;
  object_version: string;
  etag: string;
  size_bytes: number | string;
  content_type: "video/mp4" | "video/quicktime" | "audio/wav" | "audio/mpeg";
  canonical_sha256: string;
  expires_at: Date;
  identity_kind: "upload_version" | "content_etag";
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
            text: `SELECT physical_key,object_version,etag,size_bytes,content_type,canonical_sha256,expires_at,identity_kind
          FROM media_video_source_grants WHERE capability_sha256=$1
            AND revoked_at IS NULL AND expires_at > clock_timestamp()
          UNION ALL
          SELECT g.object_key,g.object_version,g.object_etag,g.byte_length,'audio/wav',
                 g.wav_sha256,g.expires_at,'upload_version'
            FROM media_song_video_excerpt_grants g
            JOIN media_song_video_render_attempts a ON a.attempt_id=g.attempt_id
           WHERE g.capability_sha256=$1 AND g.revoked_at IS NULL
             AND g.expires_at > clock_timestamp() AND a.provider_wait_deadline > clock_timestamp()
             AND a.provider_reconciliation_required_at IS NULL AND a.state='started'
          UNION ALL
          SELECT g.object_key,g.object_version,g.object_etag,g.byte_length,g.content_type,
                 g.source_sha256,g.expires_at,g.identity_kind
            FROM media_song_video_pcm_source_grants g
            JOIN media_song_video_pcm_admissions a USING (admission_id)
            JOIN media_publication_projections p ON p.post_id=a.song_post_id
              AND p.audio_revision=a.audio_revision AND p.canonical_audio_sha256=a.canonical_audio_sha256
              AND p.audio_asset_ref=a.audio_asset_ref AND p.media_kind='song' AND p.visibility='public'
           WHERE g.capability_sha256=$1 AND g.revoked_at IS NULL AND g.expires_at > clock_timestamp()
             AND a.state='processing' AND a.provider_wait_deadline > clock_timestamp()`,
            values: [digest],
          });
        }).pipe(Effect.provide(runtime)),
        { signal },
      );
      const row = result.rows[0];
      if (row === undefined || result.rows.length !== 1) return null;
      return {
        expiresAtMs: row.expires_at.getTime(),
        object: {
          key: row.physical_key,
          identity: row.identity_kind,
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
