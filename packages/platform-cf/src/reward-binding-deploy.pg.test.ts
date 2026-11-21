import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
  disposeReusablePostgresTestSchemaOwners,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  assertRewardsShutdownInventory,
  withRewardsShutdownLock,
} from "../../../scripts/rewards-binding-deploy-preflight.ts";
import { seedMegapotAuthority } from "./rewards-composed-pool.pg-fixture.ts";
import { seedActivePoolLeg, seedSong } from "./rewards-song-offers.pg-fixture.ts";

const emptySchema = createReusablePostgresTestSchemaOwner();
const fundedSchema = createReusablePostgresTestSchemaOwner();
const safeSchema = createReusablePostgresTestSchemaOwner();

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw Error("Test URL required");
const suite = url ? describe : describe.skip;
const scoped = (schema: string) => {
  if (!url) throw Error("Test URL required");
  const connection = new URL(url);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  return connection.toString();
};

suite("reward binding shutdown database proof", () => {
  test("a zero-owed upload holds pause until completion and running control refuses shutdown", async () => {
    if (!url) throw Error("Test URL required");
    await emptySchema.run({
      baseConnectionString: url,
      schemaName: "reward_binding_empty",
      use: async ({ admin, schema }) => {
        await applyPostgresTestBaselineConnection({ connectionString: scoped(schema) });
        await admin.query(`SET search_path TO "${schema}"`);
        const operator = new Client({ connectionString: scoped(schema) });
        await operator.connect();
        try {
          await operator.query("SET lock_timeout='100ms'");
          expect(
            await withRewardsShutdownLock(
              admin,
              async (signal) => {
                expect(signal.aborted).toBe(false);
                await expect(
                  operator.query("SELECT set_reward_operations_paused_v1(0,FALSE,'resume_race')"),
                ).rejects.toMatchObject({ code: "55P03" });
                return "uploaded";
              },
              schema,
            ),
          ).toBe("uploaded");
          await operator.query("SELECT set_reward_operations_paused_v1(0,FALSE,'after_upload')");
          let called = false;
          await expect(
            withRewardsShutdownLock(
              admin,
              async () => {
                called = true;
              },
              schema,
            ),
          ).rejects.toThrow("persisted pause");
          expect(called).toBe(false);
          await admin.query(
            "SET session_replication_role=replica; DELETE FROM reward_operations_control; SET session_replication_role=origin",
          );
          await expect(
            withRewardsShutdownLock(
              admin,
              async () => {
                called = true;
              },
              schema,
            ),
          ).rejects.toThrow("persisted pause");
          expect(called).toBe(false);
        } finally {
          await operator.end();
        }
      },
    });
  }, 30000);

  test("actual funded leg and open offer remain visible even while paused; missing inventory cannot deploy", async () => {
    if (!url) throw Error("Test URL required");
    await fundedSchema.run({
      baseConnectionString: url,
      schemaName: "reward_binding_funded",
      use: async ({ admin, schema }) => {
        await applyPostgresTestBaselineConnection({
          connectionString: scoped(schema),
          rewardsRunning: true,
        });
        await admin.query(`SET search_path TO "${schema}"`);
        const identity = await seedSong(admin, "binding-liability");
        await seedMegapotAuthority(admin);
        await seedActivePoolLeg(admin, identity, { fallback: false, suffix: "binding-liability" });
        await admin.query(
          "SELECT set_reward_operations_paused_v1(revision,TRUE,'binding_inventory') FROM reward_operations_control WHERE singleton",
        );
        let called = false;
        await expect(
          withRewardsShutdownLock(
            admin,
            async () => {
              called = true;
            },
            schema,
          ),
        ).rejects.toThrow("leg_liabilities");
        expect(called).toBe(false);
        await expect(assertRewardsShutdownInventory(admin, schema)).rejects.toThrow("open_offers");
        await admin.query("ALTER TABLE reward_ledger_credits RENAME TO missing_inventory_fixture");
        await expect(
          withRewardsShutdownLock(
            admin,
            async () => {
              called = true;
            },
            schema,
          ),
        ).rejects.toMatchObject({ code: "42P01" });
        expect(called).toBe(false);
        await admin.query("ALTER TABLE missing_inventory_fixture RENAME TO reward_ledger_credits");
      },
    });
  }, 30000);
  test("preserved empty ticketed hold deploys with Safe on; unpaid late and sealed refunds block Safe off", async () => {
    if (!url) throw Error("Test URL required");
    await safeSchema.run({
      baseConnectionString: url,
      schemaName: "reward_binding_safe",
      use: async ({ admin, schema }) => {
        await applyPostgresTestBaselineConnection({
          connectionString: scoped(schema),
          rewardsRunning: true,
        });
        await admin.query(`SET search_path TO "${schema}"`);
        const identity = await seedSong(admin, "safe-binding");
        await seedMegapotAuthority(admin);
        const { legId } = await seedActivePoolLeg(admin, identity, {
          fallback: false,
          suffix: "safe-binding",
        });
        await admin.query(
          "SELECT set_reward_operations_paused_v1(revision,TRUE,'safe_binding_inventory') FROM reward_operations_control WHERE singleton",
        );
        // Only fixture construction suppresses triggers; the guard executes real SELECTs and locks.
        await admin.query("SET session_replication_role=replica");
        await admin.query(`INSERT INTO reward_signer_nonces(chain_id,signer_address,next_nonce,observed_pending_nonce,observed_block_number,observed_block_hash,observed_at,nonce_authority)
        SELECT chain_id,custody_address,0,0,1,'0x'||repeat('a',64),clock_timestamp(),'safe_owner_v1' FROM megapot_deployment_attestations WHERE attestation_id='megapot-base-sepolia-v2'`);
        await admin.query(
          "UPDATE song_reward_offer_legs SET purchase_order='ticket_first_v1',funded_atomic=10000,spent_atomic=10000 WHERE leg_id=$1",
          [legId],
        );
        await admin.query(
          `INSERT INTO megapot_pool_drawings(pool_leg_id,drawing_id,observation_id,status,entry_cutoff_at,ticket_price_ceiling_atomic,purchase_order,terminal_reason,terminal_at)
        VALUES($1,11365,'held-fixture-observation','operational_hold',clock_timestamp(),10000,'ticket_first_v1','empty_ticketed_drawing',clock_timestamp())`,
          [legId],
        );
        await admin.query("SET session_replication_role=origin");
        expect(
          await withRewardsShutdownLock(admin, async () => "uploaded", schema, {
            legacy: false,
            safe: true,
          }),
        ).toBe("uploaded");
        await expect(
          assertRewardsShutdownInventory(admin, schema, { legacy: false, safe: false }),
        ).rejects.toThrow("unresolved_drawings");
        await admin.query("SET session_replication_role=replica");
        const state = {
          owner: { account_id: identity.accountId },
          receipt: {
            contribution_id: "late-binding",
            funding_effect_id: "funding-late-binding",
            target: {
              community_id: identity.communityId,
              post_id: identity.postId,
              pool_leg_id: legId,
            },
          },
          revision: 0,
          fundingState: "late_principal_owed",
          nonceFinalized: true,
        };
        await admin.query(
          `INSERT INTO song_megapot_contributions_v2(contribution_id,account_id,community_id,post_id,pool_leg_id,funding_effect_id,nonce_lease_id,profile_id,snapshot_id,state)
        VALUES('late-binding',$1,$2,$3,$4,'funding-late-binding','nonce-late-binding','profile-late-binding','snapshot-late-binding',$5)`,
          [identity.accountId, identity.communityId, identity.postId, legId, state],
        );
        await admin.query(
          "INSERT INTO reward_late_principal_liabilities_v2(receipt_id,contribution_id,amount_atomic,original_sender) VALUES('late-receipt-binding','late-binding',10000,'0x'||repeat('b',40))",
        );
        await admin.query("SET session_replication_role=origin");
        // This debt is absent from leg.funded_atomic and remains owed without a refund seal.
        await expect(
          assertRewardsShutdownInventory(admin, schema, { legacy: true, safe: false }),
        ).rejects.toThrow("unpaid_late_principal");
        await assertRewardsShutdownInventory(admin, schema, { legacy: false, safe: true });
        await admin.query("SET session_replication_role=replica");
        await admin.query(
          `INSERT INTO reward_safe_refunds_v1(refund_id,receipt_id,contribution_id,pool_leg_id,attestation_id,category,account_id,original_sender,amount_atomic)
        VALUES('refund-binding','late-receipt-binding','late-binding',$1,'megapot-base-sepolia-v2','late_principal',$2,'0x'||repeat('b',40),10000)`,
          [legId, identity.accountId],
        );
        await admin.query("SET session_replication_role=origin");
        await expect(
          assertRewardsShutdownInventory(admin, schema, { legacy: true, safe: false }),
        ).rejects.toThrow("unpaid_safe_refunds");
        await assertRewardsShutdownInventory(admin, schema, { legacy: false, safe: true });
        // Empty single-funder winnings use external_fallback credits, but their
        // allocation lineage still belongs to the Safe engine.
        await admin.query("SET session_replication_role=replica");
        await admin.query(
          `INSERT INTO megapot_allocation_batches(allocation_batch_id,pool_leg_id,drawing_id,snapshot_id,claim_effect_id,algorithm_version,net_winnings_atomic,allocation_count,allocation_hash,state)
            VALUES('safe-binding-batch',$1,11365,'safe-binding-snapshot','safe-binding-claim','equal_v1',1000,1,repeat('a',64),'prepared')`,
          [legId],
        );
        await admin.query(
          `INSERT INTO reward_ledger_credits(credit_id,account_id,payout_persona_id,chain_id,token_address,amount_atomic,source_kind,source_reference,state)
            VALUES('safe-binding-credit',$1,$2,84532,'0x'||repeat('1',40),1000,'external_fallback','safe-binding-batch','credited')`,
          [identity.accountId, identity.personaId],
        );
        await admin.query(
          `INSERT INTO megapot_allocations(allocation_batch_id,ordinal,account_id,persona_id,amount_atomic,allocation_kind,credit_id)
            VALUES('safe-binding-batch',0,$1,$2,1000,'external_fallback','safe-binding-credit')`,
          [identity.accountId, identity.personaId],
        );
        await admin.query("SET session_replication_role=origin");
        await assertRewardsShutdownInventory(admin, schema, { legacy: false, safe: true });
        await expect(
          assertRewardsShutdownInventory(admin, schema, { legacy: true, safe: false }),
        ).rejects.toThrow("unpaid_credits");
        // A missing custody attribution cannot be treated as a Safe exemption.
        await admin.query(
          "SET session_replication_role=replica; DELETE FROM reward_signer_nonces; SET session_replication_role=origin",
        );
        await expect(
          assertRewardsShutdownInventory(admin, schema, { legacy: false, safe: true }),
        ).rejects.toThrow("open_offers");
      },
    });
  }, 30000);
});

afterAll(async () => {
  await disposeReusablePostgresTestSchemaOwners(emptySchema, fundedSchema, safeSchema);
}, 30000);
