import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  assertRewardsShutdownInventory,
  withRewardsShutdownLock,
} from "../../../scripts/rewards-binding-deploy-preflight.ts";
import { seedMegapotAuthority } from "./rewards-composed-pool.pg-fixture.ts";
import { seedActivePoolLeg, seedSong } from "./rewards-song-offers.pg-fixture.ts";

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
    await withReusablePostgresTestSchema({
      baseConnectionString: url,
      schemaName: "reward_binding_empty",
      use: async ({ admin, schema }) => {
        await applyPostgresTestBaselineConnection({ connectionString: scoped(schema) });
        await admin.query(`SET search_path TO "${schema}"`);
        const operator = new Client({ connectionString: scoped(schema) });
        await operator.connect();
        try {
          await operator.query("SET lock_timeout='100ms'");
          let staleCalled = false;
          await expect(
            withRewardsShutdownLock(
              admin,
              async () => {
                staleCalled = true;
              },
              schema,
              { expectedRevision: "99" },
            ),
          ).rejects.toThrow("revision");
          expect(staleCalled).toBe(false);
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
              { expectedRevision: "0" },
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
          await operator.query("SELECT set_reward_operations_state_v2(1,'settling','incident')");
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
    await withReusablePostgresTestSchema({
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
});
