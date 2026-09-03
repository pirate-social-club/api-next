import { describe, expect, test } from "bun:test";
import type {
  AssetBonusLeg,
  MegapotPoolLeg,
  RewardFundingIntent,
  RewardFundingStore,
  RewardProjectionStore,
  SongRewardOfferStore,
} from "@pirate/application/rewards/song-reward-offers";
import { Effect } from "effect";
import { makeSongRewardOfferHandlers } from "./rewards-song-offer-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const now = "2026-08-26T12:00:00.000Z";

const leg: MegapotPoolLeg = {
  legId: "reward_leg_1",
  offerId: "reward_offer_1",
  status: "funding",
  funderAccountId: "account_1",
  chainId: 84_532,
  tokenAddress: address("2"),
  tokenDecimals: 6,
  custodyAddress: address("4"),
  maxTicketPriceAtomic: 1_000_000n,
  entryCutoffSeconds: 300,
  participationStartsDrawingId: 42n,
  eligibleActivities: ["study", "karaoke"],
  minScoreBps: 7_000,
  emptyPoolPolicy: "no_purchase",
  fallbackPayoutPersonaId: null,
  fundedAtomic: 0n,
  legTermsHash: hash("b"),
  ownerPolicyKind: "frozen_policy",
  ownerPolicyRevision: 1,
  ownerPolicyHash: "1".repeat(64),
};
const assetLeg: AssetBonusLeg = {
  legId: "reward_asset_leg_1",
  offerId: "reward_offer_1",
  status: "funding",
  funderAccountId: "account_1",
  chainId: 84_532,
  tokenAddress: address("b"),
  tokenDecimals: 18,
  tokenSymbol: "BONUS",
  assetPolicyVersion: "bonus-v1",
  custodyAddress: address("4"),
  amountPerClaimAtomic: 100n,
  maxClaims: 10,
  fundedAtomic: 0n,
  fulfilledAtomic: 0n,
  legTermsHash: hash("c"),
  ownerPolicyKind: "frozen_policy",
  ownerPolicyRevision: 1,
  ownerPolicyHash: "1".repeat(64),
};

const intent: RewardFundingIntent = {
  fundingEffectId: hash("f"),
  legId: leg.legId,
  legKind: "megapot_pool",
  funderAccountId: "account_1",
  senderAddress: address("5"),
  recipientAddress: leg.custodyAddress,
  expectedAmountAtomic: 5_000_000n,
  requiredConfirmations: 3,
  state: "planned",
  transactionHash: null,
  confirmedAmountAtomic: null,
  transferLogIndex: null,
  blockNumber: null,
  blockHash: null,
  attestationId: "attestation_1",
  environment: "staging",
  chainId: 84_532,
  tokenAddress: leg.tokenAddress,
  tokenDecimals: leg.tokenDecimals,
  usdcAddress: leg.tokenAddress,
  custodyAddress: leg.custodyAddress,
  jackpotAddress: address("1"),
  ticketNftAddress: address("3"),
  referrerAddress: address("6"),
  jackpotCodeHash: hash("7"),
  usdcCodeHash: hash("8"),
  ticketNftCodeHash: hash("9"),
};
const assetIntent: RewardFundingIntent = {
  ...intent,
  legId: assetLeg.legId,
  legKind: "asset_bonus",
  tokenAddress: assetLeg.tokenAddress,
  tokenDecimals: assetLeg.tokenDecimals,
};

const unexpected = (): never => {
  throw new Error("unexpected fake call");
};

function fixture(fundingIntent: RewardFundingIntent = intent) {
  const ids = ["open-action", "open-offer", "leg-action", "pool-leg", "observe-action"];
  const store: SongRewardOfferStore = {
    openOffer: (input) =>
      Effect.succeed({
        replayed: false,
        offer: {
          offerId: "reward_offer_1",
          communityId: input.communityId,
          postId: input.postId,
          audioRevision: 3,
          createdByAccountId: input.accountId,
          status: "draft",
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          termsHash: input.termsHash,
        },
      }),
    addMegapotPoolLeg: () => Effect.succeed({ leg, replayed: false }),
    addAssetBonusLeg: () => Effect.succeed({ leg: assetLeg, replayed: false }),
    recordFundingObservation: () => Effect.succeed({ replayed: false }),
  };
  const fundingStore: RewardFundingStore = {
    plan: unexpected,
    find: () => Effect.succeed(fundingIntent),
    bindTransaction: unexpected,
    confirm: unexpected,
    revert: unexpected,
    requireReconciliation: unexpected,
  };
  const projections: RewardProjectionStore = {
    listPublicSongAssetBonuses: ({ accountId }) =>
      Effect.succeed([
        {
          offerId: assetLeg.offerId,
          legId: assetLeg.legId,
          communityId: "community_1",
          postId: "post_1",
          offerStatus: "active",
          legStatus: "active",
          chainId: assetLeg.chainId,
          tokenAddress: assetLeg.tokenAddress,
          tokenDecimals: assetLeg.tokenDecimals,
          tokenSymbol: assetLeg.tokenSymbol,
          assetPolicyVersion: assetLeg.assetPolicyVersion,
          amountPerClaimAtomic: assetLeg.amountPerClaimAtomic,
          maxClaims: assetLeg.maxClaims,
          claimedCount: 2,
          availableInventoryAtomic: 800n,
          viewerState: accountId === null ? null : "claimable",
          viewerCreditId: null,
          viewerCreditState: null,
        },
      ]),
    findPublicSongPool: () =>
      Effect.succeed({
        offerId: "reward_offer_1",
        legId: leg.legId,
        communityId: "community_1",
        postId: "post_1",
        offerStatus: "active",
        legStatus: "active",
        chainId: 84_532,
        tokenAddress: leg.tokenAddress,
        tokenDecimals: 6,
        fundedAtomic: 5_000_000n,
        availableBudgetAtomic: 4_000_000n,
        maxTicketPriceAtomic: 1_000_000n,
        entryCutoffSeconds: 300,
        eligibleActivities: ["study", "karaoke"],
        minScoreBps: 7_000,
        emptyPoolPolicy: "no_purchase",
        fundingSource: "leg_budget",
        drawing: {
          drawingId: 42n,
          lifecycleStatus: "entry_open",
          state: "entry_open",
          entryCutoffAt: "2026-08-26T12:55:00.000Z",
          beneficiaryCount: 2,
          ticketPriceCeilingAtomic: 1_000_000n,
          actualTicketCostAtomic: 0n,
          grossPrizePoolAtomic: 9_007_199_254_740_993n,
          globalTicketsBought: 7n,
          prizePoolObservedAt: "2026-08-26T12:50:00.000Z",
          prizePoolBasis:
            "gross_observed_before_referral_win_share_terminal_last_observed_pre_rollover",
          globalTicketsBasis: "drawing_wide_all_megapot_buyers",
          netWinningsAtomic: 0n,
          commitmentReference: null,
          snapshotHash: null,
          ticketId: null,
          purchaseTransactionHash: null,
          claimTransactionHash: null,
        },
      }),
    findStanding: () =>
      Effect.succeed({
        legId: leg.legId,
        drawingId: 42n,
        participantState: "your_share_held",
        shareHeld: true,
        shareAmountAtomic: null,
        sponsorFallbackState: null,
        sponsorFallbackAmountAtomic: null,
        rewardCreditId: null,
        rewardCreditState: null,
        beneficiaryCount: 2,
      }),
    listCredits: () =>
      Effect.succeed({
        items: [
          {
            creditId: "credit_1",
            payoutPersonaId: "persona_1",
            chainId: 84_532,
            tokenAddress: leg.tokenAddress,
            tokenDecimals: 6,
            amountAtomic: 901n,
            reservedAtomic: 100n,
            paidAtomic: 0n,
            sourceKind: "megapot_allocation",
            state: "payout_reserved",
            createdAt: now,
            updatedAt: now,
            settledAt: null,
          },
        ],
        nextCursor: null,
      }),
  };
  const handlers = makeSongRewardOfferHandlers({
    clock: { now: Effect.succeed(Date.parse(now)) },
    ids: {
      next: Effect.sync(() => {
        const id = ids.shift();
        if (id === undefined) throw new Error("identifier sequence exhausted");
        return id;
      }),
    },
    store,
    fundingStore,
    projections,
    funding: {
      plan: () => Effect.succeed({ kind: "planned", intent: fundingIntent }),
      observe: ({ transactionHash }) =>
        Effect.succeed({
          kind: "confirming",
          intent: { ...fundingIntent, state: "confirming", transactionHash },
        }),
    },
    requiredConfirmations: 3,
    externalFallbackPolicy: null,
  });
  return createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers,
    authenticate: () => ({
      kind: "user",
      subject: "account_1",
      walletAddress: fundingIntent.senderAddress,
    }),
    authorize: () => undefined,
  });
}

describe("song reward offer HTTP handlers", () => {
  test("opens an offer then returns Fund with USDC custody instructions", async () => {
    const worker = fixture();
    const headers = { authorization: "Bearer test", "content-type": "application/json" };
    const opened = await worker.request("/communities/community_1/posts/post_1/reward-offers", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotency_key: "open_1",
        persona_id: "persona_1",
        starts_at: now,
        ends_at: "2026-09-26T12:00:00.000Z",
      }),
    });
    expect(opened.status).toBe(201);
    expect(await opened.json()).toMatchObject({
      offer: { object: "song_reward_offer", audio_revision: 3 },
    });

    const added = await worker.request("/reward-offers/reward_offer_1/megapot-pool-legs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotency_key: "leg_1",
        persona_id: "persona_1",
        funding_amount_atomic: "5000000",
        max_ticket_price_atomic: "1000000",
        entry_cutoff_seconds: 300,
        eligible_activities: ["study", "karaoke"],
        min_score_bps: 7000,
        empty_pool_policy: "no_purchase",
        fallback_payout_persona_id: null,
        fallback_disclosure_acknowledged: false,
      }),
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      leg: { status: "funding", custody_address: leg.custodyAddress },
      funding: {
        action: "fund_with_usdc",
        sender_address: intent.senderAddress,
        recipient_address: leg.custodyAddress,
      },
    });
  });

  test("binds an observed transaction to the authenticated funder and exact effect", async () => {
    const worker = fixture();
    const response = await worker.request(
      `/reward-offer-legs/${leg.legId}/funding/${intent.fundingEffectId}/observations`,
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: "observe_1",
          persona_id: "persona_1",
          transaction_hash: hash("a"),
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      funding: { status: "confirming", transaction_hash: hash("a") },
      replayed: false,
    });
  });

  test("adds and publicly projects an exact whitelisted asset bonus", async () => {
    const headers = { authorization: "Bearer test", "content-type": "application/json" };
    const added = await fixture(assetIntent).request(
      "/reward-offers/reward_offer_1/asset-bonus-legs",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotency_key: "asset_1",
          persona_id: "persona_1",
          funding_amount_atomic: "1000",
          chain_id: 84_532,
          token_address: assetLeg.tokenAddress,
          token_decimals: 18,
          token_symbol: "BONUS",
          asset_policy_version: "bonus-v1",
          amount_per_claim_atomic: "100",
          max_claims: 10,
        }),
      },
    );
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      leg: {
        object: "asset_bonus_leg",
        token_address: assetLeg.tokenAddress,
        token_symbol: "BONUS",
        amount_per_claim_atomic: "100",
      },
      funding: {
        object: "asset_bonus_funding",
        action: "fund_with_asset",
        token_address: assetLeg.tokenAddress,
        recipient_address: assetLeg.custodyAddress,
      },
    });

    const observed = await fixture(assetIntent).request(
      `/asset-bonus-legs/${assetLeg.legId}/funding/${assetIntent.fundingEffectId}/observations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotency_key: "observe_asset_1",
          persona_id: "persona_1",
          transaction_hash: hash("a"),
        }),
      },
    );
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({
      funding: {
        object: "asset_bonus_funding",
        token_address: assetLeg.tokenAddress,
        status: "confirming",
      },
    });
    const fundingState = await fixture(assetIntent).request(
      `/asset-bonus-legs/${assetLeg.legId}/funding/${assetIntent.fundingEffectId}`,
      { headers },
    );
    expect(fundingState.status).toBe(200);
    expect(await fundingState.json()).toMatchObject({
      funding: { object: "asset_bonus_funding", token_address: assetLeg.tokenAddress },
    });

    const publicProjection = await fixture(assetIntent).request(
      "/communities/community_1/posts/post_1/rewards/asset-bonuses",
    );
    expect(publicProjection.status).toBe(200);
    expect(await publicProjection.json()).toMatchObject({
      object: "song_asset_bonus_list",
      items: [
        {
          object: "song_asset_bonus_projection",
          token_address: assetLeg.tokenAddress,
          claimed_count: 2,
          available_inventory_atomic: "800",
          viewer_state: null,
        },
      ],
    });
  });

  test("serves a beneficiary-private public pool projection", async () => {
    const response = await fixture().request(
      "/communities/community_1/posts/post_1/rewards/megapot-pool",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      pool: {
        object: "song_megapot_pool_projection",
        ticket_custody: "pirate",
        allocation_rule: "equal_v1",
        drawing: {
          state: "entry_open",
          beneficiary_count: 2,
          gross_prize_pool_atomic: "9007199254740993",
          global_tickets_bought: "7",
          prize_pool_observed_at: "2026-08-26T12:50:00.000Z",
          prize_pool_basis:
            "gross_observed_before_referral_win_share_terminal_last_observed_pre_rollover",
          global_tickets_basis: "drawing_wide_all_megapot_buyers",
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("account_1");
    expect(JSON.stringify(body)).not.toContain("persona_1");
    expect(JSON.stringify(body)).not.toContain(intent.senderAddress);
  });

  test("keeps participant standing and reward credits authenticated and no-store", async () => {
    const headers = { authorization: "Bearer test" };
    const standing = await fixture().request(`/reward-offer-legs/${leg.legId}/standing`, {
      headers,
    });
    expect(standing.status).toBe(200);
    expect(standing.headers.get("cache-control")).toBe("no-store");
    expect(await standing.json()).toMatchObject({
      standing: {
        participant_state: "your_share_held",
        share_held: true,
        beneficiary_count: 2,
      },
    });

    const credits = await fixture().request("/rewards/credits?limit=25", { headers });
    expect(credits.status).toBe(200);
    expect(credits.headers.get("cache-control")).toBe("no-store");
    expect(await credits.json()).toMatchObject({
      object: "reward_credit_list",
      items: [
        {
          credit_id: "credit_1",
          amount_atomic: "901",
          available_atomic: "801",
          state: "payout_reserved",
        },
      ],
    });
  });

  test("maps an internally reclaimable terminal plan to the stable wire status", async () => {
    const response = await fixture({ ...intent, state: "reclaimable_failed" }).request(
      `/reward-offer-legs/${leg.legId}/funding/${intent.fundingEffectId}`,
      { headers: { authorization: "Bearer test" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ funding: { status: "reverted" } });
  });
});
