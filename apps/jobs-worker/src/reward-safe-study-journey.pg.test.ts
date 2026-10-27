/** Current contribution, Study and Safe custody on a controlled local Base Sepolia. */
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { decodeEventLog, erc20Abi, type Hex } from "viem";
import { makeSongMegapotContributions } from "../../../packages/application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../../packages/contracts/src/rewards-song-contributions-v2.ts";
import { harness as studyHarness } from "../../../packages/platform-cf/src/account-study-producer.pg-fixture.ts";
import { seedVeryRewardEvidence } from "../../../packages/platform-cf/src/activity-participation-composed-identity.pg-fixture.ts";
import { seedActivitySongMaterials } from "../../../packages/platform-cf/src/activity-participation-composed-song.pg-fixture.ts";
import { makeCustodySolvencyCoordinator } from "../../../packages/platform-cf/src/custody-solvency-coordinator.ts";
import { makeControlPlaneCustodySolvencyStore } from "../../../packages/platform-cf/src/custody-solvency-repository.ts";
import { withDanceServingPermissionFixture } from "../../../packages/platform-cf/src/dance-serving-permissions.pg-fixture.ts";
import { makeMegapotAllocationCoordinator } from "../../../packages/platform-cf/src/megapot-allocation-coordinator.ts";
import { makeControlPlaneMegapotAllocationStore } from "../../../packages/platform-cf/src/megapot-allocation-repository.ts";
import {
  makeMegapotCommitmentCoordinator,
  megapotUnsignedOwnerSafeSigner,
} from "../../../packages/platform-cf/src/megapot-commitment-coordinator.ts";
import { makeControlPlaneMegapotCommitmentStore } from "../../../packages/platform-cf/src/megapot-commitment-repository.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "../../../packages/platform-cf/src/megapot-drawing-observation-repository.ts";
import { makeMegapotSweepCoordinator } from "../../../packages/platform-cf/src/megapot-sweep-coordinator.ts";
import { makeControlPlaneMegapotSweepStore } from "../../../packages/platform-cf/src/megapot-sweep-repository.ts";
import { makeMegapotTicketFirstCutoff } from "../../../packages/platform-cf/src/megapot-ticket-first-cutoff.ts";
import { makeOwnedOrdinaryAccountBirthFixture } from "../../../packages/platform-cf/src/ordinary-study-account-birth.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "../../../packages/platform-cf/src/postgres.ts";
import { makeControlPlaneRewardRunAuthority } from "../../../packages/platform-cf/src/reward-operations-control.ts";
import { makeControlPlaneRewardProjectionStore } from "../../../packages/platform-cf/src/reward-projection-repository.ts";
import { fakeSafeChain } from "../../../packages/platform-cf/src/reward-safe-chain.pg-fixture.ts";
import { makeRewardSafeClaimCoordinator } from "../../../packages/platform-cf/src/reward-safe-claim-coordinator.ts";
import { makeRewardSafePayoutCoordinator } from "../../../packages/platform-cf/src/reward-safe-payout-coordinator.ts";
import { makeRewardSafePurchaseCoordinator } from "../../../packages/platform-cf/src/reward-safe-purchase-coordinator.ts";
import { makeReleaseRuntimeLogin } from "../../../packages/platform-cf/src/reward-safe-runtime-role.pg-fixture.ts";
import { makeRewardSafeExecutionScanner } from "../../../packages/platform-cf/src/reward-safe-settlement.ts";
import { SERVING_FUNCTION_EXECUTE_GRANTS } from "../../../packages/platform-cf/src/serving-function-privileges.ts";
import { makeControlPlaneSharedSongContextProducer } from "../../../packages/platform-cf/src/shared-song-megapot-production.ts";
import { seedProspectiveSongFundingFixture } from "../../../packages/platform-cf/src/song-funding-prospective.pg-fixture.ts";
import { seedSongContributionFixture } from "../../../packages/platform-cf/src/song-megapot-contribution.pg-fixture.ts";
import {
  makeControlPlaneRewardFundingObserver,
  makeControlPlaneSongContributionPorts,
  makeControlPlaneSongContributionReadPorts,
  makeControlPlaneSongFundingRecoveryStore,
} from "../../../packages/platform-cf/src/song-megapot-contribution-repository.ts";
import { makeControlPlaneSponsoredSendStore } from "../../../packages/platform-cf/src/wallet-sponsored-send-repository.ts";
import { makeWalletSponsoredSendService } from "../../../packages/platform-cf/src/wallet-sponsored-send-service.ts";
import { makeSongMegapotFundingRecovery } from "./song-megapot-funding-recovery.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw Error("Postgres required");
const pgTest = url ? test : test.skip;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const h = "a".repeat(64),
  bh = `0x${h}`;
const addr = (value: string) => `0x${value.repeat(40)}`;

for (const tier of [7n, 2n])
  pgTest(
    `Study funds a Safe ticket, qualifies and completes the ${tier === 7n ? "win, Claim, payout and Send" : "loss"} journey`,
    async () => {
      if (!url) throw Error("Postgres required");
      await withDanceServingPermissionFixture(url, async (f) => {
        await f.admin.query(`SET search_path TO ${f.quote(f.schema)},pg_catalog`);
        const bootstrapUrl = new URL(url);
        bootstrapUrl.searchParams.set("options", `-c search_path=${f.schema},pg_catalog`);
        const ownerLayer = makeDirectPostgresControlPlaneLayer(bootstrapUrl.toString());
        const birth = makeOwnedOrdinaryAccountBirthFixture(ownerLayer);
        await birth("a");
        await birth("b");
        await seedSongContributionFixture(f.admin, {
          accountsAlreadyBorn: true,
          environment: "staging",
        });
        const { start, postId } = await seedProspectiveSongFundingFixture(f.admin, false, {
          currentStudy: true,
          environment: "staging",
        });
        await f.admin.query("BEGIN; SET LOCAL session_replication_role=replica");
        try {
          await f.admin.query(
            "UPDATE persona_wallet_assignments SET privy_wallet_id='fixture_wallet_'||account_id WHERE assignment_id IN ('wallet-a','wallet-b')",
          );
          await seedActivitySongMaterials(f.admin, {
            communityId: "community",
            postId,
            authorId: "b",
            personaId: "persona-b",
            submissionId: "purpose-submission",
            operationId: "purpose-operation",
            publicationAlreadyExists: true,
          });
          await f.admin.query("COMMIT");
        } catch (error) {
          await f.admin.query("ROLLBACK");
          throw error;
        }
        const deployment = {
          environment: "staging" as const,
          chainId: 84532,
          attestationId: "attestation",
          jackpotAddress: addr("5"),
          ticketNftAddress: addr("6"),
          usdcAddress: addr("2"),
          custodyAddress: addr("3"),
          referrerAddress: addr("7"),
          jackpotCodeHash: bh,
          ticketNftCodeHash: bh,
          usdcCodeHash: bh,
        };
        const chain = fakeSafeChain({
          deployment,
          sourceTag: bh,
          initialDrawingId: 101n,
          usdcBalance: 0n,
          purchaseSpends: true,
          walletBalances: { [addr("4")]: 1_000_000n },
          anchor: { blockNumber: 1n, blockHash: bh },
        });
        const originalDrawing = chain.rpc.readDrawing;
        const rpc = {
          ...chain.rpc,
          readNativeBalance: async () => 1_000_000_000_000_000_000n,
          readDrawing: async (id: bigint) => ({
            ...(await originalDrawing(id)),
            drawingTime: BigInt(Math.floor(start / 1000)) + (id - 100n) * 3600n,
          }),
        };
        await f.owner.query(
          "INSERT INTO reward_signer_nonces(chain_id,signer_address,next_nonce,observed_pending_nonce,observed_block_number,observed_block_hash,observed_at,nonce_authority) VALUES(84532,$1,3,3,1000,$2,now(),'safe_owner_v1')",
          [deployment.custodyAddress, bh],
        );
        const http = await f.makeRole(),
          jobs = await f.makeRole();
        await f.owner.query(
          "SELECT bind_reward_contribution_purpose_v2($1,'http_commands'),grant_shared_song_funding_runtime_v2($1,'account')",
          [http.role],
        );
        await f.owner.query(
          "SELECT bind_reward_contribution_purpose_v2($1,'funding_recovery_jobs'),grant_shared_song_funding_runtime_v2($1,'context_worker')",
          [jobs.role],
        );
        await f.owner.query(
          `GRANT EXECUTE ON FUNCTION require_reward_run_authority_v1() TO ${f.quote(jobs.role)}`,
        );
        const httpLayer = makeDirectPostgresControlPlaneLayer(http.url),
          jobsLayer = makeDirectPostgresControlPlaneLayer(jobs.url);
        const authority = makeControlPlaneRewardRunAuthority(jobsLayer);
        const producer = makeControlPlaneSharedSongContextProducer({
          runtime: jobsLayer,
          now: () => new Date().toISOString(),
          rpcFor: () => rpc,
        });
        await run(producer.run({ enabled: true, ensure: authority.ensure }));
        await run(producer.run({ enabled: true, ensure: authority.ensure }));
        const scope = { communityId: "community", postId, contributionId: null };
        const auth = { authorize: () => Effect.succeed({ accountId: "b" }) };
        const reads = makeControlPlaneSongContributionReadPorts(httpLayer, auth, {
          rewardsEnabled: true,
        });
        const context = Schema.decodeUnknownSync(C.ContextReadyV2)(
          await run(reads.context(scope, "b", "persona-b")),
        );
        if (context.quote.kind !== "prospective") throw Error("Prospective context required");
        const ref = context.context_ref;
        const service = makeSongMegapotContributions(
          makeControlPlaneSongContributionPorts(httpLayer, auth, { rewardsEnabled: true }),
        );
        const receipt = Schema.decodeUnknownSync(C.ContributionReceiptV2)(
          await run(
            service.execute("CreateSongMegapotContributionV2", scope, {
              version: 2,
              idempotency_key: "safe_study_create_01",
              persona_id: "persona-b",
              funding_amount_atomic: "1000000",
              expected_context_hash: context.context_hash,
              expected_lifecycle_revision: context.lifecycle_revision,
              context_version: ref.version,
              context_slot_id: ref.slot_id,
              context_slot_generation: ref.slot_generation,
              context_leg_snapshot_id: ref.leg_snapshot_id ?? "",
              context_schedule_witness_id: ref.schedule_witness_id,
              context_profile_id: ref.profile_id,
              context_profile_hash: ref.profile_hash,
              context_funding_policy_hash: ref.funding_policy_hash,
              context_wallet_assignment_id: ref.wallet_assignment_id,
              context_wallet_assignment_revision: ref.wallet_assignment_revision,
              context_lifecycle_revision: ref.lifecycle_revision,
              expected_terms_kind: "prospective",
              expected_terms_hash: context.quote.prospective_terms_hash,
            }),
          ),
        );
        const ownScope = { ...scope, contributionId: receipt.contribution_id };
        const grant = await run(
          service.execute("ClaimSongMegapotContributionSubmissionV2", ownScope, {
            idempotency_key: "safe_study_claim_01",
            client_instance_id: "safe_study_browser",
            submission_attempt_id: "safe_study_send_01",
            purpose: "funding_transfer",
            expected_state_revision: 0,
            instruction_hash: receipt.instruction.instruction_hash,
          }),
        );
        expect(grant).toMatchObject({ delivery: { kind: "fresh_grant" } });
        // A chain timestamp has whole-second precision; inclusion must follow
        // the original millisecond terms start instead of predating it.
        await Bun.sleep(1000 - (Date.now() % 1000) + 10);
        const payment = chain.fund(
          receipt.instruction.from,
          BigInt(receipt.instruction.amount_atomic),
        );
        await run(
          service.execute("ObserveSongMegapotContributionV2", ownScope, {
            idempotency_key: "safe_study_observe_01",
            instruction_hash: receipt.instruction.instruction_hash,
            transaction_hash: payment,
          }),
        );
        const funding = makeSongMegapotFundingRecovery({
          store: makeControlPlaneSongFundingRecoveryStore(jobsLayer),
          now: () => new Date().toISOString(),
          rpcFor: () => rpc,
          observe: (work, tx, discover) =>
            makeControlPlaneRewardFundingObserver(jobsLayer, discover)(work, tx),
        });
        await run(funding.run({ enabled: true, limit: 1, ensure: authority.ensure }));
        expect(
          (
            await f.owner.query(
              "SELECT payload->'result' AS result FROM reward_funding_work_envelopes_v2 WHERE scope='reconciliation' AND contribution_id=$1",
              [receipt.contribution_id],
            )
          ).rows,
        ).toEqual([{ result: { complete: true, nextBlock: null, error: null } }]);
        const legId = receipt.target.pool_leg_id;
        expect(
          (
            await f.owner.query(
              "SELECT funded_atomic::text,status,purchase_order FROM song_reward_offer_legs WHERE leg_id=$1",
              [legId],
            )
          ).rows,
        ).toEqual([
          { funded_atomic: "1000000", status: "active", purchase_order: "ticket_first_v1" },
        ]);
        const app = await makeReleaseRuntimeLogin(f.admin, url, f.schema);
        try {
          const layer = makeDirectPostgresControlPlaneLayer(app.url);
          const options = {
            layer,
            rpc,
            requiredConfirmations: 1,
            runtimeEnvironment: "staging" as const,
            productionEnabled: false,
            maximumScanBlocks: 200,
            maximumScanLogs: 50,
            minimumEntrySeconds: 60,
          };
          const observed = makeControlPlaneMegapotDrawingObservationStore(layer);
          const drawing = await rpc.readDrawing(101n);
          await run(
            observed.recordAndOpen({
              observationId: "safe-study-drawing",
              attestationId: "attestation",
              chainId: 84532,
              drawingId: 101n,
              grossPrizePoolAtomic: drawing.prizePool,
              globalTicketsBought: drawing.globalTicketsBought,
              ticketPriceAtomic: drawing.ticketPrice,
              drawingTime: new Date(Number(drawing.drawingTime) * 1000).toISOString(),
              ballMax: 30,
              bonusballMax: 10,
              drawingLocked: false,
              referralFeeWei: drawing.referralFee,
              referralWinShareWei: drawing.referralWinShare,
              blockNumber: chain.head(),
              blockHash: (await rpc.readHead()).blockHash,
              blockTimestamp: new Date().toISOString(),
              confirmations: 1,
              observedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 120000).toISOString(),
              rawStateHash: h,
              legacyRawStateHash: h,
            }),
          );
          const purchases = makeRewardSafePurchaseCoordinator(options);
          const prepared = await run(purchases.prepare(legId));
          if (prepared.kind !== "prepared") throw Error(`Purchase not ready: ${prepared.kind}`);
          const call = prepared.transactionBuilderFile.transactions[0];
          if (!call) throw Error("Missing purchase");
          chain.execute({ to: call.to, data: call.data as Hex }, "success", 101n);
          await run(
            makeRewardSafeExecutionScanner(options)({
              chainId: 84532,
              safeAddress: deployment.custodyAddress,
            }),
          );
          expect(await run(purchases.settle(prepared.effectId))).toMatchObject({
            kind: "confirmed",
          });
          // Ordinary Study uses a non-owner role, its serving functions, and only
          // its domain tables in addition to the maintained financial privileges.
          for (const entry of SERVING_FUNCTION_EXECUTE_GRANTS)
            await f.owner.query(
              `GRANT EXECUTE ON FUNCTION ${entry.signature} TO ${f.quote(app.role)}`,
            );
          for (const table of [
            "account_streak_clocks",
            "study_sessions_v2",
            "study_review_items",
            "study_session_items_v2",
            "study_lesson_item_state_v2",
            "study_spoken_answer_commands",
            "learner_audio_artifacts",
            "study_attempts_v2",
            "study_presentations_v2",
            "activity_qualifications",
            "decision_records",
            "song_streak_days",
            "song_streak_day_activities",
            "song_streaks",
            "community_streak_days",
            "community_streaks",
            "persona_activity_presentations",
          ])
            await f.owner.query(
              `GRANT SELECT,INSERT,UPDATE ON ${f.quote(table)} TO ${f.quote(app.role)}`,
            );
          // Qualification inserts these ledgers, but cannot rewrite them.
          for (const table of ["reward_eligibility_decisions", "megapot_pool_shares"])
            await f.owner.query(`GRANT SELECT,INSERT ON ${f.quote(table)} TO ${f.quote(app.role)}`);
          expect(
            (
              await f.owner.query(
                "SELECT has_table_privilege($1,'megapot_pool_shares','UPDATE') AS rewrite_shares,has_table_privilege($1,'reward_eligibility_decisions','UPDATE') AS rewrite_decisions,has_table_privilege($1,'song_megapot_contributions_v2','SELECT') AS raw_contributions",
                [app.role],
              )
            ).rows,
          ).toEqual([
            { rewrite_shares: false, rewrite_decisions: false, raw_contributions: false },
          ]);
          for (const table of [
            "users",
            "personas",
            "persona_wallet_assignments",
            "persona_community_bindings",
            "posts",
            "communities",
            "media_publication_projections",
            "media_post_submissions",
            "media_song_stems",
            "study_exercise_versions",
            "localization_lyrics_revision_lines",
            "study_language_profile_units",
            "study_language_profiles",
            "activity_registry",
            "qualification_policy_versions",
            "policy_versions",
            "subject_keys",
            "subject_key_binding_events",
            "active_subject_key_bindings",
            "assertion_bindings",
            "assertions",
            "evidence_receipts",
            "proof_sessions",
            "assertion_revalidation_events",
          ])
            await f.owner.query(`GRANT SELECT ON ${f.quote(table)} TO ${f.quote(app.role)}`);
          for (const table of [
            "communities",
            "users",
            "personas",
            "persona_community_bindings",
            "posts",
            "media_publication_projections",
            "media_post_submissions",
            "song_reward_offer_legs",
            "megapot_pool_drawings",
          ])
            await f.owner.query(`GRANT UPDATE ON ${f.quote(table)} TO ${f.quote(app.role)}`);
          const drains: (() => Promise<unknown>)[] = [];
          const study = studyHarness(
            {
              admin: f.admin,
              role: app.role,
              runtime: () => layer,
              registerDrain: (drain) => drains.push(drain),
            },
            { put: async (_key, bytes) => ({ size: bytes.byteLength }) },
            {},
            undefined,
            { accountId: "a", personaId: "persona-a", communityId: "community", postId },
          );
          let session = await study.start("safe-study");
          for (let step = 0; session.status === "active" && step < 4; step++) {
            const input = await study.input(session, `safe-study-card-${step}`);
            const answer = await run(study.submit(input));
            expect(answer.outcome).toBe("correct");
            expect(await run(study.submit(input))).toEqual(answer);
            session = answer.session;
          }
          expect(session.status).toBe("completed");
          expect(study.calls()).toBe(4);
          await Promise.all(drains.map((drain) => drain()));
          expect(
            (
              await f.owner.query(
                "SELECT q.activity_key,q.score_bps,s.account_id FROM megapot_pool_shares s JOIN activity_qualifications q USING(qualification_id) WHERE s.pool_leg_id=$1",
                [legId],
              )
            ).rows,
          ).toEqual([{ activity_key: "study", score_bps: 10000, account_id: "a" }]);
          const safePilot = { runtimeEnvironment: "staging" as const, productionEnabled: false };
          const subject = { poolLegId: legId, drawingId: 101n };
          const cutoff = makeMegapotTicketFirstCutoff({
            layer,
            attestationId: "attestation",
            now: () => start + 2 * 3600000,
          });
          expect(await run(cutoff.freezeDue())).toContainEqual(
            expect.objectContaining({ poolLegId: legId, status: "cutoff_frozen" }),
          );
          const commitment = makeMegapotCommitmentCoordinator({
            store: makeControlPlaneMegapotCommitmentStore(layer),
            signer: megapotUnsignedOwnerSafeSigner,
            publisher: {
              publish: async (request) => ({
                publicReference: `https://commitments.test/${request.idempotencyKey}.json`,
                publishedAt: new Date(start + 60000).toISOString(),
              }),
            },
            authority,
          });
          expect(await run(commitment.commit(subject))).toMatchObject({
            state: "published",
            signature: null,
          });
          const sweep = makeMegapotSweepCoordinator({
            store: makeControlPlaneMegapotSweepStore(layer),
            rpc,
            requiredConfirmations: 1,
            safePilot,
          });
          expect(await run(sweep.sweep(subject))).toMatchObject({ kind: "drawing_pending" });
          chain.settle(tier);
          const settled = await run(sweep.sweep(subject));
          const scan = () =>
            run(
              makeRewardSafeExecutionScanner(options)({
                chainId: 84532,
                safeAddress: deployment.custodyAddress,
              }),
            );
          const callOf = (file: {
            transactions: readonly { to: string; data: string | null }[];
          }) => {
            const call = file.transactions[0];
            if (!call?.data) throw Error("Prepared Safe call missing");
            return { to: call.to, data: call.data as Hex };
          };
          if (tier === 2n) {
            expect(settled).toMatchObject({
              kind: "complete",
              outcome: "no_win",
              netWinningsAtomic: 0n,
            });
            expect(
              (await f.owner.query("SELECT count(*)::int AS n FROM reward_ledger_credits")).rows,
            ).toEqual([{ n: 0 }]);
            expect(await rpc.readUsdcBalance(deployment.custodyAddress)).toBe(0n);
          } else {
            expect(settled).toMatchObject({
              kind: "complete",
              outcome: "winnings_detected",
              netWinningsAtomic: 901n,
            });
            const claims = makeRewardSafeClaimCoordinator(options);
            const claim = await run(claims.prepare(subject));
            if (claim.kind !== "prepared") throw Error(`Claim not ready: ${claim.kind}`);
            chain.execute(callOf(claim.transactionBuilderFile), "success");
            await scan();
            expect(await run(claims.settle(subject))).toMatchObject({
              kind: "claimed",
              netWinningsAtomic: 901n,
            });
            expect(
              await run(makeRewardSafeClaimCoordinator(options).settle(subject)),
            ).toMatchObject({ kind: "claimed", effectId: claim.effectId });
            const allocation = makeMegapotAllocationCoordinator({
              store: makeControlPlaneMegapotAllocationStore(layer),
            });
            await run(allocation.allocate(subject));
            await run(allocation.allocate(subject));
            const credits = (
              await f.owner.query<{ credit_id: string; account_id: string; amount: string }>(
                "SELECT credit_id,account_id,amount_atomic::text AS amount FROM reward_ledger_credits WHERE source_kind='megapot_allocation'",
              )
            ).rows;
            expect(credits).toHaveLength(1);
            const credit = credits[0];
            if (!credit) throw Error("Study credit missing");
            expect(credit).toMatchObject({ account_id: "a", amount: "901" });
            // Only the external verification ceremony is a local prerequisite.
            // The participant Claim, solvency check and Safe payout execute normally.
            await seedVeryRewardEvidence(f.admin, "a", "safe-study-claim");
            const projection = makeControlPlaneRewardProjectionStore(layer);
            expect(
              await run(projection.claimCredit({ accountId: "a", creditId: credit.credit_id })),
            ).toMatchObject({ outcome: "accepted" });
            await run(
              makeCustodySolvencyCoordinator({
                store: makeControlPlaneCustodySolvencyStore(layer),
                rpc,
                requiredConfirmations: 1,
                safePilot,
              }).observe("attestation"),
            );
            const payouts = makeRewardSafePayoutCoordinator(options);
            const payout = await run(payouts.prepare(credit.credit_id));
            chain.execute(callOf(payout.transactionBuilderFile), "success");
            await scan();
            expect(await run(payouts.settle(payout.effectId))).toMatchObject({ kind: "confirmed" });
            expect(
              await run(makeRewardSafePayoutCoordinator(options).settle(payout.effectId)),
            ).toMatchObject({ kind: "not_bound" });
            expect(await rpc.readUsdcBalance(addr("1"))).toBe(901n);
            let submissions = 0;
            let sendHash: string | null = null;
            let ids = 0;
            await f.owner.query(
              `GRANT UPDATE ON subject_keys,active_subject_key_bindings TO ${f.quote(app.role)}`,
            );
            await f.owner.query(
              `GRANT EXECUTE ON FUNCTION lock_wallet_send_palm_assertions_v1(text,text) TO ${f.quote(app.role)}`,
            );
            const makeSends = () =>
              makeWalletSponsoredSendService({
                store: makeControlPlaneSponsoredSendStore(layer, {
                  perAccountUtcDay: 1,
                  perWalletUtcDay: 1,
                  platformUtcDay: 1,
                  gasBudgetPerSendWei: 1n,
                  accountDailyGasBudgetWei: 1n,
                  walletDailyGasBudgetWei: 1n,
                  platformDailyGasBudgetWei: 1n,
                }),
                appId: "app_local_study",
                appSecret: "local_fixture_secret",
                ids: () => `safe_study_${++ids}`,
                eligibleAsset: { chainId: 84532, tokenAddress: deployment.usdcAddress },
                requiredConfirmations: 1,
                chain: {
                  readTokenBalance: (token, wallet) => {
                    expect(token).toBe(deployment.usdcAddress);
                    return rpc.readUsdcBalance(wallet);
                  },
                  readHead: async () => (await rpc.readHead()).blockNumber,
                  readFinalizedHead: async () => (await rpc.readFinalizedHead()).blockNumber,
                  readReceipt: async (hash) => {
                    const receipt = await rpc.readReceipt(hash);
                    if (!receipt) return null;
                    const canonical = await rpc.readBlock(receipt.blockNumber);
                    return {
                      ...receipt,
                      canonical: canonical.blockHash === receipt.blockHash,
                      transfers: receipt.logs.map((log) => {
                        const event = decodeEventLog({
                          abi: erc20Abi,
                          eventName: "Transfer",
                          topics: log.topics as [Hex, ...Hex[]],
                          data: log.data as Hex,
                        });
                        return {
                          tokenAddress: log.address,
                          from: event.args.from,
                          to: event.args.to,
                          amountAtomic: event.args.value,
                        };
                      }),
                    };
                  },
                },
                submit: async () => {
                  submissions++;
                  sendHash = chain.transfer(addr("1"), addr("8"), 901n);
                  throw Error("Simulated response loss after provider acceptance");
                },
                findByReference: async (query) =>
                  sendHash
                    ? {
                        id: "local_study_send",
                        walletId: query.walletId,
                        referenceId: query.referenceId,
                        caip2: "eip155:84532",
                        status: "confirmed",
                        transactionHash: sendHash,
                      }
                    : null,
              });
            const sends = makeSends();
            const send = await sends.reserve({
              accountId: "a",
              personaId: "persona-a",
              chainId: 84532,
              recipientAddress: addr("8"),
              amountAtomic: 901n,
              idempotencyKey: "safe_study_send_reserve_01",
            });
            expect(send.authorization).not.toBeNull();
            await expect(
              sends.submit({
                accountId: "a",
                sendId: send.record.sendId,
                signature: "YWJjZA==",
              }),
            ).rejects.toThrow("outcome unknown");
            // Recreate both service and repository as after a Worker restart.
            // Reference lookup and canonical chain proof resolve the held send.
            const restarted = makeSends();
            expect(
              (await restarted.get({ accountId: "a", sendId: send.record.sendId })).record.status,
            ).toBe("confirmed");
            await expect(
              sends.submit({ accountId: "a", sendId: send.record.sendId, signature: "YWJjZA==" }),
            ).rejects.toThrow("conflict");
            expect(submissions).toBe(1);
            expect(await rpc.readUsdcBalance(addr("1"))).toBe(0n);
            expect(await rpc.readUsdcBalance(addr("8"))).toBe(901n);
            expect(await rpc.readUsdcBalance(deployment.custodyAddress)).toBe(0n);
            expect(
              (
                await f.owner.query(
                  "SELECT state,paid_atomic::text AS paid FROM reward_ledger_credits WHERE credit_id=$1",
                  [credit.credit_id],
                )
              ).rows,
            ).toEqual([{ state: "sent", paid: "901" }]);
          }
          await f.owner.query(
            "SELECT set_reward_operations_paused_v1(revision,TRUE,'local_study_complete') FROM reward_operations_control WHERE singleton",
          );
          expect(
            (
              await f.owner.query(
                "SELECT count(*)::int AS n FROM reward_chain_effects WHERE nonce IS NOT NULL AND state NOT IN ('confirmed','reverted')",
              )
            ).rows,
          ).toEqual([{ n: 0 }]);
        } finally {
          await app.drop();
        }
      });
    },
    90000,
  );
