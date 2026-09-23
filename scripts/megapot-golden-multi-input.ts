import { Schema } from "effect";

export const RehearsalId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
export const RehearsalInstant = Schema.String.check(
  Schema.makeFilter((value) =>
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
      ? undefined
      : "canonical instant required",
  ),
);
export const RehearsalAtomic = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/u));
const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000000 }));
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const RehearsalParticipant = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,23}$/u)),
  account_id: RehearsalId,
  persona_id: RehearsalId,
  timezone: RehearsalId,
  credential_key: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,40}$/u)),
  preflight_path: RehearsalId,
  activities: Schema.NonEmptyArray(Schema.Literals(["study", "karaoke"])).check(
    Schema.isMaxLength(2),
  ),
  expected_admission: Schema.Literals(["eligible", "verification_missing"]),
  accepted_lyrics: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(20000))),
  karaoke_audio: Schema.optional(
    Schema.Struct({
      pcm_path: RehearsalId,
      sha256: Digest,
      duration_ms: Positive,
      source: Schema.Literal("reviewed_participant_vocal_performance"),
      consent_reference: RehearsalId,
      allow_stored_retention: Schema.Boolean,
    }),
  ),
});
export type RehearsalParticipant = typeof RehearsalParticipant.Type;

export const MultiGoldenInput = Schema.Struct({
  object: Schema.Literal("megapot_base_sepolia_golden_v2"),
  activity_mode: Schema.optional(Schema.Literal("observe_app")),
  run_id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,35}$/u)),
  community_id: RehearsalId,
  post_id: RehearsalId,
  persona_id: RehearsalId,
  audio_revision: Positive,
  lyrics_revision: Positive,
  starts_at: RehearsalInstant,
  ends_at: RehearsalInstant,
  funding_amount_atomic: RehearsalAtomic,
  max_ticket_price_atomic: RehearsalAtomic,
  entry_cutoff_seconds: Positive,
  participants: Schema.Array(RehearsalParticipant).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(8),
  ),
  funding_transaction_hash: Schema.optional(
    Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u)),
  ),
  app_funded_pool: Schema.optional(
    Schema.Struct({
      offer_id: RehearsalId,
      leg_id: RehearsalId,
      funding_effect_id: RehearsalId,
      transaction_hash: Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u)),
      sender_address: Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u)),
    }),
  ),
  authorization: Schema.NullOr(
    Schema.Struct({
      owner_approval_reference: RehearsalId,
      execution_starts_at: RehearsalInstant,
      qualification_deadline: RehearsalInstant,
      reconciliation_deadline: RehearsalInstant,
      max_tickets: Schema.Literal(1),
      max_gas_wei: RehearsalAtomic,
      max_study_submissions: Positive,
      max_karaoke_attempts: Positive,
      max_provider_spend_atomic: RehearsalAtomic,
      provider_budget_reference: RehearsalId,
      http_version: RehearsalId,
      jobs_version: RehearsalId,
      rollback_http_version: RehearsalId,
      rollback_jobs_version: RehearsalId,
      bootstrap_approval_reference: RehearsalId,
      enabled_window_approval_reference: RehearsalId,
    }),
  ),
});
export type MultiGoldenInput = typeof MultiGoldenInput.Type;

export function parseMultiGoldenInput(value: unknown): MultiGoldenInput {
  const input = Schema.decodeUnknownSync(MultiGoldenInput, { onExcessProperty: "error" })(value);
  const positives = input.participants.filter((p) => p.expected_admission === "eligible");
  if (
    new Set(input.participants.map((p) => p.key)).size !== input.participants.length ||
    new Set(input.participants.map((p) => p.account_id)).size !== input.participants.length ||
    new Set(input.participants.map((p) => p.persona_id)).size !== input.participants.length ||
    new Set(input.participants.map((p) => p.credential_key)).size !== input.participants.length ||
    positives.length < 1 ||
    !positives.some((p) => p.activities.includes("study")) ||
    !positives.some((p) => p.activities.includes("karaoke")) ||
    !input.participants.some((p) => p.expected_admission === "verification_missing") ||
    input.participants.some((p) => new Set(p.activities).size !== p.activities.length) ||
    Date.parse(input.starts_at) >= Date.parse(input.ends_at) ||
    (input.app_funded_pool !== undefined && input.funding_transaction_hash !== undefined) ||
    (input.activity_mode === "observe_app" &&
      (!input.app_funded_pool ||
        input.participants.some((p) =>
          p.expected_admission === "verification_missing"
            ? p.activities.length !== 1 || p.activities[0] !== "study" || !p.accepted_lyrics
            : false,
        ))) ||
    (input.activity_mode !== "observe_app" &&
      input.participants.some(
        (p) =>
          (p.activities.includes("study") && !p.accepted_lyrics) ||
          (p.activities.includes("karaoke") && !p.karaoke_audio),
      )) ||
    BigInt(input.max_ticket_price_atomic) < 1n ||
    BigInt(input.funding_amount_atomic) < BigInt(input.max_ticket_price_atomic)
  ) {
    throw new Error("Invalid mixed-participant rehearsal plan.");
  }
  if (input.authorization) {
    const a = input.authorization;
    if (
      Date.parse(a.execution_starts_at) >= Date.parse(a.qualification_deadline) ||
      Date.parse(a.qualification_deadline) >= Date.parse(input.ends_at) ||
      Date.parse(input.ends_at) >= Date.parse(a.reconciliation_deadline) ||
      BigInt(a.max_gas_wei) < 1n ||
      BigInt(a.max_provider_spend_atomic) < 1n ||
      a.max_karaoke_attempts <
        input.participants.filter((p) => p.activities.includes("karaoke")).length
    ) {
      throw new Error("Invalid authorization bounds.");
    }
  }
  return input;
}

export const MultiParticipantPreflight = Schema.Struct({
  object: Schema.Literal("megapot_participant_preflight_v2"),
  checked_at: RehearsalInstant,
  valid_until: RehearsalInstant,
  account_id: RehearsalId,
  persona_id: RehearsalId,
  community_id: RehearsalId,
  post_id: RehearsalId,
  audio_revision: Positive,
  lyrics_revision: Positive,
  wallet_assignment_id: RehearsalId,
  wallet_address: Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u)),
  verification_state: Schema.Literals(["eligible", "verification_missing"]),
  very_evidence: Schema.Array(
    Schema.Struct({
      subject_key_id: RehearsalId,
      binding_event_id: RehearsalId,
      binding_group_id: RehearsalId,
      binding_epoch: Positive,
      evidence_receipt_id: RehearsalId,
      proof_session_id: RehearsalId,
      evidence_hash: Digest,
      personhood_assertion_id: RehearsalId,
      subject_unique_assertion_id: RehearsalId,
      evidence_expires_at: Schema.NullOr(RehearsalInstant),
      ceremony_reference: RehearsalId,
    }),
  ).check(Schema.isMaxLength(1)),
  study_exercise_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  karaoke_revision_id: Schema.NullOr(RehearsalId),
  karaoke_line_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  playback_kind: Schema.NullOr(Schema.Literal("full_mix")),
});
export type MultiParticipantPreflight = typeof MultiParticipantPreflight.Type;

export function assertMultiParticipantPreflight(
  artifact: MultiParticipantPreflight,
  input: MultiGoldenInput,
  participant: RehearsalParticipant,
  now: number,
): void {
  if (
    artifact.account_id !== participant.account_id ||
    artifact.persona_id !== participant.persona_id ||
    artifact.community_id !== input.community_id ||
    artifact.post_id !== input.post_id ||
    artifact.audio_revision !== input.audio_revision ||
    artifact.lyrics_revision !== input.lyrics_revision ||
    Date.parse(artifact.checked_at) > now ||
    Date.parse(artifact.valid_until) <= now ||
    Date.parse(artifact.valid_until) - Date.parse(artifact.checked_at) > 600000 ||
    artifact.verification_state !== participant.expected_admission ||
    artifact.very_evidence.length !== (participant.expected_admission === "eligible" ? 1 : 0) ||
    artifact.very_evidence.some(
      (e) => e.evidence_expires_at !== null && Date.parse(e.evidence_expires_at) <= now,
    ) ||
    (participant.activities.includes("study") && artifact.study_exercise_count < 4) ||
    (participant.activities.includes("karaoke") &&
      (!artifact.karaoke_revision_id ||
        artifact.karaoke_line_count < 5 ||
        artifact.playback_kind !== "full_mix"))
  ) {
    throw new Error("Fresh matching participant preflight required.");
  }
}
