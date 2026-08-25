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

const CommunityPostPath = Schema.Struct({ communityId: Identifier, postId: Identifier });
const OfferPath = Schema.Struct({ offerId: Identifier });
const FundingPath = Schema.Struct({ legId: Identifier, fundingEffectId: Identifier });
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
  response: Schema.Struct({ funding: MegapotFundingV1, replayed: Schema.Boolean }),
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
