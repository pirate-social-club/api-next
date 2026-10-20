import { Schema } from "effect";

const Id = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((s) =>
    s === s.trim() &&
    ![...s].some((c) => {
      const n = c.codePointAt(0) ?? 0;
      return n < 32 || (n >= 127 && n <= 159);
    })
      ? undefined
      : "Invalid canonical identifier",
  ),
);
const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Instant = Schema.String.check(
  Schema.makeFilter((s) => {
    const n = Date.parse(s);
    return Number.isFinite(n) && new Date(n).toISOString() === s
      ? undefined
      : "Invalid canonical instant";
  }),
);
const request = {
  idempotency_key: Id,
  community_id: Id,
  review_id: Id,
  expected_review_revision: Revision,
};

export const SubmitDanceReviewV1 = Schema.Struct({
  version: Schema.Literal("dance-review-submit-v1"),
  operation: Schema.Literal("submit"),
  ...request,
  show_publicly_if_passed: Schema.Boolean,
  publication_disclosure_version: Id,
});
export const UpdateDanceReviewVisibilityV1 = Schema.Struct({
  version: Schema.Literal("dance-review-visibility-v1"),
  operation: Schema.Literal("visibility"),
  ...request,
  show_publicly_if_passed: Schema.Boolean,
  publication_disclosure_version: Id,
});
export const WithdrawDanceReviewV1 = Schema.Struct({
  version: Schema.Literal("dance-review-withdraw-v1"),
  operation: Schema.Literal("withdraw"),
  ...request,
});
export const RecordDanceOwnerVerdictV1 = Schema.Struct({
  version: Schema.Literal("dance-owner-verdict-attestation-v1"),
  operation: Schema.Literal("verdict"),
  ...request,
  verdict: Schema.Literals(["passed", "not_passed"]),
});
export const DanceReviewCommandV1 = Schema.Union([
  SubmitDanceReviewV1,
  UpdateDanceReviewVisibilityV1,
  WithdrawDanceReviewV1,
  RecordDanceOwnerVerdictV1,
]);
export type DanceReviewCommandV1 = typeof DanceReviewCommandV1.Type;
export const decodeDanceReviewCommandV1 = Schema.decodeUnknownSync(DanceReviewCommandV1, {
  onExcessProperty: "error",
});

/** Internal task DTO, never accepted by the account command decoder. Authority
 * and all evidence are resolved by an authenticated worker port, not this body. */
export const DanceReviewTaskV1 = Schema.Union([
  Schema.Struct({
    version: Schema.Literal("dance-review-task-v1"),
    operation: Schema.Literals(["screen", "expire", "erase"]),
    ...request,
  }),
  Schema.Struct({
    version: Schema.Literal("dance-review-task-v1"),
    operation: Schema.Literal("publication_failed"),
    ...request,
    handoff_generation: Revision,
  }),
]);
export type DanceReviewTaskV1 = typeof DanceReviewTaskV1.Type;
export const decodeDanceReviewTaskV1 = Schema.decodeUnknownSync(DanceReviewTaskV1, {
  onExcessProperty: "error",
});

export const DanceReviewPrivateResultV1 = Schema.Struct({
  version: Schema.Literal("dance-private-review-v1"),
  review_id: Id,
  session_id: Id,
  attempt_id: Id,
  community_id: Id,
  song_post_id: Id,
  audio_revision: Revision,
  choreography_id: Id,
  choreography_revision: Revision,
  segment_id: Id,
  review_revision: Revision,
  session_terms_hash: Hash,
  qualification_policy_version: Id,
  qualification_policy_hash: Hash,
  captured_policy: Schema.Struct({
    version: Schema.Literal("moderator-review-policy-v1"),
    hash: Hash,
    rubric_version: Id,
    rubric_hash: Hash,
    normalization_version: Id,
    normalization_hash: Hash,
    safety_hash: Hash,
    retention_hash: Hash,
    admission: Schema.Literals(["shadow", "streak_admitted", "money_admitted"]),
    admission_version: Id,
    admission_hash: Hash,
  }),
  state: Schema.Literals([
    "uploaded",
    "screening",
    "awaiting_review",
    "reviewed",
    "review_expired",
    "withdrawn",
    "held",
    "expired",
    "abandoned",
    "processing_failed",
  ]),
  uploaded_at: Instant,
  submitted_at: Schema.NullOr(Instant),
  review_deadline: Instant,
  terminal_at: Schema.NullOr(Instant),
  verdict: Schema.NullOr(Schema.Literals(["passed", "not_passed"])),
  score_bps: Schema.Null,
  qualification_ref: Schema.NullOr(Id),
  cue_attestation: Schema.NullOr(Schema.Literals(["affirmed", "not_attested"])),
  initial_submit_receipt: Schema.NullOr(
    Schema.Struct({
      receipt_id: Id,
      show_publicly_if_passed: Schema.Boolean,
      publication_disclosure_version: Id,
      submitted_at: Instant,
    }),
  ),
  show_publicly_if_passed: Schema.NullOr(Schema.Boolean),
  publication_choice_revision: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  publication_status: Schema.Literals(["none", "staged", "cancelled", "pending", "failed"]),
  publication_revision: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
}).check(
  Schema.makeFilter((r) => {
    const pending = r.state === "screening" || r.state === "awaiting_review";
    const terminal = !pending && r.state !== "uploaded";
    if (Date.parse(r.review_deadline) !== Date.parse(r.uploaded_at) + 7 * 24 * 60 * 60 * 1000)
      return "Invalid fixed review deadline";
    if (
      r.submitted_at !== null &&
      (Date.parse(r.submitted_at) < Date.parse(r.uploaded_at) ||
        Date.parse(r.submitted_at) >= Date.parse(r.review_deadline))
    )
      return "Invalid Submit time";
    if (
      r.terminal_at !== null &&
      (Date.parse(r.terminal_at) < Date.parse(r.uploaded_at) ||
        (r.submitted_at !== null && Date.parse(r.terminal_at) < Date.parse(r.submitted_at)))
    )
      return "Invalid terminal time";
    if (
      (pending || r.state === "reviewed" || r.state === "held") &&
      r.initial_submit_receipt === null
    )
      return "Review requires Submit";
    if (r.state === "uploaded" && r.initial_submit_receipt !== null)
      return "Uploaded is not submitted";
    if (
      r.state === "review_expired" &&
      (r.terminal_at === null || Date.parse(r.terminal_at) < Date.parse(r.review_deadline))
    )
      return "Premature review expiry";
    if ((r.state === "reviewed") !== (r.verdict !== null) || terminal !== (r.terminal_at !== null))
      return "Inconsistent review result";
    if (
      (r.initial_submit_receipt === null) !== (r.submitted_at === null) ||
      (r.initial_submit_receipt === null) !== (r.show_publicly_if_passed === null)
    )
      return "Missing immutable Submit identity";
    if ((r.initial_submit_receipt === null) !== (r.publication_choice_revision === 0))
      return "Invalid choice revision";
    if (r.initial_submit_receipt && r.initial_submit_receipt.submitted_at !== r.submitted_at)
      return "Changed Submit time";
    if (r.qualification_ref !== null && r.verdict !== "passed")
      return "Only an admitted pass may qualify";
    if (
      (r.cue_attestation === "affirmed") !== (r.verdict === "passed") ||
      (r.cue_attestation === "not_attested") !== (r.verdict === "not_passed")
    )
      return "Invalid owner attestation";
    if (
      r.publication_status === "pending" &&
      (r.verdict !== "passed" || r.show_publicly_if_passed !== true)
    )
      return "No conditional release authority";
    if (
      r.publication_status === "failed" &&
      (r.verdict !== "passed" || r.show_publicly_if_passed !== true)
    )
      return "No passed handoff";
    if (r.publication_status === "staged" && (!pending || r.show_publicly_if_passed !== true))
      return "No pending private stage";
    return undefined;
  }),
);
export type DanceReviewPrivateResultV1 = typeof DanceReviewPrivateResultV1.Type;
export const decodeDanceReviewPrivateResultV1 = Schema.decodeUnknownSync(
  DanceReviewPrivateResultV1,
  { onExcessProperty: "error" },
);

export const DanceReviewCommandReceiptV1 = Schema.Struct({
  version: Schema.Literal("dance-review-receipt-v1"),
  receipt_id: Id,
  review_id: Id,
  operation: Schema.Literals([
    "submit",
    "visibility",
    "withdraw",
    "verdict",
    "screen",
    "expire",
    "erase",
    "publication_failed",
  ]),
  outcome: Schema.Literals(["applied", "refused"]),
  refusal_code: Schema.NullOr(Id),
  committed_at: Instant,
  result: DanceReviewPrivateResultV1,
}).check(
  Schema.makeFilter((r) =>
    r.review_id === r.result.review_id && (r.outcome === "applied") === (r.refusal_code === null)
      ? undefined
      : "Inconsistent command receipt",
  ),
);
export type DanceReviewCommandReceiptV1 = typeof DanceReviewCommandReceiptV1.Type;
export const decodeDanceReviewCommandReceiptV1 = Schema.decodeUnknownSync(
  DanceReviewCommandReceiptV1,
  { onExcessProperty: "error" },
);
