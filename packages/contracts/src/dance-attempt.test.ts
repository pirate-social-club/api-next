import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CreateDanceSession,
  DanceAttemptTerminalResultV1,
  DancePrivateSessionV1,
  FinalizeDanceSessionUpload,
  GetDanceSession,
  RecordDanceSessionConsent,
  ReserveDanceSessionUpload,
  SubmitDanceSessionForGrading,
} from "./dance-attempt.ts";

const strict = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
const sha = (character: string): string => character.repeat(64);

const policy = {
  qualification_policy_version_id: "dance-shadow-policy-v1",
  calibration_version_id: "dance-shadow-calibration-v1",
  calibration_checksum: sha("a"),
  captured_admission_state: "shadow",
  platform_floor_bps: 4_321,
  pose_model_version: "synthetic-pose-v1",
  feature_schema_version: "dance-features-v1",
  scorer_contract_version: "dance-scorer-v1",
  mirror_policy_version: "dance-mirror-v1",
  cue_policy_version: "dance-cue-v1",
  fingerprint_policy_version: "dance-fingerprint-v1",
  integrity_policy_version: "dance-integrity-v1",
  grader_adapter_version: "test-adapter-v1",
} as const;

const createdSession = {
  object: "dance_session",
  session_id: "dance_session_1",
  persona_id: "persona_1",
  community_id: "community_1",
  song_post_id: "post_1",
  audio_revision: 3,
  segment_id: "segment_1",
  choreography_id: "choreography_1",
  choreography_revision: 2,
  reward_mode: "practice",
  objective_snapshot: [],
  expected_scored_duration_ms: 6_000,
  cue: {
    kind: "hands_on_head",
    hold_ms: 1_000,
    observation_start_ms: 0,
    observation_end_ms: 2_000,
  },
  policy,
  session_terms_hash: sha("b"),
  state: "created",
  consented_at: null,
  upload_state: "none",
  attempt_id: null,
  result: null,
  created_at: "2026-09-01T08:00:00.000Z",
  expires_at: "2026-09-01T08:15:00.000Z",
} as const;

const scoredResult = {
  object: "dance_attempt_result",
  attempt_id: "dance_attempt_1",
  grade_outcome: "scored",
  qualification_outcome: "suppressed_shadow",
  score_bps: 7_250,
  rejection_code: null,
  scored_window_start_ms: 2_000,
  scored_window_end_ms: 8_000,
  scored_duration_ms: 6_000,
  evidence_summary: {
    schema_version: 1,
    usable_coverage_bps: 9_000,
    selected_mirror: "original",
    meaningful_motion_accepted: true,
    replay_outcome: "unique",
    subject_continuity: "stable",
  },
  completed_at: "2026-09-01T08:03:00.000Z",
} as const;

describe("Dance private shadow-attempt contracts", () => {
  test("admits only rewardless shadow sessions with a captured policy floor", () => {
    expect(strict(DancePrivateSessionV1)(createdSession)).toEqual(createdSession);
    expect(() =>
      strict(DancePrivateSessionV1)({ ...createdSession, reward_mode: "reward_eligible" }),
    ).toThrow();
    expect(() =>
      strict(DancePrivateSessionV1)({
        ...createdSession,
        policy: { ...policy, captured_admission_state: "money_admitted" },
      }),
    ).toThrow();
    expect(() =>
      strict(DancePrivateSessionV1)({
        ...createdSession,
        policy: { ...policy, platform_floor_bps: null },
      }),
    ).toThrow();
    expect(() =>
      strict(DancePrivateSessionV1)({ ...createdSession, account_id: "account_1" }),
    ).toThrow();
  });

  test("freezes cue timing and rejects inconsistent state projections", () => {
    expect(() =>
      strict(DancePrivateSessionV1)({
        ...createdSession,
        cue: { ...createdSession.cue, hold_ms: 2_001 },
      }),
    ).toThrow();
    expect(() =>
      strict(DancePrivateSessionV1)({
        ...createdSession,
        state: "consented",
        consented_at: null,
      }),
    ).toThrow();
    expect(() =>
      strict(DancePrivateSessionV1)({
        ...createdSession,
        state: "completed",
        consented_at: "2026-09-01T08:01:00.000Z",
        upload_state: "sealed",
        attempt_id: "dance_attempt_1",
        result: null,
      }),
    ).toThrow();
  });

  test("separates numeric grading from qualification and always suppresses shadow output", () => {
    expect(strict(DanceAttemptTerminalResultV1)(scoredResult)).toEqual(scoredResult);
    expect(() =>
      strict(DanceAttemptTerminalResultV1)({
        ...scoredResult,
        qualification_outcome: "emitted",
      }),
    ).toThrow();
    expect(() =>
      strict(DanceAttemptTerminalResultV1)({
        ...scoredResult,
        grade_outcome: "rejected",
        rejection_code: "replay_detected",
      }),
    ).toThrow();
    expect(
      strict(DanceAttemptTerminalResultV1)({
        ...scoredResult,
        grade_outcome: "rejected",
        score_bps: null,
        rejection_code: "replay_detected",
        evidence_summary: null,
      }).qualification_outcome,
    ).toBe("suppressed_shadow");
  });

  test("requires explicit consent terms before exposing an upload reservation command", () => {
    const consentBody = RecordDanceSessionConsent.request?.body;
    const reserveBody = ReserveDanceSessionUpload.request?.body;
    if (consentBody === undefined || reserveBody === undefined) {
      throw new Error("Dance consent or upload reservation body is missing");
    }
    expect(
      strict(consentBody)({
        idempotency_key: "dance-consent-1",
        persona_id: "persona_1",
        session_terms_hash: sha("b"),
        consent_policy_version_id: "dance-consent-v1",
        retention_disclosure_version: "dance-retention-v1",
        source: "camera",
      }),
    ).toMatchObject({ session_terms_hash: sha("b"), source: "camera" });
    expect(() =>
      strict(reserveBody)({
        idempotency_key: "dance-upload-1",
        expected_content_type: "video/mp4",
        expected_size_bytes: 1_000,
        expected_duration_ms: 8_000,
        private_object_key: "client-chosen-key",
      }),
    ).toThrow();
  });

  test("never accepts a client digest as sealed authority or provider configuration", () => {
    const finalizeBody = FinalizeDanceSessionUpload.request?.body;
    const submitBody = SubmitDanceSessionForGrading.request?.body;
    if (finalizeBody === undefined || submitBody === undefined) {
      throw new Error("Dance finalize or grading body is missing");
    }
    expect(
      strict(finalizeBody)({
        idempotency_key: "dance-finalize-1",
        reservation_id: "dance_reservation_1",
      }),
    ).toEqual({
      idempotency_key: "dance-finalize-1",
      reservation_id: "dance_reservation_1",
    });
    for (const authority of [
      { server_sha256: sha("c") },
      { sealed_sha256: sha("c") },
      { provider: "client-provider" },
      { model: "client-model" },
    ]) {
      expect(() =>
        strict(submitBody)({ idempotency_key: "dance-submit-1", ...authority }),
      ).toThrow();
    }
  });

  test("declares exactly the six authenticated private phase-7 routes", () => {
    expect(CreateDanceSession.path).toEndWith(
      "/dance/choreographies/:choreographyId/revisions/:revision/sessions",
    );
    expect(RecordDanceSessionConsent.path).toEndWith("/dance/sessions/:sessionId/consent");
    expect(ReserveDanceSessionUpload.path).toEndWith(
      "/dance/sessions/:sessionId/upload-reservations",
    );
    expect(FinalizeDanceSessionUpload.path).toEndWith("/dance/sessions/:sessionId/upload/finalize");
    expect(SubmitDanceSessionForGrading.path).toEndWith(
      "/dance/sessions/:sessionId/grading-submissions",
    );
    expect(GetDanceSession.path).toEndWith("/dance/sessions/:sessionId");
    for (const route of [
      CreateDanceSession,
      RecordDanceSessionConsent,
      ReserveDanceSessionUpload,
      FinalizeDanceSessionUpload,
      SubmitDanceSessionForGrading,
      GetDanceSession,
    ]) {
      expect(route.auth).toEqual({ policy: { kind: "user" } });
      expect(route.path).not.toMatch(/qualifications|rewards/u);
    }
  });
});
