import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { makeSongMegapotContributions } from "../../application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import { withDanceServingPermissionFixture } from "./dance-serving-permissions.pg-fixture.ts";
import type { MegapotV2FullRpcClient } from "./megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeCurrentFundingRecoveryEvidence } from "./reward-funding-receipt-discovery.ts";
import type { FundingCancellationProof } from "./song-funding-cancellation-proof.ts";
import { seedSongContributionFixture } from "./song-megapot-contribution.pg-fixture.ts";
import {
  makeControlPlaneSongContributionPorts,
  makeControlPlaneSongFundingRecoveryStore,
} from "./song-megapot-contribution-repository.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw Error("Test URL required");
const suite = url ? describe : describe.skip;
suite("owner-only finalized cancellation completion", () => {
  test("preserves immutable authority and closes exact held accounting once through a real restricted-role path", async () => {
    if (!url) throw Error("Test URL required");
    await withDanceServingPermissionFixture(
      url,
      async (f) => {
        const http = await f.makeRole(),
          jobs = await f.makeRole();
        await f.owner.query(
          "SELECT bind_reward_contribution_purpose_v2($1,'http_commands'),grant_shared_song_funding_runtime_v2($1,'account')",
          [http.role],
        );
        await f.owner.query(
          "SELECT bind_reward_contribution_purpose_v2($1,'funding_recovery_jobs')",
          [jobs.role],
        );
        await f.owner.query(`GRANT EXECUTE ON FUNCTION require_reward_run_authority_v1() TO ${f.quote(jobs.role)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} GRANT EXECUTE ON FUNCTIONS TO ${f.quote(http.role)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} GRANT ALL ON TABLES TO ${f.quote(http.role)}`);
        try {
          await f.upgrade();
        } finally {
          await f.owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} REVOKE EXECUTE ON FUNCTIONS FROM ${f.quote(http.role)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} REVOKE ALL ON TABLES FROM ${f.quote(http.role)}`);
        }
        for (const role of [http, jobs]) {
          const client = new Client({ connectionString: role.url });
          await client.connect();
          try {
            await expect(
              client.query("SELECT recover_song_funding_cancellation_v2('{}',0,0)"),
            ).rejects.toMatchObject({ code: "42501" });
            await expect(
              client.query("SELECT * FROM reward_funding_cancellation_proofs_v2"),
            ).rejects.toMatchObject({ code: "42501" });
            await expect(
              client.query("TRUNCATE reward_funding_cancellation_proofs_v2"),
            ).rejects.toMatchObject({ code: "42501" });
          } finally {
            await client.end();
          }
        }
        await f.admin.query(`SET search_path TO ${f.quote(f.schema)},pg_catalog`);
        const seeded = await seedSongContributionFixture(f.admin);
        // Fixture-only environment vector before any contribution. Production
        // code and all command tests below run with ordinary triggers enabled.
        await f.admin.query(
          "BEGIN; SET LOCAL session_replication_role=replica; UPDATE megapot_deployment_attestations SET environment='staging'; SET LOCAL session_replication_role=origin; COMMIT",
        );
        await f.owner.query(
          "SELECT set_reward_operations_paused_v1(revision,TRUE,'cancellation_fixture_acquire') FROM reward_operations_control WHERE singleton",
        );
        await f.owner.query("SELECT acquire_reward_run_lease_v1('cancellation-fixture',120,120)");
        await f.owner.query(
          "SELECT set_reward_operations_paused_v1(revision,FALSE,'cancellation_fixture_ready') FROM reward_operations_control WHERE singleton",
        );
        const httpLayer = makeDirectPostgresControlPlaneLayer(http.url),
          jobsLayer = makeDirectPostgresControlPlaneLayer(jobs.url);
        const service = makeSongMegapotContributions(
          makeControlPlaneSongContributionPorts(
            httpLayer,
            { authorize: () => Effect.succeed({ accountId: "a" }) },
            { rewardsEnabled: true },
          ),
        );
        const base = { communityId: "community", postId: "post", contributionId: null };
        const receipt = Schema.decodeUnknownSync(C.ContributionReceiptV2)(
          await Effect.runPromise(
            service.execute(
              "CreateSongMegapotContributionV2",
              base,
              await seeded.request("a", "cancel_completion_create_01"),
            ),
          ),
        );
        const scope = { ...base, contributionId: receipt.contribution_id };
        const recovery = Schema.decodeUnknownSync(C.RecoveryReceiptV2)(
          await Effect.runPromise(
            service.execute("RecoverSongMegapotContributionV2", scope, {
              idempotency_key: "cancel_completion_recover_01",
              expected_state_revision: 0,
              purpose: "reconcile_original",
            }),
          ),
        );
        const store = makeControlPlaneSongFundingRecoveryStore(jobsLayer);
        const work = await Effect.runPromise(
          store.claim(recovery.work_item_id, "cancel-completion-work"),
        );
        if (!work) throw Error("Expected real claimed work");
        const head = {
          blockNumber: 20n,
          blockHash: `0x${"a".repeat(64)}`,
          blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        };
        const rpc = {
          deployment: work.source.deployment,
          attestDeploymentAt: async () => {},
          readHead: async () => head,
          readBlock: async (n: bigint) =>
            n === 20n ? head : { blockNumber: n, blockHash: work.source.attestationBlockHash },
          readTransactionCount: async () => BigInt(receipt.instruction.nonce),
          readPendingNonce: async () => BigInt(receipt.instruction.nonce),
        } as unknown as MegapotV2FullRpcClient;
        await Effect.runPromise(
          store.record(
            work,
            await Effect.runPromise(
              makeCurrentFundingRecoveryEvidence(rpc, () => new Date().toISOString())(
                work.state,
                work.source,
              ),
            ),
          ),
        );
        const plan = Schema.decodeUnknownSync(C.CancellationReceiptV2)(
          await Effect.runPromise(
            service.execute("PrepareSongMegapotContributionCancellationV2", scope, {
              idempotency_key: "cancel_completion_prepare_01",
              expected_state_revision: 0,
              purpose: "cancel_original_nonce",
            }),
          ),
        );
        const claimed = Schema.decodeUnknownSync(C.SubmissionClaimDeliveryV2)(
          await Effect.runPromise(
            service.execute("ClaimSongMegapotContributionSubmissionV2", scope, {
              idempotency_key: "cancel_completion_claim_01",
              client_instance_id: "cancel_completion_device",
              submission_attempt_id: "cancel_completion_attempt",
              purpose: "nonce_cancellation",
              expected_state_revision: 1,
              instruction_hash: plan.instruction_hash,
            }),
          ),
        );
        expect(claimed.delivery.kind).toBe("fresh_grant");
        const proof: FundingCancellationProof = {
          proofId: `funding-cancel-v2:84532:0x${"1".repeat(64)}`,
          contributionId: receipt.contribution_id,
          nonceLeaseId: receipt.reservation.nonce_lease_id,
          instructionHash: receipt.instruction.instruction_hash,
          cancellationInstructionHash: plan.instruction_hash,
          preparationId: plan.preparation_id,
          grantId: claimed.receipt.grant_id,
          chainId: 84532,
          sender: receipt.instruction.from,
          nonce: receipt.instruction.nonce,
          transactionHash: `0x${"1".repeat(64)}`,
          blockNumber: "21",
          blockHash: `0x${"2".repeat(64)}`,
          blockTimestamp: plan.prepared_at,
          checkpointBlock: "30",
          checkpointHash: `0x${"3".repeat(64)}`,
          confirmedNonce: (BigInt(receipt.instruction.nonce) + 1n).toString(),
          policyHash: "a".repeat(64),
          requiredConfirmations: 1,
          observedAt: new Date().toISOString(),
        };
        const snapshot = async () => {
          const result = [];
          for (const table of [
            "reward_wallet_nonce_leases",
            "reward_funding_account_counters_v2",
            "reward_funding_work_envelopes_v2",
            "reward_contribution_reservations_v2",
            "song_megapot_contributions_v2",
            "reward_funding_cancellation_proofs_v2",
            "reward_incoming_receipts_v2",
            "reward_song_slots_v2",
          ])
            result.push(
              (
                await f.owner.query(
                  `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') data FROM ${table} t`,
                )
              ).rows[0].data,
            );
          return result;
        };
        const invoke = (p = proof, revision = 2, brake = 0) =>
          f.owner.query("SELECT recover_song_funding_cancellation_v2($1::jsonb,$2,$3) packet", [
            JSON.stringify(p),
            revision,
            brake,
          ]);
        const before = await snapshot();
        await expect(invoke()).rejects.toMatchObject({ code: "PCV06" });
        expect(await snapshot()).toEqual(before);
        await f.owner.query(
          "SELECT set_reward_operations_paused_v1(revision,TRUE,'cancellation_completion') FROM reward_operations_control WHERE singleton",
        );
        const brake = Number(
          (await f.owner.query("SELECT revision FROM reward_operations_control WHERE singleton"))
            .rows[0].revision,
        );
        await expect(invoke(proof, 2, brake)).rejects.toMatchObject({ code: "PCV06" });
        await f.owner.query(
          "SELECT release_reward_run_lease_v1(run_id,fence) FROM reward_operations_run_lease WHERE singleton",
        );
        const paused = await snapshot();
        for (const [p, rev, b] of [
          [proof, 1, brake],
          [proof, 2, brake - 1],
          [{ ...proof, confirmedNonce: proof.nonce }, 2, brake],
          [{ ...proof, sender: `0x${"9".repeat(40)}` }, 2, brake],
          [{ ...proof, observedAt: new Date(Date.now() - 121_000).toISOString() }, 2, brake],
        ] as const) {
          await expect(invoke(p, rev, b)).rejects.toThrow();
          expect(await snapshot()).toEqual(paused);
        }
        // A late accounting refusal must roll back the proof and every prior write.
        await f.owner.query("BEGIN");
        await f.owner.query(
          "UPDATE reward_funding_account_counters_v2 SET active=0 WHERE account_id='a'",
        );
        await expect(invoke(proof, 2, brake)).rejects.toMatchObject({ code: "PCV11" });
        await f.owner.query("ROLLBACK");
        expect(await snapshot()).toEqual(paused);
        const contextSql =
          "SELECT highest_nonce::text,blocked_reason FROM reward_wallet_nonce_context_v2($1,$2,NULL)";
        expect(
          (await f.owner.query(contextSql, [84532, proof.sender])).rows[0].blocked_reason,
        ).toBe("outstanding_nonce");
        const accountingBefore = (
          await f.owner.query(
            "SELECT scope_leg,active,admitted,custody_liabilities FROM reward_funding_account_counters_v2 WHERE account_id='a' ORDER BY scope_leg",
          )
        ).rows;
        const secondOwner = new Client({ connectionString: url });
        await secondOwner.connect();
        let applied: unknown;
        try {
          await secondOwner.query(
            `SET search_path TO ${f.quote(f.schema)},pg_catalog; SET ROLE ${f.quote(f.ownerRole)}`,
          );
          const pair = await Promise.all([
            invoke(proof, 2, brake),
            secondOwner.query(
              "SELECT recover_song_funding_cancellation_v2($1::jsonb,$2,$3) packet",
              [JSON.stringify(proof), 2, brake],
            ),
          ]);
          applied = pair[0].rows[0].packet;
          expect(pair[1].rows[0].packet).toEqual(applied);
        } finally {
          await secondOwner.end();
        }
        expect((await invoke(proof, 2, brake)).rows[0].packet).toEqual(applied);
        const final = await snapshot();
        expect(
          (
            await f.owner.query(
              "SELECT scope_leg,active,admitted,custody_liabilities FROM reward_funding_account_counters_v2 WHERE account_id='a' ORDER BY scope_leg",
            )
          ).rows,
        ).toEqual(
          accountingBefore.map((x) => ({ ...x, active: (BigInt(x.active) - 1n).toString() })),
        );
        expect(
          (await f.owner.query(contextSql, [84532, proof.sender])).rows[0].blocked_reason,
        ).toBeNull();
        const identity = { accountId: "a", ...scope };
        const current = (
          await f.owner.query("SELECT read_owned_song_contribution_current_v2($1::jsonb) packet", [
            JSON.stringify(identity),
          ])
        ).rows[0].packet.current;
        expect(Schema.decodeUnknownSync(C.CurrentStateV2)(current)).toMatchObject({
          state: "nonce_closed_no_principal",
          nonce_state: "consumed_cancellation",
          disposition: "no_principal",
          pool_credit_atomic: "0",
          reservation_capacity_state: "released_after_nonce_consumed",
          command_receipt: receipt,
        });
        expect(current.submissions.every((s: { state: string }) => s.state === "finalized")).toBe(
          true,
        );
        expect(await snapshot()).toEqual(final);
        for (const sql of [
          "UPDATE reward_funding_cancellation_proofs_v2 SET evidence='{}'",
          "DELETE FROM reward_funding_cancellation_proofs_v2",
          "TRUNCATE reward_funding_cancellation_proofs_v2",
        ])
          await expect(f.owner.query(sql)).rejects.toThrow();
        await expect(
          invoke({ ...proof, blockHash: `0x${"9".repeat(64)}` }, 2, brake),
        ).rejects.toThrow();
        expect(await snapshot()).toEqual(final);
        const concurrent = new Client({ connectionString: http.url });
        await concurrent.connect();
        try {
          await expect(
            concurrent.query("SELECT recover_song_funding_cancellation_v2($1,2,$2)", [
              JSON.stringify(proof),
              brake,
            ]),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await concurrent.end();
        }
      },
      320,
    );
  }, 120_000);
});
