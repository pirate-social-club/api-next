/** Current contribution, Study and Safe custody on a controlled local Base Sepolia. */
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { decodeEventLog, erc20Abi, type Hex } from "viem";
import { makeSongMegapotContributions } from "../../../packages/application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../../packages/contracts/src/rewards-song-contributions-v2.ts";
import {
  stopBeforeFinalize,
  harness as studyHarness,
} from "../../../packages/platform-cf/src/account-study-producer.pg-fixture.ts";
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
import { proveSafeReceiptRefund } from "../../../packages/platform-cf/src/reward-safe-refund.pg-proof.ts";
import { makeReleaseRuntimeLogin } from "../../../packages/platform-cf/src/reward-safe-runtime-role.pg-fixture.ts";
import { makeRewardSafeExecutionScanner } from "../../../packages/platform-cf/src/reward-safe-settlement.ts";
import { creditEmptySafeTreasury } from "../../../packages/platform-cf/src/safe-treasury-allocation.ts";
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
import {
  loseOneStudyCommitAcknowledgement,
  makeSafeLifecycleJobProof,
} from "./safe-lifecycle-job.pg-fixture.ts";
import { composeSongFundingStage } from "./song-funding-stage.ts";
import { makeSongMegapotFundingRecovery } from "./song-megapot-funding-recovery.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw Error("Postgres required");
const pgTest = url ? test : test.skip;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const h = "a".repeat(64),
  bh = `0x${h}`;
const addr = (value: string) => `0x${value.repeat(40)}`;
/** Leave an account, at the fixture's actual low budget, without room for one more attempt. */
const exhaustContextWork = (
  db: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  account: string,
) =>
  db.query(
    `INSERT INTO reward_context_work_counters_v2(profile_id,account_id,maximum_units,used_units)
     SELECT t.profile_id,$1,(t.operational_profile->>'maximumContextWorkPerAccount')::BIGINT,
       (t.operational_profile->>'maximumContextWorkPerAccount')::BIGINT
     FROM reward_shared_song_templates_v2 t JOIN reward_shared_song_template_admissions_v2 a USING(community_id,template_id)
     WHERE a.accepted
     ON CONFLICT(profile_id,account_id) DO UPDATE SET used_units=excluded.maximum_units
     WHERE reward_context_work_counters_v2.used_units<excluded.maximum_units`,
    [account],
  );
const contextWork = async (db: { query: (text: string) => Promise<{ rows: unknown[] }> }) => ({
  attempts: (
    await db.query(
      `SELECT w.account_id,sum(cw.attempts)::int AS attempts FROM reward_song_context_work_v2 cw
       JOIN persona_wallet_assignments w USING(assignment_id) GROUP BY w.account_id ORDER BY w.account_id`,
    )
  ).rows,
  counters: (
    await db.query(
      "SELECT account_id,used_units::int AS used,maximum_units::int AS maximum FROM reward_context_work_counters_v2 ORDER BY account_id",
    )
  ).rows,
});

for (const scenario of [
  "win",
  "loss",
  "empty_win",
  "empty_loss",
  "qualified_funder_policy",
  "job_win",
  "job_empty_win",
  "job_treasury_win",
  "job_treasury_loss",
  "job_treasury_qualified_win",
  "job_late_recovery",
  "job_commit_unknown",
  "job_context_exhaustion",
  "job_late_refund",
  "timed_late_refund",
  "job_unspent_refund",
  "late_refund",
  "unspent_refund",
  "failed_purchase_refund",
] as const) {
  const throughJob = scenario.startsWith("job_");
  const lateRefund = scenario.endsWith("late_refund");
  const timedLateRefund = scenario === "timed_late_refund";
  const treasury = scenario.includes("treasury_");
  const empty = scenario.includes("empty_") || (treasury && !scenario.includes("qualified"));
  const lateRecovery = scenario === "job_late_recovery";
  const contextExhaustion = scenario === "job_context_exhaustion";
  const funderWins = (empty || lateRecovery) && !treasury;
  const newTerms = throughJob || empty || scenario === "qualified_funder_policy";
  const beneficiary = funderWins ? "b" : "a";
  const beneficiaryWallet = addr(funderWins ? "4" : "1");
  const tier =
    scenario === "win" ||
    scenario === "empty_win" ||
    scenario === "job_treasury_win" ||
    scenario === "job_treasury_qualified_win" ||
    scenario === "qualified_funder_policy" ||
    (throughJob && scenario !== "job_treasury_loss")
      ? 7n
      : 2n;
  pgTest(
    `Safe contribution completes ${scenario}`,
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
          singleFunderTicketFirst: newTerms,
          environment: "staging",
        });
        const { start, postId } = await seedProspectiveSongFundingFixture(f.admin, false, {
          currentStudy: true,
          singleFunderTicketFirst: newTerms,
          safeTreasuryTicketFirst: treasury,
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
        if (contextExhaustion) {
          // The participant has no room for another attempt. One production-sized
          // batch must skip it, without raising, and still quote the funder.
          await exhaustContextWork(f.owner, "a");
          await run(producer.run({ enabled: true, ensure: authority.ensure, limit: 6 }));
          expect((await contextWork(f.owner)).attempts).toEqual([{ account_id: "b", attempts: 1 }]);
        } else {
          await run(producer.run({ enabled: true, ensure: authority.ensure }));
          await run(producer.run({ enabled: true, ensure: authority.ensure }));
        }
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
        const receivedAtomic =
          BigInt(receipt.instruction.amount_atomic) + (lateRefund && !timedLateRefund ? 1n : 0n);
        const payment = chain.fund(
          receipt.instruction.from,
          receivedAtomic,
          timedLateRefund
            ? BigInt(Math.ceil(Date.parse(receipt.instruction.expires_at) / 1000))
            : undefined,
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
          now: () =>
            timedLateRefund
              ? new Date(
                  Math.ceil(Date.parse(receipt.instruction.expires_at) / 1000) * 1000 + 1000,
                ).toISOString()
              : new Date().toISOString(),
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
          {
            funded_atomic: lateRefund ? "0" : "1000000",
            status: lateRefund ? "funding" : "active",
            purchase_order: "ticket_first_v1",
          },
        ]);
        if (contextExhaustion) {
          // The one admitted contribution fills this single-funder leg, so the
          // committed pot stops consuming quote budget for every account.
          const before = await contextWork(f.owner);
          await run(producer.run({ enabled: true, ensure: authority.ensure, limit: 6 }));
          expect(await contextWork(f.owner)).toEqual(before);
          // Exhaust the funder too. Every later tick runs the serving funding stage
          // with its real quote producer through purchase, Study, freeze and settlement.
          await exhaustContextWork(f.owner, "b");
        }
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
          if (
            scenario === "late_refund" ||
            timedLateRefund ||
            scenario === "unspent_refund" ||
            scenario === "failed_purchase_refund"
          ) {
            await proveSafeReceiptRefund({
              admin: f.admin,
              owner: f.owner,
              options,
              chain,
              receipt,
              category: lateRefund ? "late_principal" : "unspent_budget",
              receivedAtomic,
              failedPurchase: scenario === "failed_purchase_refund",
            });
            return;
          }
          if (!throughJob) {
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
          }
          if (!throughJob) {
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
          }
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
          let jobClock = Date.now();
          const job = makeSafeLifecycleJobProof({
            layer,
            rpc,
            now: () => jobClock,
            funding: contextExhaustion
              ? { ...funding, run: composeSongFundingStage(funding, producer) }
              : funding,
            ensure: authority.ensure,
            custody: {
              attestationId: "attestation",
              chainId: 84532,
              safeAddress: deployment.custodyAddress,
            },
          });
          if (scenario === "job_late_refund" || scenario === "job_unspent_refund") {
            await proveSafeReceiptRefund({
              admin: f.admin,
              owner: f.owner,
              options,
              chain,
              receipt,
              category: lateRefund ? "late_principal" : "unspent_budget",
              receivedAtomic,
              job,
            });
            return;
          }
          if (throughJob) {
            await job.tick();
            const purchase = await job.prepared("ticket_purchase");
            chain.execute(purchase, "success", 101n);
            await job.tick();
            expect(
              (
                await f.owner.query(
                  "SELECT status FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=101",
                  [legId],
                )
              ).rows,
            ).toEqual([{ status: "entry_open" }]);
          }
          if (!empty) {
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
              if (throughJob && step === 3) {
                await expect(
                  run(study.submit(input, stopBeforeFinalize(study.protocol))),
                ).rejects.toMatchObject({ reason: "unavailable" });
                await Promise.all(drains.map((drain) => drain()));
                expect(
                  (
                    await f.owner.query(
                      "SELECT count(*)::int n FROM megapot_pool_shares WHERE pool_leg_id=$1",
                      [legId],
                    )
                  ).rows,
                ).toEqual([{ n: 0 }]);
                if (lateRecovery) {
                  // Move only the test clock boundary. Saved grading and all
                  // qualification/share/settlement writes retain their guards.
                  await f.admin.query("BEGIN; SET LOCAL session_replication_role=replica");
                  try {
                    await f.admin.query(
                      "UPDATE megapot_pool_drawings SET entry_cutoff_at=clock_timestamp()-interval '1 millisecond' WHERE pool_leg_id=$1 AND drawing_id=101",
                      [legId],
                    );
                    await f.admin.query("COMMIT");
                  } catch (error) {
                    await f.admin.query("ROLLBACK");
                    throw error;
                  }
                  jobClock = Date.now();
                }
                if (scenario === "job_commit_unknown") {
                  const before = (
                    await f.owner.query("SELECT revision FROM reward_joint_cycle_turn_v1")
                  ).rows;
                  await expect(
                    job.tick(loseOneStudyCommitAcknowledgement(layer)),
                  ).rejects.toMatchObject({ reason: "outcome-unknown" });
                  expect(
                    (await f.owner.query("SELECT revision FROM reward_joint_cycle_turn_v1")).rows,
                  ).toEqual(before);
                  expect(
                    (
                      await f.owner.query(
                        "SELECT count(*)::int n FROM megapot_pool_shares WHERE pool_leg_id=$1",
                        [legId],
                      )
                    ).rows,
                  ).toEqual([{ n: 1 }]);
                }
                await job.tick();
              }
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
            ).toEqual(
              lateRecovery ? [] : [{ activity_key: "study", score_bps: 10000, account_id: "a" }],
            );
          }
          const safePilot = { runtimeEnvironment: "staging" as const, productionEnabled: false };
          const subject = { poolLegId: legId, drawingId: 101n };
          const cutoff = makeMegapotTicketFirstCutoff({
            layer,
            attestationId: "attestation",
            now: () => start + 2 * 3600000,
          });
          if (throughJob) {
            jobClock = start + 2 * 3600000;
            await job.tick();
          } else {
            expect(await run(cutoff.freezeDue())).toContainEqual(
              expect.objectContaining({ poolLegId: legId, status: "cutoff_frozen" }),
            );
          }
          expect(
            (
              await f.owner.query(
                "SELECT frozen_share_count,fallback_beneficiary FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=101",
                [legId],
              )
            ).rows,
          ).toEqual([
            { frozen_share_count: empty || lateRecovery ? 0 : 1, fallback_beneficiary: funderWins },
          ]);
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
          if (!throughJob) {
            expect(await run(commitment.commit(subject))).toMatchObject({
              state: "published",
              signature: null,
            });
          }
          const sweep = makeMegapotSweepCoordinator({
            store: makeControlPlaneMegapotSweepStore(layer),
            rpc,
            requiredConfirmations: 1,
            safePilot,
          });
          expect(await run(sweep.sweep(subject))).toMatchObject({ kind: "drawing_pending" });
          chain.settle(tier);
          if (throughJob) await job.tick();
          const settled = throughJob ? null : await run(sweep.sweep(subject));
          if (throughJob)
            expect(
              (
                await f.owner.query(
                  "SELECT status FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=101",
                  [legId],
                )
              ).rows,
            ).toEqual([{ status: tier === 2n ? "no_win" : "winnings_detected" }]);
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
            if (!throughJob)
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
            if (!throughJob)
              expect(settled).toMatchObject({
                kind: "complete",
                outcome: "winnings_detected",
                netWinningsAtomic: 901n,
              });
            const claims = makeRewardSafeClaimCoordinator(options);
            const claim = await run(claims.prepare(subject));
            if (claim.kind !== "prepared") throw Error(`Claim not ready: ${claim.kind}`);
            chain.execute(callOf(claim.transactionBuilderFile), "success");
            if (throughJob) await job.tick();
            else await scan();
            expect(await run(claims.settle(subject))).toMatchObject({
              kind: "claimed",
              ...(throughJob ? { effectId: claim.effectId } : { netWinningsAtomic: 901n }),
            });
            expect(
              await run(makeRewardSafeClaimCoordinator(options).settle(subject)),
            ).toMatchObject({ kind: "claimed", effectId: claim.effectId });
            if (treasury && empty) {
              expect(await run(Effect.provide(layer)(creditEmptySafeTreasury(subject)))).toBe(true);
              expect(await run(Effect.provide(layer)(creditEmptySafeTreasury(subject)))).toBe(true);
              const allocated = (
                await f.owner.query(
                  "SELECT treasury_address,amount_atomic::text amount FROM reward_safe_treasury_allocations_v1 WHERE pool_leg_id=$1 AND drawing_id=101",
                  [legId],
                )
              ).rows;
              expect(allocated).toEqual([
                { treasury_address: deployment.custodyAddress, amount: "901" },
              ]);
              expect(
                (
                  await f.owner.query(
                    "SELECT status FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=101",
                    [legId],
                  )
                ).rows,
              ).toEqual([{ status: "credited" }]);
              expect(
                (await f.owner.query("SELECT count(*)::int n FROM reward_ledger_credits")).rows,
              ).toEqual([{ n: 0 }]);
              expect(
                (await f.owner.query("SELECT count(*)::int n FROM reward_payout_effects")).rows,
              ).toEqual([{ n: 0 }]);
              expect(await rpc.readUsdcBalance(deployment.custodyAddress)).toBe(901n);
              await expect(
                f.owner.query("UPDATE reward_safe_treasury_allocations_v1 SET amount_atomic=902"),
              ).rejects.toThrow();
              await expect(
                f.owner.query("DELETE FROM reward_safe_treasury_allocations_v1"),
              ).rejects.toThrow();
            } else {
              const allocation = makeMegapotAllocationCoordinator({
                store: makeControlPlaneMegapotAllocationStore(layer),
              });
              await run(allocation.allocate(subject));
              await run(allocation.allocate(subject));
              const credits = (
                await f.owner.query<{ credit_id: string; account_id: string; amount: string }>(
                  "SELECT credit_id,account_id,amount_atomic::text AS amount FROM reward_ledger_credits WHERE source_kind IN ('megapot_allocation','external_fallback')",
                )
              ).rows;
              expect(credits).toHaveLength(1);
              const credit = credits[0];
              if (!credit) throw Error("Study credit missing");
              expect(credit).toMatchObject({ account_id: beneficiary, amount: "901" });
              // Only the external verification ceremony is a local prerequisite.
              // The participant Claim, solvency check and Safe payout execute normally.
              await seedVeryRewardEvidence(f.admin, beneficiary, "safe-study-claim");
              const projection = makeControlPlaneRewardProjectionStore(layer);
              if (!funderWins) {
                expect(
                  await run(
                    projection.claimCredit({ accountId: beneficiary, creditId: credit.credit_id }),
                  ),
                ).toMatchObject({ outcome: "accepted" });
              }
              await run(
                makeCustodySolvencyCoordinator({
                  store: makeControlPlaneCustodySolvencyStore(layer),
                  rpc,
                  requiredConfirmations: 1,
                  safePilot,
                }).observe("attestation"),
              );
              const payouts = makeRewardSafePayoutCoordinator(options);
              let payout: { effectId: string };
              if (throughJob) {
                await job.tick();
                const call = await job.prepared("reward_payout");
                payout = call;
                chain.execute(call, "success");
                await job.tick();
              } else {
                const preparedPayout = await run(payouts.prepare(credit.credit_id));
                payout = preparedPayout;
                chain.execute(callOf(preparedPayout.transactionBuilderFile), "success");
                await scan();
                expect(await run(payouts.settle(payout.effectId))).toMatchObject({
                  kind: "confirmed",
                });
              }
              expect(
                await run(makeRewardSafePayoutCoordinator(options).settle(payout.effectId)),
              ).toMatchObject({ kind: "not_bound" });
              expect(await rpc.readUsdcBalance(beneficiaryWallet)).toBe(901n);
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
                    sendHash = chain.transfer(beneficiaryWallet, addr("8"), 901n);
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
                accountId: beneficiary,
                personaId: `persona-${beneficiary}`,
                chainId: 84532,
                recipientAddress: addr("8"),
                amountAtomic: 901n,
                idempotencyKey: "safe_study_send_reserve_01",
              });
              expect(send.authorization).not.toBeNull();
              await expect(
                sends.submit({
                  accountId: beneficiary,
                  sendId: send.record.sendId,
                  signature: "YWJjZA==",
                }),
              ).rejects.toThrow("outcome unknown");
              // Recreate both service and repository as after a Worker restart.
              // Reference lookup and canonical chain proof resolve the held send.
              const restarted = makeSends();
              expect(
                (await restarted.get({ accountId: beneficiary, sendId: send.record.sendId })).record
                  .status,
              ).toBe("confirmed");
              await expect(
                sends.submit({
                  accountId: beneficiary,
                  sendId: send.record.sendId,
                  signature: "YWJjZA==",
                }),
              ).rejects.toThrow("conflict");
              expect(submissions).toBe(1);
              expect(await rpc.readUsdcBalance(beneficiaryWallet)).toBe(0n);
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
          }
          await f.owner.query(
            "SELECT set_reward_operations_paused_v1(revision,TRUE,'local_study_complete') FROM reward_operations_control WHERE singleton",
          );
          if (treasury && empty && tier !== 2n) {
            await expect(
              run(Effect.provide(layer)(creditEmptySafeTreasury(subject))),
            ).rejects.toThrow();
          }
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
}
