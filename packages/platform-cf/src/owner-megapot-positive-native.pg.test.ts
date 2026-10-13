/** Genuine complete native source only. PG source/SDK/I/O protocol acceptance,
 * never live chain/R2/provider or staging acceptance. */
import { describe, expect, test } from "bun:test";
import {
  Clock,
  IdGen,
  makeSongRewardOfferService,
  prepareActivityPersona,
} from "@pirate/application";
import { GuestStudySessionV1 } from "@pirate/contracts";
import {
  postgresTestSchemaCatalogFingerprint,
  resetPostgresTestBaseline,
} from "@pirate/testing/postgres";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { keccak256, sha256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { confirmWallet } from "./activity-participation-composed-identity.pg-fixture.ts";
import { makeControlPlaneMegapotClaimStore } from "./megapot-claim-repository.ts";
import { makeR2MegapotCommitmentPublisher } from "./megapot-commitment-r2.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import { makeControlPlaneMegapotPurchaseStore } from "./megapot-purchase-repository.ts";
import { makeControlPlaneMegapotSweepStore } from "./megapot-sweep-repository.ts";
import { makeBaseSepoliaMegapotCommitmentSigner } from "./megapot-v2-signer.ts";
import { makeOwnedOrdinaryAccountBirthFixture } from "./ordinary-study-account-birth.pg-fixture.ts";
import { openOwnerDrawingsForObservation } from "./owner-drawing-opener.ts";
import { makeOwnerMegapotCommitmentCoordinator } from "./owner-megapot-commitment-coordinator.ts";
import {
  type RewardedFixture,
  rewardedFixture,
} from "./owner-megapot-rewarded-journey.pg-fixture.ts";
import { makeControlPlaneOwnerMegapotSettlementStore } from "./owner-megapot-settlement-store.ts";
import { hash, origin, pgUrl, run } from "./owner-study-starter.pg-fixture.ts";
import {
  makeControlPlanePersonaStore,
  makeControlPlanePersonaWalletStore,
} from "./persona-repository.ts";
import type { PostgresClientFactory } from "./postgres.ts";
import { makeControlPlaneRewardFundingStore } from "./reward-funding-repository.ts";
import { makeControlPlaneRewardRunAuthority } from "./reward-operations-control.ts";
import { makeControlPlaneRewardPayoutStore } from "./reward-payout-repository.ts";
import {
  makeControlPlaneOwnerMegapotPoolLegCreator,
  makeControlPlaneSongRewardOfferStore,
} from "./song-reward-offer-repository.ts";
import {
  insertStudySongFixture,
  insertTelegramPracticeReadinessFixture,
} from "./study-v2-ready-song.pg-fixture.ts";

const suite = pgUrl ? describe : describe.skip;
const address = (c: string) => `0x${c.repeat(40)}`;
const bytes32 = (c: string) => `0x${c.repeat(64)}`;
const hex = (s: string) => sha256(toBytes(s));
const Atomic = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/u));
const atomic = (value: unknown) => BigInt(Schema.decodeUnknownSync(Atomic)(value));
const withClock = <A, E>(e: Effect.Effect<A, E, Clock | IdGen>) =>
  run(
    e.pipe(
      Effect.provideService(Clock, { now: Effect.sync(() => Date.now()) }),
      Effect.provideService(IdGen, { next: Effect.sync(() => crypto.randomUUID()) }),
    ),
  );

// Reviewed owned positive schedule: two complete native lessons on ONE original
// drawing per case, then its actual cutoff. These are test-only initial values.
const positiveDrawingWindowMilliseconds = 150000;
const positiveCaseTimeoutMilliseconds = 300000;

async function setupPool(
  f: RewardedFixture,
  suffix: string,
  cutoffMilliseconds = 45000,
  includeRetainedV2 = false,
) {
  const key = generatePrivateKey(),
    custody = privateKeyToAccount(key).address.toLowerCase();
  // Genuine source-owned operator setup ONLY inside this uniquely owned schema.
  // No deployment/shared database or runtime role receives operator permission.
  await f.admin.query("BEGIN");
  try {
    await f.admin.query(
      "SELECT set_config('pirate.reward_run_lease_requirement_change','deployment',true)",
    );
    await f.admin.query("UPDATE reward_operations_run_lease SET required=TRUE WHERE singleton");
    await f.admin.query("COMMIT");
  } catch (error) {
    await f.admin.query("ROLLBACK");
    throw error;
  }
  await f.admin.query("SELECT acquire_reward_run_lease_v1($1,600,600)", [
    `owned-positive-${crypto.randomUUID()}`,
  ]);
  await f.admin.query(
    "SELECT set_reward_operations_paused_v1(revision,FALSE,'Owned isolated native source fixture') FROM reward_operations_control WHERE singleton",
  );
  expect(
    (
      await f.admin.query(
        "SELECT control.paused,lease.required,lease.run_id IS NOT NULL AS active FROM reward_operations_control control CROSS JOIN reward_operations_run_lease lease WHERE control.singleton AND lease.singleton",
      )
    ).rows,
  ).toEqual([{ paused: false, required: true, active: true }]);
  // Trusted control-plane deployment/asset prerequisites only. Every offer, leg,
  // funding effect, drawing, learner source and reward row is produced below by
  // the actual accepted source methods with their triggers enabled.
  await f.admin.query(
    `INSERT INTO reward_asset_whitelist(chain_id,token_address,decimals,symbol,asset_kind,environment,status,
  policy_version,activated_at,plain_erc20_verified_at) VALUES(84532,$1,6,'USDC','settlement_usdc','staging','active','base-sepolia-usdc-v1',clock_timestamp(),clock_timestamp())`,
    [address("1")],
  );
  await f.admin.query(
    `INSERT INTO megapot_deployment_attestations(attestation_id,environment,chain_id,jackpot_address,usdc_address,
  ticket_nft_address,custody_address,referrer_address,source_tag,jackpot_code_hash,usdc_code_hash,ticket_nft_code_hash,
  attestation_block_number,attestation_block_hash,abi_version,status,verified_at)
  VALUES('megapot-base-sepolia-v2','staging',84532,$1,$2,$3,$4,$5,$6,$7,$8,$9,100,$10,'megapot_v2','active',clock_timestamp())`,
    [
      address("2"),
      address("1"),
      address("3"),
      custody,
      address("5"),
      bytes32("6"),
      bytes32("7"),
      bytes32("8"),
      bytes32("9"),
      bytes32("a"),
    ],
  );
  // Actual source-owned additional-persona creation also creates its immutable
  // pending wallet reservation. The historical raw song author has no such slot.
  const personaServices = {
    store: makeControlPlanePersonaStore(f.adminRuntime),
    nextPersonaId: () => Effect.sync(() => `persona_${crypto.randomUUID().replaceAll("-", "")}`),
    nowIso: () => Effect.sync(() => new Date().toISOString()),
  };
  const preparedPersona = await run(
    prepareActivityPersona(
      {
        accountId: "study-account",
        communityId: "study-community",
        body: { idempotency_key: `sponsor-persona-${suffix}`, choice: { kind: "create_new" } },
      },
      personaServices,
    ),
  );
  const sponsorPersonaId = preparedPersona.persona_id;
  expect(preparedPersona.persona_status).toBe("pending_wallet");
  expect(sponsorPersonaId).not.toBe("study-persona");
  const pendingWallet = await run(
    makeControlPlanePersonaWalletStore(f.adminRuntime).getEvmPreparation({
      accountId: "study-account",
      personaId: sponsorPersonaId,
    }),
  );
  expect(pendingWallet).toMatchObject({ persona_id: sponsorPersonaId, status: "pending" });
  // Existing deterministic verifier is the explicitly simulated provider boundary.
  // Native confirmation uses the original prepared HD slot and activates this persona.
  const wallet = await confirmWallet(f.adminRuntime)("study-account", sponsorPersonaId);
  const replay = await run(
    prepareActivityPersona(
      {
        accountId: "study-account",
        communityId: "study-community",
        body: { idempotency_key: `sponsor-persona-${suffix}`, choice: { kind: "create_new" } },
      },
      personaServices,
    ),
  );
  expect(replay.persona_id).toBe(sponsorPersonaId);
  expect(replay.persona_status).toBe("active");
  const clock = new Date(),
    initialCutoffAt = new Date(clock.getTime() + 45000),
    drawingTime = new Date(initialCutoffAt.getTime() + 300000);
  const observation = makeControlPlaneMegapotDrawingObservationStore(f.adminRuntime);
  await run(
    observation.recordAndOpen({
      observationId: `observation-${suffix}`,
      attestationId: "megapot-base-sepolia-v2",
      chainId: 84532,
      drawingId: 101n,
      grossPrizePoolAtomic: 100000n,
      globalTicketsBought: 10n,
      ticketPriceAtomic: 10000n,
      drawingTime: drawingTime.toISOString(),
      ballMax: 25,
      bonusballMax: 13,
      drawingLocked: false,
      referralFeeWei: 100000000000000000n,
      referralWinShareWei: 100000000000000000n,
      blockNumber: 101n,
      blockHash: hex(`observation-${suffix}`),
      blockTimestamp: clock.toISOString(),
      confirmations: 3,
      observedAt: clock.toISOString(),
      expiresAt: new Date(clock.getTime() + 3600000).toISOString(),
      rawStateHash: hash(`state-${suffix}`),
      legacyRawStateHash: hash(`legacy-${suffix}`),
    }),
  );
  const ordinary = makeControlPlaneSongRewardOfferStore(f.adminRuntime);
  const creator = makeControlPlaneOwnerMegapotPoolLegCreator(f.adminRuntime);
  const funding = makeControlPlaneRewardFundingStore(f.adminRuntime);
  const offerService = makeSongRewardOfferService({
    store: { ...ordinary, addMegapotPoolLeg: creator.addMegapotPoolLeg },
    funding: {
      plan: (input) =>
        funding
          .plan({
            fundingEffectId: `funding-${suffix}`,
            legId: input.legId,
            funderAccountId: input.funderAccountId,
            senderAddress: input.senderAddress,
            expectedAmountAtomic: input.expectedAmountAtomic,
            requiredConfirmations: input.requiredConfirmations,
          })
          .pipe(
            Effect.flatMap((intent) =>
              intent.state === "planned"
                ? Effect.succeed({ kind: "planned" as const, intent })
                : Effect.fail(new Error("NEW native funding plan required")),
            ),
          ),
      observe: () => Effect.die(new Error("Unobserved provider funding may not be accepted")),
    },
    requiredConfirmations: 3,
    externalFallbackPolicy: null,
  });
  const opened = await withClock(
    offerService.openOffer({
      accountId: "study-account",
      personaId: sponsorPersonaId,
      communityId: "study-community",
      postId: "study-post",
      idempotencyKey: `offer-${suffix}`,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
    }),
  );
  const created = await withClock(
    offerService.addMegapotPoolLeg({
      accountId: "study-account",
      personaId: sponsorPersonaId,
      offerId: opened.offer.offerId,
      idempotencyKey: `leg-${suffix}`,
      senderAddress: wallet.address,
      fundingAmountAtomic: 100000n,
      maxTicketPriceAtomic: 10000n,
      entryCutoffSeconds: 300,
      eligibleActivities: ["study"],
      expectedQualificationPolicyVersions: { study: "study_session_first_pass_v2@1" },
      minScoreBps: 7000,
      emptyPoolPolicy: "no_purchase",
      fallbackPayoutPersonaId: null,
      fallbackDisclosureAcknowledged: false,
    }),
  );
  const fundingHash = hex(`funding-transaction-${suffix}`);
  await run(
    funding.bindTransaction({
      fundingEffectId: created.funding.intent.fundingEffectId,
      transactionHash: fundingHash,
    }),
  );
  // Deterministic funding evidence AT the native store boundary. No live or RPC
  // receipt-validation claim: the actual original funding store writes the row.
  await run(
    funding.confirm({
      fundingEffectId: created.funding.intent.fundingEffectId,
      transactionHash: fundingHash,
      transferLogIndex: 0,
      amountAtomic: 100000n,
      blockNumber: 102n,
      blockHash: hex(`funding-block-${suffix}`),
      observationHash: hash(`funding-observation-${suffix}`),
      confirmedAt: new Date().toISOString(),
    }),
  );
  await withClock(
    ordinary.recordFundingObservation({
      actionId: `funding-action-${suffix}`,
      accountId: "study-account",
      personaId: sponsorPersonaId,
      legId: created.leg.legId,
      legKind: "megapot_pool",
      fundingEffectId: created.funding.intent.fundingEffectId,
      idempotencyKey: `observed-${suffix}`,
      requestHash: hash(`observed-${suffix}`),
      createdAt: new Date().toISOString(),
    }),
  );
  const retained = includeRetainedV2
    ? await setupRetainedSongPool(f, suffix, sponsorPersonaId, wallet.address)
    : null;
  // A NEW leg starts AFTER the observation current at its creation. Original101
  // is genuinely ineligible; never rewrite the captured prospective start floor.
  expect(created.leg.participationStartsDrawingId).toBe(102n);
  expect(
    await run(
      openOwnerDrawingsForObservation(`observation-${suffix}`).pipe(Effect.provide(f.adminRuntime)),
    ),
  ).toEqual([]);
  expect(
    (
      await f.admin.query(
        `SELECT leg.status,leg.beneficiary_version,leg.funded_atomic::text,
    leg.participation_starts_drawing_id::text,offer.status AS offer_status,
    funding.state AS funding_state,funding.confirmed_amount_atomic::text,
    (SELECT count(*)::integer FROM megapot_pool_drawings WHERE pool_leg_id=leg.leg_id) AS prior_draws
    FROM song_reward_offer_legs leg JOIN song_reward_offers offer USING(offer_id)
    JOIN song_reward_leg_funding_effects funding ON funding.leg_id=leg.leg_id
    WHERE leg.leg_id=$1 AND funding.funding_effect_id=$2`,
        [created.leg.legId, created.funding.intent.fundingEffectId],
      )
    ).rows,
  ).toEqual([
    {
      status: "active",
      beneficiary_version: 3,
      funded_atomic: "100000",
      participation_starts_drawing_id: "102",
      offer_status: "active",
      funding_state: "confirmed",
      confirmed_amount_atomic: "100000",
      prior_draws: 0,
    },
  ]);
  const originalDrawingId = created.leg.participationStartsDrawingId;
  const nextClock = new Date(),
    cutoffAt = new Date(nextClock.getTime() + cutoffMilliseconds);
  const nextObservationId = `observation-next-${suffix}`;
  // New deterministic observation AT the actual repository boundary after
  // source-owned funding. This is neither a draw insert nor a live RPC claim.
  const next = await run(
    observation.recordAndOpen({
      observationId: nextObservationId,
      attestationId: "megapot-base-sepolia-v2",
      chainId: 84532,
      drawingId: originalDrawingId,
      grossPrizePoolAtomic: 100000n,
      globalTicketsBought: 10n,
      ticketPriceAtomic: 10000n,
      drawingTime: new Date(cutoffAt.getTime() + 300000).toISOString(),
      ballMax: 25,
      bonusballMax: 13,
      drawingLocked: false,
      referralFeeWei: 100000000000000000n,
      referralWinShareWei: 100000000000000000n,
      blockNumber: 103n,
      blockHash: hex(nextObservationId),
      blockTimestamp: nextClock.toISOString(),
      confirmations: 3,
      observedAt: nextClock.toISOString(),
      expiresAt: new Date(nextClock.getTime() + 3600000).toISOString(),
      rawStateHash: hash(`state-next-${suffix}`),
      legacyRawStateHash: hash(`legacy-next-${suffix}`),
    }),
  );
  expect(next.drawingId).toBe(originalDrawingId);
  expect(next.openedPoolLegIds).toEqual(retained === null ? [] : [retained.legId]); // Ordinary observer opens ONLY version2.
  const openedLegs = await run(
    openOwnerDrawingsForObservation(nextObservationId).pipe(Effect.provide(f.adminRuntime)),
  );
  expect(openedLegs).toEqual([created.leg.legId]);
  expect(
    (
      await f.admin.query(
        `SELECT drawing_id::text,observation_id,beneficiary_version,status,
    octet_length(owner_fallback_leaf_salt) AS salt_bytes,entry_cutoff_at=$3::timestamptz AS exact_cutoff
    FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=$2::numeric`,
        [created.leg.legId, originalDrawingId.toString(), cutoffAt.toISOString()],
      )
    ).rows,
  ).toEqual([
    {
      drawing_id: originalDrawingId.toString(),
      observation_id: nextObservationId,
      beneficiary_version: 3,
      status: "entry_open",
      salt_bytes: 32,
      exact_cutoff: true,
    },
  ]);
  const original = { poolLegId: created.leg.legId, drawingId: originalDrawingId.toString() };
  return { key, custody, original, cutoffAt, sponsorPersonaId, retained };
}

// A second SONG keeps0053 one-open-pool-leg-per-offer intact. Only trusted
// prepared media IDs are changed; no learning/money source is copied or seeded.
async function setupRetainedSongPool(
  f: RewardedFixture,
  suffix: string,
  personaId: string,
  senderAddress: string,
) {
  const additionalSourceTag = "retained",
    postId = "retained-post";
  await insertStudySongFixture(f.admin, {
    accountAlreadyBorn: true,
    initializeOwnerPolicy: true,
    additionalSourceTag,
  });
  await insertTelegramPracticeReadinessFixture(f.admin, { additionalSourceTag });
  expect(
    (
      await f.admin.query(
        `SELECT owner_account_id,audio_revision::text,current_policy_revision::text
    FROM song_owner_policies WHERE community_id='study-community' AND post_id=$1`,
        [postId],
      )
    ).rows,
  ).toEqual([
    { owner_account_id: "study-account", audio_revision: "1", current_policy_revision: "1" },
  ]);
  const ordinary = makeControlPlaneSongRewardOfferStore(f.adminRuntime),
    funding = makeControlPlaneRewardFundingStore(f.adminRuntime);
  const service = makeSongRewardOfferService({
    store: ordinary,
    funding: {
      plan: (input) =>
        funding
          .plan({
            fundingEffectId: `retained-funding-${suffix}`,
            legId: input.legId,
            funderAccountId: input.funderAccountId,
            senderAddress: input.senderAddress,
            expectedAmountAtomic: input.expectedAmountAtomic,
            requiredConfirmations: input.requiredConfirmations,
          })
          .pipe(
            Effect.flatMap((intent) =>
              intent.state === "planned"
                ? Effect.succeed({ kind: "planned" as const, intent })
                : Effect.fail(new Error("Actual NEW retained funding plan required")),
            ),
          ),
      observe: () => Effect.die(new Error("Unobserved funding cannot be accepted")),
    },
    requiredConfirmations: 3,
    externalFallbackPolicy: null,
  });
  const opened = await withClock(
    service.openOffer({
      accountId: "study-account",
      personaId,
      communityId: "study-community",
      postId,
      idempotencyKey: `retained-offer-${suffix}`,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
    }),
  );
  const created = await withClock(
    service.addMegapotPoolLeg({
      accountId: "study-account",
      personaId,
      offerId: opened.offer.offerId,
      idempotencyKey: `retained-leg-${suffix}`,
      senderAddress,
      fundingAmountAtomic: 100000n,
      maxTicketPriceAtomic: 10000n,
      entryCutoffSeconds: 300,
      eligibleActivities: ["study"],
      expectedQualificationPolicyVersions: { study: "study_session_first_pass_v2@1" },
      minScoreBps: 7000,
      emptyPoolPolicy: "no_purchase",
      fallbackPayoutPersonaId: null,
      fallbackDisclosureAcknowledged: false,
    }),
  );
  expect(created.leg.participationStartsDrawingId).toBe(102n);
  const transactionHash = hex(`retained-funding-${suffix}`);
  await run(
    funding.bindTransaction({
      fundingEffectId: created.funding.intent.fundingEffectId,
      transactionHash,
    }),
  );
  await run(
    funding.confirm({
      fundingEffectId: created.funding.intent.fundingEffectId,
      transactionHash,
      transferLogIndex: 0,
      amountAtomic: 100000n,
      blockNumber: 102n,
      blockHash: hex(`retained-funded-block-${suffix}`),
      observationHash: hash(`retained-funding-evidence-${suffix}`),
      confirmedAt: new Date().toISOString(),
    }),
  );
  await withClock(
    ordinary.recordFundingObservation({
      actionId: `retained-funded-action-${suffix}`,
      accountId: "study-account",
      personaId,
      legId: created.leg.legId,
      legKind: "megapot_pool",
      fundingEffectId: created.funding.intent.fundingEffectId,
      idempotencyKey: `retained-observed-${suffix}`,
      requestHash: hash(`retained-observed-${suffix}`),
      createdAt: new Date().toISOString(),
    }),
  );
  expect(
    (
      await f.admin.query(
        "SELECT beneficiary_version,status,funded_atomic::text FROM song_reward_offer_legs WHERE leg_id=$1",
        [created.leg.legId],
      )
    ).rows,
  ).toEqual([{ beneficiary_version: 2, status: "active", funded_atomic: "100000" }]);
  return { legId: created.leg.legId, postId };
}

async function freezeAndCommit(
  f: RewardedFixture,
  pool: Awaited<ReturnType<typeof setupPool>>,
  maximumCutoffWaitMilliseconds = 60000,
) {
  // Actual clock schedule, bounded. No fake clock or source cutoff/expiry UPDATE.
  const deadline = Date.now() + maximumCutoffWaitMilliseconds;
  for (;;) {
    const actual = (
      await f.admin.query("SELECT clock_timestamp() >= $1::timestamptz AS reached", [
        pool.cutoffAt.toISOString(),
      ])
    ).rows;
    expect(actual).toHaveLength(1);
    if (actual[0]?.reached === true) break;
    if (Date.now() > deadline)
      throw new Error("Actual PostgreSQL cutoff not reached within owned bound");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const store = makeControlPlaneOwnerMegapotSettlementStore(f.adminRuntime);
  const frozen = await run(
    store.freeze(pool.original, {
      externalTickets: 100,
      externalSpendAtomic: "100000000",
      sharedTickets: 100,
      sharedSpendAtomic: "100000000",
    }),
  );
  expect(frozen.status).toBe("cutoff_frozen");
  expect(frozen.frozenShareCount).toBe(2);
  const documents = new Map<string, { uploaded: Date; text: string }>();
  const bucket = {
    get: async (key: string) => {
      const v = documents.get(key);
      return v ? { uploaded: v.uploaded, text: async () => v.text } : null;
    },
    put: async (key: string, text: string) => {
      if (documents.has(key)) return null;
      const v = { uploaded: new Date(), text };
      documents.set(key, v);
      return { uploaded: v.uploaded };
    },
  };
  const commit = makeOwnerMegapotCommitmentCoordinator({
    store,
    signer: makeBaseSepoliaMegapotCommitmentSigner({
      privateKey: pool.key,
      expectedAddress: pool.custody,
    }),
    publisher: makeR2MegapotCommitmentPublisher({
      bucket,
      publicOrigin: "https://commitments.example",
    }),
    authority: makeControlPlaneRewardRunAuthority(f.adminRuntime),
  });
  const committed = await run(commit.commit(pool.original));
  expect(await run(commit.commit(pool.original))).toEqual(committed);
  expect(documents.size).toBe(1);
  for (const v of documents.values()) {
    const envelope = Schema.decodeUnknownSync(
      Schema.Struct({
        domain: Schema.String,
        idempotencyKey: Schema.String,
        payload: Schema.String,
        payloadHash: Schema.String,
        signingKeyId: Schema.String,
        signature: Schema.String,
      }),
      { onExcessProperty: "error" },
    )(JSON.parse(v.text));
    const payload = JSON.parse(envelope.payload);
    expect(Object.keys(payload).sort()).toEqual([
      "algorithmVersion",
      "domain",
      "drawingId",
      "fallback",
      "leafCommitments",
      "leafCount",
      "poolLegId",
      "snapshotHash",
      "termsHash",
    ]);
    for (const name of [
      "ownerId",
      "ownerKind",
      "qualificationId",
      "originalPersonaId",
      "leafSalt",
      "orderKey",
      "credentialId",
      "owner_id",
      "account_id",
    ])
      expect(envelope.payload.includes(`"${name}"`)).toBe(false);
  }
  expect(
    (
      await f.admin.query(
        "SELECT count(*)::integer AS n FROM megapot_owner_snapshot_leaves WHERE snapshot_id=$1",
        [frozen.snapshotId],
      )
    ).rows,
  ).toEqual([{ n: 2 }]);
  return { store, frozen, committed };
}

async function purchaseAndSweep(
  f: RewardedFixture,
  pool: Awaited<ReturnType<typeof setupPool>>,
  net: bigint,
) {
  const key = { poolLegId: pool.original.poolLegId, drawingId: BigInt(pool.original.drawingId) },
    store = makeControlPlaneMegapotPurchaseStore(f.adminRuntime, {
      purchaseSafetyMarginSeconds: 120,
    });
  const candidate = await run(store.loadCandidate(key)),
    ticket = { normals: [1, 2, 3, 4, 5], bonusball: 1 } as const;
  const effectId = `purchase-${pool.original.poolLegId}`;
  const reservation = await run(
    store.reserveNonce({
      candidate,
      effectId,
      ticket,
      observedPendingNonce: 1n,
      observedBlockNumber: 103n,
      observedBlockHash: hex("nonce"),
      observedAt: new Date().toISOString(),
    }),
  );
  const tx = keccak256("0x0102");
  await run(
    store.prepare({
      reservation,
      ticket,
      calldata: "0xdeadbeef",
      calldataHash: hash("calldata"),
      signedTransaction: "0x0102",
      signedTransactionHash: tx,
      preparedAt: new Date().toISOString(),
    }),
  );
  await run(
    store.recordSubmission({
      effectId,
      transactionHash: tx,
      submittedAt: new Date().toISOString(),
      outcome: "accepted",
    }),
  );
  await run(
    store.confirm({
      effectId,
      transactionHash: tx,
      ticketId: 501n,
      purchaseLogIndex: 1,
      mintLogIndex: 2,
      blockNumber: 104n,
      blockHash: hex("purchase-block"),
      receiptHash: hash("purchase-receipt"),
      confirmations: 3,
      referralFeesAtomic: 100n,
      lpEarningsAtomic: 900n,
      confirmedAt: new Date().toISOString(),
    }),
  );
  const sweeps = makeControlPlaneMegapotSweepStore(f.adminRuntime);
  // Native STORE-boundary deterministic custody/drawing observations only.
  // Zero is a genuine non-paying tier with sealed zero evidence and no claim.
  const sweep = await run(
    sweeps.complete({
      candidate: await run(sweeps.loadCandidate(key)),
      sweepId: `sweep-${pool.original.poolLegId}`,
      observationBlockNumber: 105n,
      observationBlockHash: hex("sweep-block"),
      drawingStateHash: hash("drawing-state"),
      tierId: net === 0n ? 0 : 7,
      custodyOwnerAddress: pool.custody,
      grossWinningsAtomic: net,
      referralWinShareAtomic: 0n,
      referralAccrualAtomic: 0n,
      netWinningsAtomic: net,
      observedAt: new Date().toISOString(),
    }),
  );
  expect(sweep.outcome).toBe(net === 0n ? "no_win" : "winnings_detected");
  expect(sweep.netWinningsAtomic).toBe(net);
  if (net === 0n) {
    expect(sweep.tierId).toBe(0);
    expect(sweep.ticketId).toBe(501n);
    expect(sweep.grossWinningsAtomic).toBe(0n);
    expect(sweep.referralAccrualAtomic).toBe(0n);
    expect(
      (
        await f.admin.query(
          `SELECT d.status AS drawing_status,t.status AS ticket_status,
          sw.ticket_count,sw.winning_ticket_count,e.tier_id,
          e.gross_winnings_atomic::text AS gross,e.referral_accrual_atomic::text AS referral,
          e.net_winnings_atomic::text AS net,
          (SELECT count(*)::integer FROM megapot_claim_effects c WHERE c.pool_leg_id=d.pool_leg_id AND c.drawing_id=d.drawing_id) AS claims
         FROM megapot_pool_drawings d
         JOIN megapot_drawing_sweeps sw ON sw.pool_leg_id=d.pool_leg_id AND sw.drawing_id=d.drawing_id
         JOIN megapot_sweep_ticket_evidence e ON e.sweep_id=sw.sweep_id
         JOIN megapot_ticket_inventory t ON t.attestation_id=e.attestation_id AND t.ticket_id=e.ticket_id
         WHERE d.pool_leg_id=$1 AND d.drawing_id=$2::numeric AND sw.sweep_id=$3`,
          [pool.original.poolLegId, pool.original.drawingId, sweep.sweepId],
        )
      ).rows,
    ).toEqual([
      {
        drawing_status: "no_win",
        ticket_status: "no_win",
        ticket_count: 1,
        winning_ticket_count: 0,
        tier_id: 0,
        gross: "0",
        referral: "0",
        net: "0",
        claims: 0,
      },
    ]);
  }
  if (net > 0n) {
    const claims = makeControlPlaneMegapotClaimStore(f.adminRuntime),
      effect = `claim-${pool.original.poolLegId}`;
    const claim = await run(
      claims.reserveNonce({
        candidate: await run(claims.loadCandidate(key)),
        effectId: effect,
        custodyBalanceBeforeAtomic: 90000n,
        referralBalanceBeforeAtomic: 0n,
        observedPendingNonce: 2n,
        observedBlockNumber: 106n,
        observedBlockHash: hex("claim-nonce"),
        observedAt: new Date().toISOString(),
      }),
    );
    const claimTx = keccak256("0x0304");
    await run(
      claims.prepare({
        reservation: claim,
        calldata: "0x1bf0ade0",
        calldataHash: hash("claim-data"),
        signedTransaction: "0x0304",
        signedTransactionHash: claimTx,
        preparedAt: new Date().toISOString(),
      }),
    );
    await run(
      claims.recordSubmission({
        effectId: effect,
        transactionHash: claimTx,
        submittedAt: new Date().toISOString(),
        outcome: "accepted",
      }),
    );
    await run(
      claims.confirm({
        effectId: effect,
        transactionHash: claimTx,
        claimLogIndex: 3,
        burnLogIndex: 4,
        referralLogIndex: 5,
        transferLogIndex: 6,
        grossWinningsAtomic: net,
        referralAccrualAtomic: 0n,
        netWinningsAtomic: net,
        custodyBalanceAfterAtomic: 90000n + net,
        referralBalanceAfterAtomic: 0n,
        blockNumber: 107n,
        blockHash: hex("claim-block"),
        receiptHash: hash("claim-receipt"),
        confirmations: 3,
        confirmedAt: new Date().toISOString(),
      }),
    );
  }
  return key;
}

suite("actual rewarded Guest producer into private v3 settlement", () => {
  for (const net of [1n, 0n])
    test(
      `real original CP/admission produces conserved ${net === 0n ? "all-zero sweep" : "positive and zero"} allocations and private public commitment`,
      async () => {
        await rewardedFixture(
          async (f) => {
            const pool = await setupPool(f, `native-${net}`, positiveDrawingWindowMilliseconds);
            const beforeCalls = f.providerCalls();
            const first = await f.completeGuest(Number(net) + 9001, `first-${net}`),
              second = await f.completeGuest(Number(net) + 9101, `second-${net}`);
            expect(f.providerCalls() - beforeCalls).toBe(8);
            expect(f.putCalls()).toBe(8);
            expect(first.session.reward_terms?.pool_leg_id).toBe(pool.original.poolLegId);
            expect(second.session.reward_terms?.original_drawing_id).toBe(pool.original.drawingId);
            const snapshot = await freezeAndCommit(
              f,
              pool,
              positiveDrawingWindowMilliseconds + 10000,
            );
            await purchaseAndSweep(f, pool, net);
            const allocated = await run(snapshot.store.allocate(pool.original));
            expect(await run(snapshot.store.allocate(pool.original))).toEqual(allocated);
            const rows = (
              await f.admin.query(
                `SELECT allocation.owner_id,allocation.amount_atomic::text,allocation.credit_id,allocation.allocation_kind,
    credit.identity_version,credit.account_id,credit.payout_persona_id AS persona_id,credit.participation_owner_id
    FROM megapot_owner_allocations allocation LEFT JOIN reward_ledger_credits credit USING(credit_id)
    WHERE allocation.allocation_batch_id=$1 ORDER BY allocation.ordinal`,
                [allocated.allocationBatchId],
              )
            ).rows;
            expect(rows).toHaveLength(2);
            expect(rows.reduce((n, row) => n + atomic(row.amount_atomic), 0n)).toBe(net);
            expect(rows.map((row) => atomic(row.amount_atomic))).toEqual(
              net === 0n ? [0n, 0n] : [1n, 0n],
            );
            const owners = new Set([first.access.ownerId, second.access.ownerId]);
            for (const row of rows) {
              expect(owners.has(row.owner_id)).toBe(true);
              if (atomic(row.amount_atomic) === 0n) {
                expect(row.credit_id).toBeNull();
                expect(row.identity_version).toBeNull();
              } else {
                expect(row.identity_version).toBe("owner_v1");
                expect(row.account_id).toBeNull();
                expect(row.persona_id).toBeNull();
                expect(row.participation_owner_id).toBe(row.owner_id);
                await expect(
                  run(
                    makeControlPlaneRewardPayoutStore(f.adminRuntime).loadCandidate(row.credit_id),
                  ),
                ).rejects.toMatchObject({ reason: "credit-not-payable" });
              }
            }
            if (net === 0n)
              expect(
                (
                  await f.admin.query(
                    "SELECT count(*)::integer AS n FROM megapot_claim_receipt_evidence",
                  )
                ).rows,
              ).toEqual([{ n: 0 }]);
            expect(
              (await f.admin.query("SELECT count(*)::integer AS n FROM reward_payout_effects"))
                .rows,
            ).toEqual([{ n: 0 }]);
            expect(
              (
                await f.admin.query(
                  "SELECT count(*)::integer AS n FROM reward_credit_persona_bindings WHERE owner_kind='guest'",
                )
              ).rows,
            ).toEqual([{ n: 0 }]);
            const source = (
              await f.admin.query(
                "SELECT frozen_share_count,reserved_ticket_cost_atomic::text,actual_ticket_cost_atomic::text FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=$2::numeric",
                [pool.original.poolLegId, pool.original.drawingId],
              )
            ).rows;
            const beforeReset = await postgresTestSchemaCatalogFingerprint(f.admin);
            const originalFinancialRows = async () =>
              (
                await f.admin.query(
                  "SELECT jsonb_build_object('credits',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY credit_id),'[]') FROM reward_ledger_credits c),'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY owner_id,ordinal),'[]') FROM megapot_owner_allocations a),'journals',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY admission_id),'[]') FROM owner_participation_admission_operations o)) AS facts",
                )
              ).rows;
            const retainedFinancialRows = await originalFinancialRows();
            await expect(resetPostgresTestBaseline(f.admin)).rejects.toMatchObject({
              code: "GP003",
            });
            expect(await postgresTestSchemaCatalogFingerprint(f.admin)).toBe(beforeReset);
            expect(await originalFinancialRows()).toEqual(retainedFinancialRows);
            await f.admin.query("SELECT require_owner_accounting_ready_private_v1()");
            expect(source).toEqual([
              {
                frozen_share_count: 2,
                reserved_ticket_cost_atomic: "10000",
                actual_ticket_cost_atomic: "10000",
              },
            ]);
            expect(f.providerCalls() - beforeCalls).toBe(8);
            expect(f.putCalls()).toBe(8);
          },
          { ownedResetNamespace: true },
        );
      },
      positiveCaseTimeoutMilliseconds,
    );
});

// Actual driver faults only. A delivered successful COMMIT is distinguished
// from an error injected before sending COMMIT. Neither unknown reply itself
// authorizes no-effect/abort; the original separately committed hold is retained.
function owningCommitFault(mode: "successful_ack_lost" | "before_send_unknown") {
  let observed = false;
  const clientFactory: PostgresClientFactory = (_url, config) => {
    const client = new Client(config);
    let ownsFinalizer = false;
    return {
      connection: client.connection,
      connect: () => client.connect(),
      end: () => client.end(),
      query: async ({ text, values }) => {
        if (text === "COMMIT" && ownsFinalizer && !observed && mode === "before_send_unknown") {
          observed = true;
          // This deliberate driver simulation DOES NOT prove a real wire
          // COMMIT was delivered or rejected. Native locked reconciliation does.
          throw new Error("Owned original COMMIT delivery outcome unknown");
        }
        const result = await client.query({
          text,
          values: values === undefined ? [] : [...values],
        });
        if (text.includes("SELECT finish_owner_guest_reward_spoken_v1")) ownsFinalizer = true;
        if (text === "COMMIT" && ownsFinalizer && !observed && mode === "successful_ack_lost") {
          observed = true;
          throw new Error("Owned actual successful owning COMMIT acknowledgment lost");
        }
        return result;
      },
    };
  };
  return { clientFactory, observed: () => observed };
}
async function prepareFinalAnswer(f: RewardedFixture, serial: number, key: string) {
  const guest = await f.startGuest(serial, key);
  let session = guest.session;
  const inputFor = (currentSession: GuestStudySessionV1, index: number) => {
    const current = currentSession.lesson.current;
    const item = currentSession.items.find(
      (item) => item.session_item_id === current?.session_item_id,
    );
    if (current === null || item?.presentation.kind !== "say_it_back")
      throw new Error("Actual original spoken presentation required");
    return {
      access: guest.access,
      communityId: session.community_id,
      sessionId: session.session_id,
      sessionItemId: item.session_item_id,
      attemptNumber: current.presentation_number,
      idempotencyKey: `${key}:answer:${index}`,
      audio: new TextEncoder().encode(item.presentation.reference_text),
      audioContentType: "audio/webm" as const,
      audioDurationMs: 1000,
    };
  };
  expect(session.items).toHaveLength(4);
  for (let index = 0; index < 3; index++) {
    const result = await withClock(f.study.submitSpokenAnswer(inputFor(session, index)));
    if (result.state !== "completed") throw new Error("Actual acknowledged prefix required");
    expect(result.result.answer.outcome).toBe("correct");
    session = Schema.decodeUnknownSync(GuestStudySessionV1, { onExcessProperty: "error" })(
      result.result.answer.session,
    );
  }
  return { guest, session, input: inputFor(session, 3) };
}
async function heldOriginal(
  f: RewardedFixture,
  source: Awaited<ReturnType<typeof prepareFinalAnswer>>,
) {
  return (
    await f.admin.query(
      `SELECT hold.source_owner_id,hold.session_id,hold.pool_leg_id,
    hold.drawing_id::text,hold.state,hold.current_attempt_number,
    attempt.state AS attempt_state,attempt.started_at IS NOT NULL AS attempt_started,
    encode(sha256(convert_to(to_jsonb(hold)::text,'UTF8')),'hex') AS exact_retained_hash,
    clock_timestamp()<hold.entry_cutoff_at AS before_cutoff,
    clock_timestamp()<hold.purchase_safety_deadline_at AS before_safety,
    (SELECT count(*)::integer FROM megapot_owner_shares share WHERE share.owner_id=hold.source_owner_id
      AND share.pool_leg_id=hold.pool_leg_id AND share.drawing_id=hold.drawing_id) AS original_shares
    FROM owner_participation_admission_operations hold
    JOIN owner_participation_admission_attempts attempt ON attempt.admission_id=hold.admission_id
      AND attempt.attempt_fence=hold.current_attempt_fence
    WHERE hold.source_owner_id=$1 AND hold.session_id=$2 AND hold.idempotency_key=$3`,
      [source.guest.access.ownerId, source.session.session_id, source.input.idempotencyKey],
    )
  ).rows;
}
async function actualLearningAndCharges(f: RewardedFixture, sessionId: string) {
  return (
    await f.admin.query(
      `SELECT
    (SELECT count(*)::integer FROM guest_resource_provider_calls WHERE session_id=$1) AS calls,
    (SELECT count(*)::integer FROM guest_resource_provider_calls WHERE session_id=$1 AND disposition='completed') AS completed_calls,
    (SELECT count(*)::integer FROM guest_study_spoken_captures WHERE session_id=$1) AS captures,
    (SELECT count(*)::integer FROM guest_study_spoken_checkpoints cp JOIN guest_study_spoken_captures cap USING(capture_id)
      WHERE cap.session_id=$1) AS checkpoints,
    (SELECT bool_and(cp.charged_cost_micros=call.actual_cost_micros AND call.actual_cost_micros=call.maximum_provider_cost_micros
      AND cp.charge_basis='reserved_ceiling_v1') FROM guest_study_spoken_checkpoints cp
      JOIN guest_study_spoken_captures cap USING(capture_id) JOIN guest_resource_provider_calls call
      ON call.call_id=cp.provider_call_id WHERE cap.session_id=$1) AS exact_original_charges,
    (SELECT count(*)::integer FROM study_attempts_v2 attempt JOIN study_session_items_v2 item USING(session_item_id)
      WHERE item.session_id=$1) AS attempts`,
      [sessionId],
    )
  ).rows;
}
async function waitActualClock(f: RewardedFixture, instant: Date, maximumMs: number) {
  const stop = Date.now() + maximumMs;
  for (;;) {
    const rows = (
      await f.admin.query("SELECT clock_timestamp()>=$1::timestamptz AS reached", [
        instant.toISOString(),
      ])
    ).rows;
    expect(rows).toHaveLength(1);
    if (rows[0]?.reached === true) return;
    if (Date.now() >= stop) throw new Error("Owned actual clock deadline not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}
async function rotateOriginalProof(
  f: RewardedFixture,
  access: Awaited<ReturnType<typeof prepareFinalAnswer>>["guest"]["access"],
) {
  const suffix = crypto.randomUUID(),
    successor = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  await f.admin.query("SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9)", [
    origin,
    [access.credentialId],
    access.credentialId,
    access.ownerId,
    `rotate-${suffix}`,
    hash(suffix),
    `rotation-operation-${suffix}`,
    successor,
    hash(`synthetic-secret-${suffix}`),
  ]);
  await f.admin.query("SELECT acknowledge_guest_rotation_v1($1,$2::text[],$3,$4,$5)", [
    origin,
    [successor],
    access.credentialId,
    successor,
    access.ownerId,
  ]);
  return successor;
}
async function genuineSignup(f: RewardedFixture) {
  // Existing genuine signup helper owns strict AccountDocument/handle rules
  // and its normal verified-provider input boundary; no copied identity model.
  const userId = `signup-${crypto.randomUUID()}`;
  await makeOwnedOrdinaryAccountBirthFixture(f.adminRuntime)(userId);
  expect(
    (
      await f.admin.query("SELECT kind,account_id FROM participation_owners WHERE account_id=$1", [
        userId,
      ])
    ).rows,
  ).toEqual([{ kind: "account", account_id: userId }]);
  return userId;
}

suite("actual original Guest owning COMMIT and source recovery", () => {
  test("successful original owning COMMIT with lost acknowledgment stays admitted; original recovery never redispatches provider or archive", async () => {
    await rewardedFixture(async (f) => {
      const pool = await setupPool(f, "acklost", 120000);
      const source = await prepareFinalAnswer(f, 9301, "actual-owning-acklost"),
        fault = owningCommitFault("successful_ack_lost");
      const calls = f.providerCalls(),
        puts = f.putCalls();
      const uncertain = await withClock(
        f.servicesFor(fault.clientFactory).study.submitSpokenAnswer(source.input),
      );
      expect(fault.observed()).toBe(true);
      expect(uncertain.state).toBe("pending_confirmation");
      expect(f.providerCalls()).toBe(calls + 1);
      expect(f.putCalls()).toBe(puts + 1);
      const retained = await heldOriginal(f, source);
      expect(retained).toHaveLength(1);
      const originalCharges = await actualLearningAndCharges(f, source.session.session_id);
      expect(originalCharges).toEqual([
        {
          calls: 4,
          completed_calls: 4,
          captures: 4,
          checkpoints: 4,
          exact_original_charges: true,
          attempts: 4,
        },
      ]);
      expect(retained[0]).toMatchObject({
        source_owner_id: source.guest.access.ownerId,
        pool_leg_id: pool.original.poolLegId,
        drawing_id: pool.original.drawingId,
        state: "admitted",
        current_attempt_number: 1,
        attempt_state: "admitted",
        attempt_started: true,
        original_shares: 1,
      });
      const replay = await withClock(f.study.submitSpokenAnswer(source.input));
      if (replay.state !== "completed")
        throw new Error("Actual committed original outcome required");
      expect(replay.result.answer.session.status).toBe("completed");
      expect(replay.result.participation).toMatchObject({
        state: "admitted",
        pool_leg_id: pool.original.poolLegId,
        original_drawing_id: pool.original.drawingId,
      });
      expect(f.providerCalls()).toBe(calls + 1);
      expect(f.putCalls()).toBe(puts + 1);
      expect(await heldOriginal(f, source)).toEqual(retained);
      expect(await actualLearningAndCharges(f, source.session.session_id)).toEqual(originalCharges);
      expect(
        (
          await f.admin.query(
            `SELECT count(*)::integer AS n FROM activity_qualifications
        WHERE participation_owner_id=$1 AND study_session_id=$2`,
            [source.guest.access.ownerId, source.session.session_id],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
    });
  }, 180000);
  test("uncertain original owning attempt holds before and after its deadline and after proof rotation/signup; native original reconciliation admits no late share or purchase", async () => {
    // This accepted stricter trusted margin captures safety at the actual entry
    // cutoff; a later consumer120s margin cannot erase that original deadline.
    await rewardedFixture(
      async (f) => {
        const pool = await setupPool(f, "held", 120000);
        const source = await prepareFinalAnswer(f, 9401, "actual-owning-held"),
          fault = owningCommitFault("before_send_unknown");
        const calls = f.providerCalls(),
          puts = f.putCalls();
        const uncertain = await withClock(
          f.servicesFor(fault.clientFactory).study.submitSpokenAnswer(source.input),
        );
        expect(fault.observed()).toBe(true);
        expect(uncertain.state).toBe("pending_confirmation");
        expect(await actualLearningAndCharges(f, source.session.session_id)).toEqual([
          {
            calls: 4,
            completed_calls: 4,
            captures: 4,
            checkpoints: 4,
            exact_original_charges: true,
            attempts: 3,
          },
        ]);
        const retained = await heldOriginal(f, source);
        expect(retained).toHaveLength(1);
        expect(retained[0]).toMatchObject({
          source_owner_id: source.guest.access.ownerId,
          pool_leg_id: pool.original.poolLegId,
          drawing_id: pool.original.drawingId,
          state: "pending",
          current_attempt_number: 1,
          attempt_state: "pending",
          attempt_started: true,
          original_shares: 0,
          before_cutoff: true,
          before_safety: true,
        });
        await expect(
          f.guest.query("SELECT prepare_captured_original_owning_attempt_private_v1($1,$2,$3)", [
            source.guest.access.ownerId,
            "untrusted-operation",
            "a".repeat(64),
          ]),
        ).rejects.toMatchObject({ code: "42501" });
        const store = makeControlPlaneOwnerMegapotSettlementStore(f.adminRuntime),
          ceilings = {
            externalTickets: 100,
            externalSpendAtomic: "100000000",
            sharedTickets: 100,
            sharedSpendAtomic: "100000000",
          };
        for (const phase of ["before_deadline", "after_deadline"] as const) {
          if (phase === "after_deadline") await waitActualClock(f, pool.cutoffAt, 130000);
          const refused = await run(Effect.result(store.freeze(pool.original, ceilings)));
          expect(refused._tag).toBe("Failure");
          if (refused._tag === "Failure")
            expect(refused.failure).toMatchObject({ sqlState: "GP003" });
          expect((await heldOriginal(f, source))[0]).toMatchObject({
            state: "pending",
            exact_retained_hash: retained[0]?.exact_retained_hash,
            original_shares: 0,
          });
        }
        const successor = await rotateOriginalProof(f, source.guest.access);
        const signup = await genuineSignup(f);
        expect((await heldOriginal(f, source))[0]).toMatchObject({
          state: "pending",
          exact_retained_hash: retained[0]?.exact_retained_hash,
          original_shares: 0,
          before_safety: false,
          before_cutoff: false,
        });
        const browser = f.servicesFor().browser;
        const read = {
          access: source.guest.access,
          communityId: source.input.communityId,
          sessionId: source.input.sessionId,
          sessionItemId: source.input.sessionItemId,
          idempotencyKey: source.input.idempotencyKey,
          attemptNumber: source.input.attemptNumber,
          audioDigest: hash(source.input.audio),
          audioByteSize: source.input.audio.byteLength,
          audioContentType: source.input.audioContentType,
          audioDurationMs: source.input.audioDurationMs,
        };
        const revoked = await run(Effect.result(browser.findForAudio(read)));
        expect(revoked._tag).toBe("Failure");
        if (revoked._tag === "Failure")
          expect(revoked.failure).toMatchObject({ reason: "proof-revoked" });
        expect(
          await run(
            browser.findForAudio({ ...read, access: { ...read.access, credentialId: successor } }),
          ),
        ).not.toBeNull();
        // Private closed original CP continuation uses no fabricated access, fresh
        // proof/config/learning lease, no regrade/provider/R2, and native lock/fence
        // reconciliation before it can resolve the original monetary uncertainty.
        const recovered = await run(f.servicesFor().closedRecovery.run(10));
        expect(recovered).toMatchObject({ completed: 1, pending: 0 });
        const resolved = await heldOriginal(f, source);
        expect(resolved).toHaveLength(1);
        expect(await actualLearningAndCharges(f, source.session.session_id)).toEqual([
          {
            calls: 4,
            completed_calls: 4,
            captures: 4,
            checkpoints: 4,
            exact_original_charges: true,
            attempts: 4,
          },
        ]);
        expect(resolved[0]).toMatchObject({
          state: "reconciled_no_commit",
          attempt_state: "authoritative_no_commit",
          current_attempt_number: 1,
          original_shares: 0,
          before_safety: false,
          before_cutoff: false,
        });
        expect(
          (
            await f.admin.query(
              `SELECT account_id,persona_id,participation_owner_id,status,guest_reward_mode
        FROM study_sessions_v2 WHERE session_id=$1`,
              [source.session.session_id],
            )
          ).rows,
        ).toEqual([
          {
            account_id: null,
            persona_id: null,
            participation_owner_id: source.guest.access.ownerId,
            status: "completed",
            guest_reward_mode: "megapot_guest_v1",
          },
        ]);
        expect(
          (
            await f.admin.query(
              `SELECT account_id,persona_id,participation_owner_id,participation_owner_kind
        FROM activity_qualifications WHERE study_session_id=$1`,
              [source.session.session_id],
            )
          ).rows,
        ).toEqual([
          {
            account_id: null,
            persona_id: null,
            participation_owner_id: source.guest.access.ownerId,
            participation_owner_kind: "guest",
          },
        ]);
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::integer AS n FROM guest_owner_associations WHERE guest_owner_id=$1",
              [source.guest.access.ownerId],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::integer AS n FROM reward_credit_persona_bindings WHERE account_id=$1",
              [signup],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        const frozen = await run(store.freeze(pool.original, ceilings));
        expect(frozen).toMatchObject({
          status: "closed_no_entries",
          frozenShareCount: 0,
          snapshotId: null,
          snapshotHash: null,
          reservedTicketCostAtomic: "0",
          fallback: false,
        });
        expect(await run(store.freeze(pool.original, ceilings))).toEqual(frozen);
        await expect(
          run(
            makeControlPlaneMegapotPurchaseStore(f.adminRuntime, {
              purchaseSafetyMarginSeconds: 300,
            }).loadCandidate({
              poolLegId: pool.original.poolLegId,
              drawingId: BigInt(pool.original.drawingId),
            }),
          ),
        ).rejects.toMatchObject({ reason: "drawing-not-committed" });
        expect(
          (
            await f.admin.query(`SELECT (SELECT count(*) FROM megapot_ticket_purchase_effects)::integer AS purchases,
        (SELECT count(*) FROM reward_ledger_credits WHERE identity_version='owner_v1')::integer AS owner_credits,
        (SELECT count(*) FROM megapot_owner_shares)::integer AS shares,
        (SELECT count(*) FROM megapot_owner_allocations)::integer AS allocations`)
          ).rows,
        ).toEqual([{ purchases: 0, owner_credits: 0, shares: 0, allocations: 0 }]);
        expect(f.providerCalls()).toBe(calls + 1);
        expect(f.putCalls()).toBe(puts + 1);
      },
      { purchaseSafetyMarginSeconds: 300 },
    );
  }, 180000);
});

async function retainedV2Rows(f: RewardedFixture, legId: string, sessionId: string) {
  const captured: Record<string, { n: number; hash: string }[]> = {};
  for (const table of [
    "song_reward_offer_legs",
    "megapot_pool_drawings",
    "megapot_pool_shares",
    "reward_eligibility_decisions",
  ] as const) {
    const column =
      table === "song_reward_offer_legs" || table === "reward_eligibility_decisions"
        ? "leg_id"
        : "pool_leg_id";
    captured[table] = (
      await f.admin.query(
        `SELECT count(*)::integer AS n,
      encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(source_row) ORDER BY to_jsonb(source_row)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
      FROM ${table} source_row WHERE ${column}=$1`,
        [legId],
      )
    ).rows;
  }
  for (const table of ["study_sessions_v2", "activity_qualifications"] as const) {
    const column = table === "study_sessions_v2" ? "session_id" : "study_session_id";
    captured[table] = (
      await f.admin.query(
        `SELECT count(*)::integer AS n,
      encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(source_row) ORDER BY to_jsonb(source_row)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
      FROM ${table} source_row WHERE ${column}=$1`,
        [sessionId],
      )
    ).rows;
  }
  return captured;
}

suite("genuine retained-v2 Account and v3 Account/Guest mixture", () => {
  test("retained ordinary source stays2; original Account3 and Guest3 share one real drawing and retain exact positive bindings without old-row mutation", async () => {
    await rewardedFixture(async (f) => {
      const pool = await setupPool(f, "mixed", 90000, true);
      if (pool.retained === null) throw new Error("Actual separate retained song leg required");
      expect(
        (
          await f.admin.query(
            "SELECT beneficiary_version,observation_id,status FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=$2::numeric",
            [pool.retained.legId, pool.original.drawingId],
          )
        ).rows,
      ).toEqual([
        { beneficiary_version: 2, observation_id: "observation-next-mixed", status: "entry_open" },
      ]);
      const ordinary = await f.completeAccount({
        personaId: pool.sponsorPersonaId,
        postId: pool.retained.postId,
        sessionId: "actual-retained-account-session",
        rewarded: false,
      });
      expect(ordinary).toMatchObject({ providerCalls: 4, putCalls: 4 });
      expect(
        (
          await f.admin.query(
            `SELECT share.beneficiary_version,share.account_id,qualification.persona_id,
        qualification.account_main_operation_id FROM megapot_pool_shares share
        JOIN activity_qualifications qualification USING(qualification_id)
        WHERE share.pool_leg_id=$1 AND share.drawing_id=$2::numeric`,
            [pool.retained.legId, pool.original.drawingId],
          )
        ).rows,
      ).toEqual([
        {
          beneficiary_version: 2,
          account_id: "study-account",
          persona_id: pool.sponsorPersonaId,
          account_main_operation_id: null,
        },
      ]);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::integer AS n FROM account_owner_reward_sources WHERE session_id=$1",
            [ordinary.sessionId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      const preserved = await retainedV2Rows(f, pool.retained.legId, ordinary.sessionId);
      for (const rows of Object.values(preserved)) expect(rows[0]?.n).toBeGreaterThan(0);
      const paid = await f.completeAccount({
        personaId: pool.sponsorPersonaId,
        postId: "study-post",
        sessionId: "actual-owner-account-session",
        rewarded: true,
      });
      expect(paid).toMatchObject({ providerCalls: 4, putCalls: 4 });
      const guest = await f.completeGuest(9501, "actual-mixed-guest-session");
      expect(guest.session.participation).toMatchObject({
        state: "admitted",
        pool_leg_id: pool.original.poolLegId,
        original_drawing_id: pool.original.drawingId,
      });
      expect(
        (
          await f.admin.query(
            `SELECT owner.kind,qualification.account_id,qualification.persona_id,
        qualification.account_main_operation_id IS NOT NULL AS actual_account_operation,share.beneficiary_version
        FROM megapot_owner_shares share JOIN activity_qualifications qualification USING(qualification_id)
        JOIN participation_owners owner ON owner.owner_id=share.owner_id
        WHERE share.pool_leg_id=$1 AND share.drawing_id=$2::numeric ORDER BY owner.kind`,
            [pool.original.poolLegId, pool.original.drawingId],
          )
        ).rows,
      ).toEqual([
        {
          kind: "account",
          account_id: "study-account",
          persona_id: pool.sponsorPersonaId,
          actual_account_operation: true,
          beneficiary_version: 3,
        },
        {
          kind: "guest",
          account_id: null,
          persona_id: null,
          actual_account_operation: false,
          beneficiary_version: 3,
        },
      ]);
      expect(await retainedV2Rows(f, pool.retained.legId, ordinary.sessionId)).toEqual(preserved);
      await waitActualClock(f, pool.cutoffAt, 100000);
      const snapshot = await freezeAndCommit(f, pool);
      await purchaseAndSweep(f, pool, 2n);
      const allocation = await run(snapshot.store.allocate(pool.original));
      expect(await run(snapshot.store.allocate(pool.original))).toEqual(allocation);
      expect(
        (
          await f.admin.query(
            `SELECT leaf.owner_kind,leaf.original_account_id,leaf.original_persona_id,allocation.amount_atomic::text,credit.identity_version,
        credit.account_id,credit.payout_persona_id,credit.participation_owner_id=leaf.owner_id AS exact_owner,
        binding.binding_source,binding.account_id AS binding_account,binding.persona_id AS binding_persona,
        binding.selection_revision
        FROM megapot_owner_allocations allocation JOIN megapot_owner_snapshot_leaves leaf
          ON leaf.snapshot_id=allocation.snapshot_id AND leaf.ordinal=allocation.ordinal
        JOIN reward_ledger_credits credit USING(credit_id)
        LEFT JOIN reward_credit_persona_bindings binding USING(credit_id)
        WHERE allocation.allocation_batch_id=$1 ORDER BY leaf.owner_kind`,
            [allocation.allocationBatchId],
          )
        ).rows,
      ).toEqual([
        {
          owner_kind: "account",
          original_account_id: "study-account",
          original_persona_id: pool.sponsorPersonaId,
          amount_atomic: "1",
          identity_version: "owner_v1",
          account_id: null,
          payout_persona_id: null,
          exact_owner: true,
          binding_source: "account_original",
          binding_account: "study-account",
          binding_persona: pool.sponsorPersonaId,
          selection_revision: null,
        },
        {
          owner_kind: "guest",
          original_account_id: null,
          original_persona_id: null,
          amount_atomic: "1",
          identity_version: "owner_v1",
          account_id: null,
          payout_persona_id: null,
          exact_owner: true,
          binding_source: null,
          binding_account: null,
          binding_persona: null,
          selection_revision: null,
        },
      ]);
      expect(
        (await f.admin.query("SELECT count(*)::integer AS n FROM reward_payout_effects")).rows,
      ).toEqual([{ n: 0 }]);
      expect(await retainedV2Rows(f, pool.retained.legId, ordinary.sessionId)).toEqual(preserved);
    });
  }, 180000);
});
