import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RetryableConflict,
} from "./errors.ts";
import { PersonaIdV1 } from "./personas.ts";
import {
  KaraokeQualificationPolicyV1,
  KaraokeQualificationPolicyV2,
  StudyQualificationPolicyV1,
} from "./rewards-qualification.ts";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u));
const TransactionHash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));
const Bytes32 = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const AtomicAmount = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
const TokenSymbol = Schema.NonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.makeFilter((value) =>
    value === value.trim() && new TextEncoder().encode(value).byteLength <= 32
      ? undefined
      : "Expected a trimmed token symbol of at most 32 UTF-8 bytes",
  ),
);
const AssetPolicyVersion = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value) =>
    value === value.trim() && new TextEncoder().encode(value).byteLength <= 128
      ? undefined
      : "Expected a trimmed asset policy version of at most 128 UTF-8 bytes",
  ),
);
const NonNegativeAtomicAmount = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u));
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const ScoreBps = Schema.Int.check(Schema.isBetween({ minimum: 7_000, maximum: 10_000 }));
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);

export const SongRewardOfferStatusV1 = Schema.Literals([
  "draft",
  "active",
  "paused",
  "exhausted",
  "expired",
  "ended",
  "operational_hold",
]);
export const MegapotPoolLegStatusV1 = Schema.Literals([
  "draft",
  "funding",
  "active",
  "paused",
  "exhausted",
  "ended",
  "operational_hold",
]);
export const MegapotFundingStatusV1 = Schema.Literals([
  "planned",
  "confirming",
  "confirmed",
  "reverted",
  "reconciliation_required",
]);
export const RewardActivityV1 = Schema.Literals(["study", "karaoke"]);

export const RewardQualificationPoliciesV1 = Schema.NonEmptyArray(
  Schema.Union([
    Schema.Struct({ activity: Schema.Literal("study"), policy: StudyQualificationPolicyV1 }),
    Schema.Struct({
      activity: Schema.Literal("karaoke"),
      policy: Schema.Union([KaraokeQualificationPolicyV1, KaraokeQualificationPolicyV2]),
    }),
  ]),
).check(
  Schema.isMaxLength(2),
  Schema.makeFilter((policies) =>
    new Set(policies.map((entry) => entry.activity)).size === policies.length
      ? undefined
      : "Duplicate activity policy",
  ),
);
export type RewardQualificationPoliciesV1 = Schema.Schema.Type<
  typeof RewardQualificationPoliciesV1
>;
const ExpectedQualificationPolicyVersions = Schema.Struct({
  study: Schema.optionalKey(Identifier),
  karaoke: Schema.optionalKey(Identifier),
});

export const SongRewardOfferV1 = Schema.Struct({
  object: Schema.Literal("song_reward_offer"),
  offer_id: Identifier,
  community_id: Identifier,
  post_id: Identifier,
  audio_revision: PositiveInteger,
  status: SongRewardOfferStatusV1,
  starts_at: CanonicalInstant,
  ends_at: CanonicalInstant,
  terms_hash: Sha256,
});
export type SongRewardOfferV1 = Schema.Schema.Type<typeof SongRewardOfferV1>;

export const MegapotPoolLegV1 = Schema.Struct({
  object: Schema.Literal("megapot_pool_leg"),
  leg_id: Identifier,
  offer_id: Identifier,
  status: MegapotPoolLegStatusV1,
  chain_id: Schema.Literal(84_532),
  token_address: Address,
  token_decimals: Schema.Literal(6),
  custody_address: Address,
  max_ticket_price_atomic: AtomicAmount,
  entry_cutoff_seconds: PositiveInteger,
  participation_starts_drawing_id: NonNegativeAtomicAmount,
  eligible_activities: Schema.NonEmptyArray(RewardActivityV1).check(Schema.isMaxLength(2)),
  min_score_bps: ScoreBps,
  empty_pool_policy: Schema.Literals(["no_purchase", "funder_fallback"]),
  fallback_payout_persona_id: Schema.NullOr(PersonaIdV1),
  funded_atomic: NonNegativeAtomicAmount,
  leg_terms_hash: Bytes32,
  qualification_policies: Schema.NullOr(RewardQualificationPoliciesV1),
});
export type MegapotPoolLegV1 = Schema.Schema.Type<typeof MegapotPoolLegV1>;

export const MegapotFundingV1 = Schema.Struct({
  object: Schema.Literal("megapot_pool_funding"),
  action: Schema.Literal("fund_with_usdc"),
  funding_effect_id: Identifier,
  leg_id: Identifier,
  status: MegapotFundingStatusV1,
  chain_id: Schema.Literal(84_532),
  token_address: Address,
  token_decimals: Schema.Literal(6),
  sender_address: Address,
  recipient_address: Address,
  expected_amount_atomic: AtomicAmount,
  confirmed_amount_atomic: Schema.NullOr(AtomicAmount),
  required_confirmations: PositiveInteger,
  transaction_hash: Schema.NullOr(TransactionHash),
});
export type MegapotFundingV1 = Schema.Schema.Type<typeof MegapotFundingV1>;

export const AssetBonusLegV1 = Schema.Struct({
  object: Schema.Literal("asset_bonus_leg"),
  leg_id: Identifier,
  offer_id: Identifier,
  status: MegapotPoolLegStatusV1,
  chain_id: Schema.Literal(84_532),
  token_address: Address,
  token_decimals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 77 })),
  token_symbol: TokenSymbol,
  asset_policy_version: AssetPolicyVersion,
  custody_address: Address,
  amount_per_claim_atomic: AtomicAmount,
  max_claims: PositiveInteger,
  funded_atomic: NonNegativeAtomicAmount,
  fulfilled_atomic: NonNegativeAtomicAmount,
  leg_terms_hash: Bytes32,
  qualification_policies: Schema.NullOr(RewardQualificationPoliciesV1),
});
export type AssetBonusLegV1 = Schema.Schema.Type<typeof AssetBonusLegV1>;

export const AssetBonusFundingV1 = Schema.Struct({
  object: Schema.Literal("asset_bonus_funding"),
  action: Schema.Literal("fund_with_asset"),
  funding_effect_id: Identifier,
  leg_id: Identifier,
  status: MegapotFundingStatusV1,
  chain_id: Schema.Literal(84_532),
  token_address: Address,
  token_decimals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 77 })),
  sender_address: Address,
  recipient_address: Address,
  expected_amount_atomic: AtomicAmount,
  confirmed_amount_atomic: Schema.NullOr(AtomicAmount),
  required_confirmations: PositiveInteger,
  transaction_hash: Schema.NullOr(TransactionHash),
});
export type AssetBonusFundingV1 = Schema.Schema.Type<typeof AssetBonusFundingV1>;

export const MegapotPoolDrawingLifecycleStatusV1 = Schema.Literals([
  "entry_open",
  "cutoff_frozen",
  "committed",
  "purchase_pending",
  "tickets_confirmed",
  "drawing_pending",
  "no_win",
  "winnings_detected",
  "claim_pending",
  "claimed",
  "allocated",
  "credited",
  "closed_no_entries",
  "closed_unfunded",
  "closed_fallback_ineligible",
  "closed_fallback_unavailable",
  "closed_fallback_ceiling",
  "operational_hold",
]);

export const MegapotPoolProjectionStateV1 = Schema.Literals([
  "funding",
  "awaiting_drawing",
  "entry_open",
  "entry_closed",
  "committed",
  "ticket_purchased",
  "drawing_pending",
  "no_win",
  "won",
  "operational_hold",
]);

const FallbackDisclosureV1 = Schema.NullOr(
  Schema.Literals([
    "If nobody qualifies, the sponsor receives this ticket's net winnings.",
    "If nobody qualifies, the sponsor keeps this ticket and any winnings.",
  ]),
);

export const MegapotPoolDrawingProjectionV1 = Schema.Struct({
  object: Schema.Literal("megapot_pool_drawing_projection"),
  drawing_id: NonNegativeAtomicAmount,
  lifecycle_status: MegapotPoolDrawingLifecycleStatusV1,
  state: MegapotPoolProjectionStateV1,
  entry_cutoff_at: CanonicalInstant,
  beneficiary_count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ticket_price_ceiling_atomic: AtomicAmount,
  actual_ticket_cost_atomic: NonNegativeAtomicAmount,
  gross_prize_pool_atomic: Schema.NullOr(NonNegativeAtomicAmount),
  global_tickets_bought: Schema.NullOr(NonNegativeAtomicAmount),
  prize_pool_observed_at: Schema.NullOr(CanonicalInstant),
  prize_pool_basis: Schema.Literal(
    "gross_observed_before_referral_win_share_terminal_last_observed_pre_rollover",
  ),
  global_tickets_basis: Schema.Literal("drawing_wide_all_megapot_buyers"),
  net_winnings_atomic: NonNegativeAtomicAmount,
  commitment_reference: Schema.NullOr(Schema.NonEmptyString),
  snapshot_hash: Schema.NullOr(Bytes32),
  ticket_id: Schema.NullOr(NonNegativeAtomicAmount),
  purchase_transaction_hash: Schema.NullOr(TransactionHash),
  claim_transaction_hash: Schema.NullOr(TransactionHash),
});
export type MegapotPoolDrawingProjectionV1 = Schema.Schema.Type<
  typeof MegapotPoolDrawingProjectionV1
>;

export const SongMegapotPoolProjectionV1 = Schema.Struct({
  object: Schema.Literal("song_megapot_pool_projection"),
  offer_id: Identifier,
  leg_id: Identifier,
  community_id: Identifier,
  post_id: Identifier,
  offer_status: SongRewardOfferStatusV1,
  leg_status: MegapotPoolLegStatusV1,
  chain_id: Schema.Literal(84_532),
  token_address: Address,
  token_decimals: Schema.Literal(6),
  funded_atomic: NonNegativeAtomicAmount,
  available_budget_atomic: NonNegativeAtomicAmount,
  max_ticket_price_atomic: AtomicAmount,
  entry_cutoff_seconds: PositiveInteger,
  eligible_activities: Schema.NonEmptyArray(RewardActivityV1).check(Schema.isMaxLength(2)),
  min_score_bps: ScoreBps,
  empty_pool_policy: Schema.Literals(["no_purchase", "funder_fallback"]),
  qualification_policies: Schema.NullOr(RewardQualificationPoliciesV1),
  allocation_rule: Schema.Literal("equal_v1"),
  ticket_custody: Schema.Literal("pirate"),
  winnings_basis: Schema.Literal("net_of_referral_win_share"),
  fallback_disclosure: FallbackDisclosureV1,
  drawing: Schema.NullOr(MegapotPoolDrawingProjectionV1),
});
export type SongMegapotPoolProjectionV1 = Schema.Schema.Type<typeof SongMegapotPoolProjectionV1>;

export const MegapotParticipantStandingStateV1 = Schema.Literals([
  "entry_open",
  "entry_closed",
  "your_share_held",
  "committed",
  "ticket_purchased",
  "drawing_pending",
  "no_win",
  "won",
  "payout_pending",
  "sent",
  "operational_hold",
]);

export const MegapotSponsorFallbackStateV1 = Schema.Literals([
  "fallback_active",
  "fallback_displaced",
  "fallback_won",
  "fallback_unavailable",
  "fallback_ceiling",
  "payout_pending",
  "sent",
]);

export const RewardCreditStateV1 = Schema.Literals([
  "credited",
  "payout_reserved",
  "payout_pending",
  "sent",
  "reconciliation_required",
]);

export const SongAssetBonusProjectionV1 = Schema.Struct({
  qualification_policies: Schema.NullOr(RewardQualificationPoliciesV1),
  object: Schema.Literal("song_asset_bonus_projection"),
  offer_id: Identifier,
  leg_id: Identifier,
  community_id: Identifier,
  post_id: Identifier,
  offer_status: SongRewardOfferStatusV1,
  leg_status: MegapotPoolLegStatusV1,
  chain_id: Schema.Literal(84_532),
  token_address: Address,
  token_decimals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 77 })),
  token_symbol: TokenSymbol,
  asset_policy_version: Identifier,
  amount_per_claim_atomic: AtomicAmount,
  max_claims: PositiveInteger,
  claimed_count: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  available_inventory_atomic: NonNegativeAtomicAmount,
  viewer_state: Schema.NullOr(Schema.Literals(["claimable", "already_claimed", "unavailable"])),
  viewer_credit_id: Schema.NullOr(Identifier),
  viewer_credit_state: Schema.NullOr(RewardCreditStateV1),
});
export type SongAssetBonusProjectionV1 = Schema.Schema.Type<typeof SongAssetBonusProjectionV1>;

export const MegapotPoolStandingV1 = Schema.Struct({
  object: Schema.Literal("megapot_pool_standing"),
  leg_id: Identifier,
  drawing_id: Schema.NullOr(NonNegativeAtomicAmount),
  participant_state: MegapotParticipantStandingStateV1,
  share_held: Schema.Boolean,
  share_amount_atomic: Schema.NullOr(AtomicAmount),
  sponsor_fallback_state: Schema.NullOr(MegapotSponsorFallbackStateV1),
  sponsor_fallback_amount_atomic: Schema.NullOr(AtomicAmount),
  reward_credit_id: Schema.NullOr(Identifier),
  reward_credit_state: Schema.NullOr(RewardCreditStateV1),
  beneficiary_count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
});
export type MegapotPoolStandingV1 = Schema.Schema.Type<typeof MegapotPoolStandingV1>;

/** Spec 015 §5.2a. Null on credits that need no claim. */
export const RewardCreditClaimV1 = Schema.Struct({
  status: Schema.Literals(["unclaimed", "accepted", "subject_conflict"]),
  payout_status: Schema.NullOr(
    Schema.Literals(["pending", "recipient_pending", "submitted", "confirmed", "failed_retrying"]),
  ),
});
export type RewardCreditClaimV1 = Schema.Schema.Type<typeof RewardCreditClaimV1>;

/**
 * A winner send's status. retryable: nothing is mined for the record's nonce
 * and the node knows none of its reported hashes (none yet, or all dropped);
 * sign (or re-sign) the transfer with exactly that nonce. pending: the node
 * still knows a reported hash, or something for the nonce is mined but not yet
 * at the required depth. confirmed: the exact transfer succeeded at depth.
 * reverted: a reported transaction reverted at depth, moving nothing; a new
 * POST with a new idempotency key starts a new attempt with a new nonce.
 * settled_unverified: the nonce was consumed at depth by a transaction the
 * server cannot verify; never send again (check the wallet and contact
 * support). Reporting the real hash later still moves it to confirmed when
 * its receipt proves the exact transfer. cancelled: a reported cancellation
 * consumed the nonce at depth, so the transfer can never land; the wallet is
 * free and the credit may start a new send with a new idempotency key.
 */
export const RewardWinnerSendStatusV1 = Schema.Literals([
  "retryable",
  "pending",
  "confirmed",
  "reverted",
  "settled_unverified",
  "cancelled",
]);

/** The credit's onward winner send summary, as last persisted. */
export const RewardCreditSendV1 = Schema.Struct({
  send_id: Identifier,
  status: RewardWinnerSendStatusV1,
});
export type RewardCreditSendV1 = Schema.Schema.Type<typeof RewardCreditSendV1>;

export const RewardCreditV1 = Schema.Struct({
  object: Schema.Literal("reward_credit"),
  credit_id: Identifier,
  payout_persona_id: PersonaIdV1,
  chain_id: PositiveInteger,
  token_address: Address,
  token_decimals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 77 })),
  amount_atomic: AtomicAmount,
  available_atomic: NonNegativeAtomicAmount,
  reserved_atomic: NonNegativeAtomicAmount,
  paid_atomic: NonNegativeAtomicAmount,
  source_kind: Schema.Literals(["megapot_allocation", "asset_bonus", "external_fallback"]),
  state: RewardCreditStateV1,
  created_at: CanonicalInstant,
  updated_at: CanonicalInstant,
  settled_at: Schema.NullOr(CanonicalInstant),
  claim: Schema.NullOr(RewardCreditClaimV1),
  /** Null until the winner records an onward send of a participant credit. */
  send: Schema.NullOr(RewardCreditSendV1),
});
export type RewardCreditV1 = Schema.Schema.Type<typeof RewardCreditV1>;

const CommunityPostPath = Schema.Struct({ communityId: Identifier, postId: Identifier });
const OfferPath = Schema.Struct({ offerId: Identifier });
const FundingPath = Schema.Struct({ legId: Identifier, fundingEffectId: Identifier });
const LegPath = Schema.Struct({ legId: Identifier });
const CommonErrors = [AuthError, BadRequest, Conflict, NotFound, InternalError] as const;

export const OpenSongRewardOffer = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/reward-offers",
  auth: Auth.user(),
  request: {
    path: CommunityPostPath,
    body: Schema.Struct({
      idempotency_key: Identifier,
      persona_id: PersonaIdV1,
      starts_at: CanonicalInstant,
      ends_at: CanonicalInstant,
    }),
  },
  response: Schema.Struct({ offer: SongRewardOfferV1, replayed: Schema.Boolean }),
  successStatus: [200, 201],
  errors: [...CommonErrors, ProviderUnavailable],
});

export const AddMegapotPoolLeg = endpoint({
  method: "POST",
  path: "/reward-offers/:offerId/megapot-pool-legs",
  auth: Auth.user(),
  request: {
    path: OfferPath,
    body: Schema.Struct({
      idempotency_key: Identifier,
      expected_qualification_policy_versions: Schema.optionalKey(
        ExpectedQualificationPolicyVersions,
      ),
      persona_id: PersonaIdV1,
      funding_amount_atomic: AtomicAmount,
      max_ticket_price_atomic: AtomicAmount,
      entry_cutoff_seconds: PositiveInteger,
      eligible_activities: Schema.NonEmptyArray(RewardActivityV1).check(Schema.isMaxLength(2)),
      min_score_bps: ScoreBps,
      empty_pool_policy: Schema.Literals(["no_purchase", "funder_fallback"]),
      fallback_payout_persona_id: Schema.NullOr(PersonaIdV1),
      fallback_disclosure_acknowledged: Schema.Boolean,
    }),
  },
  response: Schema.Struct({
    leg: MegapotPoolLegV1,
    funding: MegapotFundingV1,
    replayed: Schema.Boolean,
  }),
  successStatus: [200, 201],
  errors: [...CommonErrors, ProviderUnavailable],
});

export const AddAssetBonusLeg = endpoint({
  method: "POST",
  path: "/reward-offers/:offerId/asset-bonus-legs",
  auth: Auth.user(),
  request: {
    path: OfferPath,
    body: Schema.Struct({
      idempotency_key: Identifier,
      expected_qualification_policy_versions: Schema.optionalKey(
        ExpectedQualificationPolicyVersions,
      ),
      persona_id: PersonaIdV1,
      funding_amount_atomic: AtomicAmount,
      chain_id: Schema.Literal(84_532),
      token_address: Address,
      token_decimals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 77 })),
      token_symbol: TokenSymbol,
      asset_policy_version: AssetPolicyVersion,
      amount_per_claim_atomic: AtomicAmount,
      max_claims: PositiveInteger,
    }),
  },
  response: Schema.Struct({
    leg: AssetBonusLegV1,
    funding: AssetBonusFundingV1,
    replayed: Schema.Boolean,
  }),
  successStatus: [200, 201],
  errors: [...CommonErrors, ProviderUnavailable],
});

export const ObserveMegapotPoolFunding = endpoint({
  method: "POST",
  path: "/reward-offer-legs/:legId/funding/:fundingEffectId/observations",
  auth: Auth.user(),
  request: {
    path: FundingPath,
    body: Schema.Struct({
      idempotency_key: Identifier,
      persona_id: PersonaIdV1,
      transaction_hash: TransactionHash,
    }),
  },
  response: Schema.Struct({
    funding: MegapotFundingV1,
    replayed: Schema.Boolean,
  }),
  errors: [...CommonErrors, RetryableConflict, ProviderUnavailable],
});

export const GetMegapotPoolFunding = endpoint({
  method: "GET",
  path: "/reward-offer-legs/:legId/funding/:fundingEffectId",
  auth: Auth.user(),
  request: { path: FundingPath },
  response: Schema.Struct({ funding: MegapotFundingV1 }),
  errors: [AuthError, BadRequest, NotFound, InternalError, ProviderUnavailable],
});

export const ObserveAssetBonusFunding = endpoint({
  method: "POST",
  path: "/asset-bonus-legs/:legId/funding/:fundingEffectId/observations",
  auth: Auth.user(),
  request: {
    path: FundingPath,
    body: Schema.Struct({
      idempotency_key: Identifier,
      persona_id: PersonaIdV1,
      transaction_hash: TransactionHash,
    }),
  },
  response: Schema.Struct({
    funding: AssetBonusFundingV1,
    replayed: Schema.Boolean,
  }),
  errors: [...CommonErrors, RetryableConflict, ProviderUnavailable],
});

export const GetAssetBonusFunding = endpoint({
  method: "GET",
  path: "/asset-bonus-legs/:legId/funding/:fundingEffectId",
  auth: Auth.user(),
  request: { path: FundingPath },
  response: Schema.Struct({ funding: AssetBonusFundingV1 }),
  errors: [AuthError, BadRequest, NotFound, InternalError, ProviderUnavailable],
});

export const GetSongMegapotPool = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/rewards/megapot-pool",
  auth: Auth.user({ optionalUser: true }),
  request: { path: CommunityPostPath },
  response: Schema.Struct({ pool: Schema.NullOr(SongMegapotPoolProjectionV1) }),
  errors: [BadRequest, InternalError, ProviderUnavailable],
});

export const ListSongAssetBonuses = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/rewards/asset-bonuses",
  auth: Auth.user({ optionalUser: true }),
  request: { path: CommunityPostPath },
  response: Schema.Struct({
    object: Schema.Literal("song_asset_bonus_list"),
    items: Schema.Array(SongAssetBonusProjectionV1),
  }),
  errors: [BadRequest, InternalError, ProviderUnavailable],
});

export const GetMegapotPoolStanding = endpoint({
  method: "GET",
  path: "/reward-offer-legs/:legId/standing",
  auth: Auth.userOrAdmin(),
  request: { path: LegPath },
  response: Schema.Struct({ standing: MegapotPoolStandingV1 }),
  errors: [AuthError, BadRequest, NotFound, InternalError, ProviderUnavailable],
});

export const ListMyRewardCredits = endpoint({
  method: "GET",
  path: "/rewards/credits",
  auth: Auth.userOrAdmin(),
  request: {
    query: Schema.Struct({
      cursor: Schema.optional(Identifier),
      limit: Schema.optional(Schema.String.check(Schema.isPattern(/^(?:[1-9]|[1-9][0-9]|100)$/u))),
    }),
  },
  response: Schema.Struct({
    object: Schema.Literal("reward_credit_list"),
    items: Schema.Array(RewardCreditV1),
    next_cursor: Schema.NullOr(Identifier),
  }),
  errors: [AuthError, BadRequest, NotFound, InternalError, ProviderUnavailable],
});

/**
 * Spec 015 §5.2a. Issues or reuses an intent that starts the Very ceremony a
 * participant claim needs, for a signed-in user with no current evidence.
 * Start it with POST /verification/sessions {intent_id, provider_id}, then
 * repeat the claim. An account whose only current Very evidence comes from a
 * community join ceremony already satisfies the claim; an account holding
 * evidence for more than one Very subject is refused as verification_failed.
 */
export const IssueRewardClaimVerificationIntent = endpoint({
  method: "POST",
  path: "/rewards/claim-verification-intents",
  auth: Auth.user(),
  response: Schema.Struct({ intent_id: Identifier, provider_id: Schema.Literal("very.web") }),
  errors: [AuthError, BadRequest, InternalError, ProviderUnavailable],
});

/**
 * Spec 015 §5.2a participant claim. Requires current server-verified Very
 * evidence for the signed-in account. Idempotent: repeating it returns the
 * existing claim and its payout status. Evidence refusals leave the credit
 * claimable later; subject_conflict holds it until a different unused
 * subject or an operator decision.
 */
export const ClaimRewardCredit = endpoint({
  method: "POST",
  path: "/rewards/credits/:creditId/claim",
  auth: Auth.user(),
  request: { path: Schema.Struct({ creditId: Identifier }) },
  response: Schema.Struct({
    outcome: Schema.Literals([
      "accepted",
      "subject_conflict",
      "verification_missing",
      "verification_stale",
      "verification_failed",
      "not_claimable",
    ]),
    credit: RewardCreditV1,
  }),
  errors: [AuthError, BadRequest, NotFound, InternalError, ProviderUnavailable],
});

/**
 * Owner decision 2026-09-25. A winner who claimed and was paid USDC may ask
 * for a bounded, platform-funded Base native-ETH gas top-up so they can send
 * that USDC onward. The gas goes to the wallet that received the confirmed
 * payout, even if the persona's wallet changed since. The server reads that
 * wallet's ETH balance and tops up only the shortfall to a fixed target,
 * capped per transfer, once per credit, per account per UTC day and by a
 * platform daily budget. not_needed: the balance already meets the target and
 * nothing is stored. pending: a top-up exists for this request, credit or
 * wallet; poll GET /rewards/gas-topups/{topupId}. limit_reached: a cap refused
 * it, including a credit whose top-up already confirmed. Idempotent per
 * idempotency_key for the signed-in account. The amount sent can be lower than
 * amount_wei if the wallet was partly funded before sending.
 */
export const RequestRewardGasTopup = endpoint({
  method: "POST",
  path: "/rewards/gas-topups",
  auth: Auth.user(),
  request: {
    body: Schema.Struct({ credit_id: Identifier, idempotency_key: Identifier }),
  },
  response: Schema.Struct({
    status: Schema.Literals(["not_needed", "pending", "limit_reached"]),
    topup_id: Schema.NullOr(Identifier),
    amount_wei: Schema.NullOr(AtomicAmount),
  }),
  errors: [AuthError, BadRequest, Conflict, NotFound, InternalError, ProviderUnavailable],
});

/** The caller's own gas top-up. released means nothing was or will be sent. */
export const GetRewardGasTopup = endpoint({
  method: "GET",
  path: "/rewards/gas-topups/:topupId",
  auth: Auth.user(),
  request: { path: Schema.Struct({ topupId: Identifier }) },
  response: Schema.Struct({
    status: Schema.Literals(["requested", "broadcast", "confirmed", "released"]),
    amount_wei: AtomicAmount,
    transaction_hash: Schema.NullOr(TransactionHash),
  }),
  errors: [AuthError, BadRequest, NotFound, InternalError, ProviderUnavailable],
});

const InputAddress = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u));
const InputTransactionHash = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/u));
const Nonce = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));

/**
 * A winner's onward send of a claimed, paid Megapot participant credit. The
 * sender is the wallet that received the confirmed payout; sign an ERC-20
 * transfer(recipient, amount_atomic) to token_address on chain_id from the
 * sender with exactly this nonce and zero value. transaction_hashes and
 * cancellation_hashes are the transfer and cancellation hashes accepted for
 * the current attempt.
 */
export const RewardWinnerSendV1 = Schema.Struct({
  object: Schema.Literal("reward_winner_send"),
  send_id: Identifier,
  credit_id: Identifier,
  status: RewardWinnerSendStatusV1,
  chain_id: Schema.Literal(84_532),
  sender: Address,
  recipient: Address,
  token_address: Address,
  amount_atomic: AtomicAmount,
  nonce: Nonce,
  attempt: PositiveInteger,
  transaction_hashes: Schema.Array(TransactionHash),
  cancellation_hashes: Schema.Array(TransactionHash),
});
export type RewardWinnerSendV1 = Schema.Schema.Type<typeof RewardWinnerSendV1>;

const WinnerSendErrors = [
  AuthError,
  BadRequest,
  Conflict,
  RetryableConflict,
  NotFound,
  InternalError,
  ProviderUnavailable,
] as const;

/**
 * Records the signed-in winner's onward send before anything is signed. Only
 * for the caller's own participant credit with an accepted claim whose USDC
 * payout confirmed. The server reads the sender's pending nonce and fixes it:
 * every retry and fee bump must reuse it, so at most one transfer can be
 * mined. A wallet has one open send at a time: while another credit's send
 * from the same wallet is retryable or pending this is 409 ("Another send
 * from this wallet is in progress"). One record per credit. Repeating the
 * idempotency_key returns the record; the same recipient and amount under
 * another key also returns it; a different recipient or amount is 409,
 * unless the record is reverted, when
 * a new idempotency key starts the next attempt with a fresh nonce. The
 * recipient cannot be the zero address, the sender or the token; the amount
 * is at most the credit's paid amount.
 */
export const CreateRewardWinnerSend = endpoint({
  method: "POST",
  path: "/rewards/credits/:creditId/send",
  auth: Auth.user(),
  request: {
    path: Schema.Struct({ creditId: Identifier }),
    body: Schema.Struct({
      recipient: InputAddress,
      amount_atomic: AtomicAmount,
      idempotency_key: Identifier,
    }),
  },
  response: RewardWinnerSendV1,
  errors: [...WinnerSendErrors],
});

/** The caller's winner send for a credit, with status read fresh from the chain. */
export const GetRewardCreditWinnerSend = endpoint({
  method: "GET",
  path: "/rewards/credits/:creditId/send",
  auth: Auth.user(),
  request: { path: Schema.Struct({ creditId: Identifier }) },
  response: RewardWinnerSendV1,
  errors: [...WinnerSendErrors],
});

/**
 * Reports a broadcast transaction. Accepted only when the chain returns it
 * from the sender with the record's nonce, to the token, with zero value and
 * exactly transfer(recipient, amount_atomic) as calldata. Report every hash
 * signed for the nonce, including re-signed or fee-bumped ones. 409 retryable
 * when the RPC does not know the hash yet.
 */
export const AttachRewardWinnerSendTransaction = endpoint({
  method: "POST",
  path: "/rewards/winner-sends/:sendId/transactions",
  auth: Auth.user(),
  request: {
    path: Schema.Struct({ sendId: Identifier }),
    body: Schema.Struct({ transaction_hash: InputTransactionHash }),
  },
  response: RewardWinnerSendV1,
  errors: [...WinnerSendErrors],
});

/**
 * Cancels an open (retryable or pending) send that will not be signed, by
 * reporting a self-transaction from the sender to the sender with the
 * record's nonce, zero value and empty calldata. The status becomes cancelled
 * once its receipt is at depth; if the transfer is mined first instead, the
 * status is confirmed. Only one of the two can use the nonce.
 */
export const CancelRewardWinnerSend = endpoint({
  method: "POST",
  path: "/rewards/winner-sends/:sendId/cancellation",
  auth: Auth.user(),
  request: {
    path: Schema.Struct({ sendId: Identifier }),
    body: Schema.Struct({ transaction_hash: InputTransactionHash }),
  },
  response: RewardWinnerSendV1,
  errors: [...WinnerSendErrors],
});

/** The caller's own winner send, with status read fresh from the chain. */
export const GetRewardWinnerSend = endpoint({
  method: "GET",
  path: "/rewards/winner-sends/:sendId",
  auth: Auth.user(),
  request: { path: Schema.Struct({ sendId: Identifier }) },
  response: RewardWinnerSendV1,
  errors: [...WinnerSendErrors],
});

/** Current server policy preview. Creation freezes and returns the actual policies. */
export const GetRewardQualificationPolicies = endpoint({
  method: "GET",
  path: "/rewards/qualification-policies",
  auth: Auth.user(),
  response: Schema.Struct({ policies: RewardQualificationPoliciesV1 }),
  errors: [...CommonErrors, ProviderUnavailable],
});

/** Metadata only. Creation rechecks the exact active whitelist tuple. */
export const AdmittedRewardAssetV1 = Schema.Struct({
  chain_id: Schema.Literal(84_532),
  token_address: Address,
  token_decimals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 77 })),
  token_symbol: TokenSymbol,
  asset_policy_version: AssetPolicyVersion,
});
export type AdmittedRewardAssetV1 = Schema.Schema.Type<typeof AdmittedRewardAssetV1>;

export const ListAdmittedRewardAssets = endpoint({
  method: "GET",
  path: "/rewards/bonus-assets",
  auth: Auth.user(),
  request: {
    query: Schema.Struct({
      cursor: Schema.optional(Address),
      limit: Schema.optional(Schema.String.check(Schema.isPattern(/^(?:[1-9]|[1-4][0-9]|50)$/u))),
    }),
  },
  response: Schema.Struct({
    items: Schema.Array(AdmittedRewardAssetV1).check(Schema.isMaxLength(50)),
    next_cursor: Schema.NullOr(Address),
  }),
  errors: [AuthError, BadRequest, InternalError, ProviderUnavailable],
});
