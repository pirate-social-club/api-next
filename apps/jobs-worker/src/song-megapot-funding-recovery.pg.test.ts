import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import type { Hex } from "viem";
import { makeSongMegapotContributions } from "../../../packages/application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../../packages/contracts/src/rewards-song-contributions-v2.ts";
import { withDanceServingPermissionFixture } from "../../../packages/platform-cf/src/dance-serving-permissions.pg-fixture.ts";
import type { MegapotReceiptLog } from "../../../packages/platform-cf/src/megapot-v2.ts";
import type { MegapotV2FullRpcClient } from "../../../packages/platform-cf/src/megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "../../../packages/platform-cf/src/postgres.ts";
import { fakeSafeChain } from "../../../packages/platform-cf/src/reward-safe-chain.pg-fixture.ts";
import { seedSongContributionFixture } from "../../../packages/platform-cf/src/song-megapot-contribution.pg-fixture.ts";
import {
  makeControlPlaneRewardFundingObserver,
  makeControlPlaneSongContributionPorts,
  makeControlPlaneSongFundingRecoveryStore,
} from "../../../packages/platform-cf/src/song-megapot-contribution-repository.ts";
import { makeSongMegapotFundingRecovery } from "./song-megapot-funding-recovery.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw Error("Postgres test URL required");
const pgTest = url ? test : test.skip;

pgTest(
  "restricted Jobs waits through 22 pending ticks, then accepts the original payment once",
  async () => {
    if (!url) throw Error("Postgres test URL required");
    await withDanceServingPermissionFixture(
      url,
      async (f) => {
        const bindingDefinition = async () =>
          (
            await f.owner.query(
              "SELECT prosrc FROM pg_proc WHERE oid='bind_reward_contribution_purpose_v2(text,text)'::regprocedure",
            )
          ).rows[0]?.prosrc as string;
        const bindingBefore = await bindingDefinition();
        const http = await f.makeRole(),
          jobs = await f.makeRole();
        await f.owner.query("SELECT bind_reward_contribution_purpose_v2($1,'http_commands')", [
          http.role,
        ]);
        await f.owner.query(
          "SELECT bind_reward_contribution_purpose_v2($1,'funding_recovery_jobs')",
          [jobs.role],
        );
        await f.owner.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} GRANT EXECUTE ON FUNCTIONS TO ${f.quote(http.role)}`,
        );
        try {
          await f.upgrade();
        } finally {
          await f.owner.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} REVOKE EXECUTE ON FUNCTIONS FROM ${f.quote(http.role)}`,
          );
        }
        expect(
          (await bindingDefinition()).replace(
            ",'list_song_funding_candidates_v2(integer,bigint)'",
            "",
          ),
        ).toBe(bindingBefore);
        const layer = makeDirectPostgresControlPlaneLayer(jobs.url);
        const store = makeControlPlaneSongFundingRecoveryStore(layer);
        await expect(Effect.runPromise(store.list(1))).rejects.toBeDefined();
        await f.owner.query(
          "SELECT bind_reward_contribution_purpose_v2($1,'funding_recovery_jobs')",
          [jobs.role],
        );
        await f.owner.query(
          `GRANT EXECUTE ON FUNCTION require_reward_run_authority_v1() TO ${f.quote(jobs.role)}`,
        );
        const denied = new Client({ connectionString: http.url });
        await denied.connect();
        try {
          await expect(
            denied.query("SELECT list_song_funding_candidates_v2(1)"),
          ).rejects.toMatchObject({ code: "42501" });
          await expect(
            denied.query("SELECT * FROM reward_funding_work_envelopes_v2"),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await denied.end();
        }
        await f.admin.query(`SET search_path TO ${f.quote(f.schema)},pg_catalog`);
        const seeded = await seedSongContributionFixture(f.admin);
        const service = makeSongMegapotContributions(
          makeControlPlaneSongContributionPorts(
            makeDirectPostgresControlPlaneLayer(http.url),
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
              await seeded.request("a", "finality_create_0001"),
            ),
          ),
        );
        const scope = { ...base, contributionId: receipt.contribution_id };
        const grant = Schema.decodeUnknownSync(C.SubmissionClaimDeliveryV2)(
          await Effect.runPromise(
            service.execute("ClaimSongMegapotContributionSubmissionV2", scope, {
              idempotency_key: "finality_claim_0001",
              client_instance_id: "finality_browser_01",
              submission_attempt_id: "finality_send_0001",
              purpose: "funding_transfer",
              expected_state_revision: 0,
              instruction_hash: receipt.instruction.instruction_hash,
            }),
          ),
        );
        expect(grant.delivery.kind).toBe("fresh_grant");
        const hash = `0x${"7".repeat(64)}`,
          blockHash = `0x${"a".repeat(64)}`;
        await Effect.runPromise(
          service.execute("ObserveSongMegapotContributionV2", scope, {
            idempotency_key: "finality_observe_01",
            instruction_hash: receipt.instruction.instruction_hash,
            transaction_hash: hash,
          }),
        );
        // The selector rotates a bounded batch even when its first item must wait.
        await f.owner.query("BEGIN");
        try {
          await f.owner.query(`INSERT INTO reward_funding_work_envelopes_v2
        SELECT 'rotation:'||w.work_id,w.scope,x.command_id,w.profile_id,w.contribution_id,w.allocated,w.used,w.reserved,w.valid_until,w.payload
        FROM reward_funding_work_envelopes_v2 w JOIN song_megapot_contribution_commands_v2 x
          ON x.contribution_id=w.contribution_id AND x.command_id<>w.scope_key
        WHERE w.scope='reconciliation' LIMIT 1`);
          const selected = [];
          for (const cursor of [0, 1])
            selected.push(
              (
                await f.owner.query(
                  "SELECT packet->>'workId' AS id FROM list_song_funding_candidates_v2(1,$1) packet",
                  [cursor],
                )
              ).rows[0]?.id,
            );
          expect(new Set(selected).size).toBe(2);
          await expect(
            f.owner.query("SELECT list_song_funding_candidates_v2(0,0)"),
          ).rejects.toMatchObject({ code: "PCV07" });
        } finally {
          await f.owner.query("ROLLBACK");
        }
        const i = receipt.instruction;
        let finalized = 20n;
        const blockTimestamp = BigInt(Math.floor(Date.now() / 1000));
        const block = (n: bigint) => ({
          blockNumber: n,
          blockHash,
          blockTimestamp,
        });
        const log: MegapotReceiptLog = {
          address: i.to_token,
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            `0x${i.from.slice(2).padStart(64, "0")}`,
            `0x${i.recipient_custody.slice(2).padStart(64, "0")}`,
          ],
          data: `0x${BigInt(i.amount_atomic).toString(16).padStart(64, "0")}`,
          logIndex: 0,
          transactionHash: hash,
          blockHash,
          blockNumber: 30n,
        };
        const runtime = makeSongMegapotFundingRecovery({
          store,
          now: () => new Date().toISOString(),
          observe: (work, tx, discover) =>
            makeControlPlaneRewardFundingObserver(layer, discover)(work, tx),
          rpcFor: (work): MegapotV2FullRpcClient => ({
            ...fakeSafeChain().rpc,
            deployment: work.source.deployment,
            attestDeploymentAt: async () => {},
            readHead: async () => block(100n),
            readBlock: async (n) => block(n),
            readFinalizedHead: async () => block(finalized),
            readTransactionCount: async () => BigInt(i.nonce) + 1n,
            readPendingNonce: async () => BigInt(i.nonce) + 1n,
            readFundingTransferLogs: async ({ fromBlock, toBlock }) =>
              fromBlock <= 30n && toBlock >= 30n ? [log] : [],
            readTransaction: async () => ({
              transactionHash: hash,
              chainId: i.chain_id,
              from: i.from,
              to: i.to_token,
              nonce: BigInt(i.nonce),
              valueWei: 0n,
              input: i.calldata as Hex,
              blockNumber: 30n,
            }),
            readReceipt: async () => ({
              chainId: i.chain_id,
              status: "success",
              transactionHash: hash,
              from: i.from,
              to: i.to_token,
              blockHash,
              blockNumber: 30n,
              logs: [log],
            }),
          }),
        });
        const run = () =>
          Effect.runPromise(runtime.run({ enabled: true, limit: 1, ensure: () => Effect.void }));
        const workRows = async () =>
          (await f.owner.query("SELECT * FROM reward_funding_work_envelopes_v2 ORDER BY work_id"))
            .rows;
        await run();
        const waiting = await workRows();
        for (let minute = 1; minute <= 22; minute++) {
          finalized = 20n + BigInt(Math.min(minute, 9));
          await run();
        }
        expect(await workRows()).toEqual(waiting);
        expect((await f.owner.query("SELECT * FROM reward_incoming_receipts_v2")).rowCount).toBe(0);
        finalized = 30n;
        await run();
        expect(
          (
            await f.owner.query(
              "SELECT category,amount_atomic::text FROM reward_incoming_receipts_v2",
            )
          ).rows,
        ).toEqual([{ category: "pool_principal", amount_atomic: i.amount_atomic }]);
        expect(
          (
            await f.owner.query(
              "SELECT (payload->>'attempts')::int attempts FROM reward_funding_work_envelopes_v2 WHERE scope='reconciliation'",
            )
          ).rows,
        ).toEqual([{ attempts: 2 }]);
        const complete = await workRows();
        await run();
        expect(await workRows()).toEqual(complete);
        expect((await f.owner.query("SELECT * FROM reward_incoming_receipts_v2")).rowCount).toBe(1);
      },
      322,
    );
  },
  90_000,
);
