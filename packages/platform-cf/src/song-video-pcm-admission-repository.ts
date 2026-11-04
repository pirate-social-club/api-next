import type { Client, QueryResultRow } from "pg";
import { mediaProcessingPhysicalObjectKey } from "./media-immutable-object-key.ts";
import { SONG_VIDEO_PCM_DECODER_RECIPE } from "./song-video-pcm-job.ts";
import { SONG_VIDEO_PCM_MAX_BYTES, type transferSongVideoPcm } from "./song-video-pcm-transfer.ts";
import { withTransactionSearchPath } from "./song-video-render-store.ts";

export type SongPcmAdmission = {
  admission_id: string;
  song_post_id: string;
  song_community_id: string;
  audio_revision: string;
  canonical_audio_sha256: string;
  audio_asset_ref: string;
  state: "pending" | "processing" | "admitted" | "refused" | "reconciliation";
  provider_job_id: string | null;
  provider_create_started_at: Date | null;
  provider_wait_deadline: Date | null;
  cleanup_completed_at: Date | null;
  failure_code: string | null;
  claim_owner: string | null;
  claim_fence: string;
};

export type SongPcmSource = {
  objectKey: string;
  objectVersion: string;
  objectEtag: string;
  byteLength: number;
  durationMs: number;
  identity: "upload_version" | "content_etag";
};

const leaseValues = (a: SongPcmAdmission) => [a.admission_id, a.claim_owner, a.claim_fence];
const LEASE =
  "admission_id=$1 AND claim_owner=$2 AND claim_fence=$3 AND claim_until > clock_timestamp()";
export const songPcmOutputKey = (admissionId: string) => `song-video-pcm/${admissionId}.pcm`;

export function makeSongPcmAdmissionRepository(
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
  const query = <T extends QueryResultRow>(sql: string, values: unknown[]) =>
    use((c) => c.query<T>(sql, values));
  return {
    async get(admissionId: string): Promise<SongPcmAdmission | null> {
      return (
        (
          await query<SongPcmAdmission>(
            "SELECT * FROM media_song_video_pcm_admissions WHERE admission_id=$1",
            [admissionId],
          )
        ).rows[0] ?? null
      );
    },
    async listDue(limit = 25) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("invalid PCM dispatch limit");
      return (
        await query<{ admission_id: string }>(
          `SELECT admission_id FROM media_song_video_pcm_admissions
          WHERE cleanup_completed_at IS NULL AND (claim_until IS NULL OR claim_until <= clock_timestamp())
          ORDER BY requested_at LIMIT $1`,
          [limit],
        )
      ).rows.map((r) => r.admission_id);
    },
    async claim(admissionId: string, owner: string): Promise<SongPcmAdmission | null> {
      const result = await query<SongPcmAdmission>(
        `UPDATE media_song_video_pcm_admissions SET claim_owner=$2,claim_fence=claim_fence+1,
           claim_until=clock_timestamp()+interval '5 minutes'
         WHERE admission_id=$1 AND cleanup_completed_at IS NULL
           AND (claim_until IS NULL OR claim_until <= clock_timestamp()) RETURNING *`,
        [admissionId, owner],
      );
      return result.rows[0] ?? null;
    },
    async release(a: SongPcmAdmission) {
      await query(
        `UPDATE media_song_video_pcm_admissions SET claim_owner=NULL,claim_until=NULL WHERE ${LEASE}`,
        leaseValues(a),
      );
    },
    async source(a: SongPcmAdmission): Promise<SongPcmSource | null> {
      const result = await query<{
        object_version: string;
        etag: string;
        size_bytes: string;
        identity_kind: "upload_version" | "content_etag";
        duration_ms: string;
      }>(
        `SELECT o.object_version,o.etag,o.size_bytes,o.identity_kind,
            probe.result #>> '{value,probe,durationMs}' AS duration_ms
         FROM media_publication_projections p
         JOIN media_immutable_objects o ON o.immutable_ref=p.audio_asset_ref
           AND o.canonical_sha256=p.canonical_audio_sha256 AND o.community_id=p.community_id
         JOIN media_processing_attempts probe ON probe.submission_id=p.submission_id
           AND probe.operation_id=p.operation_id AND probe.audio_revision=p.audio_revision
           AND probe.analysis_revision=p.analysis_revision AND probe.stage='probe' AND probe.state='succeeded'
           AND probe.result->>'kind'='probe' AND probe.result #>> '{value,status}'='completed'
         WHERE p.post_id=$1 AND p.audio_revision=$2 AND p.canonical_audio_sha256=$3
           AND p.audio_asset_ref=$4 AND p.media_kind='song' AND p.visibility='public'
           AND o.content_type='audio/mpeg'`,
        [a.song_post_id, a.audio_revision, a.canonical_audio_sha256, a.audio_asset_ref],
      );
      const r = result.rows[0];
      if (result.rows.length !== 1 || !r) return null;
      const byteLength = Number(r.size_bytes),
        durationMs = Number(r.duration_ms);
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength < 1 ||
        byteLength > 67_108_864 ||
        !Number.isFinite(durationMs) ||
        durationMs <= 0 ||
        durationMs > 240_000
      )
        return null;
      return {
        objectKey: mediaProcessingPhysicalObjectKey(a.audio_asset_ref),
        objectVersion: r.object_version,
        objectEtag: r.etag,
        byteLength,
        durationMs,
        identity: r.identity_kind,
      };
    },
    async beginCreate(a: SongPcmAdmission): Promise<SongPcmAdmission | null> {
      return use(async (c) => {
        await c.query("BEGIN");
        try {
          await c.query("SELECT pg_advisory_xact_lock(hashtext('song_pcm_create_capacity'))");
          const count = await c.query<{
            n: string;
          }>(`SELECT count(*)::text AS n FROM media_song_video_pcm_admissions
            WHERE provider_create_started_at IS NOT NULL AND cleanup_completed_at IS NULL`);
          if (Number(count.rows[0]?.n) >= 2) {
            await c.query("ROLLBACK");
            return null;
          }
          const result = await c.query<SongPcmAdmission>(
            `UPDATE media_song_video_pcm_admissions
            SET state='processing',provider_create_started_at=clock_timestamp(),
              provider_wait_deadline=clock_timestamp()+interval '30 minutes'
            WHERE ${LEASE} AND state='pending' AND provider_create_started_at IS NULL RETURNING *`,
            leaseValues(a),
          );
          await c.query("COMMIT");
          return result.rows[0] ?? null;
        } catch (error) {
          await c.query("ROLLBACK");
          throw error;
        }
      });
    },
    async attachJob(a: SongPcmAdmission, jobId: string) {
      const r = await query(
        `UPDATE media_song_video_pcm_admissions SET provider_job_id=$4
        WHERE ${LEASE} AND provider_create_started_at IS NOT NULL
          AND (provider_job_id IS NULL OR provider_job_id=$4) RETURNING admission_id`,
        [...leaseValues(a), jobId],
      );
      if (r.rowCount !== 1) throw new Error("PCM job evidence fence lost");
    },
    async grant(a: SongPcmAdmission, source: SongPcmSource, digest: string, expiresAtMs: number) {
      const r = await query(
        `INSERT INTO media_song_video_pcm_source_grants
        (capability_sha256,admission_id,object_key,object_version,object_etag,source_sha256,
         byte_length,content_type,identity_kind,expires_at)
        SELECT $4,admission_id,$5,$6,$7,canonical_audio_sha256,$8,'audio/mpeg',$9,to_timestamp($10/1000.0)
          FROM media_song_video_pcm_admissions WHERE ${LEASE} AND state='processing'
          AND provider_wait_deadline > clock_timestamp() AND to_timestamp($10/1000.0) <= provider_wait_deadline
        RETURNING admission_id`,
        [
          ...leaseValues(a),
          digest,
          source.objectKey,
          source.objectVersion,
          source.objectEtag,
          source.byteLength,
          source.identity,
          expiresAtMs,
        ],
      );
      if (r.rowCount !== 1) throw new Error("PCM source grant fence lost");
    },
    async refuse(a: SongPcmAdmission, code: string, reconciliation: boolean) {
      const result = await query(
        `UPDATE media_song_video_pcm_admissions SET state=$4,failure_code=$5
        WHERE ${LEASE} AND state <> 'admitted'`,
        [...leaseValues(a), reconciliation ? "reconciliation" : "refused", code],
      );
      return result.rowCount === 1;
    },
    async revoke(a: SongPcmAdmission) {
      await query(
        `UPDATE media_song_video_pcm_source_grants SET revoked_at=clock_timestamp()
        WHERE admission_id=$1 AND revoked_at IS NULL`,
        [a.admission_id],
      );
    },
    async cleaned(a: SongPcmAdmission) {
      await query(
        `UPDATE media_song_video_pcm_admissions SET cleanup_completed_at=clock_timestamp()
        WHERE ${LEASE} AND state IN ('admitted','refused','reconciliation') AND cleanup_completed_at IS NULL`,
        leaseValues(a),
      );
    },
    async admit(a: SongPcmAdmission, facts: Awaited<ReturnType<typeof transferSongVideoPcm>>) {
      if (
        facts.decoderRecipe !== SONG_VIDEO_PCM_DECODER_RECIPE ||
        facts.objectKey !== songPcmOutputKey(a.admission_id) ||
        facts.byteLength < 4 ||
        facts.byteLength > SONG_VIDEO_PCM_MAX_BYTES ||
        facts.byteLength !== facts.durationSamples * 4 ||
        !/^[0-9a-f]{64}$/u.test(facts.pcmSha256)
      )
        throw new Error("PCM admission facts refused");
      return use(async (c) => {
        await c.query("BEGIN");
        try {
          const held = await c.query(
            `SELECT 1 FROM media_song_video_pcm_admissions
            WHERE ${LEASE} AND state='processing' AND provider_job_id IS NOT NULL
              AND provider_wait_deadline > clock_timestamp() FOR UPDATE`,
            leaseValues(a),
          );
          if (held.rowCount !== 1) throw new Error("PCM admission lease or deadline lost");
          const live = await c.query(
            `SELECT 1 FROM media_publication_projections WHERE post_id=$1
            AND audio_revision=$2 AND canonical_audio_sha256=$3 AND audio_asset_ref=$4
            AND media_kind='song' AND visibility='public' FOR UPDATE`,
            [a.song_post_id, a.audio_revision, a.canonical_audio_sha256, a.audio_asset_ref],
          );
          if (live.rowCount !== 1) throw new Error("PCM source revision changed");
          const timing = await c.query(
            `UPDATE media_song_canonical_timings SET state='ready',duration_samples=$4,
            prober_identity=$5,prober_policy_revision=1,measured_at=clock_timestamp(),failure_code=NULL,
            lease_expires_at=NULL WHERE song_post_id=$1 AND audio_revision=$2 AND canonical_audio_sha256=$3
              AND state <> 'ready' RETURNING song_post_id`,
            [
              a.song_post_id,
              a.audio_revision,
              a.canonical_audio_sha256,
              facts.durationSamples,
              facts.decoderRecipe,
            ],
          );
          if (timing.rowCount !== 1) throw new Error("PCM timing is absent or already frozen");
          await c.query(
            `INSERT INTO media_song_video_pcm_references
            (song_post_id,audio_revision,canonical_audio_sha256,duration_samples,pcm_object_key,
             pcm_object_version,pcm_object_etag,pcm_sha256,pcm_byte_length,decoder_recipe)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              a.song_post_id,
              a.audio_revision,
              a.canonical_audio_sha256,
              facts.durationSamples,
              facts.objectKey,
              facts.objectVersion,
              facts.objectEtag,
              facts.pcmSha256,
              facts.byteLength,
              facts.decoderRecipe,
            ],
          );
          await c.query(
            `UPDATE media_song_video_pcm_admissions SET state='admitted'
            WHERE admission_id=$1`,
            [a.admission_id],
          );
          await c.query("COMMIT");
        } catch (error) {
          await c.query("ROLLBACK");
          throw error;
        }
      });
    },
  };
}
