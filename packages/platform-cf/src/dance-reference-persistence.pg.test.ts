import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_DANCE_REFERENCE_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-dance-reference-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-dance-reference-suite-complete\n";
const testCount = 2;
let completedTestCount = 0;

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);
const HASH_D = "44".repeat(32);

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema(
  label: string,
  run: (admin: Client, schema: string) => Promise<void>,
): Promise<void> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = `api_next_dance_${label}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    await runPostgresMigrations({
      connectionString: connectionForSchema(connectionString, schema),
    });
    await seedAuthority(admin);
    await run(admin, schema);
  } finally {
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seedAuthority(admin: Client): Promise<void> {
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO users (user_id) VALUES
         ('song-owner'), ('dance-creator'), ('intruder')`,
    );
    await admin.query(
      `INSERT INTO personas (persona_id, account_id, status, created_at) VALUES
         ('song-persona', 'song-owner', 'active', clock_timestamp()),
         ('dance-persona', 'dance-creator', 'active', clock_timestamp()),
         ('intruder-persona', 'intruder', 'active', clock_timestamp())`,
    );
    await admin.query(
      `INSERT INTO communities (
         community_id, display_name, status, created_by_user_id, created_at, updated_at
       ) VALUES (
         'community-1', 'Dance fixtures', 'active', 'song-owner',
         clock_timestamp(), clock_timestamp()
       )`,
    );
    await admin.query(
      `INSERT INTO posts (
         community_id, post_id, author_user_id, author_persona_id,
         post_type, status, visibility, created_at, updated_at
       ) VALUES
         ('community-1', 'song-1', 'song-owner', 'song-persona',
          'song', 'published', 'public', clock_timestamp(), clock_timestamp()),
         ('community-1', 'video-1', 'dance-creator', 'dance-persona',
          'video', 'published', 'public', clock_timestamp(), clock_timestamp()),
         ('community-1', 'video-2', 'dance-creator', 'dance-persona',
          'video', 'published', 'public', clock_timestamp(), clock_timestamp())`,
    );
    await admin.query(
      `INSERT INTO media_publication_projections (
         submission_id, community_id, actor_user_id, author_persona_id,
         operation_id, post_id, creation_revision, audio_revision,
         analysis_revision, decision_revision, canonical_audio_sha256,
         title, audio_asset_ref, language_status, lyrics_explicitness,
         alignment, data_registration, locked_delivery
       ) VALUES (
         'song-submission-1', 'community-1', 'song-owner', 'song-persona',
         'song-operation-1', 'song-1', 1, 4, 1, 1, $1,
         'Dance song', 'private/song-audio', 'not_applicable', 'not_applicable',
         'not_applicable', 'pending', 'not_required'
       )`,
      [HASH_A],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

async function insertSegment(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO dance_song_segments (
       segment_id, community_id, song_post_id, song_submission_id,
       audio_revision, start_ms, end_ms, canonical_audio_duration_ms,
       canonical_segment_audio_ref, canonical_segment_sha256,
       extraction_policy_version, source_media_sha256, segment_terms_hash
     ) VALUES (
       'segment-1', 'community-1', 'song-1', 'song-submission-1',
       4, 10000, 16000, 180000, 'private/dance/segment-1', $1,
       'extract-v1', $2, $3
     )`,
    [HASH_B, HASH_A, HASH_C],
  );
}

async function insertProcessingGraph(admin: Client, withOutbox = false): Promise<void> {
  await admin.query(
    `INSERT INTO dance_choreographies (
       choreography_id, community_id, song_post_id, creator_account_id,
       creator_persona_id, status
     ) VALUES (
       'choreography-1', 'community-1', 'song-1',
       'dance-creator', 'dance-persona', 'processing'
     )`,
  );
  await insertRevision(admin, 1, 1, "video-1", HASH_C);
  if (withOutbox) await insertOutbox(admin);
}

async function insertRevision(
  admin: Client,
  revision: number,
  aggregateVersion: number,
  videoPostId: string,
  termsHash: string,
): Promise<void> {
  await admin.query(
    `INSERT INTO dance_choreography_revisions (
       choreography_id, revision, aggregate_version, community_id, song_post_id,
       audio_revision, requested_start_ms, requested_end_ms, reference_video_post_id,
       reference_video_song_post_id, reference_video_audio_revision,
       reference_video_object_ref, reference_video_sha256, mirror_policy,
       alignment_policy_version, alignment_adapter, alignment_revision,
       pose_model_version, pose_runtime_version, feature_schema_version,
       scorer_contract_version, fingerprint_policy_version, integrity_policy_version,
       owner_policy_revision, owner_policy_hash, revision_terms_hash
     ) VALUES (
       'choreography-1', $1, $2, 'community-1', 'song-1',
       4, 10000, 16000, $3, 'song-1', 4,
       $4, $5, 'allowed', 'alignment-v1', 'fake-alignment', 'adapter-v1',
       'pose-v1', 'runtime-v1', 'features-v1', 'scorer-v1',
       'fingerprint-v1', 'integrity-v1', 7, $6, $7
     )`,
    [
      revision,
      aggregateVersion,
      videoPostId,
      `private/reference/${videoPostId}`,
      HASH_B,
      HASH_A,
      termsHash,
    ],
  );
}

async function insertOutbox(admin: Client): Promise<void> {
  await admin.query(
    `WITH authority AS (
       SELECT jsonb_build_object(
         'choreography_id', 'choreography-1',
         'effect_identity', 'dance-reference-choreography-1-r1',
         'revision', '1',
         'revision_terms_hash', $1::text
       ) AS payload
     )
     INSERT INTO dance_reference_outbox (
       outbox_event_id, choreography_id, revision, event_type,
       effect_identity, payload, payload_sha256
     ) SELECT
       'outbox-1', 'choreography-1', 1, 'reference_processing',
       'dance-reference-choreography-1-r1', payload,
       encode(sha256(convert_to(payload::text, 'UTF8')), 'hex')
     FROM authority`,
    [HASH_C],
  );
}

async function makeReady(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO dance_reference_artifacts (
       artifact_id, choreography_id, revision, private_artifact_ref,
       artifact_sha256, pose_model_version, pose_runtime_version,
       feature_schema_version, scorer_contract_version, integrity_policy_version
     ) VALUES (
       'artifact-1', 'choreography-1', 1, 'private/dance/artifact-1',
       $1, 'pose-v1', 'runtime-v1', 'features-v1', 'scorer-v1', 'integrity-v1'
     )`,
    [HASH_D],
  );
  await admin.query("BEGIN");
  try {
    await admin.query(
      `UPDATE dance_choreography_revisions
          SET status = 'ready', segment_id = 'segment-1',
              reference_video_scored_start_ms = 20000,
              reference_video_scored_end_ms = 26000,
              alignment_metrics = '{"confidence_bps":9000,"drift_bps":10}'::jsonb,
              reference_duration_ms = 6000, reference_width = 1920,
              reference_height = 1080, reference_frame_rate_numerator = 30,
              reference_frame_rate_denominator = 1,
              usable_frame_summary = '{"coverage_bps":9500,"maximum_gap_slots":1}'::jsonb,
              alignment_accepted = TRUE, time_stretch_detected = FALSE,
              body_coverage_accepted = TRUE, timeline_evidence_accepted = TRUE,
              visibility_evidence_accepted = TRUE,
              subject_continuity_accepted = TRUE, meaningful_motion_accepted = TRUE,
              terminal_evidence_digest = $1, terminal_at = clock_timestamp()
        WHERE choreography_id = 'choreography-1' AND revision = 1`,
      [HASH_D],
    );
    await admin.query(
      `UPDATE dance_choreographies
          SET status = 'ready', active_revision = 1, version = 2,
              updated_at = updated_at + interval '1 millisecond'
        WHERE choreography_id = 'choreography-1'`,
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

suite("Dance reference shadow persistence", () => {
  test("keeps Dance reserved while fencing segment, revision, cutoff, and presentation state", async () => {
    await withSchema("lifecycle", async (admin) => {
      const registry = await admin.query(
        "SELECT status, producer_version, current_policy_version_id FROM activity_registry WHERE activity_key='dance'",
      );
      expect(registry.rows).toEqual([
        { status: "reserved", producer_version: null, current_policy_version_id: null },
      ]);
      await expect(
        admin.query(
          `INSERT INTO dance_song_segments (
             segment_id, community_id, song_post_id, song_submission_id,
             audio_revision, start_ms, end_ms, canonical_audio_duration_ms,
             canonical_segment_audio_ref, canonical_segment_sha256,
             extraction_policy_version, source_media_sha256, segment_terms_hash
           ) VALUES (
             'short-segment', 'community-1', 'song-1', 'song-submission-1',
             4, 10000, 15999, 180000, 'private/dance/short', $1,
             'extract-v1', $2, $3
           )`,
          [HASH_B, HASH_A, HASH_D],
        ),
      ).rejects.toThrow();
      await insertSegment(admin);
      const storedSegment = await admin.query(
        `SELECT segment_id, duration_ms::text, source_media_sha256
           FROM dance_song_segments`,
      );
      expect(storedSegment.rows).toEqual([
        { segment_id: "segment-1", duration_ms: "6000", source_media_sha256: HASH_A },
      ]);
      await expect(
        admin.query("UPDATE dance_song_segments SET end_ms=17000 WHERE segment_id='segment-1'"),
      ).rejects.toThrow("Dance song segments are immutable");

      await insertProcessingGraph(admin);
      await makeReady(admin);
      const ready = await admin.query(
        `SELECT choreography.status, choreography.active_revision::text,
                revision.status AS revision_status, segment.duration_ms::text
           FROM dance_choreographies AS choreography
           JOIN dance_choreography_revisions AS revision
             ON revision.choreography_id=choreography.choreography_id
           JOIN dance_song_segments AS segment ON segment.segment_id=revision.segment_id`,
      );
      expect(ready.rows).toEqual([
        {
          status: "ready",
          active_revision: "1",
          revision_status: "ready",
          duration_ms: "6000",
        },
      ]);
      await expect(
        admin.query(
          `UPDATE dance_choreography_revisions SET mirror_policy='strict'
            WHERE choreography_id='choreography-1' AND revision=1`,
        ),
      ).rejects.toThrow("Dance revision terms are immutable");

      await admin.query("BEGIN");
      try {
        await admin.query(
          `UPDATE dance_choreographies
              SET version=3, updated_at=updated_at + interval '1 millisecond'
            WHERE choreography_id='choreography-1'`,
        );
        await insertRevision(admin, 2, 3, "video-2", HASH_D);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }

      await admin.query(
        `INSERT INTO song_dance_presentations (
           community_id, song_post_id, song_submission_id, audio_revision,
           presentation_revision, featured_choreography_id,
           featured_choreography_revision, song_owner_account_id, updated_by_account_id
         ) VALUES (
           'community-1', 'song-1', 'song-submission-1', 4, 1,
           'choreography-1', 1, 'song-owner', 'song-owner'
         )`,
      );
      await expect(
        admin.query(
          `UPDATE song_dance_presentations
              SET updated_by_account_id='intruder', presentation_revision=2,
                  updated_at=updated_at + interval '1 millisecond'
            WHERE community_id='community-1' AND song_post_id='song-1' AND audio_revision=4`,
        ),
      ).rejects.toThrow();
      await admin.query(
        `UPDATE song_dance_presentations
            SET featured_choreography_id=NULL, featured_choreography_revision=NULL,
                presentation_revision=2, updated_at=updated_at + interval '1 millisecond'
          WHERE community_id='community-1' AND song_post_id='song-1' AND audio_revision=4`,
      );
      const cleared = await admin.query(
        `SELECT presentation_revision::text, featured_choreography_id
           FROM song_dance_presentations`,
      );
      expect(cleared.rows).toEqual([
        { presentation_revision: "2", featured_choreography_id: null },
      ]);

      await admin.query(
        `UPDATE dance_choreographies
            SET status='disabled', disabled_reason='rights', disabled_at=clock_timestamp(),
                version=4, updated_at=updated_at + interval '1 millisecond'
          WHERE choreography_id='choreography-1'`,
      );
      await expect(
        admin.query(
          `UPDATE dance_choreography_revisions
              SET status='processing_failed', terminal_evidence_digest=$1,
                  processing_failure_code='late_result', terminal_at=clock_timestamp()
            WHERE choreography_id='choreography-1' AND revision=2`,
          [HASH_A],
        ),
      ).rejects.toThrow();
    });
    completedTestCount += 1;
  });

  test("reclaims leases and converges concurrent segment and action claims", async () => {
    await withSchema("replay", async (admin, schema) => {
      await insertProcessingGraph(admin, true);
      await admin.query(
        `INSERT INTO dance_reference_processing_attempts (
           processing_attempt_id, choreography_id, revision, attempt_number,
           adapter_id, adapter_revision, input_digest, lease_owner,
           lease_fence, lease_expires_at, created_at, updated_at
         ) VALUES (
           'processing-1', 'choreography-1', 1, 1,
           'fake-pose', 'adapter-v1', $1, 'worker-1', 1,
           clock_timestamp() + interval '10 milliseconds',
           clock_timestamp(), clock_timestamp()
         )`,
        [HASH_A],
      );
      await admin.query("SELECT pg_sleep(0.02)");
      await expect(
        admin.query(
          `UPDATE dance_reference_processing_attempts
              SET state='succeeded', lease_owner=NULL, lease_expires_at=NULL,
                  result_digest=$1, private_evidence_ref='private/evidence-expired',
                  retryable=FALSE, completed_at=clock_timestamp(), updated_at=clock_timestamp()
            WHERE processing_attempt_id='processing-1' AND lease_fence=1`,
          [HASH_B],
        ),
      ).rejects.toThrow("Dance processing terminal fence is stale");
      await admin.query(
        `UPDATE dance_reference_processing_attempts
            SET lease_owner='worker-2', lease_fence=2,
                updated_at=clock_timestamp(),
                lease_expires_at=clock_timestamp() + interval '1 minute'
          WHERE processing_attempt_id='processing-1'`,
      );
      const staleProcessing = await admin.query(
        `UPDATE dance_reference_processing_attempts
            SET state='succeeded', lease_owner=NULL, lease_expires_at=NULL,
                result_digest=$1, private_evidence_ref='private/evidence-1',
                retryable=FALSE, completed_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE processing_attempt_id='processing-1' AND lease_fence=1
        RETURNING processing_attempt_id`,
        [HASH_B],
      );
      expect(staleProcessing.rows).toEqual([]);
      await admin.query(
        `UPDATE dance_reference_processing_attempts
            SET state='succeeded', lease_owner=NULL, lease_expires_at=NULL,
                result_digest=$1, private_evidence_ref='private/evidence-1',
                retryable=FALSE, completed_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE processing_attempt_id='processing-1' AND lease_fence=2`,
        [HASH_B],
      );
      await expect(
        admin.query(
          `UPDATE dance_reference_processing_attempts SET result_digest=$1
            WHERE processing_attempt_id='processing-1'`,
          [HASH_C],
        ),
      ).rejects.toThrow("Invalid Dance processing attempt transition");

      await admin.query(
        `UPDATE dance_reference_outbox
            SET state='running', delivery_attempts=1, claim_owner='worker-1',
                claim_fence=1, updated_at=clock_timestamp(),
                lease_expires_at=clock_timestamp() + interval '10 milliseconds'
          WHERE outbox_event_id='outbox-1'`,
      );
      await admin.query("SELECT pg_sleep(0.02)");
      await expect(
        admin.query(
          `UPDATE dance_reference_outbox
              SET state='delivered', claim_owner=NULL, lease_expires_at=NULL,
                  delivered_at=clock_timestamp(), updated_at=clock_timestamp()
            WHERE outbox_event_id='outbox-1' AND claim_fence=1`,
        ),
      ).rejects.toThrow("Dance outbox terminal fence is invalid");
      await admin.query(
        `UPDATE dance_reference_outbox
            SET state='running', delivery_attempts=2, claim_owner='worker-2',
                claim_fence=2, updated_at=clock_timestamp(),
                lease_expires_at=clock_timestamp() + interval '1 minute'
          WHERE outbox_event_id='outbox-1'`,
      );
      const staleOutbox = await admin.query(
        `UPDATE dance_reference_outbox
            SET state='delivered', claim_owner=NULL, lease_expires_at=NULL,
                delivered_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE outbox_event_id='outbox-1' AND claim_fence=1
        RETURNING outbox_event_id`,
      );
      expect(staleOutbox.rows).toEqual([]);
      await admin.query(
        `UPDATE dance_reference_outbox
            SET state='delivered', claim_owner=NULL, lease_expires_at=NULL,
                delivered_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE outbox_event_id='outbox-1' AND claim_fence=2`,
      );

      if (connectionString === undefined) throw new Error("test URL was not configured");
      const first = new Client({ connectionString: connectionForSchema(connectionString, schema) });
      const second = new Client({
        connectionString: connectionForSchema(connectionString, schema),
      });
      await Promise.all([first.connect(), second.connect()]);
      const segmentSql = `
        INSERT INTO dance_song_segments (
          segment_id, community_id, song_post_id, song_submission_id,
          audio_revision, start_ms, end_ms, canonical_audio_duration_ms,
          canonical_segment_audio_ref, canonical_segment_sha256,
          extraction_policy_version, source_media_sha256, segment_terms_hash
        ) VALUES (
          'segment-race', 'community-1', 'song-1', 'song-submission-1',
          4, 20000, 26000, 180000, 'private/dance/segment-race', $1,
          'extract-v1', $2, $3
        ) ON CONFLICT DO NOTHING RETURNING segment_id`;
      const actionSql = `
        INSERT INTO dance_reference_actions (
          actor_account_id, http_method, endpoint_template, idempotency_key,
          request_hash, result_kind, response_snapshot, response_snapshot_sha256,
          choreography_id, choreography_revision
        ) VALUES (
          'dance-creator', 'POST',
          '/communities/:communityId/posts/:postId/dance/choreographies',
          'create-key-1', $1, 'accepted', convert_to('snapshot', 'UTF8'),
          encode(sha256(convert_to('snapshot', 'UTF8')), 'hex'),
          'choreography-1', 1
        ) ON CONFLICT DO NOTHING RETURNING request_hash`;
      try {
        const segmentClaims = await Promise.all([
          first.query(segmentSql, [HASH_B, HASH_A, HASH_C]),
          second.query(segmentSql, [HASH_B, HASH_A, HASH_C]),
        ]);
        expect(segmentClaims.map((claim) => claim.rowCount).sort()).toEqual([0, 1]);
        const claims = await Promise.all([
          first.query(actionSql, [HASH_A]),
          second.query(actionSql, [HASH_A]),
        ]);
        expect(claims.map((claim) => claim.rowCount).sort()).toEqual([0, 1]);
      } finally {
        await Promise.all([first.end(), second.end()]);
      }
      await expect(
        admin.query(actionSql.replace("ON CONFLICT DO NOTHING", ""), [HASH_B]),
      ).rejects.toThrow();
      await expect(
        admin.query(segmentSql.replace("ON CONFLICT DO NOTHING", ""), [HASH_C, HASH_A, HASH_D]),
      ).rejects.toThrow();
      const segmentCount = await admin.query(
        "SELECT count(*)::text AS count FROM dance_song_segments WHERE segment_id='segment-race'",
      );
      expect(segmentCount.rows).toEqual([{ count: "1" }]);
      const actionCount = await admin.query(
        "SELECT count(*)::text AS count FROM dance_reference_actions",
      );
      expect(actionCount.rows).toEqual([{ count: "1" }]);
    });
    completedTestCount += 1;
  });
});

afterAll(async () => {
  if (required && completedTestCount === testCount) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
