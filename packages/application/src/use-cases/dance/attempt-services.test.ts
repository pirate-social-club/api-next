import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type CreateDanceSessionResponse,
  type DanceAttemptSessionAuthority,
  type DanceAttemptStore,
  type DanceAttemptUploadAuthority,
  makeDanceAttemptService,
} from "./attempt-services.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const NOW = "2026-09-01T00:00:00.000Z";
const LATER = "2026-09-01T00:10:00.000Z";

const policy = {
  qualification_policy_version_id: "dance-shadow-policy-v1",
  calibration_version_id: "dance-calibration-shadow-v1",
  calibration_checksum: HASH_A,
  captured_admission_state: "shadow" as const,
  platform_floor_bps: 0,
  pose_model_version: "pose-v1",
  feature_schema_version: "features-v1",
  scorer_contract_version: "scorer-v1",
  mirror_policy_version: "mirror-v1",
  cue_policy_version: "cue-v1",
  fingerprint_policy_version: "fingerprint-v1",
  integrity_policy_version: "integrity-v1",
  grader_adapter_version: "grader-v1",
};

const session = {
  object: "dance_session" as const,
  session_id: "dance-session-1",
  persona_id: "persona-1",
  community_id: "community-1",
  song_post_id: "song-1",
  audio_revision: 4,
  segment_id: "segment-1",
  choreography_id: "choreography-1",
  choreography_revision: 2,
  reward_mode: "practice" as const,
  objective_snapshot: [] as const,
  expected_scored_duration_ms: 6_000,
  cue: {
    kind: "hands_on_head" as const,
    hold_ms: 1_000,
    observation_start_ms: 0,
    observation_end_ms: 2_000,
  },
  policy,
  session_terms_hash: HASH_B,
  state: "created" as const,
  consented_at: null,
  upload_state: "none" as const,
  attempt_id: null,
  result: null,
  created_at: NOW,
  expires_at: LATER,
};

const createResponse: CreateDanceSessionResponse = { session, replayed: false };

const authority: DanceAttemptSessionAuthority = {
  sessionId: session.session_id,
  audioRevision: session.audio_revision,
  segmentId: session.segment_id,
  expectedScoredDurationMs: session.expected_scored_duration_ms,
  cue: {
    kind: session.cue.kind,
    holdMs: session.cue.hold_ms,
    observationStartMs: session.cue.observation_start_ms,
    observationEndMs: session.cue.observation_end_ms,
  },
  policy: {
    qualificationPolicyVersionId: policy.qualification_policy_version_id,
    calibrationVersionId: policy.calibration_version_id,
    calibrationChecksum: policy.calibration_checksum,
    capturedAdmissionState: "shadow",
    platformFloorBps: policy.platform_floor_bps,
    poseModelVersion: policy.pose_model_version,
    featureSchemaVersion: policy.feature_schema_version,
    scorerContractVersion: policy.scorer_contract_version,
    mirrorPolicyVersion: policy.mirror_policy_version,
    cuePolicyVersion: policy.cue_policy_version,
    fingerprintPolicyVersion: policy.fingerprint_policy_version,
    fingerprintKeyVersion: "fingerprint-key-v1",
    integrityPolicyVersion: policy.integrity_policy_version,
    graderAdapterVersion: policy.grader_adapter_version,
  },
  sessionTermsHash: HASH_B,
  createdAt: NOW,
  expiresAt: LATER,
};

const reservation = {
  reservationId: "dance-reservation-1",
  privateObjectKey: "private/dance/session-1/source",
  uploadUrl: "https://uploads.invalid/dance-session-1",
  expectedContentType: "video/mp4" as const,
  expectedSizeBytes: 1_024,
  expectedDurationMs: 8_000,
  expectedSha256: HASH_A,
  createdAt: NOW,
  expiresAt: LATER,
};

const sealed = {
  reservationId: reservation.reservationId,
  privateObjectKey: reservation.privateObjectKey,
  contentType: reservation.expectedContentType,
  sizeBytes: reservation.expectedSizeBytes,
  durationMs: reservation.expectedDurationMs,
  serverSha256: HASH_A,
  sealedAt: "2026-09-01T00:01:00.000Z",
};

const unsupported = async (): Promise<never> => {
  throw new Error("unexpected store call");
};

function store(overrides: Partial<DanceAttemptStore>): DanceAttemptStore {
  return {
    lookupAction: async () => ({ kind: "miss" }),
    create: unsupported,
    consent: unsupported,
    reserve: unsupported,
    finalize: unsupported,
    submit: unsupported,
    get: unsupported,
    ...overrides,
  };
}

const uploadAuthority: DanceAttemptUploadAuthority = {
  reserve: async () => reservation,
  seal: async () => sealed,
};

describe("Dance attempt application services", () => {
  test("returns after durable outbox authority with no processor in the composition", async () => {
    let outboxCommits = 0;
    const gradingPending = {
      ...session,
      state: "grading_pending" as const,
      consented_at: "2026-09-01T00:00:10.000Z",
      upload_state: "sealed" as const,
      attempt_id: "dance-attempt-1",
    };
    const service = makeDanceAttemptService({
      store: store({
        submit: async () => {
          outboxCommits += 1;
          return { session: gradingPending, replayed: false };
        },
      }),
      sessionAuthority: null,
      uploadAuthority: null,
    });

    const result = await Effect.runPromise(
      service.submit({
        actorAccountId: "account-1",
        communityId: "community-1",
        sessionId: "dance-session-1",
        body: { idempotency_key: "submit-1" },
      }),
    );

    expect(result.session.state).toBe("grading_pending");
    expect(outboxCommits).toBe(1);
    expect("processor" in service).toBe(false);
    expect("queue" in service).toBe(false);
    expect("workflow" in service).toBe(false);
  });

  test("resolves private authorities only before their durable commands", async () => {
    const calls: string[] = [];
    const service = makeDanceAttemptService({
      store: store({
        create: async () => {
          calls.push("create-commit");
          return createResponse;
        },
        reserve: async () => {
          calls.push("reserve-commit");
          return {
            session: {
              ...session,
              state: "awaiting_upload",
              consented_at: "2026-09-01T00:00:10.000Z",
              upload_state: "reserved",
            },
            reservation: {
              object: "dance_upload_reservation",
              reservation_id: reservation.reservationId,
              session_id: session.session_id,
              upload_url: reservation.uploadUrl,
              expected_content_type: reservation.expectedContentType,
              expected_size_bytes: reservation.expectedSizeBytes,
              expected_duration_ms: reservation.expectedDurationMs,
              expires_at: reservation.expiresAt,
            },
            replayed: false,
          };
        },
        finalize: async () => {
          calls.push("finalize-commit");
          return {
            session: {
              ...session,
              state: "uploaded",
              consented_at: "2026-09-01T00:00:10.000Z",
              upload_state: "sealed",
            },
            replayed: false,
          };
        },
      }),
      sessionAuthority: {
        resolve: async () => {
          calls.push("session-authority");
          return authority;
        },
      },
      uploadAuthority: {
        reserve: async () => {
          calls.push("upload-authority");
          return reservation;
        },
        seal: async () => {
          calls.push("seal-authority");
          return sealed;
        },
      },
    });

    await Effect.runPromise(
      service.create({
        actorAccountId: "account-1",
        communityId: "community-1",
        songPostId: "song-1",
        choreographyId: "choreography-1",
        choreographyRevision: "2",
        body: { idempotency_key: "create-1", persona_id: "persona-1", reward_mode: "practice" },
      }),
    );
    await Effect.runPromise(
      service.reserve({
        actorAccountId: "account-1",
        communityId: "community-1",
        sessionId: "dance-session-1",
        body: {
          idempotency_key: "reserve-1",
          expected_content_type: "video/mp4",
          expected_size_bytes: 1_024,
          expected_duration_ms: 8_000,
          expected_sha256: HASH_A,
        },
      }),
    );
    await Effect.runPromise(
      service.finalize({
        actorAccountId: "account-1",
        communityId: "community-1",
        sessionId: "dance-session-1",
        body: { idempotency_key: "finalize-1", reservation_id: reservation.reservationId },
      }),
    );

    expect(calls).toEqual([
      "session-authority",
      "create-commit",
      "upload-authority",
      "reserve-commit",
      "seal-authority",
      "finalize-commit",
    ]);
  });

  test("replays before consulting an absent production authority", async () => {
    const service = makeDanceAttemptService({
      store: store({ lookupAction: async () => ({ kind: "replay", response: createResponse }) }),
      sessionAuthority: null,
      uploadAuthority,
    });

    const result = await Effect.runPromise(
      service.create({
        actorAccountId: "account-1",
        communityId: "community-1",
        songPostId: "song-1",
        choreographyId: "choreography-1",
        choreographyRevision: "2",
        body: { idempotency_key: "create-1", persona_id: "persona-1", reward_mode: "practice" },
      }),
    );

    expect(result.replayed).toBe(true);
    expect(result.session.session_id).toBe("dance-session-1");
  });
});
