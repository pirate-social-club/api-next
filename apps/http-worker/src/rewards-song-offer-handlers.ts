import {
  type AssetBonusLeg,
  Clock,
  IdGen,
  type MegapotPoolLeg,
  makeSongRewardOfferService,
  type PublicSongAssetBonusProjection,
  type PublicSongMegapotPoolProjection,
  type RewardCredit,
  type RewardFundingIntent,
  type RewardFundingPlanner,
  type RewardFundingStore,
  type RewardProjectionFailure,
  type RewardProjectionStore,
  type SongRewardOffer,
  type SongRewardOfferStore,
} from "@pirate/application/rewards/song-reward-offers";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RetryableConflict,
} from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export type SongRewardOfferHandlerServices = Readonly<{
  clock: Clock["Service"];
  ids: IdGen["Service"];
  store: SongRewardOfferStore;
  funding: RewardFundingPlanner;
  fundingStore: RewardFundingStore;
  projections: RewardProjectionStore;
  requiredConfirmations: number;
  externalFallbackPolicy: Readonly<{
    referralAllocationVersion: string;
    referralPolicyHash: string;
  }> | null;
}>;

export type SongRewardOfferHandlers = Readonly<{
  OpenSongRewardOffer: EndpointHandler;
  AddAssetBonusLeg: EndpointHandler;
  AddMegapotPoolLeg: EndpointHandler;
  ObserveAssetBonusFunding: EndpointHandler;
  GetAssetBonusFunding: EndpointHandler;
  ObserveMegapotPoolFunding: EndpointHandler;
  GetMegapotPoolFunding: EndpointHandler;
  GetSongMegapotPool: EndpointHandler;
  ListSongAssetBonuses: EndpointHandler;
  GetMegapotPoolStanding: EndpointHandler;
  ListMyRewardCredits: EndpointHandler;
}>;

function user(principal: Principal | null): {
  readonly accountId: string;
  readonly wallet: string | null;
} {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return { accountId: principal.subject, wallet: principal.walletAddress ?? null };
}

function optionalAccountId(principal: Principal | null): string | null {
  return principal !== null && (principal.kind === "user" || principal.kind === "admin")
    ? principal.subject
    : null;
}

function wireFailure(error: unknown): Error {
  const tagged = error as { readonly _tag?: string; readonly reason?: string };
  if (tagged._tag === "SongRewardOfferRejected") {
    if (
      tagged.reason === "not-found" ||
      tagged.reason === "song-unavailable" ||
      tagged.reason === "persona-ineligible"
    ) {
      return new NotFound({ message: "Song reward target is unavailable" });
    }
    if (tagged.reason === "membership-required" || tagged.reason === "owner-only") {
      return new NotFound({ message: "Song reward target is unavailable" });
    }
    if (tagged.reason === "idempotency-conflict" || tagged.reason === "offer-conflict") {
      return new Conflict({ message: "Song reward command conflicts with durable state" });
    }
    if (tagged.reason === "fallback-policy-unavailable") {
      return new Conflict({ message: "Funder fallback is not activated in this environment" });
    }
    return new BadRequest({ message: "Song reward command is invalid" });
  }
  if (tagged._tag === "SongRewardOfferStorageFailed") {
    return tagged.reason === "unavailable" || tagged.reason === "outcome-unknown"
      ? new ProviderUnavailable({ message: "Song reward storage is unavailable" })
      : new InternalError({ message: "Song reward command failed" });
  }
  if (tagged._tag === "RewardFundingRejected") {
    if (tagged.reason === "not-found" || tagged.reason === "sender-not-owned") {
      return new NotFound({ message: "Reward funding target is unavailable" });
    }
    return new Conflict({ message: "Reward funding conflicts with durable state" });
  }
  if (tagged._tag === "RewardFundingStorageFailed") {
    return tagged.reason === "unavailable" || tagged.reason === "outcome-unknown"
      ? new ProviderUnavailable({ message: "Reward funding storage is unavailable" })
      : new InternalError({ message: "Reward funding failed" });
  }
  if (tagged._tag === "RewardFundingCoordinatorFailed") {
    return tagged.reason === "receipt_evidence_invalid"
      ? new RetryableConflict({ message: "Reward funding receipt is not yet acceptable" })
      : new ProviderUnavailable({ message: "Reward funding chain service is unavailable" });
  }
  if (tagged._tag === "RewardProjectionRejected") {
    return tagged.reason === "not-found"
      ? new NotFound({ message: "Reward projection is unavailable" })
      : new BadRequest({ message: "Reward projection cursor is invalid" });
  }
  if (tagged._tag === "RewardProjectionStorageFailed") {
    return new InternalError({ message: "Reward projection failed" });
  }
  return error instanceof AuthError ? error : new InternalError({ message: "Song reward failed" });
}

const offer = (value: SongRewardOffer) => ({
  object: "song_reward_offer" as const,
  offer_id: value.offerId,
  community_id: value.communityId,
  post_id: value.postId,
  audio_revision: value.audioRevision,
  status: value.status,
  starts_at: value.startsAt,
  ends_at: value.endsAt,
  terms_hash: value.termsHash,
});

const leg = (value: MegapotPoolLeg) => ({
  object: "megapot_pool_leg" as const,
  leg_id: value.legId,
  offer_id: value.offerId,
  status: value.status,
  chain_id: value.chainId as 84_532,
  token_address: value.tokenAddress,
  token_decimals: value.tokenDecimals as 6,
  custody_address: value.custodyAddress,
  max_ticket_price_atomic: value.maxTicketPriceAtomic.toString(),
  entry_cutoff_seconds: value.entryCutoffSeconds,
  participation_starts_drawing_id: value.participationStartsDrawingId.toString(),
  eligible_activities: value.eligibleActivities,
  min_score_bps: value.minScoreBps,
  empty_pool_policy: value.emptyPoolPolicy,
  fallback_payout_persona_id: value.fallbackPayoutPersonaId,
  funded_atomic: value.fundedAtomic.toString(),
  leg_terms_hash: value.legTermsHash,
});

const assetLeg = (value: AssetBonusLeg) => ({
  object: "asset_bonus_leg" as const,
  leg_id: value.legId,
  offer_id: value.offerId,
  status: value.status,
  chain_id: value.chainId as 84_532,
  token_address: value.tokenAddress,
  token_decimals: value.tokenDecimals,
  token_symbol: value.tokenSymbol,
  asset_policy_version: value.assetPolicyVersion,
  custody_address: value.custodyAddress,
  amount_per_claim_atomic: value.amountPerClaimAtomic.toString(),
  max_claims: value.maxClaims,
  funded_atomic: value.fundedAtomic.toString(),
  fulfilled_atomic: value.fulfilledAtomic.toString(),
  leg_terms_hash: value.legTermsHash,
});

const funding = (value: RewardFundingIntent) => ({
  object: "megapot_pool_funding" as const,
  action: "fund_with_usdc" as const,
  funding_effect_id: value.fundingEffectId,
  leg_id: value.legId,
  status: value.state === "reclaimable_failed" ? ("reverted" as const) : value.state,
  chain_id: value.chainId as 84_532,
  token_address: value.tokenAddress,
  token_decimals: value.tokenDecimals as 6,
  sender_address: value.senderAddress,
  recipient_address: value.recipientAddress,
  expected_amount_atomic: value.expectedAmountAtomic.toString(),
  confirmed_amount_atomic: value.confirmedAmountAtomic?.toString() ?? null,
  required_confirmations: value.requiredConfirmations,
  transaction_hash: value.transactionHash,
});

const assetFunding = (value: RewardFundingIntent) => ({
  object: "asset_bonus_funding" as const,
  action: "fund_with_asset" as const,
  funding_effect_id: value.fundingEffectId,
  leg_id: value.legId,
  status: value.state === "reclaimable_failed" ? ("reverted" as const) : value.state,
  chain_id: value.chainId as 84_532,
  token_address: value.tokenAddress,
  token_decimals: value.tokenDecimals,
  sender_address: value.senderAddress,
  recipient_address: value.recipientAddress,
  expected_amount_atomic: value.expectedAmountAtomic.toString(),
  confirmed_amount_atomic: value.confirmedAmountAtomic?.toString() ?? null,
  required_confirmations: value.requiredConfirmations,
  transaction_hash: value.transactionHash,
});

const assetBonusProjection = (value: PublicSongAssetBonusProjection) => ({
  object: "song_asset_bonus_projection" as const,
  offer_id: value.offerId,
  leg_id: value.legId,
  community_id: value.communityId,
  post_id: value.postId,
  offer_status: value.offerStatus,
  leg_status: value.legStatus,
  chain_id: value.chainId as 84_532,
  token_address: value.tokenAddress,
  token_decimals: value.tokenDecimals,
  token_symbol: value.tokenSymbol,
  asset_policy_version: value.assetPolicyVersion,
  amount_per_claim_atomic: value.amountPerClaimAtomic.toString(),
  max_claims: value.maxClaims,
  claimed_count: value.claimedCount,
  available_inventory_atomic: value.availableInventoryAtomic.toString(),
  viewer_state: value.viewerState,
  viewer_credit_id: value.viewerCreditId,
  viewer_credit_state: value.viewerCreditState,
});

const drawingProjection = (value: NonNullable<PublicSongMegapotPoolProjection["drawing"]>) => ({
  object: "megapot_pool_drawing_projection" as const,
  drawing_id: value.drawingId.toString(),
  lifecycle_status: value.lifecycleStatus,
  state: value.state,
  entry_cutoff_at: value.entryCutoffAt,
  beneficiary_count: value.beneficiaryCount,
  ticket_price_ceiling_atomic: value.ticketPriceCeilingAtomic.toString(),
  actual_ticket_cost_atomic: value.actualTicketCostAtomic.toString(),
  net_winnings_atomic: value.netWinningsAtomic.toString(),
  commitment_reference: value.commitmentReference,
  snapshot_hash: value.snapshotHash,
  ticket_id: value.ticketId?.toString() ?? null,
  purchase_transaction_hash: value.purchaseTransactionHash,
  claim_transaction_hash: value.claimTransactionHash,
});

const poolProjection = (value: PublicSongMegapotPoolProjection) => ({
  object: "song_megapot_pool_projection" as const,
  offer_id: value.offerId,
  leg_id: value.legId,
  community_id: value.communityId,
  post_id: value.postId,
  offer_status: value.offerStatus,
  leg_status: value.legStatus,
  chain_id: value.chainId as 84_532,
  token_address: value.tokenAddress,
  token_decimals: value.tokenDecimals as 6,
  funded_atomic: value.fundedAtomic.toString(),
  available_budget_atomic: value.availableBudgetAtomic.toString(),
  max_ticket_price_atomic: value.maxTicketPriceAtomic.toString(),
  entry_cutoff_seconds: value.entryCutoffSeconds,
  eligible_activities: value.eligibleActivities,
  min_score_bps: value.minScoreBps,
  empty_pool_policy: value.emptyPoolPolicy,
  allocation_rule: "equal_v1" as const,
  ticket_custody: "pirate" as const,
  winnings_basis: "net_of_referral_win_share" as const,
  fallback_disclosure:
    value.fundingSource === "shared_sponsor_budget"
      ? ("If nobody qualifies, the sponsor keeps this ticket and any winnings." as const)
      : value.emptyPoolPolicy === "funder_fallback"
        ? ("If nobody qualifies, the sponsor receives this ticket's net winnings." as const)
        : null,
  drawing: value.drawing === null ? null : drawingProjection(value.drawing),
});

const rewardCredit = (value: RewardCredit) => ({
  object: "reward_credit" as const,
  credit_id: value.creditId,
  payout_persona_id: value.payoutPersonaId,
  chain_id: value.chainId,
  token_address: value.tokenAddress,
  token_decimals: value.tokenDecimals,
  amount_atomic: value.amountAtomic.toString(),
  available_atomic: (value.amountAtomic - value.reservedAtomic - value.paidAtomic).toString(),
  reserved_atomic: value.reservedAtomic.toString(),
  paid_atomic: value.paidAtomic.toString(),
  source_kind: value.sourceKind,
  state: value.state,
  created_at: value.createdAt,
  updated_at: value.updatedAt,
  settled_at: value.settledAt,
});

export function makeSongRewardOfferHandlers(
  services: SongRewardOfferHandlerServices,
): SongRewardOfferHandlers {
  const rewards = makeSongRewardOfferService({
    store: services.store,
    funding: services.funding,
    requiredConfirmations: services.requiredConfirmations,
    externalFallbackPolicy: services.externalFallbackPolicy,
  });
  const run = <A, E>(effect: Effect.Effect<A, E, Clock | IdGen>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Clock, services.clock),
        Effect.provideService(IdGen, services.ids),
        Effect.mapError(wireFailure),
      ),
    );

  return {
    OpenSongRewardOffer: async (request) => {
      const principal = user(request.principal);
      const path = request.params as { readonly communityId: string; readonly postId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly starts_at: string;
        readonly ends_at: string;
      };
      const result = await run(
        rewards.openOffer({
          accountId: principal.accountId,
          personaId: body.persona_id,
          communityId: path.communityId,
          postId: path.postId,
          idempotencyKey: body.idempotency_key,
          startsAt: body.starts_at,
          endsAt: body.ends_at,
        }),
      );
      return withEndpointResult(
        { offer: offer(result.offer), replayed: result.replayed },
        result.replayed ? 200 : 201,
      );
    },
    AddMegapotPoolLeg: async (request) => {
      const principal = user(request.principal);
      if (principal.wallet === null) throw new AuthError({ message: "Wallet session required" });
      const path = request.params as { readonly offerId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly funding_amount_atomic: string;
        readonly max_ticket_price_atomic: string;
        readonly entry_cutoff_seconds: number;
        readonly eligible_activities: readonly ("study" | "karaoke")[];
        readonly min_score_bps: number;
        readonly empty_pool_policy: "no_purchase" | "funder_fallback";
        readonly fallback_payout_persona_id: string | null;
        readonly fallback_disclosure_acknowledged: boolean;
      };
      const result = await run(
        rewards.addMegapotPoolLeg({
          accountId: principal.accountId,
          personaId: body.persona_id,
          offerId: path.offerId,
          idempotencyKey: body.idempotency_key,
          senderAddress: principal.wallet,
          fundingAmountAtomic: BigInt(body.funding_amount_atomic),
          maxTicketPriceAtomic: BigInt(body.max_ticket_price_atomic),
          entryCutoffSeconds: body.entry_cutoff_seconds,
          eligibleActivities: body.eligible_activities,
          minScoreBps: body.min_score_bps,
          emptyPoolPolicy: body.empty_pool_policy,
          fallbackPayoutPersonaId: body.fallback_payout_persona_id,
          fallbackDisclosureAcknowledged: body.fallback_disclosure_acknowledged,
        }),
      );
      return withEndpointResult(
        {
          leg: leg(result.leg),
          funding: funding(result.funding.intent),
          replayed: result.replayed,
        },
        result.replayed ? 200 : 201,
      );
    },
    AddAssetBonusLeg: async (request) => {
      const principal = user(request.principal);
      if (principal.wallet === null) throw new AuthError({ message: "Wallet session required" });
      const path = request.params as { readonly offerId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly funding_amount_atomic: string;
        readonly chain_id: 84_532;
        readonly token_address: string;
        readonly token_decimals: number;
        readonly token_symbol: string;
        readonly asset_policy_version: string;
        readonly amount_per_claim_atomic: string;
        readonly max_claims: number;
      };
      const result = await run(
        rewards.addAssetBonusLeg({
          accountId: principal.accountId,
          personaId: body.persona_id,
          offerId: path.offerId,
          idempotencyKey: body.idempotency_key,
          senderAddress: principal.wallet,
          fundingAmountAtomic: BigInt(body.funding_amount_atomic),
          chainId: body.chain_id,
          tokenAddress: body.token_address,
          tokenDecimals: body.token_decimals,
          tokenSymbol: body.token_symbol,
          assetPolicyVersion: body.asset_policy_version,
          amountPerClaimAtomic: BigInt(body.amount_per_claim_atomic),
          maxClaims: body.max_claims,
        }),
      );
      return withEndpointResult(
        {
          leg: assetLeg(result.leg),
          funding: assetFunding(result.funding.intent),
          replayed: result.replayed,
        },
        result.replayed ? 200 : 201,
      );
    },
    ObserveMegapotPoolFunding: async (request) => {
      const principal = user(request.principal);
      const path = request.params as { readonly legId: string; readonly fundingEffectId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly transaction_hash: string;
      };
      const result = await run(
        rewards.observeFunding({
          accountId: principal.accountId,
          personaId: body.persona_id,
          legId: path.legId,
          legKind: "megapot_pool",
          fundingEffectId: path.fundingEffectId,
          idempotencyKey: body.idempotency_key,
          transactionHash: body.transaction_hash,
        }),
      );
      if (result.funding.intent.legKind !== "megapot_pool") {
        throw new NotFound({ message: "Reward funding target is unavailable" });
      }
      return { funding: funding(result.funding.intent), replayed: result.replayed };
    },
    GetMegapotPoolFunding: async (request) => {
      const principal = user(request.principal);
      const path = request.params as { readonly legId: string; readonly fundingEffectId: string };
      const intent = await Effect.runPromise(
        services.fundingStore.find(path.fundingEffectId).pipe(Effect.mapError(wireFailure)),
      );
      if (
        intent === null ||
        intent.legId !== path.legId ||
        intent.legKind !== "megapot_pool" ||
        intent.funderAccountId !== principal.accountId
      ) {
        throw new NotFound({ message: "Reward funding target is unavailable" });
      }
      return { funding: funding(intent) };
    },
    ObserveAssetBonusFunding: async (request) => {
      const principal = user(request.principal);
      const path = request.params as { readonly legId: string; readonly fundingEffectId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly transaction_hash: string;
      };
      const result = await run(
        rewards.observeFunding({
          accountId: principal.accountId,
          personaId: body.persona_id,
          legId: path.legId,
          legKind: "asset_bonus",
          fundingEffectId: path.fundingEffectId,
          idempotencyKey: body.idempotency_key,
          transactionHash: body.transaction_hash,
        }),
      );
      if (result.funding.intent.legKind !== "asset_bonus") {
        throw new NotFound({ message: "Reward funding target is unavailable" });
      }
      return { funding: assetFunding(result.funding.intent), replayed: result.replayed };
    },
    GetAssetBonusFunding: async (request) => {
      const principal = user(request.principal);
      const path = request.params as { readonly legId: string; readonly fundingEffectId: string };
      const intent = await Effect.runPromise(
        services.fundingStore.find(path.fundingEffectId).pipe(Effect.mapError(wireFailure)),
      );
      if (
        intent === null ||
        intent.legId !== path.legId ||
        intent.legKind !== "asset_bonus" ||
        intent.funderAccountId !== principal.accountId
      ) {
        throw new NotFound({ message: "Reward funding target is unavailable" });
      }
      return { funding: assetFunding(intent) };
    },
    GetSongMegapotPool: async (request) => {
      const path = request.params as { readonly communityId: string; readonly postId: string };
      const pool = await Effect.runPromise(
        services.projections
          .findPublicSongPool({ communityId: path.communityId, postId: path.postId })
          .pipe(Effect.mapError((error) => wireFailure(error as RewardProjectionFailure))),
      );
      return { pool: pool === null ? null : poolProjection(pool) };
    },
    ListSongAssetBonuses: async (request) => {
      const path = request.params as { readonly communityId: string; readonly postId: string };
      const items = await Effect.runPromise(
        services.projections
          .listPublicSongAssetBonuses({
            accountId: optionalAccountId(request.principal),
            communityId: path.communityId,
            postId: path.postId,
          })
          .pipe(Effect.mapError((error) => wireFailure(error as RewardProjectionFailure))),
      );
      return {
        object: "song_asset_bonus_list" as const,
        items: items.map(assetBonusProjection),
      };
    },
    GetMegapotPoolStanding: async (request) => {
      const principal = user(request.principal);
      const path = request.params as { readonly legId: string };
      const standing = await Effect.runPromise(
        services.projections
          .findStanding({ accountId: principal.accountId, legId: path.legId })
          .pipe(Effect.mapError((error) => wireFailure(error as RewardProjectionFailure))),
      );
      if (standing === null) throw new NotFound({ message: "Reward projection is unavailable" });
      return {
        standing: {
          object: "megapot_pool_standing" as const,
          leg_id: standing.legId,
          drawing_id: standing.drawingId?.toString() ?? null,
          participant_state: standing.participantState,
          share_held: standing.shareHeld,
          share_amount_atomic: standing.shareAmountAtomic?.toString() ?? null,
          sponsor_fallback_state: standing.sponsorFallbackState,
          sponsor_fallback_amount_atomic: standing.sponsorFallbackAmountAtomic?.toString() ?? null,
          reward_credit_id: standing.rewardCreditId,
          reward_credit_state: standing.rewardCreditState,
          beneficiary_count: standing.beneficiaryCount,
        },
      };
    },
    ListMyRewardCredits: async (request) => {
      const principal = user(request.principal);
      const query = request.query as { readonly cursor?: string; readonly limit?: string };
      const result = await Effect.runPromise(
        services.projections
          .listCredits({
            accountId: principal.accountId,
            cursor: query.cursor ?? null,
            limit: query.limit === undefined ? 25 : Number(query.limit),
          })
          .pipe(Effect.mapError((error) => wireFailure(error as RewardProjectionFailure))),
      );
      return {
        object: "reward_credit_list" as const,
        items: result.items.map(rewardCredit),
        next_cursor: result.nextCursor,
      };
    },
  };
}
