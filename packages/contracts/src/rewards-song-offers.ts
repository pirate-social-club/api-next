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
  errors: CommonErrors,
});

export const AddMegapotPoolLeg = endpoint({
  method: "POST",
  path: "/reward-offers/:offerId/megapot-pool-legs",
  auth: Auth.user(),
  request: {
    path: OfferPath,
    body: Schema.Struct({
      idempotency_key: Identifier,
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
  errors: [AuthError, BadRequest, NotFound, InternalError],
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
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const GetSongMegapotPool = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/rewards/megapot-pool",
  auth: Auth.user({ optionalUser: true }),
  request: { path: CommunityPostPath },
  response: Schema.Struct({ pool: Schema.NullOr(SongMegapotPoolProjectionV1) }),
  errors: [BadRequest, InternalError],
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
  errors: [BadRequest, InternalError],
});

export const GetMegapotPoolStanding = endpoint({
  method: "GET",
  path: "/reward-offer-legs/:legId/standing",
  auth: Auth.userOrAdmin(),
  request: { path: LegPath },
  response: Schema.Struct({ standing: MegapotPoolStandingV1 }),
  errors: [AuthError, BadRequest, NotFound, InternalError],
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
  errors: [AuthError, BadRequest, NotFound, InternalError],
});
