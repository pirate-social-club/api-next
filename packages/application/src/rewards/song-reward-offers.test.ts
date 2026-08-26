import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Clock, IdGen } from "../ports.ts";
import type { RewardFundingIntent } from "./reward-funding.ts";
import {
  type MegapotPoolLeg,
  makeSongRewardOfferService,
  SongRewardOfferRejected,
  type SongRewardOfferStore,
} from "./song-reward-offers.ts";

const now = "2026-08-26T12:00:00.000Z";
const offer = {
  offerId: "reward_offer_1",
  communityId: "community_1",
  postId: "post_1",
  audioRevision: 3,
  createdByAccountId: "account_1",
  status: "draft" as const,
  startsAt: now,
  endsAt: "2026-09-26T12:00:00.000Z",
  termsHash: "a".repeat(64),
};
const leg: MegapotPoolLeg = {
  legId: "reward_leg_1",
  offerId: offer.offerId,
  status: "funding",
  funderAccountId: "account_1",
  chainId: 84_532,
  tokenAddress: `0x${"2".repeat(40)}`,
  tokenDecimals: 6,
  custodyAddress: `0x${"4".repeat(40)}`,
  maxTicketPriceAtomic: 1_000_000n,
  entryCutoffSeconds: 300,
  participationStartsDrawingId: 8n,
  eligibleActivities: ["study", "karaoke"],
  minScoreBps: 7_000,
  emptyPoolPolicy: "no_purchase",
  fallbackPayoutPersonaId: null,
  fundedAtomic: 0n,
  legTermsHash: `0x${"b".repeat(64)}`,
};

const fundingIntent: RewardFundingIntent = {
  fundingEffectId: `0x${"f".repeat(64)}`,
  legId: leg.legId,
  funderAccountId: "account_1",
  senderAddress: `0x${"5".repeat(40)}`,
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
  jackpotAddress: `0x${"1".repeat(40)}`,
  ticketNftAddress: `0x${"3".repeat(40)}`,
  referrerAddress: `0x${"6".repeat(40)}`,
  jackpotCodeHash: `0x${"7".repeat(64)}`,
  usdcCodeHash: `0x${"8".repeat(64)}`,
  ticketNftCodeHash: `0x${"9".repeat(64)}`,
};

const services = (ids: string[]) =>
  [
    Effect.provideService(Clock, { now: Effect.succeed(Date.parse(now)) }),
    Effect.provideService(IdGen, {
      next: Effect.sync(() => {
        const id = ids.shift();
        if (id === undefined) throw new Error("fake id sequence exhausted");
        return id;
      }),
    }),
  ] as const;

const unexpected = (): never => {
  throw new Error("unexpected fake-store call");
};

describe("song reward offer application service", () => {
  test("opens an idempotent offer and returns a user-authorized USDC funding instruction", async () => {
    const openCalls: unknown[] = [];
    const legCalls: unknown[] = [];
    const fundingCalls: unknown[] = [];
    const store: SongRewardOfferStore = {
      openOffer: (input) => {
        openCalls.push(input);
        return Effect.succeed({ offer, replayed: false });
      },
      addMegapotPoolLeg: (input) => {
        legCalls.push(input);
        return Effect.succeed({ leg, replayed: false });
      },
      recordFundingObservation: unexpected,
    };
    const service = makeSongRewardOfferService({
      store,
      requiredConfirmations: 3,
      externalFallbackPolicy: null,
      funding: {
        plan: (input) => {
          fundingCalls.push(input);
          return Effect.succeed({ kind: "planned", intent: fundingIntent });
        },
        observe: unexpected,
      },
    });
    const opened = await Effect.runPromise(
      service
        .openOffer({
          accountId: "account_1",
          personaId: "persona_1",
          communityId: "community_1",
          postId: "post_1",
          idempotencyKey: "open_1",
          startsAt: now,
          endsAt: offer.endsAt,
        })
        .pipe(...services(["action-open", "offer-open"])),
    );
    const added = await Effect.runPromise(
      service
        .addMegapotPoolLeg({
          accountId: "account_1",
          personaId: "persona_1",
          offerId: offer.offerId,
          idempotencyKey: "pool_1",
          senderAddress: fundingIntent.senderAddress,
          fundingAmountAtomic: 5_000_000n,
          maxTicketPriceAtomic: 1_000_000n,
          entryCutoffSeconds: 300,
          eligibleActivities: ["study", "karaoke"],
          minScoreBps: 7_000,
          emptyPoolPolicy: "no_purchase",
          fallbackPayoutPersonaId: null,
          fallbackDisclosureAcknowledged: false,
        })
        .pipe(...services(["action-leg", "pool-leg"])),
    );

    expect(opened.offer.offerId).toBe(offer.offerId);
    expect(added.funding.intent).toEqual(fundingIntent);
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]).toMatchObject({
      rewardPolicy: {
        version: "scarce_reward_v1",
        community_id: "community_1",
        offer_id: "reward_offer_offer-open",
        requirements: ["human.personhood", "credential.subject_unique"],
        uniqueness: { kind: "single_authority", authority_id: "reward_offer_offer-open" },
        legal_eligibility: {
          age: null,
          geography: null,
          disclosure: null,
          environment: "test_staging_empty_v1",
        },
      },
      rewardPolicyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(legCalls).toHaveLength(1);
    expect(fundingCalls).toEqual([
      {
        legId: leg.legId,
        funderAccountId: "account_1",
        senderAddress: fundingIntent.senderAddress,
        expectedAmountAtomic: 5_000_000n,
        requiredConfirmations: 3,
        idempotencyKey: "pool_1",
      },
    ]);
  });

  test("fails a fallback leg before persistence when disclosure policy is unresolved", async () => {
    const service = makeSongRewardOfferService({
      store: {
        openOffer: unexpected,
        addMegapotPoolLeg: unexpected,
        recordFundingObservation: unexpected,
      },
      funding: { plan: unexpected, observe: unexpected },
      requiredConfirmations: 3,
      externalFallbackPolicy: null,
    });
    const error = await Effect.runPromise(
      Effect.flip(
        service
          .addMegapotPoolLeg({
            accountId: "account_1",
            personaId: "persona_1",
            offerId: offer.offerId,
            idempotencyKey: "fallback_1",
            senderAddress: fundingIntent.senderAddress,
            fundingAmountAtomic: 5_000_000n,
            maxTicketPriceAtomic: 1_000_000n,
            entryCutoffSeconds: 300,
            eligibleActivities: ["study"],
            minScoreBps: 7_000,
            emptyPoolPolicy: "funder_fallback",
            fallbackPayoutPersonaId: "persona_1",
            fallbackDisclosureAcknowledged: true,
          })
          .pipe(...services([])),
      ),
    );
    expect(error).toBeInstanceOf(SongRewardOfferRejected);
    expect((error as SongRewardOfferRejected).reason).toBe("fallback-policy-unavailable");
  });
});
