import { describe, expect, test } from "bun:test";
import type {
  DanceAttemptStore,
  SubmitDanceSessionForGradingResponse,
} from "@pirate/application/use-cases/dance/attempt-services";
import { makeDanceAttemptHandlers } from "./dance-attempt-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const NOW = "2026-09-01T00:00:00.000Z";
const LATER = "2026-09-01T00:10:00.000Z";
const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);

const response: SubmitDanceSessionForGradingResponse = {
  session: {
    object: "dance_session",
    session_id: "dance-session-1",
    persona_id: "persona-1",
    community_id: "community-1",
    song_post_id: "song-1",
    audio_revision: 4,
    segment_id: "segment-1",
    choreography_id: "choreography-1",
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
    policy: {
      qualification_policy_version_id: "dance-shadow-policy-v1",
      calibration_version_id: "dance-calibration-shadow-v1",
      calibration_checksum: HASH_A,
      captured_admission_state: "shadow",
      platform_floor_bps: 0,
      pose_model_version: "pose-v1",
      feature_schema_version: "features-v1",
      scorer_contract_version: "scorer-v1",
      mirror_policy_version: "mirror-v1",
      cue_policy_version: "cue-v1",
      fingerprint_policy_version: "fingerprint-v1",
      integrity_policy_version: "integrity-v1",
      grader_adapter_version: "grader-v1",
    },
    session_terms_hash: HASH_B,
    state: "grading_pending",
    consented_at: "2026-09-01T00:00:10.000Z",
    upload_state: "sealed",
    attempt_id: "dance-attempt-1",
    result: null,
    created_at: NOW,
    expires_at: LATER,
  },
  replayed: false,
};

const unsupported = async (): Promise<never> => {
  throw new Error("unexpected store call");
};

function store(submit: DanceAttemptStore["submit"]): DanceAttemptStore {
  return {
    lookupAction: unsupported,
    create: unsupported,
    consent: unsupported,
    reserve: unsupported,
    finalize: unsupported,
    submit,
    get: unsupported,
  };
}

describe("Dance attempt HTTP handlers", () => {
  test("returns after durable grading outbox authority with no processor in composition", async () => {
    let durableOutboxCommits = 0;
    const handlers = makeDanceAttemptHandlers({
      store: store(async () => {
        durableOutboxCommits += 1;
        return response;
      }),
      sessionAuthority: null,
      uploadAuthority: null,
    });
    const app = createHttpWorker({
      handlers,
      authenticate: () => ({ kind: "user", subject: "account-1" }),
      authorize: () => undefined,
    });

    const result = await app.request(
      "http://api.test/communities/community-1/dance/sessions/dance-session-1/grading-submissions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ idempotency_key: "submit-1" }),
      },
    );

    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(response);
    expect(durableOutboxCommits).toBe(1);
    expect("processor" in handlers).toBe(false);
    expect("queue" in handlers).toBe(false);
    expect("workflow" in handlers).toBe(false);
  });
});
