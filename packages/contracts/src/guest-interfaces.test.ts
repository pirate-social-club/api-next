import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  Auth,
  BrowserParticipationOperationSchema,
  browserParticipationOperations,
} from "./auth.ts";
import { generateClient, generateOpenApi } from "./codegen.ts";
import { endpoint } from "./endpoint.ts";
import { GuestBadRequest, GuestConflict, GuestPendingConflict, toErrorBody } from "./errors.ts";
import {
  CleanupGuestBrowserProofV1,
  ListGuestParticipationsV1,
} from "./guest-browser-authority.ts";
import {
  GuestAuthorityV1,
  GuestParticipationProjectionV1,
  GuestParticipationResultV1,
} from "./guest-participation.ts";
import { guestParticipationRegistry } from "./guest-registry.ts";
import {
  GuestStudyPreparedContentV1,
  GuestStudySessionV1,
  GuestStudyStartOperationV1,
  StartGuestStudySessionV1,
} from "./guest-study.ts";
import { ClaimOwnerRewardCreditV1, OwnerRewardCreditV1 } from "./rewards-owner-claims.ts";
import { StudySessionV2 } from "./study-v2.ts";

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const instant = "2026-10-11T10:00:00.000Z";
const operation = {
  operation_kind: "study_start" as const,
  idempotency_key: "start-1",
  operation_id: null,
};
const item = (ordinal: number) => ({
  object: "study_session_item_v2",
  session_item_id: `item-${ordinal}`,
  ordinal,
  exercise_review_key: `review-${ordinal}`,
  exercise_version_id: `version-${ordinal}`,
  exercise_type: "say_it_back",
  exercise_variant: "spoken-recall-v1",
  line: {
    post_id: "post-1",
    audio_revision: 1,
    lyrics_revision: 1,
    lyric_line_id: `line-${ordinal}`,
    study_unit_id: `unit-${ordinal}`,
    line_version: 1,
    line_source_hash: "a".repeat(64),
  },
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  language_profile_revision: null,
  presentation: { kind: "say_it_back", reference_text: "Hold on", capture: "microphone_audio" },
  answer_visibility: "always_visible",
  feedback_release: "every_graded_attempt",
  grader_policy_revision: "script-aware-token-diff-v1",
  feedback_policy_revision: "spoken-feedback-v1",
  quality_policy_revision: "study-quality-v1",
  maximum_attempts: 1,
});
const session = () => ({
  object: "guest_study_session_v1",
  actor: { kind: "guest" },
  owner_id: "guest-owner-1",
  session_id: "session-1",
  community_id: "community-1",
  post_id: "post-1",
  audio_revision: 1,
  lyrics_revision: 1,
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  study_profile_revision: 1,
  language_profile_revision: null,
  source_set_revision: 1,
  selection_policy_revision: "selection-v1",
  qualification_policy_revision: "study_session_first_pass_v2@1",
  timezone: "UTC",
  status: "active",
  items: Array.from({ length: 4 }, (_, ordinal) => item(ordinal)),
  progress: {
    qualifying_exercise_count: 4,
    answered_exercise_count: 0,
    first_pass_correct: 0,
    required_correct: 3,
    score_bps: null,
  },
  lesson: {
    current: {
      session_item_id: "item-0",
      presentation_number: 1,
      is_reappearance: false,
      presented_at: instant,
    },
    resolved_card_count: 0,
    total_card_count: 4,
    presentation_count: 0,
    presentation_cap: 12,
    completion_reason: null,
  },
  created_at: instant,
  completed_at: null,
  expires_at: "2026-10-12T10:00:00.000Z",
  reward_mode: "practice_only",
  reward_terms: null,
  participation: { state: "practice_only" },
});
const credit = () => ({
  object: "owner_reward_credit_v1",
  identity_version: "owner_v1",
  owner_id: "owner-1",
  credit_id: "credit-1",
  community_id: "community-1",
  pool_leg_id: "leg-1",
  original_drawing_id: "7",
  chain_id: 8453,
  token_address: `0x${"a".repeat(40)}`,
  token_decimals: 6,
  amount_atomic: "123",
  available_atomic: "123",
  reserved_atomic: "0",
  paid_atomic: "0",
  source_kind: "megapot_allocation",
  state: "credited",
  created_at: instant,
  updated_at: instant,
  settled_at: null,
  claim: { status: "unclaimed", payout_status: null },
  send: null,
  recipient: { kind: "guest_owner", selection: null, binding: null },
});

describe("Guest learning and source-admitted financial contracts", () => {
  test("the single correlated vocabulary rejects impossible policies", () => {
    for (const [authority, operations] of Object.entries(browserParticipationOperations)) {
      for (const operation of operations)
        expect(Schema.is(BrowserParticipationOperationSchema)({ authority, operation })).toBe(true);
    }
    const invalid = { authority: "bootstrap", operation: "answer" };
    expect(Schema.is(BrowserParticipationOperationSchema)(invalid)).toBe(false);
    expect(() => Auth.browserParticipation(invalid as never)).toThrow("Invalid browser");
    const valid = Auth.browserParticipation({ authority: "learning", operation: "answer" });
    expect(() =>
      endpoint({
        method: "POST",
        path: "/invalid",
        auth: { ...valid, optionalUser: true },
        response: Schema.String,
      }),
    ).toThrow("Invalid browser");
    expect(() =>
      endpoint({
        method: "POST",
        path: "/invalid",
        auth: Auth.successfulGuestAttachment(),
        response: Schema.String,
      }),
    ).toThrow("Invalid setup");
  });
  test("guest identity never weakens ordinary account session fields or qualification arithmetic", () => {
    const value = session();
    expect(decode(GuestStudySessionV1, value).actor.kind).toBe("guest");
    expect(() => decode(StudySessionV2, value)).toThrow();
    expect(() => decode(GuestStudySessionV1, { ...value, persona_id: "invented" })).toThrow();
    expect(() =>
      decode(GuestStudySessionV1, {
        ...value,
        progress: { ...value.progress, required_correct: 2 },
      }),
    ).toThrow();
    expect(() =>
      decode(GuestStudySessionV1, {
        ...value,
        items: [value.items[0], ...value.items.slice(1, 3), value.items[0]],
      }),
    ).toThrow();
    expect(() =>
      decode(GuestStudySessionV1, { ...value, expires_at: "2026-10-11T11:00:00.000Z" }),
    ).toThrow();
    expect(() =>
      decode(GuestStudySessionV1, {
        ...value,
        participation: {
          state: "admitted",
          share_id: "share-1",
          original_drawing_id: "7",
          pool_leg_id: "leg-1",
        },
      }),
    ).toThrow();
  });
  test("missing start and unresolved COMMIT cannot masquerade as completed or admitted", () => {
    expect(
      decode(GuestStudyStartOperationV1, { state: "pending_confirmation", session: null }).state,
    ).toBe("pending_confirmation");
    expect(() =>
      decode(GuestStudyStartOperationV1, { state: "not_started", session: session() }),
    ).toThrow();
    expect(() =>
      decode(GuestParticipationResultV1, {
        state: "pending_confirmation",
        operation,
        share_id: "promised",
      }),
    ).toThrow();
    const projection = {
      participation_id: "participation-1",
      original_drawing_id: "7",
      pool_leg_id: "leg-1",
      admission_state: "pending_confirmation",
      purchase_state: "held_unresolved_admission",
      purchase_safety_deadline_at: instant,
      reconciliation_state: "pending",
      purchase_deadline_passed: false,
      allocation_id: null,
      credit_id: null,
      amount_atomic: null,
    };
    for (const passed of [false, true])
      expect(
        decode(GuestParticipationProjectionV1, { ...projection, purchase_deadline_passed: passed })
          .purchase_state,
      ).toBe("held_unresolved_admission");
    expect(() =>
      decode(GuestParticipationProjectionV1, { ...projection, purchase_state: "unavailable" }),
    ).toThrow();
    expect(() =>
      decode(GuestParticipationProjectionV1, { ...projection, amount_atomic: "1000000" }),
    ).toThrow();
  });
  test("start rejects body authority and changed preview semantics before a handler", () => {
    const body = {
      idempotency_key: "start-1",
      expected_owner_id: "owner-1",
      target_language: null,
      learner_band: null,
      timezone: "UTC",
      reward_mode: "practice_only",
      reward_preview_terms_hash: null,
      disclosure: { version: "disclosure-v1", accepted: true },
    };
    expect(() => decode(StartGuestStudySessionV1.request.body, body)).not.toThrow();
    expect(() =>
      decode(StartGuestStudySessionV1.request.body, { ...body, reward_mode: "practice" }),
    ).toThrow();
    for (const field of ["persona_id", "account_id", "drawing_id", "source_kind"])
      expect(() =>
        decode(StartGuestStudySessionV1.request.body, { ...body, [field]: "invented" }),
      ).toThrow();
    expect(() =>
      decode(StartGuestStudySessionV1.request.body, { ...body, reward_mode: "megapot_guest_v1" }),
    ).toThrow();
  });
  test("participation limits decode canonical HTTP query strings", () => {
    for (const limit of ["1", "25", "100"])
      expect(decode(ListGuestParticipationsV1.request.query, { limit }).limit).toBe(limit);
    for (const limit of ["0", "101", "01", "-1", "1.0", "invalid", 25])
      expect(() => decode(ListGuestParticipationsV1.request.query, { limit })).toThrow();
  });
  test("public prepared readiness has finite response bounds", () => {
    const value = {
      object: "guest_study_prepared_content_v1",
      reward_preview: null,
      disclosure: { version: "disclosure-v1", text: "Private learning" },
      availability: {
        state: "ready",
        available_exercise_types: ["say_it_back"],
        learning_language: "en",
        target_languages: ["es"],
        learner_bands: ["A1"],
      },
    };
    expect(() => decode(GuestStudyPreparedContentV1, value)).not.toThrow();
    expect(() =>
      decode(GuestStudyPreparedContentV1, {
        ...value,
        availability: {
          ...value.availability,
          target_languages: Array.from({ length: 129 }, () => "es"),
        },
      }),
    ).toThrow();
    expect(() =>
      decode(GuestStudyPreparedContentV1, {
        ...value,
        availability: {
          ...value.availability,
          available_exercise_types: ["say_it_back", "translation_choice", "say_it_back"],
        },
      }),
    ).toThrow();
  });
  test("rewarded sessions retain accepted source, policy, original drawing and offer leg", () => {
    const value = session();
    const terms = {
      community_id: value.community_id,
      post_id: value.post_id,
      audio_revision: value.audio_revision,
      lyrics_revision: value.lyrics_revision,
      offer_id: "offer-1",
      pool_leg_id: "leg-1",
      original_drawing_id: "7",
      qualification_policy_version_id: value.qualification_policy_revision,
      policy_hash: "a".repeat(64),
      terms_hash: "b".repeat(64),
      entry_cutoff_at: instant,
      disclosure_version: "disclosure-v1",
    };
    const rewarded = {
      ...value,
      reward_mode: "megapot_guest_v1",
      reward_terms: terms,
      participation: {
        state: "admitted",
        share_id: "share-1",
        original_drawing_id: "7",
        pool_leg_id: "leg-1",
      },
    };
    expect(() => decode(GuestStudySessionV1, rewarded)).not.toThrow();
    expect(() =>
      decode(GuestStudySessionV1, {
        ...rewarded,
        qualification_policy_revision: "different-policy",
      }),
    ).toThrow();
    for (const field of ["original_drawing_id", "pool_leg_id"])
      expect(() =>
        decode(GuestStudySessionV1, {
          ...rewarded,
          participation: {
            ...rewarded.participation,
            [field]: field === "original_drawing_id" ? "8" : "leg-2",
          },
        }),
      ).toThrow();
  });
  test("cleanup bounds and deduplicates explicit candidates without treating IDs as proof", () => {
    const body = {
      selected_credential_id: null,
      candidate_credential_ids: [`${"a".repeat(21)}A`],
      candidate_intent_ids: [],
    };
    expect(() => decode(CleanupGuestBrowserProofV1.request.body, body)).not.toThrow();
    expect(() =>
      decode(CleanupGuestBrowserProofV1.request.body, {
        ...body,
        candidate_credential_ids: [
          ...body.candidate_credential_ids,
          ...body.candidate_credential_ids,
        ],
      }),
    ).toThrow();
    expect(() =>
      decode(CleanupGuestBrowserProofV1.request.body, {
        ...body,
        candidate_credential_ids: Array.from(
          { length: 17 },
          (_, i) => `${String.fromCharCode(65 + i).repeat(21)}A`,
        ),
      }),
    ).toThrow();
  });
  test("one owner liability has no fabricated persona; successful guest binding pins its selection", () => {
    const value = credit();
    expect(() => decode(OwnerRewardCreditV1, value)).not.toThrow();
    expect(() =>
      decode(OwnerRewardCreditV1, {
        ...value,
        claim: { status: "subject_conflict", payout_status: null },
      }),
    ).not.toThrow();
    expect(() => decode(OwnerRewardCreditV1, { ...value, claim: null })).toThrow();
    expect(() =>
      decode(OwnerRewardCreditV1, { ...value, amount_atomic: "1".repeat(79) }),
    ).toThrow();
    const accountCredit = {
      ...value,
      recipient: {
        kind: "account_owner",
        original_persona_id: "persona-1",
        selection: null,
        binding: { persona_id: "persona-1", selection_revision: null, bound_at: instant },
      },
    };
    expect(() => decode(OwnerRewardCreditV1, accountCredit)).not.toThrow();
    for (const credit of [value, accountCredit])
      for (const state of ["payout_reserved", "payout_pending", "sent"])
        expect(() => decode(OwnerRewardCreditV1, { ...credit, state })).toThrow();
    expect(() => decode(OwnerRewardCreditV1, { ...accountCredit, claim: null })).toThrow();
    expect(() =>
      decode(OwnerRewardCreditV1, {
        ...accountCredit,
        available_atomic: "0",
        reserved_atomic: "123",
      }),
    ).toThrow();
    expect(() =>
      decode(OwnerRewardCreditV1, { ...accountCredit, available_atomic: "0", paid_atomic: "123" }),
    ).toThrow();
    expect(() =>
      decode(OwnerRewardCreditV1, {
        ...accountCredit,
        send: { send_id: "send-1", status: "pending" },
      }),
    ).toThrow();
    expect(() => decode(OwnerRewardCreditV1, { ...value, reserved_atomic: "1" })).toThrow();
    expect(() =>
      decode(OwnerRewardCreditV1, { ...value, payout_persona_id: "fabricated" }),
    ).toThrow();
    const selection = { revision: 1, persona_id: "persona-1", selected_at: instant };
    const bound = {
      ...value,
      claim: { status: "accepted", payout_status: "pending" },
      recipient: {
        kind: "guest_owner",
        selection,
        binding: { persona_id: "persona-1", selection_revision: 1, bound_at: instant },
      },
    };
    expect(() => decode(OwnerRewardCreditV1, bound)).not.toThrow();
    expect(() =>
      decode(OwnerRewardCreditV1, {
        ...bound,
        recipient: {
          ...bound.recipient,
          binding: { ...bound.recipient.binding, selection_revision: 2 },
        },
      }),
    ).toThrow();
    expect(() =>
      decode(ClaimOwnerRewardCreditV1.request.body, {
        idempotency_key: "claim-1",
        selection_revision: 0,
      }),
    ).toThrow();
    expect(() =>
      decode(ClaimOwnerRewardCreditV1.request.body, {
        idempotency_key: "claim-1",
        selection_revision: null,
        source_kind: "account",
      }),
    ).toThrow();
  });
  test("guest errors redact diagnostic proof material and require a durable conflict locator", () => {
    const message = `__Host-pirate_guest_${"a".repeat(21)}A=${"x".repeat(42)}A`;
    const serialized = toErrorBody(
      new GuestBadRequest({ message, details: { reason_code: "guest_cookie_invalid" } }),
    );
    expect(JSON.stringify(serialized)).not.toContain(message);
    const pending = toErrorBody(
      new GuestPendingConflict({
        message,
        details: {
          reason_code: "operation_pending_confirmation",
          operation,
          retry_after_seconds: 3,
        },
      }),
    );
    expect(pending.status).toBe(409);
    expect(pending.headers?.["Retry-After"]).toBe("3");
    const invalid = new GuestConflict({
      message,
      details: { reason_code: "participation_conflict" } as never,
    });
    expect(toErrorBody(invalid).status).toBe(500);
    const extra = new GuestBadRequest({
      message,
      details: { reason_code: "guest_cookie_invalid", cookie: "secret" } as never,
    });
    expect(JSON.stringify(toErrorBody(extra))).not.toContain("cookie");
  });
  test("generated candidate enforces wire caps and specialized same-code error details", async () => {
    const generated = await import(
      `data:text/javascript;base64,${btoa(new Bun.Transpiler({ loader: "ts" }).transformSync(generateClient(guestParticipationRegistry)))}`
    );
    let responseBody: unknown = {
      object: "guest_authority",
      state: "absent",
      selected: null,
      proved_credentials: [],
      pointer_repair: null,
    };
    let status = 200;
    const client = generated.createPirateApiClient("https://fixture.invalid", {
      fetchImpl: async () => Response.json(responseBody, { status }),
    });
    await expect(client.get_guestAuthority({})).resolves.toHaveProperty("state", "absent");
    const proof = {
      owner_id: "owner-1",
      credential_id: `${"a".repeat(21)}A`,
      credential_state: "confirmed",
      session_until: instant,
    };
    responseBody = {
      object: "guest_authority",
      state: "confirmed",
      selected: null,
      proved_credentials: Array.from({ length: 5 }, () => proof),
      pointer_repair: null,
    };
    await expect(client.get_guestAuthority({})).rejects.toThrow();
    responseBody = {
      object: "guest_authority",
      state: "confirmed",
      selected: { ...proof, owner_id: "x".repeat(129) },
      proved_credentials: [],
      pointer_repair: null,
    };
    await expect(client.get_guestAuthority({})).rejects.toThrow();
    status = 401;
    responseBody = {
      error: {
        code: "auth_error",
        message: "refused",
        retryable: false,
        details: { reason_code: "invented" },
      },
    };
    await expect(client.get_guestAuthority({})).rejects.toThrow();
    responseBody = {
      error: {
        code: "auth_error",
        message: "refused",
        retryable: false,
        details: { reason_code: "guest_proof_required" },
      },
    };
    await expect(client.get_guestAuthority({})).rejects.toMatchObject({
      code: "auth_error",
      status: 401,
    });
    const openApi = generateOpenApi(guestParticipationRegistry);
    expect(openApi.paths["/guest/authority"]?.get?.["x-implementation"]).toBeUndefined();
    expect(
      openApi.paths["/guest/attachment-intents/{id}/prepare"]?.post?.["x-implementation"],
    ).toBeUndefined();
    expect(() =>
      decode(GuestAuthorityV1, {
        object: "guest_authority",
        state: "absent",
        selected: null,
        proved_credentials: [],
        pointer_repair: null,
        secret: "invented",
      }),
    ).toThrow();
  });
});
