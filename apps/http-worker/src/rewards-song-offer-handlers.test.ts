import { describe, expect, test } from "bun:test";
import type {
  MegapotPoolLeg,
  RewardFundingIntent,
  RewardFundingStore,
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
};

const intent: RewardFundingIntent = {
  fundingEffectId: hash("f"),
  legId: leg.legId,
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
  usdcAddress: leg.tokenAddress,
  custodyAddress: leg.custodyAddress,
  jackpotAddress: address("1"),
  ticketNftAddress: address("3"),
  referrerAddress: address("6"),
  jackpotCodeHash: hash("7"),
  usdcCodeHash: hash("8"),
  ticketNftCodeHash: hash("9"),
};

const unexpected = (): never => {
  throw new Error("unexpected fake call");
};

function fixture() {
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
    recordFundingObservation: () => Effect.succeed({ replayed: false }),
  };
  const fundingStore: RewardFundingStore = {
    plan: unexpected,
    find: () => Effect.succeed(intent),
    bindTransaction: unexpected,
    confirm: unexpected,
    revert: unexpected,
    requireReconciliation: unexpected,
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
    funding: {
      plan: () => Effect.succeed({ kind: "planned", intent }),
      observe: ({ transactionHash }) =>
        Effect.succeed({
          kind: "confirming",
          intent: { ...intent, state: "confirming", transactionHash },
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
      walletAddress: intent.senderAddress,
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
});
