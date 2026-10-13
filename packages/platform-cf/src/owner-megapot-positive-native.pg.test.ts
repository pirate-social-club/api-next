/** Genuine complete native source only. PG source/SDK/I/O protocol acceptance,
 * never live chain/R2/provider or staging acceptance. */
import { describe, expect, test } from "bun:test";
import {
  Clock,
  IdGen,
  makeSongRewardOfferService,
  prepareActivityPersona,
} from "@pirate/application";
import { Effect, Schema } from "effect";
import { keccak256, sha256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { confirmWallet } from "./activity-participation-composed-identity.pg-fixture.ts";
import { makeControlPlaneMegapotClaimStore } from "./megapot-claim-repository.ts";
import { makeR2MegapotCommitmentPublisher } from "./megapot-commitment-r2.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import { makeControlPlaneMegapotPurchaseStore } from "./megapot-purchase-repository.ts";
import { makeControlPlaneMegapotSweepStore } from "./megapot-sweep-repository.ts";
import { makeBaseSepoliaMegapotCommitmentSigner } from "./megapot-v2-signer.ts";
import { openOwnerDrawingsForObservation } from "./owner-drawing-opener.ts";
import { makeOwnerMegapotCommitmentCoordinator } from "./owner-megapot-commitment-coordinator.ts";
import {
  type RewardedFixture,
  rewardedFixture,
} from "./owner-megapot-rewarded-journey.pg-fixture.ts";
import { makeControlPlaneOwnerMegapotSettlementStore } from "./owner-megapot-settlement-store.ts";
import { hash, pgUrl, run } from "./owner-study-starter.pg-fixture.ts";
import {
  makeControlPlanePersonaStore,
  makeControlPlanePersonaWalletStore,
} from "./persona-repository.ts";
import { makeControlPlaneRewardFundingStore } from "./reward-funding-repository.ts";
import { makeControlPlaneRewardRunAuthority } from "./reward-operations-control.ts";
import { makeControlPlaneRewardPayoutStore } from "./reward-payout-repository.ts";
import {
  makeControlPlaneOwnerMegapotPoolLegCreator,
  makeControlPlaneSongRewardOfferStore,
} from "./song-reward-offer-repository.ts";

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

async function setupPool(f: RewardedFixture, suffix: string) {
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
    cutoffAt = new Date(clock.getTime() + 45000),
    drawingTime = new Date(cutoffAt.getTime() + 300000);
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
  const openedLegs = await run(
    openOwnerDrawingsForObservation(`observation-${suffix}`).pipe(Effect.provide(f.adminRuntime)),
  );
  expect(openedLegs).toEqual([created.leg.legId]);
  const original = { poolLegId: created.leg.legId, drawingId: "101" };
  return { key, custody, original, cutoffAt };
}

async function freezeAndCommit(f: RewardedFixture, pool: Awaited<ReturnType<typeof setupPool>>) {
  // Actual clock schedule, bounded. No fake clock or source cutoff/expiry UPDATE.
  const deadline = Date.now() + 60000;
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
  const key = { poolLegId: pool.original.poolLegId, drawingId: 101n },
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
  // Zero uses a paying-tier zero sealed sweep and NEVER creates a fake claim.
  const sweep = await run(
    sweeps.complete({
      candidate: await run(sweeps.loadCandidate(key)),
      sweepId: `sweep-${pool.original.poolLegId}`,
      observationBlockNumber: 105n,
      observationBlockHash: hex("sweep-block"),
      drawingStateHash: hash("drawing-state"),
      tierId: 7,
      custodyOwnerAddress: pool.custody,
      grossWinningsAtomic: net,
      referralWinShareAtomic: 0n,
      referralAccrualAtomic: 0n,
      netWinningsAtomic: net,
      observedAt: new Date().toISOString(),
    }),
  );
  expect(sweep.outcome).toBe("winnings_detected");
  expect(sweep.netWinningsAtomic).toBe(net);
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
    test(`real original CP/admission produces conserved ${net === 0n ? "all-zero sweep" : "positive and zero"} allocations and private public commitment`, async () => {
      await rewardedFixture(async (f) => {
        const pool = await setupPool(f, `native-${net}`);
        const beforeCalls = f.providerCalls();
        const first = await f.completeGuest(Number(net) + 9001, `first-${net}`),
          second = await f.completeGuest(Number(net) + 9101, `second-${net}`);
        expect(f.providerCalls() - beforeCalls).toBe(8);
        expect(f.putCalls()).toBe(8);
        expect(first.session.reward_terms?.pool_leg_id).toBe(pool.original.poolLegId);
        expect(second.session.reward_terms?.original_drawing_id).toBe("101");
        const snapshot = await freezeAndCommit(f, pool);
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
              run(makeControlPlaneRewardPayoutStore(f.adminRuntime).loadCandidate(row.credit_id)),
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
          (await f.admin.query("SELECT count(*)::integer AS n FROM reward_payout_effects")).rows,
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
            "SELECT frozen_share_count,reserved_ticket_cost_atomic::text,actual_ticket_cost_atomic::text FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=101",
            [pool.original.poolLegId],
          )
        ).rows;
        expect(source).toEqual([
          {
            frozen_share_count: 2,
            reserved_ticket_cost_atomic: "10000",
            actual_ticket_cost_atomic: "10000",
          },
        ]);
        expect(f.providerCalls() - beforeCalls).toBe(8);
        expect(f.putCalls()).toBe(8);
      });
    }, 180000);
});
