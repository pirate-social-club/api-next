import { Schema } from "effect";

/** JSON syntax is validated by the built-in parser; this lexical pass preserves
 * duplicate-key evidence (including escaped keys) that JSON.parse would discard.
 * Bounds are explicit transport inputs, not economic policy defaults.
 */
export function decodeFundingCommandJsonV2<O extends FundingOperationV2>(
  operation: O,
  text: string,
  bounds: { readonly maxBytes: number; readonly maxDepth: number },
): FundingCommandV2<O> {
  if (
    !Number.isSafeInteger(bounds.maxBytes) ||
    bounds.maxBytes < 1 ||
    !Number.isSafeInteger(bounds.maxDepth) ||
    bounds.maxDepth < 1 ||
    new TextEncoder().encode(text).byteLength > bounds.maxBytes
  )
    throw new TypeError("Invalid JSON bounds");
  const parsed: unknown = JSON.parse(text);
  let i = 0;
  const space = () => {
    while (/\s/u.test(text[i] ?? "") && i < text.length) i++;
  };
  const stringEnd = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") i += 2;
      else if (text[i++] === '"') return text.slice(start, i);
    }
    throw new TypeError("Unterminated string");
  };
  const walk = (depth: number): void => {
    if (depth > bounds.maxDepth) throw new TypeError("JSON depth exceeded");
    space();
    if (text[i] === '"') {
      stringEnd();
      return;
    }
    if (text[i] === "{") {
      i++;
      space();
      const keys = new Set<string>();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        space();
        const key: string = JSON.parse(stringEnd());
        if (keys.has(key)) throw new TypeError("Duplicate JSON key");
        keys.add(key);
        space();
        i++;
        walk(depth + 1);
        space();
        if (text[i++] === "}") return;
      }
    }
    if (text[i] === "[") {
      i++;
      space();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        walk(depth + 1);
        space();
        if (text[i++] === "]") return;
      }
    }
    while (i < text.length && !/[\s,}\]]/u.test(text[i] ?? "")) i++;
  };
  walk(0);
  return decodeFundingCommandV2(operation, parsed);
}

// V5 schema 9ab3097c. Standalone V2 boundary; no endpoint registration or V1 changes.
// Decoders MUST use onExcessProperty:error. Semantic financial proofs live in the application.

export const IdV2 = Schema.String.check(
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject C0/C1 controls as required by the canonical identifier schema.
  Schema.isPattern(/^(?!\s)(?![\s\S]*\s$)[^\u0000-\u001f\u007f-\u009f]+$/u),
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
);
export type IdV2 = typeof IdV2.Type;

export const ContextRequestV2 = Schema.Struct({
  persona_id: IdV2,
});
export type ContextRequestV2 = typeof ContextRequestV2.Type;

export const HashV2 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export type HashV2 = typeof HashV2.Type;

export const InstantV2 = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.makeFilter((v) =>
    Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
      ? undefined
      : "Invalid canonical instant",
  ),
);
export type InstantV2 = typeof InstantV2.Type;

export const RevisionV2 = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 9007199254740991 }),
);
export type RevisionV2 = typeof RevisionV2.Type;

export const EmptyTargetV2 = Schema.Struct({
  community_id: IdV2,
  post_id: IdV2,
  canonical_song_id: IdV2,
  audio_revision: RevisionV2,
  kind: Schema.Literal("empty"),
  slot_id: IdV2,
  slot_generation: RevisionV2,
  offer_id: Schema.Null,
  pool_leg_id: Schema.Null,
});
export type EmptyTargetV2 = typeof EmptyTargetV2.Type;

export const CommittedTargetV2 = Schema.Struct({
  community_id: IdV2,
  post_id: IdV2,
  canonical_song_id: IdV2,
  audio_revision: RevisionV2,
  kind: Schema.Literal("committed"),
  offer_id: IdV2,
  pool_leg_id: IdV2,
});
export type CommittedTargetV2 = typeof CommittedTargetV2.Type;

export const TargetV2 = Schema.Union([EmptyTargetV2, CommittedTargetV2]);
export type TargetV2 = typeof TargetV2.Type;

export const AddressV2 = Schema.String.check(Schema.isPattern(/^0x[a-f0-9]{40}$/u));
export type AddressV2 = typeof AddressV2.Type;

export const OwnedActorV2 = Schema.Struct({
  account_id: IdV2,
  persona_id: IdV2,
  community_id: IdV2,
  wallet_assignment_id: IdV2,
  wallet_index: RevisionV2,
  sender_address: AddressV2,
});
export type OwnedActorV2 = typeof OwnedActorV2.Type;

export const ChainV2 = Schema.Literals([84532, 8453]);
export type ChainV2 = typeof ChainV2.Type;

export const UIntV2 = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,77})$/u)).check(
  Schema.makeFilter((v) => (BigInt(v) < 1n << 256n ? undefined : "Unsigned uint256 overflow")),
);
export type UIntV2 = typeof UIntV2.Type;

export const TxHashV2 = Schema.String.check(Schema.isPattern(/^0x[a-f0-9]{64}$/u));
export type TxHashV2 = typeof TxHashV2.Type;

export const ChainAnchorV2 = Schema.Struct({
  chain_id: ChainV2,
  block_number: UIntV2,
  block_hash: TxHashV2,
  block_timestamp: InstantV2,
  observed_at: InstantV2,
  finality_policy_id: IdV2,
  attestation_id: IdV2,
  attestation_hash: HashV2,
});
export type ChainAnchorV2 = typeof ChainAnchorV2.Type;

export const AtomicV2 = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,77}$/u)).check(
  Schema.makeFilter((v) => (BigInt(v) < 1n << 256n ? undefined : "Atomic uint256 overflow")),
);
export type AtomicV2 = typeof AtomicV2.Type;

export const ScheduleRowV2 = Schema.Struct({
  drawing_id: UIntV2,
  drawing_time: InstantV2,
  entry_cutoff_at: InstantV2,
  purchase_deadline_at: InstantV2,
  price_atomic: AtomicV2,
  price_ceiling_atomic: AtomicV2,
  initialized: Schema.Boolean,
  proof_kind: Schema.Literals(["initialized_state", "attested_recurrence"]),
});
export type ScheduleRowV2 = typeof ScheduleRowV2.Type;

export const ScheduleWitnessV2 = Schema.Struct({
  version: Schema.Literal("song-megapot-schedule-v1"),
  rule_id: IdV2,
  rule_hash: HashV2,
  contract_code_hash: HashV2,
  anchor: ChainAnchorV2,
  cadence_seconds: AtomicV2,
  price_rule_hash: HashV2,
  valid_until: InstantV2,
  rows: Schema.Array(ScheduleRowV2).check(Schema.isMaxLength(30)),
  schedule_witness_id: IdV2,
});
export type ScheduleWitnessV2 = typeof ScheduleWitnessV2.Type;

export const LimitsV2 = Schema.Struct({
  profile_id: IdV2,
  minimum_atomic: AtomicV2,
  maximum_atomic: UIntV2,
  usable_capacity_atomic: UIntV2,
  capacity_revision: RevisionV2,
  max_admitted_effects_per_leg: RevisionV2,
  remaining_effect_slots: RevisionV2,
  account_pending_slots_available: RevisionV2,
  fee_policy_id: IdV2,
  reservation_ttl_seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
  latest_allocation_at: InstantV2,
  reservation_deadline_upper_bound: InstantV2,
});
export type LimitsV2 = typeof LimitsV2.Type;

export const ContextReferenceV2 = Schema.Struct({
  version: Schema.Literal("funding-context-reference-v1"),
  slot_id: IdV2,
  slot_generation: RevisionV2,
  leg_snapshot_id: Schema.Union([IdV2, Schema.Null]),
  schedule_witness_id: IdV2,
  profile_id: IdV2,
  profile_hash: HashV2,
  funding_policy_hash: HashV2,
  wallet_assignment_id: IdV2,
  wallet_assignment_revision: RevisionV2,
  lifecycle_revision: RevisionV2,
});
export type ContextReferenceV2 = typeof ContextReferenceV2.Type;

export const SongTargetV2 = Schema.Struct({
  community_id: IdV2,
  post_id: IdV2,
  canonical_song_id: IdV2,
  audio_revision: RevisionV2,
});
export type SongTargetV2 = typeof SongTargetV2.Type;

export const QualificationTemplateV2 = Schema.Struct({
  template_key: IdV2,
  activity: Schema.Literals(["study", "karaoke", "dance"]),
  grading_family: Schema.Literals(["numeric", "moderator_verdict"]),
  qualification_policy_id: IdV2,
  qualification_policy_hash: HashV2,
  numeric_floor_bps: Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
    Schema.Null,
  ]),
  choreography_scope: Schema.Literals(["not_applicable", "any_policy_accepted"]),
  admission_id: IdV2,
  admission_hash: HashV2,
  disclosure_version: IdV2,
}).check(
  Schema.makeFilter((v) =>
    v.activity === "dance"
      ? v.grading_family === "moderator_verdict" &&
        v.numeric_floor_bps === null &&
        v.choreography_scope === "any_policy_accepted"
        ? undefined
        : "Dance is categorical"
      : v.grading_family === "numeric" && v.choreography_scope === "not_applicable"
        ? undefined
        : "Numeric objective required",
  ),
);
export type QualificationTemplateV2 = typeof QualificationTemplateV2.Type;

export const ProspectiveTermsV2 = Schema.Struct({
  version: Schema.Literal("shared-song-megapot-prospectus-v1"),
  target: SongTargetV2,
  profile_id: IdV2,
  profile_hash: HashV2,
  funding_policy_revision: RevisionV2,
  funding_policy_hash: HashV2,
  reward_policy_template_hash: HashV2,
  start_rule: Schema.Literal("allocation_linearization_time"),
  budget_source: Schema.Literal("leg_budget"),
  empty_behavior: Schema.Literal("no_purchase"),
  eligible_activities: Schema.Tuple([
    Schema.Literal("study"),
    Schema.Literal("karaoke"),
    Schema.Literal("dance"),
  ]),
  dance_scope: Schema.Literal("any_policy_accepted"),
  qualification_templates: Schema.Array(QualificationTemplateV2).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(3),
    Schema.makeFilter((v) =>
      new Set(v.map((x) => JSON.stringify(x))).size === v.length
        ? undefined
        : "Duplicate array item",
    ),
    Schema.makeFilter((v) =>
      ["study", "karaoke", "dance"].every((a) => v.filter((x) => x.activity === a).length === 1)
        ? undefined
        : "Expected one objective per activity",
    ),
  ),
  fixed_ends_at: InstantV2,
  first_drawing_id: UIntV2,
  last_planned_drawing_id: UIntV2,
  planned_drawing_ids: Schema.Array(UIntV2).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  planned_schedule_hash: HashV2,
  ticket_price_ceiling_atomic: AtomicV2,
  disclosure_version: IdV2,
});
export type ProspectiveTermsV2 = typeof ProspectiveTermsV2.Type;

export const EmptyQuoteV2 = Schema.Struct({
  kind: Schema.Literal("prospective"),
  prospective_terms: ProspectiveTermsV2,
  prospective_terms_hash: HashV2,
});
export type EmptyQuoteV2 = typeof EmptyQuoteV2.Type;

export const QualificationBindingV2 = Schema.Struct({
  template_key: IdV2,
  activity: Schema.Literals(["study", "karaoke", "dance"]),
  grading_family: Schema.Literals(["numeric", "moderator_verdict"]),
  qualification_policy_id: IdV2,
  qualification_policy_hash: HashV2,
  numeric_floor_bps: Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
    Schema.Null,
  ]),
  choreography_scope: Schema.Literals(["not_applicable", "any_policy_accepted"]),
  admission_id: IdV2,
  admission_hash: HashV2,
  disclosure_version: IdV2,
  binding_id: IdV2,
  objective_id: IdV2,
  offer_id: IdV2,
  leg_id: IdV2,
}).check(
  Schema.makeFilter((v) =>
    v.activity === "dance"
      ? v.grading_family === "moderator_verdict" &&
        v.numeric_floor_bps === null &&
        v.choreography_scope === "any_policy_accepted"
        ? undefined
        : "Dance is categorical"
      : v.grading_family === "numeric" && v.choreography_scope === "not_applicable"
        ? undefined
        : "Numeric objective required",
  ),
);
export type QualificationBindingV2 = typeof QualificationBindingV2.Type;

export const TermsV2 = Schema.Struct({
  version: Schema.Literal("shared-song-megapot-v2"),
  profile_id: IdV2,
  profile_hash: HashV2,
  terms_hash: HashV2,
  funding_policy_revision: RevisionV2,
  funding_policy_hash: HashV2,
  budget_source: Schema.Literal("leg_budget"),
  empty_behavior: Schema.Literal("no_purchase"),
  eligible_activities: Schema.Tuple([
    Schema.Literal("study"),
    Schema.Literal("karaoke"),
    Schema.Literal("dance"),
  ]),
  dance_scope: Schema.Literal("any_policy_accepted"),
  starts_at: InstantV2,
  ends_at: InstantV2,
  first_drawing_id: UIntV2,
  last_planned_drawing_id: UIntV2,
  ticket_price_ceiling_atomic: AtomicV2,
  disclosure_version: IdV2,
  origin_prospective_terms_hash: HashV2,
  origin_slot_generation: RevisionV2,
  reward_policy_hash: HashV2,
  qualification_bindings: Schema.Array(QualificationBindingV2).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(3),
    Schema.makeFilter((v) =>
      new Set(v.map((x) => JSON.stringify(x))).size === v.length
        ? undefined
        : "Duplicate array item",
    ),
    Schema.makeFilter((v) =>
      ["study", "karaoke", "dance"].every((a) => v.filter((x) => x.activity === a).length === 1)
        ? undefined
        : "Expected one objective per activity",
    ),
  ),
  qualification_bindings_hash: HashV2,
  planned_drawing_ids: Schema.Array(UIntV2).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  planned_schedule_hash: HashV2,
});
export type TermsV2 = typeof TermsV2.Type;

export const ExistingQuoteV2 = Schema.Struct({
  kind: Schema.Literal("committed"),
  committed_terms: TermsV2,
  committed_terms_hash: HashV2,
});
export type ExistingQuoteV2 = typeof ExistingQuoteV2.Type;

export const ContextReadyV2 = Schema.Struct({
  object: Schema.Literal("song_megapot_funding_context"),
  version: Schema.Literal(2),
  readiness: Schema.Literal("ready"),
  context_hash: HashV2,
  context_expires_at: InstantV2,
  lifecycle_revision: RevisionV2,
  target: TargetV2,
  actor: OwnedActorV2,
  schedule: ScheduleWitnessV2,
  limits: LimitsV2,
  chain_id: ChainV2,
  token_address: AddressV2,
  custody_address: AddressV2,
  attestation_id: IdV2,
  fees: Schema.Struct({
    inbound_payer: Schema.Literal("selected_persona_wallet"),
    outbound_policy_id: IdV2,
    gas_ready: Schema.Boolean,
  }),
  context_ref: ContextReferenceV2,
  quote: Schema.Union([EmptyQuoteV2, ExistingQuoteV2]),
  submission_protocol: Schema.Literal("single_fresh_delivery_v1"),
}).check(
  Schema.makeFilter((v) =>
    (v.quote.kind === "prospective") === (v.target.kind === "empty") &&
    (v.quote.kind === "prospective") === (v.context_ref.leg_snapshot_id === null)
      ? undefined
      : "Context branch mismatch",
  ),
);
export type ContextReadyV2 = typeof ContextReadyV2.Type;

export const RelativeHrefV2 = Schema.String.check(
  Schema.isPattern(/^\/communities\/[^?#]+$/u),
  Schema.isMaxLength(1024),
);
export type RelativeHrefV2 = typeof RelativeHrefV2.Type;

export const ContextUnavailableV2 = Schema.Struct({
  object: Schema.Literal("song_megapot_funding_context"),
  version: Schema.Literal(2),
  readiness: Schema.Literal("unavailable"),
  target: TargetV2,
  persona_id: IdV2,
  reason: Schema.Literals([
    "target_persona_required",
    "wallet_not_ready",
    "quota_exhausted",
    "excluded",
    "policy_unavailable",
    "mixed_objective_unavailable",
    "legacy_pool_occupied",
    "schedule_unproven",
    "observation_stale",
    "capacity_exhausted",
    "work_budget_exhausted",
    "gas_unavailable",
    "paused",
    "attestation_unavailable",
    "recovery_required",
  ]),
  retry_after_seconds: Schema.Union([RevisionV2, Schema.Null]),
  own_recovery_href: Schema.Union([RelativeHrefV2, Schema.Null]),
});
export type ContextUnavailableV2 = typeof ContextUnavailableV2.Type;

export const ContextResponseV2 = Schema.Union([ContextReadyV2, ContextUnavailableV2]);
export type ContextResponseV2 = typeof ContextResponseV2.Type;

export const KeyV2 = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
  Schema.isMinLength(16),
  Schema.isMaxLength(128),
);
export type KeyV2 = typeof KeyV2.Type;

export const ProspectiveTermsExpectationV2 = Schema.Struct({
  kind: Schema.Literal("prospective"),
  prospective_terms_hash: HashV2,
});
export type ProspectiveTermsExpectationV2 = typeof ProspectiveTermsExpectationV2.Type;

export const CommittedTermsExpectationV2 = Schema.Struct({
  kind: Schema.Literal("committed"),
  terms_hash: HashV2,
});
export type CommittedTermsExpectationV2 = typeof CommittedTermsExpectationV2.Type;

export const ContributionRequestV2 = Schema.Struct({
  version: Schema.Literal(2),
  idempotency_key: KeyV2,
  persona_id: IdV2,
  funding_amount_atomic: AtomicV2,
  expected_context_hash: HashV2,
  expected_lifecycle_revision: RevisionV2,
  context_ref: ContextReferenceV2,
  expected_terms: Schema.Union([ProspectiveTermsExpectationV2, CommittedTermsExpectationV2]),
}).check(
  Schema.makeFilter((v) =>
    (v.expected_terms.kind === "prospective") === (v.context_ref.leg_snapshot_id === null)
      ? undefined
      : "Quote branch mismatch",
  ),
);
export type ContributionRequestV2 = typeof ContributionRequestV2.Type;

export const ReservationV2 = Schema.Struct({
  reservation_id: IdV2,
  revision: RevisionV2,
  amount_atomic: AtomicV2,
  valid_from_block_exclusive: UIntV2,
  deadline: InstantV2,
  disposition_rule_id: Schema.Literal("receipt-chain-time-v3"),
  nonce_lease_id: IdV2,
});
export type ReservationV2 = typeof ReservationV2.Type;

export const TransferInstructionV2 = Schema.Struct({
  kind: Schema.Literal("erc20_transfer"),
  instruction_hash: HashV2,
  chain_id: ChainV2,
  attestation_id: IdV2,
  attestation_hash: HashV2,
  from: AddressV2,
  to_token: AddressV2,
  recipient_custody: AddressV2,
  value_atomic: Schema.Literal("0"),
  amount_atomic: AtomicV2,
  nonce: UIntV2,
  calldata: Schema.String.check(Schema.isPattern(/^0xa9059cbb[a-f0-9]{128}$/u)),
  wallet_assignment_id: IdV2,
  wallet_index: RevisionV2,
  expires_at: InstantV2,
});
export type TransferInstructionV2 = typeof TransferInstructionV2.Type;

export const ContributionReceiptV2 = Schema.Struct({
  object: Schema.Literal("song_megapot_contribution_command_receipt"),
  version: Schema.Literal(2),
  command_id: IdV2,
  request_hash: HashV2,
  idempotency_key: KeyV2,
  created_at: InstantV2,
  contribution_id: IdV2,
  funding_effect_id: IdV2,
  target: CommittedTargetV2,
  persona_id: IdV2,
  terms_hash: HashV2,
  reservation: ReservationV2,
  instruction: TransferInstructionV2,
  current_state_href: RelativeHrefV2,
  observation_href: RelativeHrefV2,
  recovery_href: RelativeHrefV2,
  accepted_context_hash: HashV2,
  accepted_prospective_terms_hash: Schema.Union([HashV2, Schema.Null]),
  committed_terms: TermsV2,
});
export type ContributionReceiptV2 = typeof ContributionReceiptV2.Type;

export const ObservationRequestV2 = Schema.Struct({
  idempotency_key: KeyV2,
  instruction_hash: HashV2,
  transaction_hash: TxHashV2,
});
export type ObservationRequestV2 = typeof ObservationRequestV2.Type;

export const ObservationReceiptV2 = Schema.Struct({
  object: Schema.Literal("contribution_observation_command_receipt"),
  version: Schema.Literal(2),
  command_id: IdV2,
  request_hash: HashV2,
  contribution_id: IdV2,
  accepted_candidate_hash: TxHashV2,
  current_state_href: RelativeHrefV2,
});
export type ObservationReceiptV2 = typeof ObservationReceiptV2.Type;

export const RecoveryRequestV2 = Schema.Struct({
  idempotency_key: KeyV2,
  expected_state_revision: RevisionV2,
  purpose: Schema.Literal("reconcile_original"),
});
export type RecoveryRequestV2 = typeof RecoveryRequestV2.Type;

export const RecoveryReceiptV2 = Schema.Struct({
  object: Schema.Literal("contribution_recovery_command_receipt"),
  version: Schema.Literal(2),
  command_id: IdV2,
  request_hash: HashV2,
  contribution_id: IdV2,
  work_item_id: IdV2,
  current_state_href: RelativeHrefV2,
  semantics: Schema.Literal("reconcile_only_no_send"),
});
export type RecoveryReceiptV2 = typeof RecoveryReceiptV2.Type;

export const CancellationRequestV2 = Schema.Struct({
  idempotency_key: KeyV2,
  expected_state_revision: RevisionV2,
  purpose: Schema.Literal("cancel_original_nonce"),
});
export type CancellationRequestV2 = typeof CancellationRequestV2.Type;

export const CancellationReceiptV2 = Schema.Struct({
  object: Schema.Literal("contribution_cancellation_command_receipt"),
  version: Schema.Literal(2),
  command_id: IdV2,
  request_hash: HashV2,
  contribution_id: IdV2,
  chain_id: ChainV2,
  sender: AddressV2,
  recipient: AddressV2,
  nonce: UIntV2,
  value_atomic: Schema.Literal("0"),
  data: Schema.Literal("0x"),
  instruction_hash: HashV2,
  current_state_href: RelativeHrefV2,
  purpose: Schema.Literal("nonce_cancellation"),
  preparation_id: IdV2,
  preparation_revision: RevisionV2.check(
    Schema.isBetween({ minimum: 1, maximum: 9007199254740991 }),
  ),
  previous_preparation_id: Schema.Union([IdV2, Schema.Null]),
  previous_preparation_instruction_hash: Schema.Union([HashV2, Schema.Null]),
  prepared_state_revision: RevisionV2,
  prepared_at: InstantV2,
  dispatch_expires_at: InstantV2,
  original_funding_instruction_hash: HashV2,
  recovery_policy_id: IdV2,
  recovery_policy_hash: HashV2,
  recovery_attestation_id: IdV2,
  recovery_attestation_hash: HashV2,
  recovery_attestation_valid_until: InstantV2,
  fee_policy_id: IdV2,
  fee_policy_hash: HashV2,
  wallet_assignment_id: IdV2,
  wallet_index: RevisionV2,
}).check(
  Schema.makeFilter((v) =>
    v.sender === v.recipient &&
    v.prepared_at < v.dispatch_expires_at &&
    (v.preparation_revision === 1
      ? v.previous_preparation_id === null && v.previous_preparation_instruction_hash === null
      : v.previous_preparation_id !== null && v.previous_preparation_instruction_hash !== null)
      ? undefined
      : "Cancellation identity, links or window mismatch",
  ),
);
export type CancellationReceiptV2 = typeof CancellationReceiptV2.Type;

export const CancellationRecoveryPolicyV2 = Schema.Struct({
  object: Schema.Literal("nonce_cancellation_recovery_policy"),
  version: Schema.Literal("nonce-cancellation-recovery-v1"),
  policy_id: IdV2,
  policy_hash: HashV2,
  chain_id: ChainV2,
  valid_from: InstantV2,
  valid_until: InstantV2,
  dispatch_ttl_seconds: RevisionV2.check(
    Schema.isBetween({ minimum: 1, maximum: 9007199254740991 }),
  ),
  max_preparations_per_contribution: RevisionV2.check(
    Schema.isBetween({ minimum: 1, maximum: 9007199254740991 }),
  ),
  fee_policy_id: IdV2,
  fee_policy_hash: HashV2,
  attestation_contract_version: IdV2,
}).check(
  Schema.makeFilter((v) =>
    v.valid_from < v.valid_until ? undefined : "Invalid recovery policy window",
  ),
);
export type CancellationRecoveryPolicyV2 = typeof CancellationRecoveryPolicyV2.Type;

export const SubmissionClaimRequestV2 = Schema.Struct({
  idempotency_key: KeyV2,
  client_instance_id: KeyV2,
  submission_attempt_id: KeyV2,
  purpose: Schema.Literals(["funding_transfer", "nonce_cancellation"]),
  expected_state_revision: RevisionV2,
  instruction_hash: HashV2,
});
export type SubmissionClaimRequestV2 = typeof SubmissionClaimRequestV2.Type;

export const SubmissionClaimReceiptV2 = Schema.Struct({
  object: Schema.Literal("contribution_submission_claim_receipt"),
  version: Schema.Literal(2),
  command_id: IdV2,
  request_hash: HashV2,
  contribution_id: IdV2,
  instruction_hash: HashV2,
  purpose: Schema.Literals(["funding_transfer", "nonce_cancellation"]),
  grant_id: IdV2,
  grant_revision: RevisionV2,
  holder_client_instance_id: KeyV2,
  submission_attempt_id: KeyV2,
  claimed_at: InstantV2,
  valid_until: InstantV2,
  current_state_href: RelativeHrefV2,
  cancellation_preparation_id: Schema.Union([IdV2, Schema.Null]),
  cancellation_preparation_revision: Schema.Union([RevisionV2, Schema.Null]),
}).check(
  Schema.makeFilter((v) =>
    v.purpose === "nonce_cancellation"
      ? v.cancellation_preparation_id !== null &&
        v.cancellation_preparation_revision !== null &&
        v.cancellation_preparation_revision >= 1
        ? undefined
        : "Cancellation plan required"
      : v.cancellation_preparation_id === null && v.cancellation_preparation_revision === null
        ? undefined
        : "Unexpected cancellation plan",
  ),
);
export type SubmissionClaimReceiptV2 = typeof SubmissionClaimReceiptV2.Type;

export const SubmissionDeliveryMetadataV2 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("fresh_grant"),
    replayed: Schema.Literal(false),
  }),
  Schema.Struct({
    kind: Schema.Literal("recovery_only"),
    replayed: Schema.Literal(true),
  }),
]);
export type SubmissionDeliveryMetadataV2 = typeof SubmissionDeliveryMetadataV2.Type;

export const SubmissionClaimDeliveryV2 = Schema.Struct({
  receipt: SubmissionClaimReceiptV2,
  delivery: SubmissionDeliveryMetadataV2,
});
export type SubmissionClaimDeliveryV2 = typeof SubmissionClaimDeliveryV2.Type;

export const ReceiptEvidenceV2 = Schema.Struct({
  chain_id: ChainV2,
  transaction_hash: TxHashV2,
  transfer_log_index: RevisionV2,
  sender_nonce: UIntV2,
  block_number: UIntV2,
  block_hash: TxHashV2,
  block_timestamp: InstantV2,
  first_observed_at: InstantV2,
  finalized_at: Schema.Union([InstantV2, Schema.Null]),
  actual_amount_atomic: AtomicV2,
  attestation_id: IdV2,
});
export type ReceiptEvidenceV2 = typeof ReceiptEvidenceV2.Type;

export const SubmissionStateV2 = Schema.Struct({
  state: Schema.Literals(["unclaimed", "claimed", "finalized"]),
  purpose: Schema.Literals(["funding_transfer", "nonce_cancellation"]),
  grant_id: Schema.Union([IdV2, Schema.Null]),
  grant_revision: RevisionV2,
  holder_client_instance_id: Schema.Union([KeyV2, Schema.Null]),
  submission_attempt_id: Schema.Union([KeyV2, Schema.Null]),
  valid_until: Schema.Union([InstantV2, Schema.Null]),
  cancellation_preparation_id: Schema.Union([IdV2, Schema.Null]),
  cancellation_preparation_revision: Schema.Union([RevisionV2, Schema.Null]),
}).check(
  Schema.makeFilter((v) =>
    v.purpose === "nonce_cancellation"
      ? v.cancellation_preparation_id !== null &&
        v.cancellation_preparation_revision !== null &&
        v.cancellation_preparation_revision >= 1
        ? undefined
        : "Cancellation plan required"
      : v.cancellation_preparation_id === null && v.cancellation_preparation_revision === null
        ? undefined
        : "Unexpected cancellation plan",
  ),
);
export type SubmissionStateV2 = typeof SubmissionStateV2.Type;

export const CancellationPreparationStateV2 = Schema.Struct({
  object: Schema.Literal("contribution_cancellation_preparation_state"),
  state: Schema.Literals(["not_prepared", "prepared", "expired_unclaimed", "claimed", "finalized"]),
  preparations_used: RevisionV2,
  current_preparation_id: Schema.Union([IdV2, Schema.Null]),
  current_preparation_revision: RevisionV2,
  current_receipt: Schema.Union([CancellationReceiptV2, Schema.Null]),
}).check(
  Schema.makeFilter((v) =>
    v.state === "not_prepared"
      ? v.preparations_used === 0 &&
        v.current_preparation_revision === 0 &&
        v.current_preparation_id === null &&
        v.current_receipt === null
        ? undefined
        : "Unexpected plan"
      : v.current_receipt !== null &&
          v.preparations_used >= 1 &&
          v.current_preparation_revision >= 1 &&
          v.current_preparation_id === v.current_receipt.preparation_id &&
          v.current_preparation_revision === v.current_receipt.preparation_revision
        ? undefined
        : "Plan head mismatch",
  ),
);
export type CancellationPreparationStateV2 = typeof CancellationPreparationStateV2.Type;

export const CurrentStateV2 = Schema.Struct({
  object: Schema.Literal("song_megapot_contribution_state"),
  version: Schema.Literal(2),
  contribution_id: IdV2,
  funding_effect_id: IdV2,
  revision: RevisionV2,
  state: Schema.Literals([
    "instruction_issued",
    "submission_claimed",
    "broadcast_unknown",
    "confirming",
    "pool_credited",
    "expired_reconciling",
    "late_principal_owed",
    "refund_pending",
    "refunded",
    "nonce_closed_no_principal",
    "manual_reconciliation_required",
  ]),
  nonce_state: Schema.Literals([
    "reserved_unknown",
    "consumed_transfer",
    "consumed_revert",
    "consumed_cancellation",
    "consumed_other",
    "unresolved",
  ]),
  disposition: Schema.Literals([
    "unresolved",
    "pool_principal",
    "late_principal",
    "no_principal",
    "unattributed_asset",
  ]),
  target: CommittedTargetV2,
  original_persona_id: IdV2,
  original_sender: AddressV2,
  terms_hash: HashV2,
  instruction_hash: HashV2,
  receipt_evidence: Schema.Union([ReceiptEvidenceV2, Schema.Null]),
  pool_credit_atomic: UIntV2,
  late_principal_owed_atomic: UIntV2,
  refund_paid_atomic: UIntV2,
  reservation_capacity_state: Schema.Literals([
    "reserved",
    "consumed_by_pool_credit",
    "released_after_closed_window",
    "released_after_nonce_consumed",
  ]),
  cohort_seal_id: Schema.Union([IdV2, Schema.Null]),
  allowed_actions: Schema.Array(
    Schema.Literals([
      "observe_original",
      "recover_original",
      "prepare_nonce_cancellation",
      "claim_nonce_cancellation",
      "claim_funding_submission",
      "start_fresh_contribution",
      "wait",
      "contact_support",
    ]),
  ).check(
    Schema.isMaxLength(8),
    Schema.makeFilter((v) =>
      new Set(v.map((x) => JSON.stringify(x))).size === v.length
        ? undefined
        : "Duplicate array item",
    ),
  ),
  pause_reason: Schema.Union([IdV2, Schema.Null]),
  updated_at: InstantV2,
  submissions: Schema.Array(SubmissionStateV2).check(Schema.isMinLength(0), Schema.isMaxLength(2)),
  command_receipt: ContributionReceiptV2,
  cancellation: CancellationPreparationStateV2,
});
export type CurrentStateV2 = typeof CurrentStateV2.Type;

export const PublicPotSummaryV2 = Schema.Struct({
  object: Schema.Literal("shared_song_megapot_summary"),
  version: Schema.Literal(2),
  target: CommittedTargetV2,
  terms_hash: HashV2,
  ends_at: InstantV2,
  confirmed_pool_atomic: UIntV2,
  availability: Schema.Literals(["ready", "unavailable"]),
  activities: Schema.Tuple([
    Schema.Literal("study"),
    Schema.Literal("karaoke"),
    Schema.Literal("dance"),
  ]),
});
export type PublicPotSummaryV2 = typeof PublicPotSummaryV2.Type;

export const ErrorV2 = Schema.Struct({
  object: Schema.Literal("contribution_error"),
  version: Schema.Literal(2),
  code: Schema.Literals([
    "invalid_request",
    "unauthenticated",
    "forbidden",
    "not_found",
    "origin_rejected",
    "csrf_rejected",
    "idempotency_conflict",
    "context_stale",
    "terms_mismatch",
    "lifecycle_changed",
    "persona_not_owned",
    "persona_wrong_community",
    "wallet_not_ready",
    "wallet_nonce_busy",
    "quota_exhausted",
    "account_excluded",
    "policy_unavailable",
    "mixed_objective_unavailable",
    "legacy_pool_incompatible",
    "schedule_unproven",
    "observation_stale",
    "price_changed",
    "cutoff_passed",
    "amount_below_minimum",
    "capacity_exhausted",
    "effect_limit",
    "attempt_limit",
    "rate_limited",
    "work_budget_exhausted",
    "gas_budget_unavailable",
    "paused",
    "attestation_unavailable",
    "instruction_expired",
    "recovery_required",
    "receipt_mismatch",
    "outcome_unknown",
    "reward_policy_fields_retired",
    "quote_expired",
    "quote_mismatch",
    "quote_reference_invalid",
    "submission_already_claimed",
    "durable_recovery_unavailable",
    "cancellation_plan_stale",
    "cancellation_plan_expired",
    "cancellation_recovery_unavailable",
    "cancellation_preparation_limit",
  ]),
  request_id: IdV2,
  retry_after_seconds: Schema.Union([RevisionV2, Schema.Null]),
  current_state_href: Schema.Union([RelativeHrefV2, Schema.Null]),
  refusal_receipt: Schema.Union([
    Schema.Struct({
      command_id: IdV2,
      request_hash: HashV2,
      allocation: Schema.Literal("none"),
      instruction_issued: Schema.Literal(false),
    }),
    Schema.Null,
  ]),
});
export type ErrorV2 = typeof ErrorV2.Type;

export function projectSongTarget(value: SongTargetV2): unknown {
  return [
    ["community_id", value.community_id],
    ["post_id", value.post_id],
    ["canonical_song_id", value.canonical_song_id],
    ["audio_revision", value.audio_revision],
  ];
}

export function projectCommittedTarget(value: CommittedTargetV2): unknown {
  return [
    ["community_id", value.community_id],
    ["post_id", value.post_id],
    ["canonical_song_id", value.canonical_song_id],
    ["audio_revision", value.audio_revision],
    ["kind", value.kind],
    ["offer_id", value.offer_id],
    ["pool_leg_id", value.pool_leg_id],
  ];
}

export function projectEmptyTarget(value: EmptyTargetV2): unknown {
  return [
    ["community_id", value.community_id],
    ["post_id", value.post_id],
    ["canonical_song_id", value.canonical_song_id],
    ["audio_revision", value.audio_revision],
    ["kind", value.kind],
    ["slot_id", value.slot_id],
    ["slot_generation", value.slot_generation],
    ["offer_id", value.offer_id],
    ["pool_leg_id", value.pool_leg_id],
  ];
}

export function projectTarget(value: TargetV2): unknown {
  return value.kind === "empty" ? projectEmptyTarget(value) : projectCommittedTarget(value);
}

export function projectOwnedActor(value: OwnedActorV2): unknown {
  return [
    ["account_id", value.account_id],
    ["persona_id", value.persona_id],
    ["community_id", value.community_id],
    ["wallet_assignment_id", value.wallet_assignment_id],
    ["wallet_index", value.wallet_index],
    ["sender_address", value.sender_address],
  ];
}

export function projectContextReference(value: ContextReferenceV2): unknown {
  return [
    ["version", value.version],
    ["slot_id", value.slot_id],
    ["slot_generation", value.slot_generation],
    ["leg_snapshot_id", value.leg_snapshot_id],
    ["schedule_witness_id", value.schedule_witness_id],
    ["profile_id", value.profile_id],
    ["profile_hash", value.profile_hash],
    ["funding_policy_hash", value.funding_policy_hash],
    ["wallet_assignment_id", value.wallet_assignment_id],
    ["wallet_assignment_revision", value.wallet_assignment_revision],
    ["lifecycle_revision", value.lifecycle_revision],
  ];
}

export function projectProspectiveTermsExpectation(value: ProspectiveTermsExpectationV2): unknown {
  return [
    ["kind", value.kind],
    ["prospective_terms_hash", value.prospective_terms_hash],
  ];
}

export function projectCommittedTermsExpectation(value: CommittedTermsExpectationV2): unknown {
  return [
    ["kind", value.kind],
    ["terms_hash", value.terms_hash],
  ];
}

export function projectQualificationTemplate(value: QualificationTemplateV2): unknown {
  return [
    ["template_key", value.template_key],
    ["activity", value.activity],
    ["grading_family", value.grading_family],
    ["qualification_policy_id", value.qualification_policy_id],
    ["qualification_policy_hash", value.qualification_policy_hash],
    ["numeric_floor_bps", value.numeric_floor_bps],
    ["choreography_scope", value.choreography_scope],
    ["admission_id", value.admission_id],
    ["admission_hash", value.admission_hash],
    ["disclosure_version", value.disclosure_version],
  ];
}

export function projectQualificationBinding(value: QualificationBindingV2): unknown {
  return [
    ["template_key", value.template_key],
    ["activity", value.activity],
    ["grading_family", value.grading_family],
    ["qualification_policy_id", value.qualification_policy_id],
    ["qualification_policy_hash", value.qualification_policy_hash],
    ["numeric_floor_bps", value.numeric_floor_bps],
    ["choreography_scope", value.choreography_scope],
    ["admission_id", value.admission_id],
    ["admission_hash", value.admission_hash],
    ["disclosure_version", value.disclosure_version],
    ["binding_id", value.binding_id],
    ["objective_id", value.objective_id],
    ["offer_id", value.offer_id],
    ["leg_id", value.leg_id],
  ];
}

export function projectContributionRequest(value: ContributionRequestV2): unknown {
  return [
    ["version", value.version],
    ["idempotency_key", value.idempotency_key],
    ["persona_id", value.persona_id],
    ["funding_amount_atomic", value.funding_amount_atomic],
    ["expected_context_hash", value.expected_context_hash],
    ["expected_lifecycle_revision", value.expected_lifecycle_revision],
    ["context_ref", projectContextReference(value.context_ref)],
    [
      "expected_terms",
      value.expected_terms.kind === "prospective"
        ? projectProspectiveTermsExpectation(value.expected_terms)
        : projectCommittedTermsExpectation(value.expected_terms),
    ],
  ];
}

export function projectSubmissionClaimRequest(value: SubmissionClaimRequestV2): unknown {
  return [
    ["idempotency_key", value.idempotency_key],
    ["client_instance_id", value.client_instance_id],
    ["submission_attempt_id", value.submission_attempt_id],
    ["purpose", value.purpose],
    ["expected_state_revision", value.expected_state_revision],
    ["instruction_hash", value.instruction_hash],
  ];
}

export function projectObservationRequest(value: ObservationRequestV2): unknown {
  return [
    ["idempotency_key", value.idempotency_key],
    ["instruction_hash", value.instruction_hash],
    ["transaction_hash", value.transaction_hash],
  ];
}

export function projectRecoveryRequest(value: RecoveryRequestV2): unknown {
  return [
    ["idempotency_key", value.idempotency_key],
    ["expected_state_revision", value.expected_state_revision],
    ["purpose", value.purpose],
  ];
}

export function projectCancellationRequest(value: CancellationRequestV2): unknown {
  return [
    ["idempotency_key", value.idempotency_key],
    ["expected_state_revision", value.expected_state_revision],
    ["purpose", value.purpose],
  ];
}

export function projectProspectiveTerms(value: ProspectiveTermsV2): unknown {
  return [
    ["version", value.version],
    ["target", projectSongTarget(value.target)],
    ["profile_id", value.profile_id],
    ["profile_hash", value.profile_hash],
    ["funding_policy_revision", value.funding_policy_revision],
    ["funding_policy_hash", value.funding_policy_hash],
    ["reward_policy_template_hash", value.reward_policy_template_hash],
    ["start_rule", value.start_rule],
    ["budget_source", value.budget_source],
    ["empty_behavior", value.empty_behavior],
    ["eligible_activities", value.eligible_activities],
    ["dance_scope", value.dance_scope],
    [
      "qualification_templates",
      value.qualification_templates.map((item) => projectQualificationTemplate(item)),
    ],
    ["fixed_ends_at", value.fixed_ends_at],
    ["first_drawing_id", value.first_drawing_id],
    ["last_planned_drawing_id", value.last_planned_drawing_id],
    ["planned_drawing_ids", value.planned_drawing_ids.map((item) => item)],
    ["planned_schedule_hash", value.planned_schedule_hash],
    ["ticket_price_ceiling_atomic", value.ticket_price_ceiling_atomic],
    ["disclosure_version", value.disclosure_version],
  ];
}

export function projectTerms(value: TermsV2): unknown {
  return [
    ["version", value.version],
    ["profile_id", value.profile_id],
    ["profile_hash", value.profile_hash],
    ["terms_hash", value.terms_hash],
    ["funding_policy_revision", value.funding_policy_revision],
    ["funding_policy_hash", value.funding_policy_hash],
    ["budget_source", value.budget_source],
    ["empty_behavior", value.empty_behavior],
    ["eligible_activities", value.eligible_activities],
    ["dance_scope", value.dance_scope],
    ["starts_at", value.starts_at],
    ["ends_at", value.ends_at],
    ["first_drawing_id", value.first_drawing_id],
    ["last_planned_drawing_id", value.last_planned_drawing_id],
    ["ticket_price_ceiling_atomic", value.ticket_price_ceiling_atomic],
    ["disclosure_version", value.disclosure_version],
    ["origin_prospective_terms_hash", value.origin_prospective_terms_hash],
    ["origin_slot_generation", value.origin_slot_generation],
    ["reward_policy_hash", value.reward_policy_hash],
    [
      "qualification_bindings",
      value.qualification_bindings.map((item) => projectQualificationBinding(item)),
    ],
    ["qualification_bindings_hash", value.qualification_bindings_hash],
    ["planned_drawing_ids", value.planned_drawing_ids.map((item) => item)],
    ["planned_schedule_hash", value.planned_schedule_hash],
  ];
}

export function projectCancellationRecoveryPolicy(value: CancellationRecoveryPolicyV2): unknown {
  return [
    ["object", value.object],
    ["version", value.version],
    ["policy_id", value.policy_id],
    ["policy_hash", value.policy_hash],
    ["chain_id", value.chain_id],
    ["valid_from", value.valid_from],
    ["valid_until", value.valid_until],
    ["dispatch_ttl_seconds", value.dispatch_ttl_seconds],
    ["max_preparations_per_contribution", value.max_preparations_per_contribution],
    ["fee_policy_id", value.fee_policy_id],
    ["fee_policy_hash", value.fee_policy_hash],
    ["attestation_contract_version", value.attestation_contract_version],
  ];
}

export const fundingCommandSchemasV2 = {
  CreateSongMegapotContributionV2: ContributionRequestV2,
  ClaimSongMegapotContributionSubmissionV2: SubmissionClaimRequestV2,
  ObserveSongMegapotContributionV2: ObservationRequestV2,
  RecoverSongMegapotContributionV2: RecoveryRequestV2,
  PrepareSongMegapotContributionCancellationV2: CancellationRequestV2,
};
export type FundingOperationV2 = keyof typeof fundingCommandSchemasV2;
export type FundingCommandV2<O extends FundingOperationV2> =
  (typeof fundingCommandSchemasV2)[O]["Type"];
export function decodeFundingCommandV2<O extends FundingOperationV2>(
  operation: O,
  body: unknown,
): FundingCommandV2<O> {
  return Schema.decodeUnknownSync(fundingCommandSchemasV2[operation], {
    onExcessProperty: "error",
  })(body) as FundingCommandV2<O>;
}
export function fundingHashPreimageV2(domain: string, payload: unknown): string {
  return JSON.stringify([domain, payload]);
}
export function fundingCommandPreimageV2<O extends FundingOperationV2>(
  operation: O,
  accountId: string,
  communityId: string,
  postId: string,
  contributionId: string | null,
  body: FundingCommandV2<O>,
): string {
  Schema.decodeUnknownSync(IdV2)(accountId);
  Schema.decodeUnknownSync(IdV2)(communityId);
  Schema.decodeUnknownSync(IdV2)(postId);
  if ((operation === "CreateSongMegapotContributionV2") !== (contributionId === null))
    throw new TypeError("Invalid command path");
  if (contributionId !== null) Schema.decodeUnknownSync(IdV2)(contributionId);
  const decoded = decodeFundingCommandV2(operation, body);
  let pairs: unknown;
  switch (operation) {
    case "CreateSongMegapotContributionV2":
      pairs = projectContributionRequest(decoded as ContributionRequestV2);
      break;
    case "ClaimSongMegapotContributionSubmissionV2":
      pairs = projectSubmissionClaimRequest(decoded as SubmissionClaimRequestV2);
      break;
    case "ObserveSongMegapotContributionV2":
      pairs = projectObservationRequest(decoded as ObservationRequestV2);
      break;
    case "RecoverSongMegapotContributionV2":
      pairs = projectRecoveryRequest(decoded as RecoveryRequestV2);
      break;
    case "PrepareSongMegapotContributionCancellationV2":
      pairs = projectCancellationRequest(decoded as CancellationRequestV2);
      break;
  }
  return fundingHashPreimageV2("pirate.song-megapot-command.v2", [
    operation,
    accountId,
    communityId,
    postId,
    contributionId,
    pairs,
  ]);
}

export function prospectiveTermsPreimageV2(value: ProspectiveTermsV2): string {
  const v = Schema.decodeUnknownSync(ProspectiveTermsV2, { onExcessProperty: "error" })(value);
  return fundingHashPreimageV2("pirate.shared-song-megapot-prospectus.v1", [
    ["version", v.version],
    ["target", projectSongTarget(v.target)],
    ["profile_id", v.profile_id],
    ["profile_hash", v.profile_hash],
    ["funding_policy_revision", v.funding_policy_revision],
    ["funding_policy_hash", v.funding_policy_hash],
    ["reward_policy_template_hash", v.reward_policy_template_hash],
    ["start_rule", v.start_rule],
    ["budget_source", v.budget_source],
    ["empty_behavior", v.empty_behavior],
    ["eligible_activities", v.eligible_activities],
    ["dance_scope", v.dance_scope],
    [
      "qualification_templates",
      v.qualification_templates.map((item) => projectQualificationTemplate(item)),
    ],
    ["fixed_ends_at", v.fixed_ends_at],
    ["first_drawing_id", v.first_drawing_id],
    ["last_planned_drawing_id", v.last_planned_drawing_id],
    ["planned_drawing_ids", v.planned_drawing_ids.map((item) => item)],
    ["planned_schedule_hash", v.planned_schedule_hash],
    ["ticket_price_ceiling_atomic", v.ticket_price_ceiling_atomic],
    ["disclosure_version", v.disclosure_version],
  ]);
}
export function committedTermsPreimageV2(value: TermsV2): string {
  const v = Schema.decodeUnknownSync(TermsV2, { onExcessProperty: "error" })(value);
  return fundingHashPreimageV2("pirate.shared-song-megapot-terms.v2", [
    ["version", v.version],
    ["profile_id", v.profile_id],
    ["profile_hash", v.profile_hash],
    ["funding_policy_revision", v.funding_policy_revision],
    ["funding_policy_hash", v.funding_policy_hash],
    ["budget_source", v.budget_source],
    ["empty_behavior", v.empty_behavior],
    ["eligible_activities", v.eligible_activities],
    ["dance_scope", v.dance_scope],
    ["starts_at", v.starts_at],
    ["ends_at", v.ends_at],
    ["first_drawing_id", v.first_drawing_id],
    ["last_planned_drawing_id", v.last_planned_drawing_id],
    ["ticket_price_ceiling_atomic", v.ticket_price_ceiling_atomic],
    ["disclosure_version", v.disclosure_version],
    ["origin_prospective_terms_hash", v.origin_prospective_terms_hash],
    ["origin_slot_generation", v.origin_slot_generation],
    ["reward_policy_hash", v.reward_policy_hash],
    ["qualification_bindings_hash", v.qualification_bindings_hash],
    ["planned_drawing_ids", v.planned_drawing_ids.map((item) => item)],
    ["planned_schedule_hash", v.planned_schedule_hash],
  ]);
}
export function cancellationInstructionPreimageV2(v: CancellationReceiptV2): string {
  return fundingHashPreimageV2("pirate.song-megapot-nonce-cancellation.v2", [
    v.command_id,
    v.request_hash,
    v.contribution_id,
    v.preparation_id,
    v.preparation_revision,
    v.previous_preparation_id,
    v.previous_preparation_instruction_hash,
    v.prepared_state_revision,
    v.original_funding_instruction_hash,
    v.recovery_policy_id,
    v.recovery_policy_hash,
    v.recovery_attestation_id,
    v.recovery_attestation_hash,
    v.recovery_attestation_valid_until,
    v.fee_policy_id,
    v.fee_policy_hash,
    v.prepared_at,
    v.dispatch_expires_at,
    v.chain_id,
    v.sender,
    v.recipient,
    v.wallet_assignment_id,
    v.wallet_index,
    v.nonce,
    v.value_atomic,
    v.data,
  ]);
}
export function cancellationPolicyPreimageV2(v: CancellationRecoveryPolicyV2): string {
  return fundingHashPreimageV2("pirate.nonce-cancellation-recovery-policy.v1", [
    ["object", v.object],
    ["version", v.version],
    ["policy_id", v.policy_id],
    ["chain_id", v.chain_id],
    ["valid_from", v.valid_from],
    ["valid_until", v.valid_until],
    ["dispatch_ttl_seconds", v.dispatch_ttl_seconds],
    ["max_preparations_per_contribution", v.max_preparations_per_contribution],
    ["fee_policy_id", v.fee_policy_id],
    ["fee_policy_hash", v.fee_policy_hash],
    ["attestation_contract_version", v.attestation_contract_version],
  ]);
}
