import { afterAll, describe, expect, test } from "bun:test";
import {
  type DanceReferenceOutcome,
  type DanceReferenceProcessingBinding,
  type FrozenDanceReferenceInput,
  type PreparedDanceReferenceOperation,
  runDanceReferenceProcessing,
} from "@pirate/application/dance/reference-processing";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeDanceReferenceProcessingStore } from "./dance-reference-processing-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

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
const testCount = 7;
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

function frozenReferenceInput(
  overrides: Partial<FrozenDanceReferenceInput> = {},
): FrozenDanceReferenceInput {
  return {
    version: "frozen-dance-reference-input-v1",
    effectIdentity: "dance-reference-choreography-1-r1",
    choreographyId: "choreography-1",
    choreographyRevision: 1,
    revisionTermsHash: HASH_C,
    canonicalAudio: {
      objectKey: "private/song-audio",
      sha256: HASH_A,
      durationMs: 180000,
      audioRevision: 4,
    },
    referenceVideo: {
      postId: "video-1",
      objectKey: "private/reference/video-1",
      sha256: HASH_B,
      durationMs: 60000,
    },
    requestedStartMs: 10000,
    requestedEndMs: 16000,
    segmentTermsHash: HASH_B,
    mirrorPolicy: "allowed",
    outputs: {
      segmentId: "segment-runtime-1",
      segmentObjectKey: "private/dance/segment-runtime-1",
      artifactId: "artifact-runtime-1",
      artifactObjectKey: "private/dance/artifact-runtime-1",
      evidenceObjectKey: "private/dance/evidence-runtime-1",
    },
    extraction: {
      policyVersion: "extract-v1",
      outputProfile: { sampleRateHz: 48000, channels: 1, codec: "flac" },
    },
    alignment: {
      policyVersion: "alignment-v1",
      adapterId: "fake-alignment",
      adapterRevision: "adapter-v1",
      limits: {
        maximumAbsoluteOffsetMs: 15000,
        maximumAbsoluteDriftMs: 50,
        maximumAbsoluteSlopeDeltaPpm: 1000,
        minimumOverallConfidenceBps: 8000,
        minimumCoverageBps: 9000,
        minimumSoundtrackMatchBps: 8000,
      },
    },
    pose: {
      modelVersion: "pose-v1",
      runtimeVersion: "runtime-v1",
      featureSchemaVersion: "features-v1",
      scorerContractVersion: "scorer-v1",
      fingerprintPolicyVersion: "fingerprint-v1",
      integrityPolicyVersion: "integrity-v1",
    },
    qualityLimits: {
      minimumUsableCoverageBps: 9000,
      maximumMissingGapSlots: 3,
      minimumBodyCoverageBps: 9000,
      minimumVisibilityCoverageBps: 8500,
      minimumMotionEnergyBps: 2000,
      minimumSpatialExtentBps: 2000,
    },
    ownerPolicy: { revision: 7, hash: HASH_A },
    ...overrides,
  };
}

function preparedReference(
  binding: DanceReferenceProcessingBinding,
): PreparedDanceReferenceOperation {
  return {
    version: "prepared-dance-reference-operation-v1",
    binding,
    providerOperationId: `provider-${binding.requestId}`,
  };
}

function readyReference(binding: DanceReferenceProcessingBinding): DanceReferenceOutcome {
  return {
    status: "ready",
    binding,
    segment: {
      segmentId: "segment-runtime-1",
      objectKey: "private/dance/segment-runtime-1",
      sha256: HASH_D,
      sourceSha256: HASH_A,
      startMs: 10000,
      endMs: 16000,
      durationMs: 6000,
      extractionPolicyVersion: "extract-v1",
      segmentTermsHash: HASH_B,
    },
    alignment: {
      videoSha256: HASH_B,
      songAudioSha256: HASH_A,
      requestedStartMs: 10000,
      requestedEndMs: 16000,
      referenceVideoScoredStartMs: 20000,
      referenceVideoScoredEndMs: 26000,
      detectedSongOffsetMs: 10000,
      alignmentPolicyVersion: "alignment-v1",
      alignmentRevision: "adapter-v1",
      driftMetrics: {
        maximumAbsoluteDriftMs: 20,
        p95AbsoluteDriftMs: 10,
        slopeDeltaPpm: 100,
      },
      confidenceMetrics: { overallBps: 9500, coverageBps: 9400, soundtrackMatchBps: 9300 },
      continuousMapping: true,
      timeStretchDetected: false,
    },
    artifact: {
      artifactId: "artifact-runtime-1",
      privateArtifactRef: "private/dance/artifact-runtime-1",
      artifactSha256: HASH_C,
      poseModelVersion: "pose-v1",
      poseRuntimeVersion: "runtime-v1",
      featureSchemaVersion: "features-v1",
      scorerContractVersion: "scorer-v1",
      integrityPolicyVersion: "integrity-v1",
      referenceDurationMs: 6000,
      width: 1920,
      height: 1080,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      usableFrameSummary: {
        totalTimelineSlots: 180,
        usableTimelineSlots: 171,
        coverageBps: 9500,
        maximumMissingGapSlots: 2,
        bodyCoverageBps: 9400,
        visibilityCoverageBps: 9200,
        stablePrincipalTrackCount: 1,
        subjectContinuityAmbiguous: false,
        motionEnergyBps: 6000,
        spatialExtentBps: 5000,
      },
    },
    evidence: {
      evidenceRef: "private/dance/evidence-runtime-1",
      evidenceDigest: HASH_D,
      resultDigest: HASH_C,
      bodyCoverageAccepted: true,
      timelineEvidenceAccepted: true,
      visibilityEvidenceAccepted: true,
      subjectContinuityAccepted: true,
      meaningfulMotionAccepted: true,
    },
  };
}

function rejectedReference(binding: DanceReferenceProcessingBinding): DanceReferenceOutcome {
  return {
    status: "rejected",
    binding,
    reason: "insufficient_reference_evidence",
    evidenceRef: "private/dance/evidence-rejected",
    evidenceDigest: HASH_D,
    resultDigest: HASH_C,
  };
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
  test("persists exact request and commits fake reference readiness atomically", async () => {
    await withSchema("runtime_ready", async (admin, schema) => {
      await insertProcessingGraph(admin, true);
      const store = makeDanceReferenceProcessingStore(
        makeDirectPostgresControlPlaneLayer(
          connectionForSchema(connectionString as string, schema),
        ),
      );
      expect(await store.listEligibleWakeups(25)).toEqual([
        {
          outboxId: "outbox-1",
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          effectIdentity: "dance-reference-choreography-1-r1",
          revisionStatus: "processing",
          state: "pending",
          deliveryAttempts: 0,
          claimFence: 0,
          eligible: true,
        },
      ]);
      const result = await runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-ready",
          leaseSeconds: 60,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
          frozenInput: frozenReferenceInput(),
        },
        {
          store,
          processor: {
            prepareReference: (_input, binding) => Effect.succeed(preparedReference(binding)),
            observeReference: (operation) => Effect.succeed(readyReference(operation.binding)),
          },
        },
      );
      expect(result).toEqual({ kind: "committed", status: "ready" });
      expect(await store.getWakeup("outbox-1")).toMatchObject({
        revisionStatus: "ready",
        state: "delivered",
        deliveryAttempts: 1,
        claimFence: 1,
        eligible: false,
      });
      const persisted = await admin.query(
        `SELECT revision.status, choreography.status AS choreography_status,
                outbox.state AS outbox_state, attempt.state AS attempt_state,
                request.input_digest, attempt.prepared_operation->>'providerOperationId' AS provider_id,
                artifact.private_artifact_ref
           FROM dance_choreography_revisions revision
           JOIN dance_choreographies choreography USING (choreography_id)
           JOIN dance_reference_outbox outbox USING (choreography_id, revision)
           JOIN dance_reference_processing_requests request USING (choreography_id, revision)
           JOIN dance_reference_processing_attempts attempt USING (choreography_id, revision)
           JOIN dance_reference_artifacts artifact USING (choreography_id, revision)`,
      );
      expect(persisted.rows).toEqual([
        {
          status: "ready",
          choreography_status: "ready",
          outbox_state: "delivered",
          attempt_state: "succeeded",
          input_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          provider_id: expect.stringContaining("dance-reference-choreography-1-r1"),
          private_artifact_ref: "private/dance/artifact-runtime-1",
        },
      ]);
    });
    completedTestCount += 1;
  });

  test("recovery reclaims one fenced attempt and reuses its prepared operation", async () => {
    await withSchema("runtime_recovery", async (admin, schema) => {
      await insertProcessingGraph(admin, true);
      const store = makeDanceReferenceProcessingStore(
        makeDirectPostgresControlPlaneLayer(
          connectionForSchema(connectionString as string, schema),
        ),
      );
      let prepareCalls = 0;
      const first = await runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-first",
          leaseSeconds: 1,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
          frozenInput: frozenReferenceInput(),
        },
        {
          store,
          processor: {
            prepareReference: (_input, binding) => {
              prepareCalls += 1;
              return Effect.succeed(preparedReference(binding));
            },
            observeReference: (operation) =>
              Effect.succeed({ status: "pending", binding: operation.binding }),
          },
        },
      );
      expect(first).toEqual({ kind: "pending", claimFence: 1, outboxClaimFence: 1 });
      const renewed = await runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-first",
          leaseSeconds: 1,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
          resume: { claimFence: 1, outboxClaimFence: 1 },
        },
        {
          store,
          processor: {
            prepareReference: () => Effect.die("renewal must reuse preparation"),
            observeReference: (operation) =>
              Effect.succeed({ status: "pending", binding: operation.binding }),
          },
        },
      );
      expect(renewed).toEqual({ kind: "pending", claimFence: 1, outboxClaimFence: 1 });
      const renewedFences = await admin.query(
        `SELECT attempt.lease_fence::text,outbox.claim_fence::text AS outbox_fence,
                outbox.delivery_attempts
           FROM dance_reference_processing_attempts attempt
           JOIN dance_reference_outbox outbox USING (choreography_id,revision)`,
      );
      expect(renewedFences.rows).toEqual([
        { lease_fence: "1", outbox_fence: "1", delivery_attempts: 1 },
      ]);
      const concurrent = await runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-concurrent",
          leaseSeconds: 60,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
        },
        {
          store,
          processor: {
            prepareReference: () => Effect.die("active lease must not invoke provider"),
            observeReference: () => Effect.die("active lease must not invoke provider"),
          },
        },
      );
      expect(concurrent).toEqual({ kind: "busy" });
      await admin.query("SELECT pg_sleep(1.05)");
      const recovered = await runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-recovery",
          leaseSeconds: 60,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
        },
        {
          store,
          processor: {
            prepareReference: () => {
              prepareCalls += 1;
              return Effect.die("prepared operation must be reused");
            },
            observeReference: (operation) => Effect.succeed(readyReference(operation.binding)),
          },
        },
      );
      expect(recovered).toEqual({ kind: "committed", status: "ready" });
      expect(prepareCalls).toBe(1);
      const fence = await admin.query(
        `SELECT lease_fence::text, state FROM dance_reference_processing_attempts`,
      );
      expect(fence.rows).toEqual([{ lease_fence: "2", state: "succeeded" }]);
      await expect(
        runDanceReferenceProcessing(
          {
            choreographyId: "choreography-1",
            choreographyRevision: 1,
            workerId: "worker-conflict",
            leaseSeconds: 60,
            adapterId: "fake-reference",
            adapterRevision: "fake-v1",
            frozenInput: frozenReferenceInput({ requestedEndMs: 17000 }),
          },
          {
            store,
            processor: {
              prepareReference: () => Effect.die("must not run"),
              observeReference: () => Effect.die("must not run"),
            },
          },
        ),
      ).rejects.toMatchObject({ reason: "identity-conflict" });
    });
    completedTestCount += 1;
  });

  test("rejects the original completion after a reconciler steals its expired lease", async () => {
    await withSchema("runtime_stolen_lease", async (admin, schema) => {
      await insertProcessingGraph(admin, true);
      const store = makeDanceReferenceProcessingStore(
        makeDirectPostgresControlPlaneLayer(
          connectionForSchema(connectionString as string, schema),
        ),
      );
      let releaseOriginal: (() => void) | undefined;
      let signalObserved: (() => void) | undefined;
      const originalObserved = new Promise<void>((resolve) => {
        signalObserved = resolve;
      });
      const originalRelease = new Promise<void>((resolve) => {
        releaseOriginal = resolve;
      });
      const original = runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "workflow-original",
          leaseSeconds: 1,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
          frozenInput: frozenReferenceInput(),
        },
        {
          store,
          processor: {
            prepareReference: (_input, binding) => Effect.succeed(preparedReference(binding)),
            observeReference: (operation) =>
              Effect.promise(async () => {
                signalObserved?.();
                await originalRelease;
                return readyReference(operation.binding);
              }),
          },
        },
      );
      await originalObserved;
      await admin.query("SELECT pg_sleep(1.05)");
      const stolen = await runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "workflow-reconciler",
          leaseSeconds: 60,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
        },
        {
          store,
          processor: {
            prepareReference: () => Effect.die("the prepared operation must be replayed"),
            observeReference: (operation) => Effect.succeed(readyReference(operation.binding)),
          },
        },
      );
      expect(stolen).toEqual({ kind: "committed", status: "ready" });
      releaseOriginal?.();
      expect(await original).toEqual({ kind: "stale" });
      const persisted = await admin.query(
        `SELECT attempt.lease_fence::text,attempt.state,outbox.claim_fence::text AS outbox_fence,
                outbox.state AS outbox_state,revision.status AS revision_status
           FROM dance_reference_processing_attempts attempt
           JOIN dance_reference_outbox outbox USING (choreography_id,revision)
           JOIN dance_choreography_revisions revision USING (choreography_id,revision)`,
      );
      expect(persisted.rows).toEqual([
        {
          lease_fence: "2",
          state: "succeeded",
          outbox_fence: "2",
          outbox_state: "delivered",
          revision_status: "ready",
        },
      ]);
    });
    completedTestCount += 1;
  });

  test("retryable processing advances to one exact next attempt", async () => {
    await withSchema("runtime_retry", async (admin, schema) => {
      await insertProcessingGraph(admin, true);
      const store = makeDanceReferenceProcessingStore(
        makeDirectPostgresControlPlaneLayer(
          connectionForSchema(connectionString as string, schema),
        ),
        { retryBaseMs: 1 },
      );
      const first = await runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-retry-1",
          leaseSeconds: 60,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
          frozenInput: frozenReferenceInput(),
        },
        {
          store,
          processor: {
            prepareReference: (_input, binding) => Effect.succeed(preparedReference(binding)),
            observeReference: (operation) =>
              Effect.succeed({
                status: "retryable_failure",
                binding: operation.binding,
                reason: "provider_timeout",
                evidenceRef: "private/dance/evidence-timeout",
                resultDigest: HASH_D,
              }),
          },
        },
      );
      expect(first).toEqual({ kind: "committed", status: "failed" });
      await admin.query("SELECT pg_sleep(1.05)");
      const second = await runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-retry-2",
          leaseSeconds: 60,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
        },
        {
          store,
          processor: {
            prepareReference: (_input, binding) => Effect.succeed(preparedReference(binding)),
            observeReference: (operation) => Effect.succeed(readyReference(operation.binding)),
          },
        },
      );
      expect(second).toEqual({ kind: "committed", status: "ready" });
      const attempts = await admin.query(
        `SELECT attempt_number, state FROM dance_reference_processing_attempts
          ORDER BY attempt_number`,
      );
      expect(attempts.rows).toEqual([
        { attempt_number: 1, state: "failed" },
        { attempt_number: 2, state: "succeeded" },
      ]);
    });
    completedTestCount += 1;
  });

  test("nonretryable rejection commits one failed revision without a ready artifact", async () => {
    await withSchema("runtime_rejected", async (admin, schema) => {
      await insertProcessingGraph(admin, true);
      const store = makeDanceReferenceProcessingStore(
        makeDirectPostgresControlPlaneLayer(
          connectionForSchema(connectionString as string, schema),
        ),
      );
      const result = await runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-rejected",
          leaseSeconds: 60,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
          frozenInput: frozenReferenceInput(),
        },
        {
          store,
          processor: {
            prepareReference: (_input, binding) => Effect.succeed(preparedReference(binding)),
            observeReference: (operation) => Effect.succeed(rejectedReference(operation.binding)),
          },
        },
      );
      expect(result).toEqual({ kind: "committed", status: "failed" });
      const terminal = await admin.query(
        `SELECT revision.status, outbox.state AS outbox_state,
                attempt.state AS attempt_state,
                (SELECT count(*)::text FROM dance_reference_artifacts) AS artifact_count
           FROM dance_choreography_revisions revision
           JOIN dance_reference_outbox outbox USING (choreography_id, revision)
           JOIN dance_reference_processing_attempts attempt USING (choreography_id, revision)`,
      );
      expect(terminal.rows).toEqual([
        {
          status: "processing_failed",
          outbox_state: "delivered",
          attempt_state: "exhausted",
          artifact_count: "0",
        },
      ]);
    });
    completedTestCount += 1;
  });

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
