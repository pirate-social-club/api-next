import {
  Clock,
  IdGen,
  type MegapotPoolLeg,
  makeSongRewardOfferService,
  type RewardFundingIntent,
  type RewardFundingPlanner,
  type RewardFundingStore,
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
  requiredConfirmations: number;
  externalFallbackPolicy: Readonly<{
    referralAllocationVersion: string;
    referralPolicyHash: string;
  }> | null;
}>;

export type SongRewardOfferHandlers = Readonly<{
  OpenSongRewardOffer: EndpointHandler;
  AddMegapotPoolLeg: EndpointHandler;
  ObserveMegapotPoolFunding: EndpointHandler;
  GetMegapotPoolFunding: EndpointHandler;
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

const funding = (value: RewardFundingIntent) => ({
  object: "megapot_pool_funding" as const,
  action: "fund_with_usdc" as const,
  funding_effect_id: value.fundingEffectId,
  leg_id: value.legId,
  status: value.state,
  chain_id: value.chainId as 84_532,
  token_address: value.usdcAddress,
  token_decimals: 6 as const,
  sender_address: value.senderAddress,
  recipient_address: value.recipientAddress,
  expected_amount_atomic: value.expectedAmountAtomic.toString(),
  confirmed_amount_atomic: value.confirmedAmountAtomic?.toString() ?? null,
  required_confirmations: value.requiredConfirmations,
  transaction_hash: value.transactionHash,
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
          fundingEffectId: path.fundingEffectId,
          idempotencyKey: body.idempotency_key,
          transactionHash: body.transaction_hash,
        }),
      );
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
        intent.funderAccountId !== principal.accountId
      ) {
        throw new NotFound({ message: "Reward funding target is unavailable" });
      }
      return { funding: funding(intent) };
    },
  };
}
