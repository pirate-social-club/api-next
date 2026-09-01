import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDanceAttemptStore } from "./dance-attempt-authoring-repository.ts";
import { makeDanceAttemptCleanupStore } from "./dance-attempt-cleanup-repository.ts";
import { makeDanceAttemptProcessingStore } from "./dance-attempt-processing-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
setDefaultTimeout(20_000);
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_DANCE_ATTEMPT_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-dance-attempt-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-dance-attempt-suite-complete\n";
const testCount = 10;
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
  const schema = `api_next_dance_attempt_${label}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    await applyPostgresTestBaselineConnection({
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
      `INSERT INTO users (user_id) VALUES ('song-owner'), ('dancer-1'), ('dancer-2')`,
    );
    await admin.query(
      `INSERT INTO personas (persona_id, account_id, status, created_at) VALUES
         ('song-persona', 'song-owner', 'active', clock_timestamp()),
         ('dancer-persona-1', 'dancer-1', 'active', clock_timestamp()),
         ('dancer-persona-2', 'dancer-2', 'active', clock_timestamp())`,
    );
    await admin.query(
      `INSERT INTO communities (
         community_id, display_name, status, created_by_user_id, created_at, updated_at
       ) VALUES (
         'community-1', 'Dance attempt fixtures', 'active', 'song-owner',
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
         ('community-1', 'video-1', 'dancer-1', 'dancer-persona-1',
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
    await admin.query(
      `INSERT INTO dance_choreographies (
         choreography_id, community_id, song_post_id, creator_account_id,
         creator_persona_id, version, status, active_revision
       ) VALUES (
         'choreography-1', 'community-1', 'song-1',
         'dancer-1', 'dancer-persona-1', 2, 'ready', 1
       )`,
    );
    await admin.query(
      `INSERT INTO dance_choreography_revisions (
         choreography_id, revision, aggregate_version, community_id, song_post_id,
         audio_revision, requested_start_ms, requested_end_ms, segment_id,
         reference_video_post_id, reference_video_song_post_id,
         reference_video_audio_revision, reference_video_object_ref,
         reference_video_sha256, mirror_policy, alignment_policy_version,
         alignment_adapter, alignment_revision, pose_model_version,
         pose_runtime_version, feature_schema_version, scorer_contract_version,
         fingerprint_policy_version, integrity_policy_version, owner_policy_revision,
         owner_policy_hash, revision_terms_hash, status,
         reference_video_scored_start_ms, reference_video_scored_end_ms,
         alignment_metrics, reference_duration_ms, reference_width, reference_height,
         reference_frame_rate_numerator, reference_frame_rate_denominator,
         usable_frame_summary, alignment_accepted, time_stretch_detected,
         body_coverage_accepted, timeline_evidence_accepted,
         visibility_evidence_accepted, subject_continuity_accepted,
         meaningful_motion_accepted, terminal_evidence_digest, terminal_at
       ) VALUES (
         'choreography-1', 1, 1, 'community-1', 'song-1', 4,
         10000, 16000, 'segment-1', 'video-1', 'song-1', 4,
         'private/reference/video-1', $1, 'allowed', 'alignment-v1',
         'fake-alignment', 'adapter-v1', 'pose-v1', 'runtime-v1',
         'features-v1', 'scorer-v1', 'fingerprint-v1', 'integrity-v1',
         7, $2, $3, 'ready', 2000, 8000, '{}'::jsonb, 9000,
         1280, 720, 30, 1, '{}'::jsonb, TRUE, FALSE, TRUE, TRUE, TRUE, TRUE,
         TRUE, $4, clock_timestamp()
       )`,
      [HASH_B, HASH_A, HASH_C, HASH_D],
    );
    await admin.query(
      `INSERT INTO dance_reference_artifacts (
         artifact_id, choreography_id, revision, private_artifact_ref,
         artifact_sha256, pose_model_version, pose_runtime_version,
         feature_schema_version, scorer_contract_version, integrity_policy_version
       ) VALUES (
         'artifact-1', 'choreography-1', 1, 'private/reference/artifact-1',
         $1, 'pose-v1', 'runtime-v1', 'features-v1', 'scorer-v1', 'integrity-v1'
       )`,
      [HASH_D],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

async function createPendingAttempt(admin: Client, suffix: "1" | "2"): Promise<void> {
  const account = `dancer-${suffix}`;
  const persona = `dancer-persona-${suffix}`;
  const session = `session-${suffix}`;
  const reservation = `reservation-${suffix}`;
  const attempt = `attempt-${suffix}`;
  const mediaHash = suffix === "1" ? HASH_A : HASH_B;
  const inputDigest = suffix === "1" ? HASH_C : HASH_D;
  await admin.query(
    `INSERT INTO dance_sessions (
       session_id, account_id, persona_id, community_id, song_post_id,
       audio_revision, segment_id, choreography_id, choreography_revision,
       reward_mode, expected_scored_duration_ms, cue_kind, cue_hold_ms,
       cue_observation_start_ms, cue_observation_end_ms,
       qualification_policy_version_id, calibration_version_id,
       calibration_checksum, captured_admission_state, platform_floor_bps,
       pose_model_version, feature_schema_version, scorer_contract_version,
       mirror_policy_version, cue_policy_version, fingerprint_policy_version,
       fingerprint_key_version, integrity_policy_version, grader_adapter_version,
       session_terms_hash, expires_at
     ) VALUES (
       $1, $2, $3, 'community-1', 'song-1', 4, 'segment-1',
       'choreography-1', 1, 'practice', 6000, 'hands_on_head', 1000,
       0, 2000, 'shadow-policy-v1', 'shadow-calibration-v1', $4,
       'shadow', 4321, 'pose-v1', 'features-v1', 'scorer-v1',
       'mirror-v1', 'cue-v1', 'fingerprint-v1', 'fingerprint-key-v1',
       'integrity-v1', 'adapter-v1', $5, clock_timestamp() + interval '15 minutes'
     )`,
    [session, account, persona, HASH_A, suffix === "1" ? HASH_B : HASH_D],
  );
  await admin.query(
    `INSERT INTO dance_session_consents (
       session_id, account_id, persona_id, session_terms_hash,
       consent_policy_version_id, retention_disclosure_version, source
     ) VALUES ($1, $2, $3, $4, 'consent-v1', 'retention-v1', 'camera')`,
    [session, account, persona, suffix === "1" ? HASH_B : HASH_D],
  );
  await admin.query(
    `INSERT INTO dance_upload_reservations (
       reservation_id, session_id, private_object_key, expected_content_type,
       expected_size_bytes, expected_duration_ms, expires_at
     ) VALUES ($1, $2, $3, 'video/mp4', 1000, 8000,
       clock_timestamp() + interval '10 minutes')`,
    [reservation, session, `private/random/${suffix}`],
  );
  await admin.query(
    `UPDATE dance_upload_reservations SET state = 'sealed', server_sha256 = $1,
       sealed_size_bytes = 1000, sealed_duration_ms = 8000,
       sealed_at = clock_timestamp() WHERE reservation_id = $2`,
    [mediaHash, reservation],
  );
  await admin.query(
    `INSERT INTO dance_attempts (
       attempt_id, session_id, reservation_id, sealed_media_sha256, input_digest
     ) VALUES ($1, $2, $3, $4, $5)`,
    [attempt, session, reservation, mediaHash, inputDigest],
  );
  await admin.query(
    `WITH authority AS (
       SELECT jsonb_build_object('attempt_id', $1::text, 'session_id', $2::text) AS payload
     ) INSERT INTO dance_attempt_outbox (
       outbox_event_id, attempt_id, effect_identity, payload, payload_sha256
     ) SELECT $3, $1, $4, payload,
       encode(sha256(convert_to(payload::text, 'UTF8')), 'hex') FROM authority`,
    [attempt, session, `outbox-${suffix}`, `dance-attempt-${suffix}`],
  );
}

async function claim(admin: Client, suffix: "1" | "2", owner: string): Promise<number> {
  const result = await admin.query<{ claim_fence: string }>(
    `UPDATE dance_attempt_outbox SET state = 'running', delivery_attempts = delivery_attempts + 1,
       claim_owner = $1, claim_fence = claim_fence + 1,
       lease_expires_at = clock_timestamp() + interval '10 minutes',
       updated_at = clock_timestamp()
     WHERE attempt_id = $2 AND state = 'pending'
     RETURNING claim_fence::text`,
    [owner, `attempt-${suffix}`],
  );
  return Number(result.rows[0]?.claim_fence);
}

async function finalize(
  client: Client,
  suffix: "1" | "2",
  owner: string,
  fence: number,
  wholeFingerprint: string,
): Promise<void> {
  const evidenceDigest = suffix === "1" ? HASH_C : HASH_D;
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO dance_replay_fingerprint_claims (
         fingerprint_claim_id, attempt_id, fingerprint_policy_version,
         fingerprint_key_version, match_scope, account_scope_id,
         whole_sequence_fingerprint, segment_fingerprints, terminal_evidence_digest
       ) VALUES ($1, $2, 'fingerprint-v1', 'fingerprint-key-v1',
         'platform_wide', NULL, $3, ARRAY[$4]::text[], $5)`,
      [
        `fingerprint-claim-${suffix}`,
        `attempt-${suffix}`,
        wholeFingerprint,
        HASH_B,
        evidenceDigest,
      ],
    );
    await client.query(
      `INSERT INTO dance_attempt_evidence (
         attempt_id, session_id, fingerprint_claim_id, claim_owner, claim_fence,
         grade_outcome, qualification_outcome, score_bps, rejection_code,
         scored_window_start_ms, scored_window_end_ms, scored_duration_ms,
         evidence_summary, evidence_digest
       ) VALUES ($1, $2, $3, $4, $5, 'scored', 'suppressed_shadow',
         7250, NULL, 2000, 8000, 6000, '{"schema_version":1}'::jsonb, $6)`,
      [
        `attempt-${suffix}`,
        `session-${suffix}`,
        `fingerprint-claim-${suffix}`,
        owner,
        fence,
        evidenceDigest,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function scoredOutcome(
  claim: Awaited<ReturnType<typeof claimProcessing>>,
  evidenceDigest: string,
  fingerprintClaimId: string,
) {
  if (claim.kind !== "claimed") throw new Error("Dance processing claim was unavailable");
  return {
    version: "dance-attempt-processing-outcome-v1" as const,
    binding: claim.claim.binding,
    gradeOutcome: "scored" as const,
    qualificationOutcome: "suppressed_shadow" as const,
    scoreBps: 7_250,
    rejectionCode: null,
    scoredWindowStartMs: claim.claim.frozenInput.scoredWindowStartMs,
    scoredWindowEndMs: claim.claim.frozenInput.scoredWindowEndMs,
    scoredDurationMs: claim.claim.frozenInput.expectedScoredDurationMs,
    evidenceSummary: {
      schema_version: 1 as const,
      usable_coverage_bps: 9_500,
      selected_mirror: "original" as const,
      meaningful_motion_accepted: true,
      replay_outcome: "unique" as const,
      subject_continuity: "stable" as const,
    },
    evidenceDigest,
    fingerprint: {
      claimId: fingerprintClaimId,
      policyVersion: "fingerprint-v1",
      keyVersion: "fingerprint-key-v1",
      matchScope: "platform_wide" as const,
      accountScopeId: null,
      wholeSequenceFingerprint: HASH_A,
      segmentFingerprints: [HASH_B],
    },
  };
}

function preFingerprintRejection(
  claim: Awaited<ReturnType<typeof claimProcessing>>,
  evidenceDigest: string,
) {
  if (claim.kind !== "claimed") throw new Error("Dance processing claim was unavailable");
  return {
    version: "dance-attempt-processing-outcome-v1" as const,
    binding: claim.claim.binding,
    gradeOutcome: "rejected" as const,
    qualificationOutcome: "suppressed_shadow" as const,
    scoreBps: null,
    rejectionCode: "multiple_people",
    scoredWindowStartMs: claim.claim.frozenInput.scoredWindowStartMs,
    scoredWindowEndMs: claim.claim.frozenInput.scoredWindowEndMs,
    scoredDurationMs: claim.claim.frozenInput.expectedScoredDurationMs,
    evidenceSummary: null,
    evidenceDigest,
    fingerprint: null,
  };
}

function processingStore(schema: string) {
  return makeDanceAttemptProcessingStore(
    makeDirectPostgresControlPlaneLayer(connectionForSchema(connectionString as string, schema)),
  );
}

function claimProcessing(schema: string, attemptId: string, workerId: string) {
  return Effect.runPromise(
    processingStore(schema).claim({ attemptId, workerId, leaseSeconds: 60 }),
  );
}

suite("Dance attempt shadow persistence", () => {
  test("commits authoring actions and grading outbox without a processor", async () => {
    await withSchema("authoring_repository", async (admin, schema) => {
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + 15 * 60_000);
      const uploadCreatedAt = new Date(createdAt.getTime() + 1_000);
      const uploadExpiresAt = new Date(createdAt.getTime() + 10 * 60_000);
      const sealedAt = new Date(createdAt.getTime() + 2_000);
      const store = makeDanceAttemptStore(
        makeDirectPostgresControlPlaneLayer(
          connectionForSchema(connectionString as string, schema),
        ),
      );
      const action = (
        endpointTemplate:
          | "/communities/:communityId/posts/:postId/dance/choreographies/:choreographyId/revisions/:revision/sessions"
          | "/communities/:communityId/dance/sessions/:sessionId/consent"
          | "/communities/:communityId/dance/sessions/:sessionId/upload-reservations"
          | "/communities/:communityId/dance/sessions/:sessionId/upload/finalize"
          | "/communities/:communityId/dance/sessions/:sessionId/grading-submissions",
        idempotencyKey: string,
      ) => ({
        actorAccountId: "dancer-1",
        httpMethod: "POST" as const,
        endpointTemplate,
        idempotencyKey,
        requestHash: HASH_D,
      });
      const created = await store.create({
        action: action(
          "/communities/:communityId/posts/:postId/dance/choreographies/:choreographyId/revisions/:revision/sessions",
          "create-repository-1",
        ),
        communityId: "community-1",
        songPostId: "song-1",
        choreographyId: "choreography-1",
        choreographyRevision: 1,
        personaId: "dancer-persona-1",
        authority: {
          sessionId: "dance-session-repository-1",
          audioRevision: 4,
          segmentId: "segment-1",
          expectedScoredDurationMs: 6_000,
          cue: {
            kind: "hands_on_head",
            holdMs: 1_000,
            observationStartMs: 0,
            observationEndMs: 2_000,
          },
          policy: {
            qualificationPolicyVersionId: "shadow-policy-v1",
            calibrationVersionId: "shadow-calibration-v1",
            calibrationChecksum: HASH_A,
            capturedAdmissionState: "shadow",
            platformFloorBps: 4_321,
            poseModelVersion: "pose-v1",
            featureSchemaVersion: "features-v1",
            scorerContractVersion: "scorer-v1",
            mirrorPolicyVersion: "mirror-v1",
            cuePolicyVersion: "cue-v1",
            fingerprintPolicyVersion: "fingerprint-v1",
            fingerprintKeyVersion: "fingerprint-key-v1",
            integrityPolicyVersion: "integrity-v1",
            graderAdapterVersion: "adapter-v1",
          },
          sessionTermsHash: HASH_B,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
      });
      expect(created.session.state).toBe("created");
      await store.consent({
        action: action(
          "/communities/:communityId/dance/sessions/:sessionId/consent",
          "consent-repository-1",
        ),
        communityId: "community-1",
        sessionId: created.session.session_id,
        personaId: "dancer-persona-1",
        sessionTermsHash: HASH_B,
        consentPolicyVersionId: "consent-v1",
        retentionDisclosureVersion: "retention-v1",
        source: "camera",
      });
      const reserved = await store.reserve({
        action: action(
          "/communities/:communityId/dance/sessions/:sessionId/upload-reservations",
          "reserve-repository-1",
        ),
        communityId: "community-1",
        sessionId: created.session.session_id,
        authority: {
          reservationId: "dance-reservation-repository-1",
          privateObjectKey: "private/random/repository-1",
          uploadUrl: "https://uploads.invalid/dance-repository-1",
          expectedContentType: "video/mp4",
          expectedSizeBytes: 1_000,
          expectedDurationMs: 8_000,
          expectedSha256: HASH_A,
          createdAt: uploadCreatedAt.toISOString(),
          expiresAt: uploadExpiresAt.toISOString(),
        },
      });
      expect(reserved.session.state).toBe("awaiting_upload");
      await store.finalize({
        action: action(
          "/communities/:communityId/dance/sessions/:sessionId/upload/finalize",
          "finalize-repository-1",
        ),
        communityId: "community-1",
        sessionId: created.session.session_id,
        authority: {
          reservationId: reserved.reservation.reservation_id,
          privateObjectKey: "private/random/repository-1",
          contentType: "video/mp4",
          sizeBytes: 1_000,
          durationMs: 8_000,
          serverSha256: HASH_A,
          sealedAt: sealedAt.toISOString(),
        },
      });
      const submitted = await store.submit({
        action: action(
          "/communities/:communityId/dance/sessions/:sessionId/grading-submissions",
          "submit-repository-1",
        ),
        communityId: "community-1",
        sessionId: created.session.session_id,
      });
      expect(submitted.session.state).toBe("grading_pending");
      const rows = await admin.query(
        `SELECT (SELECT count(*)::int FROM dance_attempt_actions) AS actions,
                (SELECT count(*)::int FROM dance_attempts) AS attempts,
                (SELECT count(*)::int FROM dance_attempt_outbox) AS outbox`,
      );
      expect(rows.rows[0]).toEqual({ actions: 5, attempts: 1, outbox: 1 });
      const wakeups = processingStore(schema);
      const eligibleWakeups = await wakeups.listEligibleWakeups(10);
      expect(eligibleWakeups).toHaveLength(1);
      const attemptId = eligibleWakeups[0]?.attemptId;
      if (attemptId === undefined) throw new Error("Dance grading wake-up was not persisted");
      expect(await wakeups.getWakeup(attemptId)).toMatchObject({
        attemptId,
        attemptState: "grading_pending",
        state: "pending",
        deliveryAttempts: 0,
        claimFence: 0,
        eligible: true,
      });
      const replayed = await store.submit({
        action: action(
          "/communities/:communityId/dance/sessions/:sessionId/grading-submissions",
          "submit-repository-1",
        ),
        communityId: "community-1",
        sessionId: created.session.session_id,
      });
      expect(replayed.replayed).toBe(true);
      expect("processor" in store).toBe(false);
      completedTestCount += 1;
    });
  });

  test("requires consent, seals once, and atomically commits a suppressed result", async () => {
    await withSchema("lifecycle", async (admin) => {
      await expect(
        admin.query(
          `INSERT INTO dance_upload_reservations (
             reservation_id, session_id, private_object_key, expected_content_type,
             expected_size_bytes, expected_duration_ms, expires_at
           ) VALUES ('early', 'missing', 'private/early', 'video/mp4', 1, 8000,
             clock_timestamp() + interval '1 minute')`,
        ),
      ).rejects.toThrow();
      await createPendingAttempt(admin, "1");
      const fence = await claim(admin, "1", "worker-a");
      await finalize(admin, "1", "worker-a", fence, HASH_A);
      const result = await admin.query(
        `SELECT s.state AS session_state, a.state AS attempt_state,
                e.qualification_outcome, o.state AS outbox_state,
                (SELECT count(*)::int FROM dance_replay_fingerprint_claims) AS claims,
                (SELECT state FROM dance_media_cleanup_operations
                  WHERE session_id=s.session_id AND artifact_kind='raw_video') AS cleanup_state
           FROM dance_sessions s
           JOIN dance_attempts a USING (session_id)
           JOIN dance_attempt_evidence e USING (attempt_id)
           JOIN dance_attempt_outbox o USING (attempt_id)`,
      );
      expect(result.rows[0]).toMatchObject({
        session_state: "completed",
        attempt_state: "completed",
        qualification_outcome: "suppressed_shadow",
        outbox_state: "delivered",
        claims: 1,
        cleanup_state: "pending",
      });
      completedTestCount += 1;
    });
  });

  test("processing repository claims and commits exact shadow evidence", async () => {
    await withSchema("processing_complete", async (admin, schema) => {
      await createPendingAttempt(admin, "1");
      const store = processingStore(schema);
      const claimed = await claimProcessing(schema, "attempt-1", "worker-a");
      if (claimed.kind !== "claimed") throw new Error("attempt was not claimed");
      expect(claimed.claim.frozenInput).toMatchObject({
        attemptId: "attempt-1",
        privateMediaRef: "private/random/1",
        referenceArtifactRef: "private/reference/artifact-1",
        scoredWindowStartMs: 2_000,
        scoredWindowEndMs: 8_000,
      });
      expect(
        await Effect.runPromise(
          store.complete(claimed.claim, scoredOutcome(claimed, HASH_C, "claim-processing-1")),
        ),
      ).toBe("committed");
      const terminal = await admin.query(
        `SELECT a.state,e.qualification_outcome,e.grade_outcome,o.state AS outbox_state
           FROM dance_attempts a JOIN dance_attempt_evidence e USING (attempt_id)
           JOIN dance_attempt_outbox o USING (attempt_id) WHERE a.attempt_id='attempt-1'`,
      );
      expect(terminal.rows[0]).toEqual({
        state: "completed",
        qualification_outcome: "suppressed_shadow",
        grade_outcome: "scored",
        outbox_state: "delivered",
      });
      expect(await store.getWakeup("attempt-1")).toMatchObject({
        attemptState: "completed",
        state: "delivered",
        eligible: false,
      });
      completedTestCount += 1;
    });
  });

  test("commits pre-fingerprint integrity rejection without invented evidence", async () => {
    await withSchema("processing_integrity_reject", async (admin, schema) => {
      await createPendingAttempt(admin, "1");
      const store = processingStore(schema);
      const claimed = await claimProcessing(schema, "attempt-1", "worker-a");
      if (claimed.kind !== "claimed") throw new Error("attempt was not claimed");
      expect(
        await Effect.runPromise(
          store.complete(claimed.claim, preFingerprintRejection(claimed, HASH_C)),
        ),
      ).toBe("committed");
      const terminal = await admin.query(
        `SELECT a.state,e.grade_outcome,e.rejection_code,e.evidence_summary,
                e.fingerprint_claim_id,e.matched_fingerprint_claim_id,
                (SELECT count(*)::int FROM dance_replay_fingerprint_claims) AS fingerprints
           FROM dance_attempts a JOIN dance_attempt_evidence e USING (attempt_id)
          WHERE a.attempt_id='attempt-1'`,
      );
      expect(terminal.rows[0]).toEqual({
        state: "rejected",
        grade_outcome: "rejected",
        rejection_code: "multiple_people",
        evidence_summary: null,
        fingerprint_claim_id: null,
        matched_fingerprint_claim_id: null,
        fingerprints: 0,
      });
      completedTestCount += 1;
    });
  });

  test("concurrent processing fingerprints converge to unique and duplicate terminals", async () => {
    await withSchema("processing_duplicate", async (admin, schema) => {
      await createPendingAttempt(admin, "1");
      await createPendingAttempt(admin, "2");
      const first = await claimProcessing(schema, "attempt-1", "worker-a");
      const second = await claimProcessing(schema, "attempt-2", "worker-b");
      if (first.kind !== "claimed" || second.kind !== "claimed") {
        throw new Error("concurrent attempts were not claimed");
      }
      const firstStore = processingStore(schema);
      const secondStore = processingStore(schema);
      const results = await Promise.all([
        Effect.runPromise(
          firstStore.complete(first.claim, scoredOutcome(first, HASH_C, "claim-processing-1")),
        ),
        Effect.runPromise(
          secondStore.complete(second.claim, scoredOutcome(second, HASH_D, "claim-processing-2")),
        ),
      ]);
      expect(results).toEqual(["committed", "committed"]);
      const terminals = await admin.query(
        `SELECT grade_outcome,rejection_code,count(*)::int AS count
           FROM dance_attempt_evidence GROUP BY grade_outcome,rejection_code
           ORDER BY grade_outcome`,
      );
      expect(terminals.rows).toEqual([
        { grade_outcome: "rejected", rejection_code: "duplicate_attempt", count: 1 },
        { grade_outcome: "scored", rejection_code: null, count: 1 },
      ]);
      const counts = await admin.query(
        `SELECT (SELECT count(*)::int FROM dance_replay_fingerprint_claims) AS claims,
                (SELECT count(*)::int FROM dance_attempt_evidence) AS evidence`,
      );
      expect(counts.rows[0]).toEqual({ claims: 1, evidence: 2 });
      completedTestCount += 1;
    });
  });

  test("third adapter failure is terminal and cannot be claimed again", async () => {
    await withSchema("processing_exhausted", async (admin, schema) => {
      await createPendingAttempt(admin, "1");
      const store = processingStore(schema);
      for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
        const claimed = await claimProcessing(schema, "attempt-1", `worker-${attemptNumber}`);
        if (claimed.kind !== "claimed") throw new Error("retry attempt was not claimed");
        const disposition = await Effect.runPromise(
          store.fail({
            claim: claimed.claim,
            failureCode: "grader_adapter_failure",
            retryAfterSeconds: 0,
          }),
        );
        expect(disposition).toBe(attemptNumber < 3 ? "retryable" : "exhausted");
      }
      expect(await claimProcessing(schema, "attempt-1", "late-worker")).toEqual({
        kind: "terminal",
        status: "failed",
      });
      const terminal = await admin.query(
        `SELECT a.state,e.grade_outcome,e.rejection_code,o.state AS outbox_state,
                o.delivery_attempts,
                (SELECT count(*)::int FROM dance_replay_fingerprint_claims) AS fingerprints
           FROM dance_attempts a JOIN dance_attempt_evidence e USING (attempt_id)
           JOIN dance_attempt_outbox o USING (attempt_id) WHERE a.attempt_id='attempt-1'`,
      );
      expect(terminal.rows[0]).toEqual({
        state: "processing_failed",
        grade_outcome: "failed",
        rejection_code: "grader_adapter_exhausted",
        outbox_state: "delivered",
        delivery_attempts: 3,
        fingerprints: 0,
      });
      completedTestCount += 1;
    });
  });

  test("cleanup retry fencing rejects stale completion and converges once", async () => {
    await withSchema("cleanup_fence", async (admin, schema) => {
      await createPendingAttempt(admin, "1");
      const gradingFence = await claim(admin, "1", "grading-worker");
      await finalize(admin, "1", "grading-worker", gradingFence, HASH_A);
      const operation = await admin.query<{ cleanup_operation_id: string }>(
        `SELECT cleanup_operation_id FROM dance_media_cleanup_operations
          WHERE session_id='session-1' AND artifact_kind='raw_video'`,
      );
      const cleanupOperationId = operation.rows[0]?.cleanup_operation_id;
      if (cleanupOperationId === undefined) throw new Error("cleanup operation was not scheduled");
      const cleanup = makeDanceAttemptCleanupStore(
        makeDirectPostgresControlPlaneLayer(
          connectionForSchema(connectionString as string, schema),
        ),
      );
      const first = await Effect.runPromise(
        cleanup.claim({ cleanupOperationId, workerId: "cleanup-worker-a", leaseSeconds: 60 }),
      );
      if (first.kind !== "claimed") throw new Error("first cleanup lease was not claimed");
      expect(
        await Effect.runPromise(
          cleanup.fail({
            binding: first.binding,
            failureCode: "delete_failed",
            retryAfterSeconds: 0,
          }),
        ),
      ).toBe("retryable");
      const second = await Effect.runPromise(
        cleanup.claim({ cleanupOperationId, workerId: "cleanup-worker-b", leaseSeconds: 60 }),
      );
      if (second.kind !== "claimed") throw new Error("retry cleanup lease was not claimed");
      expect(second.binding.claimFence).toBe(first.binding.claimFence + 1);
      expect(await Effect.runPromise(cleanup.complete(first.binding))).toBe("stale");
      expect(await Effect.runPromise(cleanup.complete(second.binding))).toBe("committed");
      expect(await Effect.runPromise(cleanup.complete(second.binding))).toBe("replayed");
      completedTestCount += 1;
    });
  });

  test("rejects the original completion after a reconciler steals an expired lease", async () => {
    await withSchema("stolen_lease", async (admin) => {
      await createPendingAttempt(admin, "1");
      const staleFence = await claim(admin, "1", "worker-a");
      await admin.query(
        `UPDATE dance_attempt_outbox SET
           updated_at = clock_timestamp() - interval '2 minutes',
           lease_expires_at = clock_timestamp() - interval '1 minute'
         WHERE attempt_id = 'attempt-1'`,
      );
      const stolen = await admin.query<{ claim_fence: string }>(
        `UPDATE dance_attempt_outbox SET claim_owner = 'worker-b',
           claim_fence = claim_fence + 1,
           lease_expires_at = clock_timestamp() + interval '10 minutes',
           updated_at = clock_timestamp()
         WHERE attempt_id = 'attempt-1' AND state = 'running'
           AND lease_expires_at <= clock_timestamp()
         RETURNING claim_fence::text`,
      );
      await expect(finalize(admin, "1", "worker-a", staleFence, HASH_A)).rejects.toThrow(
        "current shadow lease authority",
      );
      await finalize(admin, "1", "worker-b", Number(stolen.rows[0]?.claim_fence), HASH_A);
      completedTestCount += 1;
    });
  });

  test("concurrent whole-sequence claims converge to one terminal attempt", async () => {
    await withSchema("fingerprint_race", async (admin, schema) => {
      await createPendingAttempt(admin, "1");
      await createPendingAttempt(admin, "2");
      const firstFence = await claim(admin, "1", "worker-a");
      const secondFence = await claim(admin, "2", "worker-b");
      if (connectionString === undefined) throw new Error("test URL was not configured");
      const other = new Client({ connectionString: connectionForSchema(connectionString, schema) });
      await other.connect();
      try {
        const outcomes = await Promise.allSettled([
          finalize(admin, "1", "worker-a", firstFence, HASH_A),
          finalize(other, "2", "worker-b", secondFence, HASH_A),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
        const counts = await admin.query(
          `SELECT (SELECT count(*)::int FROM dance_replay_fingerprint_claims) AS claims,
                  (SELECT count(*)::int FROM dance_attempt_evidence) AS evidence`,
        );
        expect(counts.rows[0]).toEqual({ claims: 1, evidence: 1 });
      } finally {
        await other.end();
      }
      completedTestCount += 1;
    });
  });

  test("cannot promote suppressed shadow evidence into a qualification outcome", async () => {
    await withSchema("shadow_terminal", async (admin) => {
      await createPendingAttempt(admin, "1");
      const fence = await claim(admin, "1", "worker-a");
      await admin.query("BEGIN");
      try {
        await admin.query(
          `INSERT INTO dance_replay_fingerprint_claims (
             fingerprint_claim_id, attempt_id, fingerprint_policy_version,
             fingerprint_key_version, match_scope, account_scope_id,
             whole_sequence_fingerprint, segment_fingerprints, terminal_evidence_digest
           ) VALUES ('fingerprint-claim-1', 'attempt-1', 'fingerprint-v1',
             'fingerprint-key-v1', 'platform_wide', NULL, $1, ARRAY[$2]::text[], $3)`,
          [HASH_A, HASH_B, HASH_C],
        );
        await expect(
          admin.query(
            `INSERT INTO dance_attempt_evidence (
               attempt_id, session_id, fingerprint_claim_id, claim_owner, claim_fence,
               grade_outcome, qualification_outcome, score_bps, rejection_code,
               scored_window_start_ms, scored_window_end_ms, scored_duration_ms,
               evidence_summary, evidence_digest
             ) VALUES ('attempt-1', 'session-1', 'fingerprint-claim-1', 'worker-a', $1,
               'scored', 'emitted', 7250, NULL, 2000, 8000, 6000,
               '{}'::jsonb, $2)`,
            [fence, HASH_C],
          ),
        ).rejects.toThrow();
      } finally {
        await admin.query("ROLLBACK");
      }
      await finalize(admin, "1", "worker-a", fence, HASH_A);
      await expect(
        admin.query(
          `UPDATE dance_attempt_evidence SET qualification_outcome = 'emitted'
            WHERE attempt_id = 'attempt-1'`,
        ),
      ).rejects.toThrow();
      const evidence = await admin.query(
        `SELECT qualification_outcome FROM dance_attempt_evidence WHERE attempt_id = 'attempt-1'`,
      );
      expect(evidence.rows[0]?.qualification_outcome).toBe("suppressed_shadow");
      completedTestCount += 1;
    });
  });
});

afterAll(async () => {
  if (connectionString === undefined || completedTestCount !== testCount) return;
  await Bun.write(sentinelPath, sentinelContents);
});
