import { Data, Effect } from "effect";
import { Clock, IdGen } from "../ports.ts";
import { canonicalBodyHash } from "../use-cases/content/common.ts";
import type { RewardFundingIntent } from "./reward-funding.ts";

export { Clock, IdGen } from "../ports.ts";
export type { RewardFundingIntent, RewardFundingStore } from "./reward-funding.ts";
export type {
  PublicSongAssetBonusProjection,
  PublicSongMegapotPoolProjection,
  RewardCredit,
  RewardProjectionFailure,
  RewardProjectionStore,
} from "./reward-projections.ts";

export class SongRewardOfferStorageFailed extends Data.TaggedError("SongRewardOfferStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class SongRewardOfferRejected extends Data.TaggedError("SongRewardOfferRejected")<{
  readonly reason:
    | "fallback-policy-unavailable"
    | "idempotency-conflict"
    | "invalid-input"
    | "membership-required"
    | "not-found"
    | "offer-conflict"
    | "owner-only"
    | "persona-ineligible"
    | "song-unavailable";
}> {}

export type SongRewardOfferFailure = SongRewardOfferRejected | SongRewardOfferStorageFailed;

export type SongRewardOffer = Readonly<{
  offerId: string;
  communityId: string;
  postId: string;
  audioRevision: number;
  createdByAccountId: string;
  status: "draft" | "active" | "paused" | "exhausted" | "expired" | "ended" | "operational_hold";
  startsAt: string;
  endsAt: string;
  termsHash: string;
}>;

export type MegapotPoolLeg = Readonly<{
  legId: string;
  offerId: string;
  status: "draft" | "funding" | "active" | "paused" | "exhausted" | "ended" | "operational_hold";
  funderAccountId: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  custodyAddress: string;
  maxTicketPriceAtomic: bigint;
  entryCutoffSeconds: number;
  participationStartsDrawingId: bigint;
  eligibleActivities: readonly ("study" | "karaoke")[];
  minScoreBps: number;
  emptyPoolPolicy: "no_purchase" | "funder_fallback";
  fallbackPayoutPersonaId: string | null;
  fundedAtomic: bigint;
  legTermsHash: string;
}>;

export type AssetBonusLeg = Readonly<{
  legId: string;
  offerId: string;
  status: "draft" | "funding" | "active" | "paused" | "exhausted" | "ended" | "operational_hold";
  funderAccountId: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  tokenSymbol: string;
  assetPolicyVersion: string;
  custodyAddress: string;
  amountPerClaimAtomic: bigint;
  maxClaims: number;
  fundedAtomic: bigint;
  fulfilledAtomic: bigint;
  legTermsHash: string;
}>;

export type ScarceRewardPolicyV1 = Readonly<{
  version: "scarce_reward_v1";
  community_id: string;
  offer_id: string;
  requirements: readonly ["human.personhood", "credential.subject_unique"];
  uniqueness: Readonly<{ kind: "single_authority"; authority_id: string }>;
  legal_eligibility: Readonly<{
    age: null;
    geography: null;
    disclosure: null;
    environment: "test_staging_empty_v1";
  }>;
}>;

export interface SongRewardOfferStore {
  readonly openOffer: (input: {
    readonly actionId: string;
    readonly offerId: string;
    readonly accountId: string;
    readonly personaId: string;
    readonly communityId: string;
    readonly postId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly termsHash: string;
    readonly rewardPolicy: ScarceRewardPolicyV1;
    readonly rewardPolicyHash: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly createdAt: string;
  }) => Effect.Effect<
    Readonly<{ offer: SongRewardOffer; replayed: boolean }>,
    SongRewardOfferFailure
  >;
  readonly addMegapotPoolLeg: (input: {
    readonly actionId: string;
    readonly legId: string;
    readonly offerId: string;
    readonly accountId: string;
    readonly personaId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly legTermsHash: string;
    readonly createdAt: string;
    readonly maxTicketPriceAtomic: bigint;
    readonly entryCutoffSeconds: number;
    readonly eligibleActivities: readonly ("study" | "karaoke")[];
    readonly minScoreBps: number;
    readonly emptyPoolPolicy: "no_purchase" | "funder_fallback";
    readonly fallbackPayoutPersonaId: string | null;
    readonly referralAllocationVersion: string | null;
    readonly referralPolicyHash: string | null;
    readonly referralDisclosedAt: string | null;
  }) => Effect.Effect<Readonly<{ leg: MegapotPoolLeg; replayed: boolean }>, SongRewardOfferFailure>;
  readonly addAssetBonusLeg: (input: {
    readonly actionId: string;
    readonly legId: string;
    readonly offerId: string;
    readonly accountId: string;
    readonly personaId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly legTermsHash: string;
    readonly createdAt: string;
    readonly chainId: number;
    readonly tokenAddress: string;
    readonly tokenDecimals: number;
    readonly tokenSymbol: string;
    readonly assetPolicyVersion: string;
    readonly amountPerClaimAtomic: bigint;
    readonly maxClaims: number;
  }) => Effect.Effect<Readonly<{ leg: AssetBonusLeg; replayed: boolean }>, SongRewardOfferFailure>;
  readonly recordFundingObservation: (input: {
    readonly actionId: string;
    readonly accountId: string;
    readonly personaId: string;
    readonly legId: string;
    readonly legKind: "megapot_pool" | "asset_bonus";
    readonly fundingEffectId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAt: string;
  }) => Effect.Effect<Readonly<{ replayed: boolean }>, SongRewardOfferFailure>;
}

export type RewardFundingPlan = Readonly<{
  kind: "planned" | "confirming" | "confirmed" | "reverted" | "reconciliation_required";
  intent: RewardFundingIntent;
}>;

export interface RewardFundingPlanner {
  readonly plan: (input: {
    readonly legId: string;
    readonly funderAccountId: string;
    readonly senderAddress: string;
    readonly expectedAmountAtomic: bigint;
    readonly requiredConfirmations: number;
    readonly idempotencyKey: string;
  }) => Effect.Effect<RewardFundingPlan, unknown>;
  readonly observe: (input: {
    readonly fundingEffectId: string;
    readonly transactionHash: string;
  }) => Effect.Effect<RewardFundingPlan, unknown>;
}

export type ExternalFallbackPolicy = Readonly<{
  referralAllocationVersion: string;
  referralPolicyHash: string;
}>;

export interface SongRewardOfferService {
  readonly openOffer: (input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly communityId: string;
    readonly postId: string;
    readonly idempotencyKey: string;
    readonly startsAt: string;
    readonly endsAt: string;
  }) => Effect.Effect<
    Readonly<{ offer: SongRewardOffer; replayed: boolean }>,
    SongRewardOfferFailure,
    Clock | IdGen
  >;
  readonly addMegapotPoolLeg: (input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly offerId: string;
    readonly idempotencyKey: string;
    readonly senderAddress: string;
    readonly fundingAmountAtomic: bigint;
    readonly maxTicketPriceAtomic: bigint;
    readonly entryCutoffSeconds: number;
    readonly eligibleActivities: readonly ("study" | "karaoke")[];
    readonly minScoreBps: number;
    readonly emptyPoolPolicy: "no_purchase" | "funder_fallback";
    readonly fallbackPayoutPersonaId: string | null;
    readonly fallbackDisclosureAcknowledged: boolean;
  }) => Effect.Effect<
    Readonly<{
      leg: MegapotPoolLeg;
      funding: RewardFundingPlan;
      replayed: boolean;
    }>,
    SongRewardOfferFailure | unknown,
    Clock | IdGen
  >;
  readonly addAssetBonusLeg: (input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly offerId: string;
    readonly idempotencyKey: string;
    readonly senderAddress: string;
    readonly fundingAmountAtomic: bigint;
    readonly chainId: number;
    readonly tokenAddress: string;
    readonly tokenDecimals: number;
    readonly tokenSymbol: string;
    readonly assetPolicyVersion: string;
    readonly amountPerClaimAtomic: bigint;
    readonly maxClaims: number;
  }) => Effect.Effect<
    Readonly<{ leg: AssetBonusLeg; funding: RewardFundingPlan; replayed: boolean }>,
    SongRewardOfferFailure | unknown,
    Clock | IdGen
  >;
  readonly observeFunding: (input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly legId: string;
    readonly legKind: "megapot_pool" | "asset_bonus";
    readonly fundingEffectId: string;
    readonly idempotencyKey: string;
    readonly transactionHash: string;
  }) => Effect.Effect<
    Readonly<{ funding: RewardFundingPlan; replayed: boolean }>,
    SongRewardOfferFailure | unknown,
    Clock | IdGen
  >;
}

const rejected = (reason: SongRewardOfferRejected["reason"]) =>
  new SongRewardOfferRejected({ reason });

const hash = (value: unknown) =>
  canonicalBodyHash(value).pipe(Effect.mapError(() => rejected("invalid-input")));

const nextId = Effect.fn("SongRewardOffer.nextId")(function* (prefix: string) {
  const ids = yield* IdGen;
  return `${prefix}_${yield* ids.next}`;
});

const validInstant = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

export function makeSongRewardOfferService(input: {
  readonly store: SongRewardOfferStore;
  readonly funding: RewardFundingPlanner;
  readonly requiredConfirmations: number;
  readonly externalFallbackPolicy: ExternalFallbackPolicy | null;
}): SongRewardOfferService {
  const openOffer = Effect.fn("SongRewardOffer.openOffer")(function* (
    request: Parameters<SongRewardOfferService["openOffer"]>[0],
  ) {
    if (
      !validInstant(request.startsAt) ||
      !validInstant(request.endsAt) ||
      Date.parse(request.endsAt) <= Date.parse(request.startsAt)
    ) {
      return yield* rejected("invalid-input");
    }
    const [requestHash, termsHash, actionId, offerId, clock] = yield* Effect.all([
      hash(request),
      hash({ starts_at: request.startsAt, ends_at: request.endsAt }),
      nextId("reward_action"),
      nextId("reward_offer"),
      Clock,
    ]);
    const rewardPolicy = {
      version: "scarce_reward_v1",
      community_id: request.communityId,
      offer_id: offerId,
      requirements: ["human.personhood", "credential.subject_unique"],
      uniqueness: { kind: "single_authority", authority_id: offerId },
      legal_eligibility: {
        age: null,
        geography: null,
        disclosure: null,
        environment: "test_staging_empty_v1",
      },
    } as const satisfies ScarceRewardPolicyV1;
    const rewardPolicyHash = yield* hash(rewardPolicy);
    const createdAt = new Date(yield* clock.now).toISOString();
    return yield* input.store.openOffer({
      ...request,
      requestHash,
      termsHash,
      rewardPolicy,
      rewardPolicyHash,
      actionId,
      offerId,
      createdAt,
    });
  });

  const addMegapotPoolLeg = Effect.fn("SongRewardOffer.addMegapotPoolLeg")(function* (
    request: Parameters<SongRewardOfferService["addMegapotPoolLeg"]>[0],
  ) {
    const activities = [...new Set(request.eligibleActivities)].sort();
    if (
      request.fundingAmountAtomic <= 0n ||
      request.maxTicketPriceAtomic <= 0n ||
      request.fundingAmountAtomic < request.maxTicketPriceAtomic ||
      !Number.isSafeInteger(request.entryCutoffSeconds) ||
      request.entryCutoffSeconds <= 0 ||
      !Number.isSafeInteger(request.minScoreBps) ||
      request.minScoreBps < 7_000 ||
      request.minScoreBps > 10_000 ||
      activities.length === 0 ||
      activities.length !== request.eligibleActivities.length
    ) {
      return yield* rejected("invalid-input");
    }
    const fallback = request.emptyPoolPolicy === "funder_fallback";
    const policy = fallback ? input.externalFallbackPolicy : null;
    if (
      fallback &&
      (policy === null ||
        !request.fallbackDisclosureAcknowledged ||
        request.fallbackPayoutPersonaId === null ||
        request.minScoreBps !== 7_000)
    ) {
      return yield* rejected("fallback-policy-unavailable");
    }
    if (!fallback && request.fallbackPayoutPersonaId !== null) {
      return yield* rejected("invalid-input");
    }
    const canonicalRequest = {
      account_id: request.accountId,
      persona_id: request.personaId,
      offer_id: request.offerId,
      idempotency_key: request.idempotencyKey,
      sender_address: request.senderAddress,
      funding_amount_atomic: request.fundingAmountAtomic.toString(),
      max_ticket_price_atomic: request.maxTicketPriceAtomic.toString(),
      entry_cutoff_seconds: request.entryCutoffSeconds,
      eligible_activities: activities,
      min_score_bps: request.minScoreBps,
      empty_pool_policy: request.emptyPoolPolicy,
      fallback_payout_persona_id: request.fallbackPayoutPersonaId,
      fallback_disclosure_acknowledged: request.fallbackDisclosureAcknowledged,
    };
    const [requestHash, termsDigest, actionId, legId, clock] = yield* Effect.all([
      hash(canonicalRequest),
      hash({
        ...canonicalRequest,
        referral_allocation_version: policy?.referralAllocationVersion ?? null,
        referral_policy_hash: policy?.referralPolicyHash ?? null,
      }),
      nextId("reward_action"),
      nextId("reward_leg"),
      Clock,
    ]);
    const createdAt = new Date(yield* clock.now).toISOString();
    const result = yield* input.store.addMegapotPoolLeg({
      actionId,
      legId,
      offerId: request.offerId,
      accountId: request.accountId,
      personaId: request.personaId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      legTermsHash: `0x${termsDigest}`,
      createdAt,
      maxTicketPriceAtomic: request.maxTicketPriceAtomic,
      entryCutoffSeconds: request.entryCutoffSeconds,
      eligibleActivities: activities,
      minScoreBps: request.minScoreBps,
      emptyPoolPolicy: request.emptyPoolPolicy,
      fallbackPayoutPersonaId: request.fallbackPayoutPersonaId,
      referralAllocationVersion: policy?.referralAllocationVersion ?? null,
      referralPolicyHash: policy?.referralPolicyHash ?? null,
      referralDisclosedAt: fallback ? createdAt : null,
    });
    const funding = yield* input.funding.plan({
      legId: result.leg.legId,
      funderAccountId: request.accountId,
      senderAddress: request.senderAddress,
      expectedAmountAtomic: request.fundingAmountAtomic,
      requiredConfirmations: input.requiredConfirmations,
      idempotencyKey: request.idempotencyKey,
    });
    return { leg: result.leg, funding, replayed: result.replayed };
  });

  const observeFunding = Effect.fn("SongRewardOffer.observeFunding")(function* (
    request: Parameters<SongRewardOfferService["observeFunding"]>[0],
  ) {
    const [requestHash, actionId, clock] = yield* Effect.all([
      hash({
        account_id: request.accountId,
        persona_id: request.personaId,
        leg_id: request.legId,
        leg_kind: request.legKind,
        funding_effect_id: request.fundingEffectId,
        idempotency_key: request.idempotencyKey,
        transaction_hash: request.transactionHash,
      }),
      nextId("reward_action"),
      Clock,
    ]);
    const action = yield* input.store.recordFundingObservation({
      actionId,
      accountId: request.accountId,
      personaId: request.personaId,
      legId: request.legId,
      legKind: request.legKind,
      fundingEffectId: request.fundingEffectId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      createdAt: new Date(yield* clock.now).toISOString(),
    });
    const funding = yield* input.funding.observe({
      fundingEffectId: request.fundingEffectId,
      transactionHash: request.transactionHash,
    });
    return { funding, replayed: action.replayed };
  });

  const addAssetBonusLeg = Effect.fn("SongRewardOffer.addAssetBonusLeg")(function* (
    request: Parameters<SongRewardOfferService["addAssetBonusLeg"]>[0],
  ) {
    if (
      request.chainId !== 84_532 ||
      !/^0x[0-9a-f]{40}$/u.test(request.tokenAddress) ||
      !Number.isSafeInteger(request.tokenDecimals) ||
      request.tokenDecimals < 0 ||
      request.tokenDecimals > 77 ||
      request.tokenSymbol.length === 0 ||
      request.tokenSymbol !== request.tokenSymbol.trim() ||
      new TextEncoder().encode(request.tokenSymbol).byteLength > 32 ||
      request.assetPolicyVersion.length === 0 ||
      request.assetPolicyVersion !== request.assetPolicyVersion.trim() ||
      new TextEncoder().encode(request.assetPolicyVersion).byteLength > 128 ||
      request.fundingAmountAtomic <= 0n ||
      request.amountPerClaimAtomic <= 0n ||
      !Number.isSafeInteger(request.maxClaims) ||
      request.maxClaims <= 0 ||
      request.fundingAmountAtomic < request.amountPerClaimAtomic
    ) {
      return yield* rejected("invalid-input");
    }
    const canonicalRequest = {
      account_id: request.accountId,
      persona_id: request.personaId,
      offer_id: request.offerId,
      idempotency_key: request.idempotencyKey,
      sender_address: request.senderAddress,
      funding_amount_atomic: request.fundingAmountAtomic.toString(),
      chain_id: request.chainId,
      token_address: request.tokenAddress,
      token_decimals: request.tokenDecimals,
      token_symbol: request.tokenSymbol,
      asset_policy_version: request.assetPolicyVersion,
      amount_per_claim_atomic: request.amountPerClaimAtomic.toString(),
      max_claims: request.maxClaims,
    };
    const [requestHash, termsDigest, actionId, legId, clock] = yield* Effect.all([
      hash(canonicalRequest),
      hash(canonicalRequest),
      nextId("reward_action"),
      nextId("reward_leg"),
      Clock,
    ]);
    const createdAt = new Date(yield* clock.now).toISOString();
    const result = yield* input.store.addAssetBonusLeg({
      actionId,
      legId,
      offerId: request.offerId,
      accountId: request.accountId,
      personaId: request.personaId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      legTermsHash: `0x${termsDigest}`,
      createdAt,
      chainId: request.chainId,
      tokenAddress: request.tokenAddress,
      tokenDecimals: request.tokenDecimals,
      tokenSymbol: request.tokenSymbol,
      assetPolicyVersion: request.assetPolicyVersion,
      amountPerClaimAtomic: request.amountPerClaimAtomic,
      maxClaims: request.maxClaims,
    });
    const funding = yield* input.funding.plan({
      legId: result.leg.legId,
      funderAccountId: request.accountId,
      senderAddress: request.senderAddress,
      expectedAmountAtomic: request.fundingAmountAtomic,
      requiredConfirmations: input.requiredConfirmations,
      idempotencyKey: request.idempotencyKey,
    });
    return { leg: result.leg, funding, replayed: result.replayed };
  });

  return { openOffer, addMegapotPoolLeg, addAssetBonusLeg, observeFunding };
}
