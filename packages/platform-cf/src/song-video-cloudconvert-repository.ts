import type { SongVideoPcmReference } from "@pirate/application/video/song-interval";
import type { Client, QueryResultRow } from "pg";
import { withTransactionSearchPath } from "./song-video-render-store.ts";

export type CloudConvertAttempt = Readonly<{
  attemptId: string;
  outputObjectKey: string;
  jobId: string | null;
  createStarted: boolean;
  deadlineMs: number;
  reconciliationRequired: boolean;
  cleanupComplete: boolean;
  pcmSha256: string | null;
  clipDurationSamples: number;
}>;

/** All mutations are fenced by the existing, immutable render-attempt identity. */
export function makeCloudConvertRenderRepository(
  input: Readonly<{
    connect: () => Promise<Client>;
    transactionSearchPath?: string;
  }>,
) {
  const use = async <T>(fn: (client: Client) => Promise<T>): Promise<T> => {
    const raw = await input.connect();
    try {
      return await fn(
        input.transactionSearchPath === undefined
          ? raw
          : withTransactionSearchPath(raw, input.transactionSearchPath),
      );
    } finally {
      await raw.end();
    }
  };
  const query = <T extends QueryResultRow>(text: string, values: unknown[]) =>
    use((client) => client.query<T>(text, values));
  return {
    async read(attemptId: string): Promise<CloudConvertAttempt | null> {
      const result = await query<{
        attempt_id: string;
        dispatch_output_key: string;
        provider_job_id: string | null;
        provider_create_started_at: Date | null;
        provider_wait_deadline: Date | null;
        provider_reconciliation_required_at: Date | null;
        provider_cleanup_completed_at: Date | null;
        provider_pcm_sha256: string | null;
        clip_duration_samples: string;
      }>(
        `SELECT a.*,p.clip_duration_samples FROM media_song_video_render_attempts a
          JOIN media_song_video_render_plans p ON p.plan_id=a.plan_id
          WHERE a.attempt_id=$1 AND a.dispatch_renderer_identity='cloudconvert-song-video-pcm-v1'`,
        [attemptId],
      );
      const row = result.rows[0];
      if (!row?.provider_wait_deadline) return null;
      return {
        attemptId,
        outputObjectKey: row.dispatch_output_key,
        jobId: row.provider_job_id,
        createStarted: row.provider_create_started_at !== null,
        deadlineMs: row.provider_wait_deadline.getTime(),
        reconciliationRequired: row.provider_reconciliation_required_at !== null,
        cleanupComplete: row.provider_cleanup_completed_at !== null,
        pcmSha256: row.provider_pcm_sha256,
        clipDurationSamples: Number(row.clip_duration_samples),
      };
    },
    async reference(
      input: Readonly<{
        songAssetId: string;
        canonicalAudioSha256: string;
        songDurationSamples: number;
      }>,
    ): Promise<SongVideoPcmReference | null> {
      const result = await query<{
        song_post_id: string;
        audio_revision: string;
        canonical_audio_sha256: string;
        duration_samples: string;
        pcm_object_key: string;
        pcm_object_version: string;
        pcm_object_etag: string;
        pcm_sha256: string;
        pcm_byte_length: string;
        decoder_recipe: string;
      }>(
        `SELECT DISTINCT r.* FROM media_song_video_pcm_references r
          JOIN media_song_video_render_plans p
            ON p.song_post_id=r.song_post_id AND p.audio_revision=r.audio_revision
          WHERE p.song_asset_id=$1 AND r.canonical_audio_sha256=$2 AND r.duration_samples=$3`,
        [input.songAssetId, input.canonicalAudioSha256, input.songDurationSamples],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || row === undefined) return null;
      return {
        songPostId: row.song_post_id,
        audioRevision: Number(row.audio_revision),
        canonicalAudioSha256: row.canonical_audio_sha256,
        durationSamples: Number(row.duration_samples),
        objectKey: row.pcm_object_key,
        objectVersion: row.pcm_object_version,
        objectEtag: row.pcm_object_etag,
        pcmSha256: row.pcm_sha256,
        byteLength: Number(row.pcm_byte_length),
        decoderRecipe: row.decoder_recipe,
      };
    },
    async sourceMediaType(
      immutableRef: string,
      sha256: string,
      byteLength: number,
    ): Promise<"video/mp4" | "video/quicktime" | null> {
      const result = await query<{ content_type: "video/mp4" | "video/quicktime" }>(
        `SELECT content_type FROM media_immutable_objects WHERE immutable_ref=$1
          AND canonical_sha256=$2 AND size_bytes=$3 AND content_type IN ('video/mp4','video/quicktime')`,
        [immutableRef, sha256, byteLength],
      );
      return result.rows[0]?.content_type ?? null;
    },
    async bindPcm(attemptId: string, digest: string): Promise<void> {
      const result = await query(
        `UPDATE media_song_video_render_attempts SET provider_pcm_sha256=$2
        WHERE attempt_id=$1 AND state='started' AND provider_wait_deadline > clock_timestamp()
          AND provider_reconciliation_required_at IS NULL
          AND (provider_pcm_sha256 IS NULL OR provider_pcm_sha256=$2)`,
        [attemptId, digest],
      );
      if (result.rowCount !== 1) throw new Error("CloudConvert PCM binding refused");
    },
    async beginCreate(attemptId: string): Promise<boolean> {
      return use(async (client) => {
        await client.query("BEGIN");
        try {
          // Serialize admission to the fixed two-job bound. Neither a timeout
          // nor a missing response releases an in-flight create for resending.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('song-video-cloudconvert-capacity',0))",
          );
          const result = await client.query(
            `UPDATE media_song_video_render_attempts
            SET provider_create_started_at=clock_timestamp()
            WHERE attempt_id=$1 AND state='started' AND provider_create_started_at IS NULL
              AND provider_wait_deadline > clock_timestamp() AND provider_pcm_sha256 IS NOT NULL
              AND provider_reconciliation_required_at IS NULL
              AND (SELECT count(*) FROM media_song_video_render_attempts
                WHERE provider_create_started_at IS NOT NULL AND provider_cleanup_completed_at IS NULL) < 2`,
            [attemptId],
          );
          await client.query("COMMIT");
          return result.rowCount === 1;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    },
    async attachJob(attemptId: string, jobId: string): Promise<void> {
      const result = await query(
        `UPDATE media_song_video_render_attempts SET provider_job_id=$2
        WHERE attempt_id=$1 AND provider_create_started_at IS NOT NULL
          AND (provider_job_id IS NULL OR provider_job_id=$2)`,
        [attemptId, jobId],
      );
      if (result.rowCount !== 1) throw new Error("CloudConvert job identity conflict");
    },
    async requireReconciliation(attemptId: string): Promise<void> {
      await query(
        `UPDATE media_song_video_render_attempts
        SET provider_reconciliation_required_at=clock_timestamp()
        WHERE attempt_id=$1 AND provider_reconciliation_required_at IS NULL`,
        [attemptId],
      );
    },
    async grant(
      input: Readonly<{
        digest: string;
        attemptId: string;
        key: string;
        version: string;
        etag: string;
        sha256: string;
        byteLength: number;
        expiresAtMs: number;
      }>,
    ): Promise<void> {
      const result = await query(
        `INSERT INTO media_song_video_excerpt_grants
        (capability_sha256,attempt_id,object_key,object_version,object_etag,wav_sha256,byte_length,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM media_song_video_render_attempts
         WHERE attempt_id=$2 AND state='started' AND provider_wait_deadline >= $8::timestamptz
           AND provider_reconciliation_required_at IS NULL AND $8::timestamptz > clock_timestamp()`,
        [
          input.digest,
          input.attemptId,
          input.key,
          input.version,
          input.etag,
          input.sha256,
          input.byteLength,
          new Date(input.expiresAtMs),
        ],
      );
      if (result.rowCount !== 1) throw new Error("CloudConvert excerpt grant refused");
    },
    async excerptKeys(attemptId: string): Promise<string[]> {
      const result = await query<{ object_key: string }>(
        "SELECT object_key FROM media_song_video_excerpt_grants WHERE attempt_id=$1",
        [attemptId],
      );
      return result.rows.map((row) => row.object_key);
    },
    async revoke(attemptId: string): Promise<void> {
      await query(
        `UPDATE media_song_video_excerpt_grants SET revoked_at=clock_timestamp()
        WHERE attempt_id=$1 AND revoked_at IS NULL`,
        [attemptId],
      );
      await query(
        `UPDATE media_video_source_grants SET revoked_at=clock_timestamp()
        WHERE request_id=$1 AND consumer='cloudconvert' AND revoked_at IS NULL`,
        [attemptId],
      );
    },
    async cleaned(attemptId: string): Promise<void> {
      await query(
        `UPDATE media_song_video_render_attempts SET provider_cleanup_completed_at=clock_timestamp()
        WHERE attempt_id=$1 AND provider_cleanup_completed_at IS NULL`,
        [attemptId],
      );
    },
  };
}

export type CloudConvertRenderRepository = ReturnType<typeof makeCloudConvertRenderRepository>;
