import { expect, test } from "bun:test";
import { RewardRunAuthorityUnavailable } from "@pirate/application";
import {
  type IndependentRewardCreditIssuerV1,
  RewardSafeSettlementFailedV1,
  type RewardSafeSignerV1,
} from "@pirate/application/rewards/safe-settlement-v1";
import { Effect } from "effect";
import { Client } from "pg";
import { encodeFunctionData, type Hex, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { upgradeLocalSafeTestSchema } from "./reward-safe-forward-test.fixture.ts";
import {
  moneyTableInventoryViolations,
  REWARDS_MONEY_TABLE_PATTERN,
} from "../../../scripts/rewards-money-write-contract.ts";
import { seedVeryRewardEvidence } from "./activity-participation-composed-identity.pg-fixture.ts";
import { makeCustodySolvencyCoordinator } from "./custody-solvency-coordinator.ts";
import { makeControlPlaneCustodySolvencyStore } from "./custody-solvency-repository.ts";
import { makeMegapotAllocationCoordinator } from "./megapot-allocation-coordinator.ts";
import { makeControlPlaneMegapotAllocationStore } from "./megapot-allocation-repository.ts";
import { makeMegapotApprovalCoordinator } from "./megapot-approval-coordinator.ts";
import { makeControlPlaneMegapotApprovalStore } from "./megapot-approval-repository.ts";
import { makeMegapotClaimCoordinator } from "./megapot-claim-coordinator.ts";
import { makeControlPlaneMegapotClaimStore } from "./megapot-claim-repository.ts";
import { makeMegapotCommitmentCoordinator } from "./megapot-commitment-coordinator.ts";
import { makeControlPlaneMegapotCommitmentStore } from "./megapot-commitment-repository.ts";
import { createControlledMainnet } from "./megapot-controlled-mainnet.fixture.ts";
import { makeMegapotCutoffCoordinator } from "./megapot-cutoff-coordinator.ts";
import { makeControlPlaneMegapotCutoffStore } from "./megapot-cutoff-repository.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import { makeMegapotDrawingObserver } from "./megapot-drawing-observer.ts";
import { openMainnetLocalFixture } from "./megapot-mainnet-local.fixture.ts";
import { makeMegapotPurchaseCoordinator } from "./megapot-purchase-coordinator.ts";
import { makeControlPlaneMegapotPurchaseStore } from "./megapot-purchase-repository.ts";
import { makeMegapotSweepCoordinator } from "./megapot-sweep-coordinator.ts";
import { makeControlPlaneMegapotSweepStore } from "./megapot-sweep-repository.ts";
import { encodeMegapotUsdcTransfer } from "./megapot-v2.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeRewardFundingCoordinator } from "./reward-funding-coordinator.ts";
import { makeControlPlaneRewardFundingStore } from "./reward-funding-repository.ts";
import {
  makeControlPlaneRewardOfferTerminalStore,
  makeLocalRewardOfferTerminalStore,
} from "./reward-offer-terminal-repository.ts";
import { makeControlPlaneRewardRunAuthority } from "./reward-operations-control.ts";
import { makeRewardRefundCoordinator } from "./reward-refund-coordinator.ts";
import { makeControlPlaneRewardRefundStore } from "./reward-refund-repository.ts";
import { makeLocalRewardSafeBackingV1 } from "./reward-safe-backing-v1.ts";
import { makeLocalRewardSafeCoordinatorV1 } from "./reward-safe-coordinator-v1.ts";
import { rewardSafeCreditDigestV1, rewardSafeTypedDataV1 } from "./reward-safe-credit-v1.ts";
import { createLocalSafeSettlement, readLocalContract } from "./reward-safe-local.fixture.ts";
import { makeControlPlaneRewardSafeStoreV1 } from "./reward-safe-repository-v1.ts";
import { seedActivePoolLeg, seedSong } from "./rewards-song-offers.pg-fixture.ts";

const forkTest = process.env.MEGAPOT_LOCAL_PERSISTENCE_TEST === "1" ? test : test.skip;
forkTest.each(["complete", "reverted", "reorg"] as const)(
  "PostgreSQL mainnet-local lifecycle through real Safe settlement: %s",
  async (scenario) => {
    const url = new URL(process.env.CONTROL_PLANE_POSTGRES_TEST_URL ?? "");
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "54387" ||
      url.pathname !== "/rewards_source_test"
    )
      throw new Error("assigned_test_database_required");
    const schema = `rewards_lifecycle_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: url.href });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    let f: Awaited<ReturnType<typeof openMainnetLocalFixture>> | undefined;
    try {
      f = await openMainnetLocalFixture();
      await f.provision(110000n);
      const controlled = await createControlledMainnet(f);
      const d = controlled.deployment;
      const rpc = controlled.client;
      await f.rpc("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]);
      await f.rpc("anvil_mine", ["0x1"]);
      let now = Date.now();
      const syncClock = async () => {
        const h = await rpc.readHead();
        if (h.blockTimestamp === undefined) throw new Error("clock_missing");
        now = Number(h.blockTimestamp) * 1000 + 10;
      };
      await syncClock();
      await applyPostgresTestBaselineConnection({
        connectionString: scoped.href,
        rewardsRunning: true,
      });
      await admin.query(`SET search_path TO "${schema}"`);
      await upgradeLocalSafeTestSchema(scoped.href);
      const inventory = await admin.query(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND c.relname ~ $2 ORDER BY c.relname",
        [schema, REWARDS_MONEY_TABLE_PATTERN],
      );
      expect(moneyTableInventoryViolations(inventory.rows.map((r) => r.relname))).toEqual([]);
      const unsafeGrants = await admin.query(
        "SELECT count(*)::int AS unsafe FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE n.nspname=$1 AND c.relname LIKE 'reward_safe_%_v1' AND a.grantee<>c.relowner AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')",
        [schema],
      );
      expect(unsafeGrants.rows).toEqual([{ unsafe: 0 }]);
      await admin.query(
        `INSERT INTO reward_asset_whitelist(chain_id,token_address,decimals,symbol,asset_kind,environment,status,policy_version,activated_at,plain_erc20_verified_at)
      VALUES(8453,$1,6,'USDC','settlement_usdc','production','active','local-fork-only',statement_timestamp(),statement_timestamp())`,
        [d.usdcAddress],
      );
      await admin.query(
        `INSERT INTO megapot_deployment_attestations(attestation_id,environment,chain_id,jackpot_address,usdc_address,ticket_nft_address,custody_address,referrer_address,source_tag,jackpot_code_hash,usdc_code_hash,ticket_nft_code_hash,usdc_implementation_address,usdc_implementation_code_hash,attestation_block_number,attestation_block_hash,abi_version,status,verified_at)
      VALUES($1,'production',8453,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'megapot_v2','active',clock_timestamp())`,
        [
          d.attestationId,
          d.jackpotAddress,
          d.usdcAddress,
          d.ticketNftAddress,
          d.custodyAddress,
          d.referrerAddress,
          keccak256(toBytes("local-lifecycle")),
          d.jackpotCodeHash,
          d.usdcCodeHash,
          d.ticketNftCodeHash,
          d.usdcImplementationAddress,
          d.usdcImplementationCodeHash,
          (await rpc.readHead()).blockNumber.toString(),
          (await rpc.readHead()).blockHash,
        ],
      );
      const funder = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Hex;
      const identity = await seedSong(admin, "mainnet-lifecycle", funder);
      const second = await seedSong(
        admin,
        "mainnet-second",
        privateKeyToAccount(generatePrivateKey()).address.toLowerCase(),
      );
      const leg = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "mainnet-lifecycle",
        localMainnet: {
          localForkOnly: true,
          attestationId: d.attestationId,
          tokenAddress: d.usdcAddress,
          drawingId: 1n,
          fundedAtomic: 0n,
          activate: false,
        },
      });
      const layer = () => makeDirectPostgresControlPlaneLayer(scoped.href);
      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
      const authority = () => makeControlPlaneRewardRunAuthority(layer());
      const funding = () =>
        makeRewardFundingCoordinator({
          store: makeControlPlaneRewardFundingStore(layer()),
          rpc,
          now: () => Math.max(now, Date.now()),
        });
      await f.setupTransaction(encodeMegapotUsdcTransfer(funder, 100000n), d.usdcAddress as Hex);
      const planned = await run(
        funding().plan({
          legId: leg.legId,
          funderAccountId: identity.accountId,
          senderAddress: funder,
          expectedAmountAtomic: 100000n,
          requiredConfirmations: 1,
          idempotencyKey: "mainnet-funding",
        }),
      );
      await f.rpc("anvil_impersonateAccount", [funder]);
      await f.rpc("anvil_setBalance", [funder, "0x3635c9adc5dea00000"]);
      let fundTx: string;
      try {
        fundTx = String(
          await f.rpc("eth_sendTransaction", [
            {
              from: funder,
              to: d.usdcAddress,
              gas: "0x30d40",
              data: encodeMegapotUsdcTransfer(d.custodyAddress, 100000n),
            },
          ]),
        );
      } finally {
        await f.rpc("anvil_stopImpersonatingAccount", [funder]);
      }
      await run(
        funding().observe({
          fundingEffectId: planned.intent.fundingEffectId,
          transactionHash: fundTx,
        }),
      );
      await f.rpc("anvil_mine", ["0x80"]);
      await syncClock();
      expect(await run(funding().reconcile(planned.intent.fundingEffectId))).toMatchObject({
        kind: "confirmed",
      });
      await f.setupTransaction(
        encodeMegapotUsdcTransfer(d.jackpotAddress, 10000n),
        d.usdcAddress as Hex,
      );
      const approval = () =>
        makeMegapotApprovalCoordinator({
          store: makeControlPlaneMegapotApprovalStore(layer()),
          rpc,
          signer: f!.signer,
          authority: authority(),
          requiredConfirmations: 1,
          gasLimitMultiplierBps: 12000,
          nativeGasReserveFloorWei: 0n,
          now: () => Math.max(now, Date.now()),
        });
      let approved = await run(
        approval().approve({
          attestationId: d.attestationId,
          minimumAllowanceAtomic: 20000n,
          approvedAmountAtomic: 20000n,
        }),
      );
      if (approved.kind !== "confirmed" && approved.kind !== "not_required") {
        await f.rpc("anvil_mine", ["0x80"]);
        await syncClock();
        approved = await run(approval().reconcile(approved.effectId));
      }
      expect(approved.kind).toBe("confirmed");
      const allCredits: string[] = [];
      for (const [cycle, losing] of [
        [1n, false],
        [2n, true],
      ] as const) {
        await syncClock();
        const drawAt = BigInt(Math.floor(now / 1000) + 600);
        await controlled.arm(drawAt, 1001n, losing);
        await syncClock();
        const observer = () =>
          makeMegapotDrawingObserver({
            store: makeControlPlaneMegapotDrawingObservationStore(layer()),
            rpc,
            observationTtlMs: 900000,
            now: () => now,
          });
        const observation = await run(observer().observe(d.attestationId));
        expect(observation.openedPoolLegIds).toContain(leg.legId);
        // Activity and independent eligibility are offline prerequisites; every
        // drawing/chain/economic effect below is created by real stores/coordinators.
        for (const [ordinal, person] of [identity, second].entries()) {
          const suffix = `${cycle}-${ordinal}`;
          await admin.query("SET session_replication_role=replica");
          try {
            await admin.query(
              `INSERT INTO activity_qualifications(qualification_id,account_id,persona_id,community_id,post_id,audio_revision,activity_key,study_session_id,score_bps,qualification_policy_version_id,qualified_at,streak_day,evidence_summary)
          VALUES($1,$2,$3,$4,$5,3,'study',$6,8000,'study_session_first_pass_v2@1',clock_timestamp(),current_date,'{"kind":"study_session_first_pass_v2"}')`,
              [
                `q-${suffix}`,
                person.accountId,
                person.personaId,
                identity.communityId,
                identity.postId,
                `study-${suffix}`,
              ],
            );
          } finally {
            await admin.query("SET session_replication_role=origin");
          }
          await admin.query(
            `INSERT INTO reward_eligibility_decisions(eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,drawing_id,outcome,policy_version,evidence_hash,decided_at,expires_at)
          VALUES($1,$2,$3,$4,'pool_share',$5,$6,'eligible','local-verified-activity',$7,clock_timestamp(),clock_timestamp()+interval '2 hours')`,
            [
              `eligible-${suffix}`,
              leg.legId,
              person.accountId,
              person.personaId,
              `q-${suffix}`,
              cycle.toString(),
              "e".repeat(64),
            ],
          );
          await admin.query(
            `INSERT INTO megapot_pool_shares(pool_leg_id,drawing_id,account_id,persona_id,qualification_id,eligibility_decision_id,qualified_at)
          SELECT $1,$2,account_id,persona_id,qualification_id,$3,qualified_at FROM activity_qualifications WHERE qualification_id=$4`,
            [leg.legId, cycle.toString(), `eligible-${suffix}`, `q-${suffix}`],
          );
        }
        await f.rpc("evm_setNextBlockTimestamp", [Number(drawAt - 250n)]);
        await f.rpc("anvil_mine", ["0x1"]);
        await syncClock();
        const frozen = await run(
          makeMegapotCutoffCoordinator({
            store: makeControlPlaneMegapotCutoffStore(layer()),
            externalSponsorDailyTicketCeiling: 10,
            externalSponsorDailySpendCeilingAtomic: 100000n,
            sharedSponsorDailyTicketCeiling: 10,
            sharedSponsorDailySpendCeilingAtomic: 100000n,
            now: () => now,
          }).freezeDue(),
        );
        expect(frozen).toMatchObject([{ status: "cutoff_frozen", frozenShareCount: 2 }]);
        const key = { poolLegId: leg.legId, drawingId: cycle };
        const commitment = () =>
          makeMegapotCommitmentCoordinator({
            store: makeControlPlaneMegapotCommitmentStore(layer()),
            authority: authority(),
            signer: {
              sign: async (payload) => ({
                signingKeyId: "local-fake-commitment",
                signature: await f!.testAccount.signMessage({ message: { raw: payload } }),
              }),
            },
            publisher: {
              publish: async (input) => ({
                publicReference: `urn:local:${input.idempotencyKey}`,
                publishedAt: new Date(now).toISOString(),
              }),
            },
            now: () => now,
          });
        const committed = await run(commitment().commit(key));
        expect(committed.state).toBe("published");
        expect(await run(commitment().commit(key))).toEqual(committed);
        const purchase = () =>
          makeMegapotPurchaseCoordinator({
            store: makeControlPlaneMegapotPurchaseStore(layer()),
            rpc,
            signer: f!.signer,
            authority: authority(),
            options: {
              requiredConfirmations: 1,
              purchaseSafetyMarginSeconds: 60,
              gasLimitMultiplierBps: 12000,
              nativeGasReserveFloorWei: 0n,
              now: () => now,
            },
          });
        const bought = await run(purchase().purchase(key));
        if (
          bought.kind !== "confirmed" &&
          bought.kind !== "submitted" &&
          bought.kind !== "reconciliation_required"
        )
          throw new Error("purchase_not_admitted");
        await f.rpc("anvil_mine", ["0x80"]);
        await syncClock();
        const purchased = await run(purchase().reconcile(bought.effectId));
        expect(purchased.kind).toBe("confirmed");
        if (purchased.kind !== "confirmed") throw new Error("purchase_not_confirmed");
        expect(await controlled.readOwner(purchased.ticketId)).toBe(d.custodyAddress);
        const sweep = () =>
          makeMegapotSweepCoordinator({
            store: makeControlPlaneMegapotSweepStore(layer()),
            rpc,
            requiredConfirmations: 1,
            now: () => now,
          });
        expect(await run(sweep().sweep(key))).toMatchObject({ kind: "drawing_pending" });
        await controlled.settle(cycle, purchased.ticketId);
        await f.rpc("anvil_mine", ["0x80"]);
        await syncClock();
        const swept = await run(sweep().sweep(key));
        expect(swept).toMatchObject({
          kind: "complete",
          outcome: losing ? "no_win" : "winnings_detected",
        });
        expect(await run(sweep().sweep(key))).toEqual(swept);
        if (losing) {
          await expect(
            run(makeControlPlaneMegapotClaimStore(layer()).loadCandidate(key)),
          ).rejects.toMatchObject({ reason: "ticket-not-claimable" });
          continue;
        }
        const claim = () =>
          makeMegapotClaimCoordinator({
            store: makeControlPlaneMegapotClaimStore(layer()),
            rpc,
            signer: f!.signer,
            authority: authority(),
            requiredConfirmations: 1,
            gasLimitMultiplierBps: 12000,
            nativeGasReserveFloorWei: 0n,
            now: () => now,
          });
        const claiming = await run(claim().claim(key));
        if (!("effectId" in claiming)) throw new Error("claim_not_admitted");
        await f.rpc("anvil_mine", ["0x80"]);
        await syncClock();
        const claimed = await run(claim().reconcile(claiming.effectId));
        expect(claimed).toMatchObject({
          kind: "confirmed",
          grossWinningsAtomic: 1001n,
          referralAccrualAtomic: 100n,
          netWinningsAtomic: 901n,
        });
        expect(await run(claim().claim(key))).toEqual(claimed);
        const allocator = () =>
          makeMegapotAllocationCoordinator({
            store: makeControlPlaneMegapotAllocationStore(layer()),
            now: () => now,
          });
        const allocation = await run(allocator().allocate(key));
        expect(allocation.allocations.map((a) => a.amountAtomic).sort()).toEqual([450n, 451n]);
        expect(await run(allocator().allocate(key))).toEqual(allocation);
        for (const row of allocation.allocations) {
          if (row.creditId === null) throw new Error("credit_missing");
          allCredits.push(row.creditId);
          await seedVeryRewardEvidence(
            admin,
            row.accountId,
            `mainnet-${row.ordinal}`,
            String(row.ordinal + 1).repeat(64),
          );
          expect(
            (
              await admin.query("SELECT outcome FROM accept_megapot_participant_claim_v1($1,$2)", [
                row.creditId,
                row.accountId,
              ])
            ).rows,
          ).toEqual([{ outcome: "accepted" }]);
        }
      }
      expect(allCredits).toHaveLength(2);
      const solvency = await run(
        makeCustodySolvencyCoordinator({
          store: makeControlPlaneCustodySolvencyStore(layer()),
          rpc,
          requiredConfirmations: 1,
          now: () => now,
        }).observe(d.attestationId),
      );
      expect(solvency).toMatchObject({
        solvent: true,
        outstandingCreditAtomic: 901n,
        pendingRefundAtomic: 80000n,
      });
      expect(await rpc.readUsdcBalance(d.custodyAddress)).toBe(80901n);
      const safe = await createLocalSafeSettlement(f, 901n);
      await safe.enable();
      await f.rpc("anvil_mine", ["0x80"]);
      const policy = {
        policyId: "local-safe-v1",
        version: "safe_credit_v1",
        posture: "local_only",
        attestationId: d.attestationId,
        collectionRoot: d.custodyAddress,
        safeRoot: safe.safe,
        token: d.usdcAddress,
        module: safe.module,
        relayer: d.custodyAddress,
        creditAuthority: safe.issuer.address.toLowerCase(),
        aggregateCapAtomic: "901",
        safeCodeHash: keccak256((await f.rpc("eth_getCode", [safe.safe, "latest"])) as Hex),
        moduleCodeHash: keccak256((await f.rpc("eth_getCode", [safe.module, "latest"])) as Hex),
        safeSingleton: "0x41675c099f32341bf84bfc5382af534df5c7461a",
        safeSingletonCodeHash: "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4",
      };
      await admin.query(
        "INSERT INTO reward_safe_policies_v1(policy_id,attestation_id,configuration,cap_atomic) VALUES($1,$2,$3::jsonb,901)",
        [policy.policyId, d.attestationId, JSON.stringify(policy)],
      );
      await expect(
        admin.query("UPDATE reward_safe_policies_v1 SET cap_atomic=902 WHERE policy_id=$1", [
          policy.policyId,
        ]),
      ).rejects.toMatchObject({ code: "P0001" });
      const signedResults = new Map<string, { rawTransaction: string; transactionHash: string }>();
      let signingCalls = 0,
        issuerCalls = 0,
        unknownSigning = false;
      let lookupAvailable = true;
      const fakeSigner: RewardSafeSignerV1 = {
        sign: (key, u) =>
          Effect.tryPromise({
            try: async () => {
              let result = signedResults.get(key);
              if (result === undefined) {
                signingCalls++;
                const rawTransaction = await f!.testAccount.signTransaction({
                  chainId: 8453,
                  type: "eip1559",
                  to: u.targetAddress as Hex,
                  nonce: Number(u.nonce),
                  data: u.data as Hex,
                  value: 0n,
                  gas: BigInt(u.gas),
                  maxFeePerGas: BigInt(u.maxFeePerGas),
                  maxPriorityFeePerGas: BigInt(u.maxPriorityFeePerGas),
                });
                result = { rawTransaction, transactionHash: keccak256(rawTransaction) };
                signedResults.set(key, result);
              }
              if (unknownSigning) {
                unknownSigning = false;
                throw new Error("injected_sign_ack_loss");
              }
              return result;
            },
            catch: () => new RewardSafeSettlementFailedV1({ reason: "unavailable" }),
          }),
        lookup: (key) => Effect.succeed(lookupAvailable ? (signedResults.get(key) ?? null) : null),
      };
      const issuer: IndependentRewardCreditIssuerV1 = {
        authorize: (c, p) =>
          Effect.tryPromise({
            try: async () => {
              issuerCalls++;
              const credit = {
                creditId: keccak256(toBytes(c.creditId)),
                safeRoot: p.safeRoot as Hex,
                token: p.token as Hex,
                module: p.module as Hex,
                recipient: c.recipient as Hex,
                amount: c.amountAtomic,
                validUntil: BigInt(Math.floor(now / 1000)) + 3600n,
              };
              return {
                digest: rewardSafeCreditDigestV1(credit),
                signature: await safe.issuer.signTypedData(rewardSafeTypedDataV1(credit)),
                validUntil: credit.validUntil,
                issuerKeyId: "local-independent-fake-issuer",
              };
            },
            catch: () => new RewardSafeSettlementFailedV1({ reason: "unavailable" }),
          }),
      };
      const safeStore = () => makeControlPlaneRewardSafeStoreV1(layer());
      const settlement = () =>
        makeLocalRewardSafeCoordinatorV1({
          rpc,
          store: safeStore(),
          issuer,
          signer: fakeSigner,
          authority: authority(),
          localGasLimit: scenario === "reverted" ? 50000n : 500000n,
        });
      const backing = () =>
        makeLocalRewardSafeBackingV1({
          layer: layer(),
          rpc,
          signer: fakeSigner,
          authority: authority(),
          localGasLimit: 150000n,
          settlement: settlement(),
        });
      f.loseNextAcknowledgement();
      expect(await run(backing().fund(policy.policyId, 901n))).toMatchObject({
        state: "broadcast_unknown",
      });
      expect(await run(backing().fund(policy.policyId, 901n))).toMatchObject({
        state: "broadcast_unknown",
      });
      await f.rpc("anvil_mine", ["0x80"]);
      expect(await run(backing().fund(policy.policyId, 901n))).toMatchObject({
        state: "confirmed",
      });
      await expect(
        admin.query("UPDATE reward_safe_backing_v1 SET raw_transaction='0x01' WHERE policy_id=$1", [
          policy.policyId,
        ]),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(await run(backing().fund(policy.policyId, 901n))).toMatchObject({
        state: "confirmed",
      });
      expect(signingCalls).toBe(1);
      unknownSigning = true;
      expect(await run(settlement().observe(policy.policyId))).toMatchObject({
        solvent: true,
        collectionBalanceAtomic: 80000n,
        safeBalanceAtomic: 901n,
        outstandingCreditAtomic: 901n,
        pendingRefundAtomic: 80000n,
        reservedSafeAtomic: 0n,
      });
      const restart = async (
        creditId: string,
        lookup?: { rawTransaction: string; transactionHash: string },
        loseAck = false,
      ) => {
        const child = Bun.spawn(
          [process.execPath, new URL("./reward-safe-restart.fixture.ts", import.meta.url).pathname],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        );
        child.stdin.write(
          JSON.stringify({ database: scoped.href, deployment: d, creditId, lookup, loseAck }),
        );
        child.stdin.end();
        const [exit, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (exit !== 0) throw new Error(`local_restart_exit_${exit}:${error}`);
        return JSON.parse(output) as { state: string; transactionHash: string };
      };
      const first = allCredits[0]!;
      await expect(run(settlement().settle(first, policy.policyId))).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(await run(safeStore().find(first))).toMatchObject({ state: "signing" });
      expect(signingCalls).toBe(2);
      lookupAvailable = false;
      expect(await run(settlement().reconcile(first))).toMatchObject({
        state: "signing",
        signed: null,
      });
      expect(signingCalls).toBe(2);
      lookupAvailable = true;
      const refused = makeLocalRewardSafeCoordinatorV1({
        rpc,
        store: safeStore(),
        issuer,
        signer: fakeSigner,
        authority: {
          ensure: () => Effect.fail(new RewardRunAuthorityUnavailable({ reason: "unavailable" })),
        },
        localGasLimit: 500000n,
      });
      await expect(run(refused.reconcile(first))).rejects.toMatchObject({ reason: "authority" });
      expect(await run(safeStore().find(first))).toMatchObject({ state: "signed" });
      await expect(
        admin.query(
          'UPDATE reward_safe_settlements_v1 SET unsigned_transaction=unsigned_transaction || \'{"valueWei":"1"}\'::jsonb WHERE credit_id=$1',
          [first],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      const beforeIdentityChange = f.counts().sends;
      const identitySnapshot = await f.rpc("evm_snapshot", []);
      try {
        await f.rpc("anvil_setCode", [safe.module, "0x6000"]);
        await expect(run(settlement().reconcile(first))).rejects.toMatchObject({
          reason: "invalid",
        });
        expect(f.counts().sends).toBe(beforeIdentityChange);
      } finally {
        expect(await f.rpc("evm_revert", [identitySnapshot])).toBe(true);
      }
      const signed = [...signedResults.values()].at(-1)!;
      const beforeBroadcastSnapshot = scenario === "reorg" ? await f.rpc("evm_snapshot", []) : null;
      expect(await restart(first, signed, true)).toMatchObject({
        state: "broadcast_unknown",
        transactionHash: signed.transactionHash,
      });
      expect(await restart(first)).toMatchObject({ state: "broadcast_unknown" });
      if (scenario === "reorg") {
        expect(await f.rpc("evm_revert", [beforeBroadcastSnapshot])).toBe(true);
        expect(await rpc.readReceipt(signed.transactionHash)).toBeNull();
        expect(await rpc.readTransaction?.(signed.transactionHash)).toBeNull();
        const journal = await run(safeStore().find(first));
        if (journal?.unsigned === null || journal === null)
          throw new Error("reorg_unsigned_missing");
        expect(await rpc.readPendingNonce(d.custodyAddress)).toBe(BigInt(journal.unsigned.nonce));
        expect(await restart(first)).toMatchObject({
          state: "broadcast_unknown",
          transactionHash: signed.transactionHash,
        });
        expect(await run(settlement().settle(first, policy.policyId))).toMatchObject({
          state: "broadcast_unknown",
          signed,
        });
        expect(await rpc.readReceipt(signed.transactionHash)).toBeNull();
        expect(await run(settlement().observe(policy.policyId))).toMatchObject({
          solvent: true,
          collectionBalanceAtomic: 80000n,
          safeBalanceAtomic: 901n,
          outstandingCreditAtomic: 901n,
          pendingRefundAtomic: 80000n,
        });
        expect(await readLocalContract(f, safe.module, safe.moduleAbi, "spentAtomic")).toBe(0n);
        const fence = await admin.query(
          "SELECT next_nonce::text FROM reward_signer_nonces WHERE chain_id=8453 AND signer_address=$1",
          [d.custodyAddress],
        );
        expect(BigInt(fence.rows[0]?.next_nonce)).toBe(BigInt(journal.unsigned.nonce) + 1n);
        expect(signingCalls).toBe(2);
        expect(issuerCalls).toBe(1);
        return;
      }
      await f.rpc("anvil_mine", ["0x80"]);
      expect(await restart(first)).toMatchObject({
        state: scenario === "reverted" ? "held" : "confirmed",
        transactionHash: signed.transactionHash,
      });
      if (scenario === "reverted") {
        expect((await rpc.readReceipt(signed.transactionHash))?.status).toBe("reverted");
        expect(await run(settlement().settle(first, policy.policyId))).toMatchObject({
          state: "held",
        });
        expect(await run(settlement().reconcile(first))).toMatchObject({ state: "held" });
        expect(await run(settlement().observe(policy.policyId))).toMatchObject({
          solvent: true,
          collectionBalanceAtomic: 80000n,
          safeBalanceAtomic: 901n,
          outstandingCreditAtomic: 901n,
          pendingRefundAtomic: 80000n,
        });
        expect(await readLocalContract(f, safe.module, safe.moduleAbi, "spentAtomic")).toBe(0n);
        expect(
          await readLocalContract(f, safe.module, safe.moduleAbi, "consumed", [
            keccak256(toBytes(first)),
          ]),
        ).toBe(false);
        expect(signingCalls).toBe(2);
        expect(issuerCalls).toBe(1);
        const held = await admin.query(
          "SELECT state,reserved_atomic::text,paid_atomic::text FROM reward_ledger_credits WHERE credit_id=$1",
          [first],
        );
        expect(held.rows[0]?.state).toBe("reconciliation_required");
        expect(BigInt(held.rows[0]?.reserved_atomic)).toBeGreaterThan(0n);
        expect(held.rows[0]?.paid_atomic).toBe("0");
        return;
      }
      expect(await run(settlement().settle(first, policy.policyId))).toMatchObject({
        state: "confirmed",
      });
      await expect(
        admin.query(
          "UPDATE reward_safe_settlements_v1 SET state='broadcast_unknown' WHERE credit_id=$1",
          [first],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      const secondCredit = allCredits[1]!;
      const next = await run(settlement().settle(secondCredit, policy.policyId));
      expect(next.state).toBe("submitted");
      await f.rpc("anvil_mine", ["0x80"]);
      expect(await restart(secondCredit)).toMatchObject({ state: "confirmed" });
      expect(signingCalls).toBe(3);
      expect(issuerCalls).toBe(2);
      expect(await rpc.readUsdcBalance(safe.safe)).toBe(0n);
      expect(await rpc.readUsdcBalance(d.custodyAddress)).toBe(80000n);
      const paid = await admin.query(
        "SELECT state,paid_atomic::text,reserved_atomic::text FROM reward_ledger_credits ORDER BY credit_id",
      );
      expect(paid.rows.map((r) => r.state)).toEqual(["sent", "sent"]);
      expect(paid.rows.reduce((s, r) => s + BigInt(r.paid_atomic), 0n)).toBe(901n);
      expect(paid.rows.map((r) => r.reserved_atomic)).toEqual(["0", "0"]);
      expect(await run(settlement().observe(policy.policyId))).toMatchObject({
        solvent: true,
        collectionBalanceAtomic: 80000n,
        safeBalanceAtomic: 0n,
        outstandingCreditAtomic: 0n,
        pendingRefundAtomic: 80000n,
        reservedSafeAtomic: 0n,
      });
      expect(await run(makeControlPlaneRewardOfferTerminalStore(layer()).closeExpired(10))).toEqual(
        [],
      );
      const expiry = (
        await admin.query("SELECT ends_at FROM song_reward_offers WHERE offer_id=$1", [leg.offerId])
      ).rows[0]?.ends_at;
      now = new Date(expiry).getTime() + 1000;
      const terminal = () => makeLocalRewardOfferTerminalStore(layer(), rpc, () => now);
      expect(await run(terminal().closeExpired(10))).toMatchObject([
        { offerId: leg.offerId, status: "expired", legIds: [leg.legId] },
      ]);
      expect(await run(terminal().closeExpired(10))).toEqual([]);
      await f.rpc("evm_setNextBlockTimestamp", [Math.floor(now / 1000)]);
      await f.rpc("anvil_mine", ["0x80"]);
      await syncClock();
      expect(
        await run(
          makeCustodySolvencyCoordinator({
            store: makeControlPlaneCustodySolvencyStore(layer()),
            rpc,
            requiredConfirmations: 1,
            now: () => now,
          }).observe(d.attestationId),
        ),
      ).toMatchObject({ solvent: true, pendingRefundAtomic: 80000n, outstandingCreditAtomic: 0n });
      const refund = () =>
        makeRewardRefundCoordinator({
          store: makeControlPlaneRewardRefundStore(layer()),
          rpc,
          signer: f!.signer,
          authority: authority(),
          requiredConfirmations: 1,
          gasLimitMultiplierBps: 12000,
          nativeGasReserveFloorWei: 0n,
          now: () => now,
        });
      const funderBeforeRefund = await rpc.readUsdcBalance(funder);
      const refunding = await run(refund().refund(planned.intent.fundingEffectId));
      await f.rpc("anvil_mine", ["0x80"]);
      await syncClock();
      const refunded = await run(refund().reconcile(refunding.effectId));
      expect(refunded).toMatchObject({
        kind: "confirmed",
        amountAtomic: 80000n,
        destinationAddress: funder,
      });
      expect(await run(refund().refund(planned.intent.fundingEffectId))).toEqual(refunded);
      expect((await rpc.readUsdcBalance(funder)) - funderBeforeRefund).toBe(80000n);
      expect(await run(settlement().observe(policy.policyId))).toMatchObject({
        solvent: true,
        collectionBalanceAtomic: 0n,
        safeBalanceAtomic: 0n,
        outstandingCreditAtomic: 0n,
        pendingRefundAtomic: 0n,
        reservedSafeAtomic: 0n,
      });
    } finally {
      try {
        await f?.close();
      } finally {
        await admin.query("SET search_path TO public");
        try {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin.end();
        }
      }
    }
  },
  240_000,
);
