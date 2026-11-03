import { describe, expect, test } from "bun:test";
import {
  decodeDanceReviewCommandReceiptV1,
  decodeDanceReviewCommandV1,
  decodeDanceReviewPrivateResultV1,
  decodeDanceReviewTaskV1,
} from "./dance-review.ts";

const common = {
  idempotency_key: "command-key",
  community_id: "community",
  review_id: "review",
  expected_review_revision: 1,
};
const submit = {
  ...common,
  version: "dance-review-submit-v1",
  operation: "submit",
  show_publicly_if_passed: false,
  publication_disclosure_version: "disclosure-v1",
} as const;
const result = {
  version: "dance-private-review-v1",
  review_id: "review",
  session_id: "session",
  attempt_id: "attempt",
  community_id: "community",
  song_post_id: "song",
  audio_revision: 1,
  choreography_id: "dance",
  choreography_revision: 1,
  segment_id: "segment",
  review_revision: 1,
  session_terms_hash: "a".repeat(64),
  qualification_policy_version: "qualification-v1",
  qualification_policy_hash: "b".repeat(64),
  captured_policy: {
    version: "moderator-review-policy-v1",
    hash: "a".repeat(64),
    rubric_version: "rubric-v1",
    rubric_hash: "c".repeat(64),
    normalization_version: "normalization-v1",
    normalization_hash: "d".repeat(64),
    safety_hash: "e".repeat(64),
    retention_hash: "f".repeat(64),
    admission: "shadow",
    admission_version: "admission-v1",
    admission_hash: "1".repeat(64),
  },
  state: "uploaded",
  uploaded_at: "1970-01-01T00:00:01.000Z",
  submitted_at: null,
  review_deadline: "1970-01-08T00:00:01.000Z",
  terminal_at: null,
  verdict: null,
  score_bps: null,
  qualification_ref: null,
  cue_attestation: null,
  initial_submit_receipt: null,
  show_publicly_if_passed: null,
  publication_choice_revision: 0,
  publication_status: "none",
  publication_revision: 0,
} as const;

describe("unregistered moderated Dance contracts", () => {
  test("explicit publication choice and disclosure are required; no actor/score/reward truth or alternate persona", () => {
    expect(decodeDanceReviewCommandV1(submit)).toEqual(submit);
    for (const key of ["show_publicly_if_passed", "publication_disclosure_version"]) {
      const missing: Record<string, unknown> = { ...submit };
      delete missing[key];
      expect(() => decodeDanceReviewCommandV1(missing)).toThrow();
    }
    for (const extra of [
      { score_bps: 10000 },
      { actor_account_id: "owner" },
      { qualification_ref: "forged" },
      { reward_mode: "reward_eligible" },
      { persona_id: "other" },
      { human_verified: true },
      { funder_class: "song_owner" },
    ])
      expect(() => decodeDanceReviewCommandV1({ ...submit, ...extra })).toThrow();
  });
  test("verdict version binds the human attestation, with no fabricated observed cue or reviewer note", () => {
    const verdict = {
      ...common,
      version: "dance-owner-verdict-attestation-v1",
      operation: "verdict",
      verdict: "passed",
    } as const;
    expect(decodeDanceReviewCommandV1(verdict)).toEqual(verdict);
    expect(decodeDanceReviewCommandV1({ ...verdict, verdict: "not_passed" })).toMatchObject({
      verdict: "not_passed",
    });
    for (const body of [
      { ...verdict, version: "unqualified-button" },
      { ...verdict, verdict: "approved" },
      { ...verdict, cue_observed_at: "now" },
      { ...verdict, note: "looks fine" },
    ])
      expect(() => decodeDanceReviewCommandV1(body)).toThrow();
  });
  test("worker tasks cannot pass the account command decoder", () => {
    for (const operation of ["screen", "expire", "erase"] as const) {
      const task = { ...common, version: "dance-review-task-v1", operation } as const;
      expect(decodeDanceReviewTaskV1(task)).toEqual(task);
      expect(() => decodeDanceReviewCommandV1(task)).toThrow();
    }
    expect(() =>
      decodeDanceReviewTaskV1({
        ...common,
        version: "dance-review-task-v1",
        operation: "publication_failed",
        handoff_generation: 0,
      }),
    ).toThrow();
    expect(() =>
      decodeDanceReviewTaskV1({
        ...common,
        version: "dance-review-task-v1",
        operation: "screen",
        safety_accepted: true,
      }),
    ).toThrow();
  });
  test("identifiers/revisions are canonical and unknown fields fail closed", () => {
    for (const id of ["", " review", "review ", "bad\u0000id", "bad\u0080id", "a".repeat(129)])
      expect(() => decodeDanceReviewCommandV1({ ...submit, review_id: id })).toThrow();
    for (const revision of [0, -1, 1.1, "1", Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        decodeDanceReviewCommandV1({ ...submit, expected_review_revision: revision }),
      ).toThrow();
  });
  test("private result has no URL/key/score and requires coherent immutable Submit and deadline", () => {
    expect(decodeDanceReviewPrivateResultV1(result)).toEqual(result);
    for (const extra of [
      { signed_url: "https://private" },
      { object_key: "private/source" },
      { account_id: "dancer" },
      { score_bps: 10000 },
      { review_deadline: "1970-01-09T00:00:01.000Z" },
      { state: "awaiting_review" },
      { state: "reviewed", verdict: "passed" },
      { qualification_ref: "forged" },
    ])
      expect(() => decodeDanceReviewPrivateResultV1({ ...result, ...extra })).toThrow();
    const pending = {
      ...result,
      state: "screening",
      review_revision: 2,
      submitted_at: "1970-01-01T00:00:02.000Z",
      initial_submit_receipt: {
        receipt_id: "submit",
        show_publicly_if_passed: false,
        publication_disclosure_version: "disclosure-v1",
        submitted_at: "1970-01-01T00:00:02.000Z",
      },
      show_publicly_if_passed: false,
      publication_choice_revision: 1,
    } as const;
    expect(decodeDanceReviewPrivateResultV1(pending)).toEqual(pending);
    expect(() =>
      decodeDanceReviewPrivateResultV1({ ...pending, submitted_at: "1970-01-01T00:00:03.000Z" }),
    ).toThrow();
    const expired = { ...pending, state: "review_expired", terminal_at: pending.review_deadline };
    expect(decodeDanceReviewPrivateResultV1(expired).verdict).toBeNull();
    expect(() =>
      decodeDanceReviewPrivateResultV1({
        ...expired,
        verdict: "not_passed",
        cue_attestation: "not_attested",
      }),
    ).toThrow();
  });
  test("immutable command receipts bind the review and their exact success/refusal state", () => {
    const receipt = {
      version: "dance-review-receipt-v1",
      receipt_id: "receipt",
      review_id: "review",
      operation: "submit",
      outcome: "refused",
      refusal_code: "evidence_unavailable",
      committed_at: "1970-01-01T00:00:02.000Z",
      result,
    } as const;
    expect(decodeDanceReviewCommandReceiptV1(receipt)).toEqual(receipt);
    expect(() => decodeDanceReviewCommandReceiptV1({ ...receipt, review_id: "foreign" })).toThrow();
    expect(() => decodeDanceReviewCommandReceiptV1({ ...receipt, outcome: "applied" })).toThrow();
  });
});

test.each(["passed", "not_passed"] as const)(
  "no-pose private %s result cannot claim a pose affirmation",
  (verdict) => {
    const reviewed = {
      ...result,
      state: "reviewed",
      verdict,
      captured_policy: { ...result.captured_policy, version: "moderator-review-policy-v2" },
      cue_attestation: "not_required",
      submitted_at: "1970-01-01T00:00:02.000Z",
      terminal_at: "1970-01-01T00:00:03.000Z",
      initial_submit_receipt: {
        receipt_id: "submit",
        show_publicly_if_passed: false,
        publication_disclosure_version: "disclosure-v1",
        submitted_at: "1970-01-01T00:00:02.000Z",
      },
      show_publicly_if_passed: false,
      publication_choice_revision: 1,
    };
    expect(decodeDanceReviewPrivateResultV1(reviewed).cue_attestation).toBe("not_required");
    for (const cue_attestation of ["affirmed", "not_attested", null])
      expect(() => decodeDanceReviewPrivateResultV1({ ...reviewed, cue_attestation })).toThrow();
    expect(() =>
      decodeDanceReviewPrivateResultV1({ ...reviewed, captured_policy: result.captured_policy }),
    ).toThrow();
    expect(
      decodeDanceReviewCommandV1({
        ...common,
        operation: "verdict",
        version: "dance-owner-verdict-attestation-v2",
        verdict,
      }).version,
    ).toBe("dance-owner-verdict-attestation-v2");
  },
);
