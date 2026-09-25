import { describe, expect, test } from "bun:test";
import type {
  AssetBonusLeg,
  MegapotPoolLeg,
  RewardFundingIntent,
  RewardFundingStore,
  RewardGasTopupRequester,
  RewardProjectionStore,
  RewardWinnerSendRecord,
  RewardWinnerSendService,
  SongRewardOfferStore,
} from "@pirate/application/rewards/song-reward-offers";
import {
  RewardGasTopupRejected,
  RewardProjectionRejected,
  RewardWinnerSendChainUnavailable,
  RewardWinnerSendRejected,
  SongRewardOfferRejected,
  SongRewardOfferStorageFailed,
} from "@pirate/application/rewards/song-reward-offers";
import { Effect } from "effect";
import {
  makeLazySongRewardOfferHandlers,
  makeSongRewardOfferHandlers,
  makeUnavailableSongRewardOfferHandlers,
} from "./rewards-song-offer-handlers.ts";
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
  qualificationPolicies: null,
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
  qualificationPolicies: null,
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

const claimCalls: { accountId: string; creditId: string }[] = [];

function fixture(
  fundingIntent: RewardFundingIntent = intent,
  options: {
    catalog?: SongRewardOfferStore["listAdmittedAssets"];
    policies?: SongRewardOfferStore["qualificationPolicies"];
    production?: boolean;
    gasTopups?: RewardGasTopupRequester | null;
    winnerSends?: RewardWinnerSendService | null;
  } = {},
) {
  const ids = ["open-action", "open-offer", "leg-action", "pool-leg", "observe-action"];
  const store: SongRewardOfferStore = {
    listAdmittedAssets: options.catalog ?? (() => Effect.succeed({ items: [], nextCursor: null })),
    // Only account_1's persona_1 owns one active wallet; anything else fails closed.
    fundingSender: ({ accountId, personaId }) =>
      accountId === "account_1" && personaId === "persona_1"
        ? Effect.succeed(fundingIntent.senderAddress)
        : Effect.fail(new SongRewardOfferRejected({ reason: "persona-ineligible" })),
    qualificationPolicies:
      options.policies ??
      (() =>
        Effect.succeed([
          {
            activity: "study",
            policy: {
              kind: "study_session_first_pass_v2",
              qualification_policy_version_id: "study_session_first_pass_v2@1",
              required_correct_bps: 7000,
            },
          },
        ])),
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
          qualificationPolicies: null,
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
        qualificationPolicies: null,
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
            claim: { status: "accepted", payoutStatus: "pending" },
            send: { sendId: "winner-send_1", status: "pending" },
          },
        ],
        nextCursor: null,
      }),
    issueClaimVerificationIntent: ({ accountId }) => {
      claimCalls.push({ accountId, creditId: "intent" });
      return Effect.succeed({ intentId: "reward-claim_1" });
    },
    claimCredit: ({ accountId, creditId }) => {
      claimCalls.push({ accountId, creditId });
      return creditId === "credit_2"
        ? Effect.succeed({
            outcome: "verification_missing" as const,
            credit: {
              creditId: "credit_2",
              payoutPersonaId: "persona_1",
              chainId: 84_532,
              tokenAddress: leg.tokenAddress,
              tokenDecimals: 6,
              amountAtomic: 150n,
              reservedAtomic: 0n,
              paidAtomic: 0n,
              sourceKind: "megapot_allocation" as const,
              state: "credited" as const,
              createdAt: now,
              updatedAt: now,
              settledAt: null,
              claim: { status: "unclaimed" as const, payoutStatus: null },
              send: null,
            },
          })
        : Effect.fail(new RewardProjectionRejected({ reason: "not-found" }));
    },
  };
  const handlers = makeSongRewardOfferHandlers({
    rewardCatalogAuthority: options.production
      ? null
      : { environment: "test", attestationId: "attestation_1" },
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
    gasTopups: options.gasTopups ?? null,
    winnerSends: options.winnerSends ?? null,
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
    // An email-only session: no wallet is proved at sign-in.
    authenticate: () => ({ kind: "user", subject: "account_1" }),
    authorize: () => undefined,
  });
}

describe("song reward offer HTTP handlers", () => {
  test("returns typed unavailability while retaining authentication boundaries", async () => {
    const worker = createHttpWorker({
      config: { corsOrigin: "https://app.pirate.test" },
      handlers: makeUnavailableSongRewardOfferHandlers(),
      authenticate: () => ({ kind: "user", subject: "account_1" }),
      authorize: () => undefined,
    });
    const publicProjection = await worker.request(
      "/communities/community_1/posts/post_1/rewards/megapot-pool",
    );
    expect(publicProjection.status).toBe(502);
    expect(await publicProjection.json()).toMatchObject({
      error: { code: "provider_unavailable", retryable: true },
    });

    const protectedRoute = await worker.request("/rewards/qualification-policies");
    expect(protectedRoute.status).toBe(401);
    expect(await protectedRoute.json()).toMatchObject({ error: { code: "auth_error" } });
  });

  test("contains an attestation load failure and retries instead of retaining its rejection", async () => {
    let attempts = 0;
    const readyHandlers = {
      ...makeUnavailableSongRewardOfferHandlers(),
      GetSongMegapotPool: async () => ({ state: "ready" }),
    };
    const handlers = makeLazySongRewardOfferHandlers(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("attestation unavailable");
      return readyHandlers;
    });
    const request = { body: undefined, headers: undefined, params: {}, query: {}, principal: null };

    await expect(handlers.GetSongMegapotPool(request)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(handlers.GetSongMegapotPool(request)).resolves.toEqual({ state: "ready" });
    expect(attempts).toBe(2);
  });

  test("serves bounded authenticated asset discovery and distinguishes unavailable storage", async () => {
    const asset = {
      chain_id: 84_532,
      token_address: address("b"),
      token_decimals: 18,
      token_symbol: "BONUS",
      asset_policy_version: "bonus-v1",
    } as const;
    const calls: Parameters<SongRewardOfferStore["listAdmittedAssets"]>[0][] = [];
    const worker = fixture(intent, {
      catalog: (input) => {
        calls.push(input);
        return Effect.succeed({ items: [asset], nextCursor: asset.token_address });
      },
    });
    const response = await worker.request(`/rewards/bonus-assets?limit=1&cursor=${address("a")}`, {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [asset], next_cursor: asset.token_address });
    expect(calls).toEqual([
      { environment: "test", attestationId: "attestation_1", cursor: address("a"), limit: 1 },
    ]);
    expect(
      (
        await worker.request("/rewards/bonus-assets?limit=51", {
          headers: { authorization: "Bearer test" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await worker.request("/rewards/bonus-assets?cursor=invalid", {
          headers: { authorization: "Bearer test" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fixture(intent, { production: true, catalog: unexpected }).request(
          "/rewards/bonus-assets",
          { headers: { authorization: "Bearer test" } },
        )
      ).status,
    ).toBe(502);
    expect(
      (
        await fixture(intent, {
          catalog: () => Effect.fail(new SongRewardOfferStorageFailed({ reason: "unavailable" })),
        }).request("/rewards/bonus-assets", { headers: { authorization: "Bearer test" } })
      ).status,
    ).toBe(502);
    expect(
      await (
        await fixture().request("/rewards/bonus-assets", {
          headers: { authorization: "Bearer test" },
        })
      ).json(),
    ).toEqual({ items: [], next_cursor: null });
    const anonymous = createHttpWorker({
      config: { corsOrigin: "https://app.pirate.test" },
      authenticate: unexpected,
      authorize: unexpected,
      handlers: { ListAdmittedRewardAssets: unexpected },
    });
    expect((await anonymous.request("/rewards/bonus-assets")).status).toBe(401);
    const disabled = createHttpWorker({
      config: { corsOrigin: "https://app.pirate.test" },
      handlers: {},
    });
    expect(
      (
        await disabled.request("/rewards/bonus-assets", {
          headers: { authorization: "Bearer test" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fixture(intent, {
          policies: () =>
            Effect.fail(
              new SongRewardOfferRejected({ reason: "qualification-policy-unavailable" }),
            ),
        }).request("/rewards/qualification-policies", { headers: { authorization: "Bearer test" } })
      ).status,
    ).toBe(502);
  });

  test("serves qualification policy previews without caching", async () => {
    const response = await fixture().request("/rewards/qualification-policies", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      policies: [
        {
          activity: "study",
          policy: {
            kind: "study_session_first_pass_v2",
            required_correct_bps: 7_000,
            qualification_policy_version_id: "study_session_first_pass_v2@1",
          },
        },
      ],
    });
    const anonymous = createHttpWorker({
      config: { corsOrigin: "https://app.pirate.test" },
      authenticate: unexpected,
      authorize: unexpected,
      handlers: { GetRewardQualificationPolicies: unexpected },
    });
    expect((await anonymous.request("/rewards/qualification-policies")).status).toBe(401);
  });

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

  test("pins the persona wallet as sender and refuses a persona without one", async () => {
    const worker = fixture();
    const headers = { authorization: "Bearer test", "content-type": "application/json" };
    const body = (personaId: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        idempotency_key: "leg_sender",
        persona_id: personaId,
        funding_amount_atomic: "5000000",
        max_ticket_price_atomic: "1000000",
        entry_cutoff_seconds: 300,
        eligible_activities: ["study"],
        min_score_bps: 7000,
        empty_pool_policy: "no_purchase",
        fallback_payout_persona_id: null,
        fallback_disclosure_acknowledged: false,
        ...extra,
      });
    const pinned = await worker.request("/reward-offers/reward_offer_1/megapot-pool-legs", {
      method: "POST",
      headers,
      body: body("persona_1"),
    });
    expect(pinned.status).toBe(201);
    expect(await pinned.json()).toMatchObject({
      funding: { sender_address: intent.senderAddress },
    });
    // A caller-supplied sender is not part of the contract and is rejected.
    const steered = await worker.request("/reward-offers/reward_offer_1/megapot-pool-legs", {
      method: "POST",
      headers,
      body: body("persona_1", { sender_address: address("9") }),
    });
    expect(steered.status).toBe(400);
    const foreign = await worker.request("/reward-offers/reward_offer_1/megapot-pool-legs", {
      method: "POST",
      headers,
      body: body("persona_without_wallet"),
    });
    expect(foreign.status).toBe(404);
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

  test("claims a participant credit as the signed-in account only", async () => {
    claimCalls.length = 0;
    const unauthenticated = await fixture().request("/rewards/credits/credit_2/claim", {
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);
    expect(claimCalls).toEqual([]);

    const headers = { authorization: "Bearer test" };
    const claimed = await fixture().request("/rewards/credits/credit_2/claim", {
      method: "POST",
      headers,
    });
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get("cache-control")).toBe("no-store");
    expect(await claimed.json()).toMatchObject({
      outcome: "verification_missing",
      credit: {
        credit_id: "credit_2",
        amount_atomic: "150",
        state: "credited",
        claim: { status: "unclaimed", payout_status: null },
        send: null,
      },
    });
    const missing = await fixture().request("/rewards/credits/credit_9/claim", {
      method: "POST",
      headers,
    });
    expect(missing.status).toBe(404);
    expect(claimCalls.map((call) => call.creditId)).toEqual(["credit_2", "credit_9"]);
    expect(new Set(claimCalls.map((call) => call.accountId)).size).toBe(1);

    const credits = await fixture().request("/rewards/credits?limit=25", { headers });
    expect(await credits.json()).toMatchObject({
      items: [
        {
          credit_id: "credit_1",
          claim: { status: "accepted", payout_status: "pending" },
          send: { send_id: "winner-send_1", status: "pending" },
        },
      ],
    });
  });

  test("issues a reward-claim Very intent for the signed-in account only", async () => {
    claimCalls.length = 0;
    const unauthenticated = await fixture().request("/rewards/claim-verification-intents", {
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);
    const issued = await fixture().request("/rewards/claim-verification-intents", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(await issued.json()).toEqual({ intent_id: "reward-claim_1", provider_id: "very.web" });
    expect(claimCalls).toEqual([{ accountId: "account_1", creditId: "intent" }]);
  });

  test("requests and reads gas top-ups for the signed-in account only", async () => {
    const requests: { accountId: string; creditId: string; idempotencyKey: string }[] = [];
    const gasTopups: RewardGasTopupRequester = {
      request: (input) => {
        requests.push(input);
        return Effect.succeed(
          input.creditId === "credit_full"
            ? { status: "not_needed" as const, topupId: null, amountWei: null }
            : { status: "pending" as const, topupId: "gas-topup_1", amountWei: 30_000n },
        );
      },
      get: ({ accountId, topupId }) =>
        accountId === "account_1" && topupId === "gas-topup_1"
          ? Effect.succeed({
              topupId,
              creditId: "credit_1",
              status: "broadcast" as const,
              amountWei: 30_000n,
              transactionHash: hash("e"),
            })
          : Effect.fail(new RewardGasTopupRejected({ reason: "not-found" })),
    };
    const worker = fixture(intent, { gasTopups });
    const post = (body: unknown, authorized = true) =>
      worker.request("/rewards/gas-topups", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorized ? { authorization: "Bearer test" } : {}),
        },
        body: JSON.stringify(body),
      });

    expect((await post({ credit_id: "credit_1", idempotency_key: "key_1" }, false)).status).toBe(
      401,
    );
    expect((await worker.request("/rewards/gas-topups/gas-topup_1")).status).toBe(401);

    const pending = await post({ credit_id: "credit_1", idempotency_key: "key_1" });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({
      status: "pending",
      topup_id: "gas-topup_1",
      amount_wei: "30000",
    });
    const full = await post({ credit_id: "credit_full", idempotency_key: "key_2" });
    expect(await full.json()).toEqual({ status: "not_needed", topup_id: null, amount_wei: null });
    // The account always comes from the session, never the body.
    expect(requests.map((entry) => entry.accountId)).toEqual(["account_1", "account_1"]);

    const own = await worker.request("/rewards/gas-topups/gas-topup_1", {
      headers: { authorization: "Bearer test" },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({
      status: "broadcast",
      amount_wei: "30000",
      transaction_hash: hash("e"),
    });
    const foreign = await worker.request("/rewards/gas-topups/gas-topup_other", {
      headers: { authorization: "Bearer test" },
    });
    expect(foreign.status).toBe(404);
  });

  test("records and reads winner sends for the signed-in account only", async () => {
    const sendRecord: RewardWinnerSendRecord = {
      sendId: "winner-send_1",
      creditId: "credit_1",
      accountId: "account_1",
      status: "pending",
      chainId: 84_532,
      senderAddress: address("a"),
      recipientAddress: address("d"),
      tokenAddress: leg.tokenAddress,
      amountAtomic: 400_000n,
      nonce: 5n,
      attempt: 1,
      transactionHashes: [hash("e")],
      cancellationHashes: [],
    };
    const calls: string[] = [];
    const own = (
      accountId: string,
      id: string,
    ): Effect.Effect<RewardWinnerSendRecord, RewardWinnerSendRejected> =>
      accountId === "account_1" && (id === "winner-send_1" || id === "credit_1")
        ? Effect.succeed(sendRecord)
        : Effect.fail(new RewardWinnerSendRejected({ reason: "not-found" }));
    const winnerSends: RewardWinnerSendService = {
      request: (input) => {
        calls.push(`request:${input.accountId}:${input.creditId}:${input.recipientAddress}`);
        if (input.amountAtomic > 1_000_000n) {
          return Effect.fail(new RewardWinnerSendRejected({ reason: "invalid-amount" }));
        }
        if (input.idempotencyKey === "key_conflict") {
          return Effect.fail(new RewardWinnerSendRejected({ reason: "send-conflict" }));
        }
        if (input.idempotencyKey === "key_busy") {
          return Effect.fail(new RewardWinnerSendRejected({ reason: "sender-busy" }));
        }
        return own(input.accountId, input.creditId);
      },
      attachTransaction: (input) => {
        calls.push(`attach:${input.accountId}:${input.sendId}`);
        return input.transactionHash === hash("0")
          ? Effect.fail(new RewardWinnerSendRejected({ reason: "transaction-not-found" }))
          : input.transactionHash === hash("1")
            ? Effect.fail(new RewardWinnerSendChainUnavailable({ reason: "rpc-unavailable" }))
            : own(input.accountId, input.sendId);
      },
      cancel: (input) => {
        calls.push(`cancel:${input.accountId}:${input.sendId}`);
        if (input.transactionHash === hash("2")) {
          return Effect.fail(new RewardWinnerSendRejected({ reason: "send-conflict" }));
        }
        return own(input.accountId, input.sendId).pipe(
          Effect.map((value) => ({
            ...value,
            status: "cancelled" as const,
            cancellationHashes: [input.transactionHash.toLowerCase()],
          })),
        );
      },
      get: (input) => own(input.accountId, input.sendId),
      getByCredit: (input) => own(input.accountId, input.creditId),
    };
    const worker = fixture(intent, { winnerSends });
    const headers = { "content-type": "application/json", authorization: "Bearer test" };
    const post = (path: string, body: unknown, authorized = true) =>
      worker.request(path, {
        method: "POST",
        headers: authorized ? headers : { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const body = { recipient: address("D"), amount_atomic: "400000", idempotency_key: "key_1" };

    expect((await post("/rewards/credits/credit_1/send", body, false)).status).toBe(401);
    expect((await worker.request("/rewards/winner-sends/winner-send_1")).status).toBe(401);
    expect((await worker.request("/rewards/credits/credit_1/send")).status).toBe(401);
    expect(
      (
        await post(
          "/rewards/winner-sends/winner-send_1/transactions",
          { transaction_hash: hash("e") },
          false,
        )
      ).status,
    ).toBe(401);
    expect(calls).toEqual([]);

    const wire = {
      object: "reward_winner_send",
      send_id: "winner-send_1",
      credit_id: "credit_1",
      status: "pending",
      chain_id: 84_532,
      sender: address("a"),
      recipient: address("d"),
      token_address: leg.tokenAddress,
      amount_atomic: "400000",
      nonce: 5,
      attempt: 1,
      transaction_hashes: [hash("e")],
      cancellation_hashes: [],
    };
    const created = await post("/rewards/credits/credit_1/send", body);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual(wire);
    // The account always comes from the session.
    expect(calls).toEqual([`request:account_1:credit_1:${address("D")}`]);
    expect((await post("/rewards/credits/credit_other/send", body)).status).toBe(404);
    expect(
      (await post("/rewards/credits/credit_1/send", { ...body, amount_atomic: "1000001" })).status,
    ).toBe(400);
    expect(
      (await post("/rewards/credits/credit_1/send", { ...body, recipient: "0x12" })).status,
    ).toBe(400);
    expect(
      (await post("/rewards/credits/credit_1/send", { ...body, idempotency_key: "key_conflict" }))
        .status,
    ).toBe(409);
    const busy = await post("/rewards/credits/credit_1/send", {
      ...body,
      idempotency_key: "key_busy",
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({
      error: { code: "conflict", message: "Another send from this wallet is in progress" },
    });

    const attached = await post("/rewards/winner-sends/winner-send_1/transactions", {
      transaction_hash: hash("e"),
    });
    expect(await attached.json()).toEqual(wire);
    const unknown = await post("/rewards/winner-sends/winner-send_1/transactions", {
      transaction_hash: hash("0"),
    });
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ error: { code: "conflict", retryable: true } });
    const rpcDown = await post("/rewards/winner-sends/winner-send_1/transactions", {
      transaction_hash: hash("1"),
    });
    expect(await rpcDown.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    expect(
      (
        await post("/rewards/winner-sends/winner-send_other/transactions", {
          transaction_hash: hash("e"),
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await post(
          "/rewards/winner-sends/winner-send_1/cancellation",
          { transaction_hash: hash("c") },
          false,
        )
      ).status,
    ).toBe(401);
    const cancelled = await post("/rewards/winner-sends/winner-send_1/cancellation", {
      transaction_hash: hash("C"),
    });
    expect(await cancelled.json()).toEqual({
      ...wire,
      status: "cancelled",
      cancellation_hashes: [hash("c")],
    });
    const settled = await post("/rewards/winner-sends/winner-send_1/cancellation", {
      transaction_hash: hash("2"),
    });
    expect(settled.status).toBe(409);
    expect(
      (
        await post("/rewards/winner-sends/winner-send_other/cancellation", {
          transaction_hash: hash("c"),
        })
      ).status,
    ).toBe(404);
    expect(calls.filter((call) => call.startsWith("cancel:"))).toEqual([
      "cancel:account_1:winner-send_1",
      "cancel:account_1:winner-send_1",
      "cancel:account_1:winner-send_other",
    ]);

    const authorized = { headers: { authorization: "Bearer test" } };
    const read = await worker.request("/rewards/winner-sends/winner-send_1", authorized);
    expect(await read.json()).toEqual(wire);
    const byCredit = await worker.request("/rewards/credits/credit_1/send", authorized);
    expect(await byCredit.json()).toEqual(wire);
    expect(
      (await worker.request("/rewards/winner-sends/winner-send_other", authorized)).status,
    ).toBe(404);
    expect((await worker.request("/rewards/credits/credit_other/send", authorized)).status).toBe(
      404,
    );
  });

  test("reports winner sends as unavailable without a chain client", async () => {
    const response = await fixture().request("/rewards/winner-sends/winner-send_1", {
      headers: { authorization: "Bearer test" },
    });
    expect(await response.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    const disabled = createHttpWorker({
      config: { corsOrigin: "https://app.pirate.test" },
      handlers: makeUnavailableSongRewardOfferHandlers(),
      authenticate: () => ({ kind: "user", subject: "account_1" }),
      authorize: () => undefined,
    });
    const unavailable = await disabled.request("/rewards/credits/credit_1/send", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({
        recipient: address("d"),
        amount_atomic: "1",
        idempotency_key: "key_1",
      }),
    });
    expect(await unavailable.json()).toMatchObject({ error: { code: "provider_unavailable" } });
  });

  test("reports gas top-ups as unavailable when their limits are not configured", async () => {
    const response = await fixture().request("/rewards/gas-topups", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ credit_id: "credit_1", idempotency_key: "key_1" }),
    });
    expect(await response.json()).toMatchObject({ error: { code: "provider_unavailable" } });
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
