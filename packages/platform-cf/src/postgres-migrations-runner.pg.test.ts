import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_MIGRATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-migration-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-migration-suite-complete\n";
let completedTestCount = 0;

function schemaIdentifier(): string {
  return `api_next_migrations_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  const option = encodeURIComponent(`-c search_path=${schema}`);
  return `${raw}${separator}options=${option}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

suite("Postgres 17 migration runner", () => {
  test("applies a fresh database and then performs an up-to-date no-op", async () => {
    const migrations = await loadPostgresMigrations();
    await withSchema(async (scopedConnection, admin) => {
      const fresh = await runPostgresMigrations({ connectionString: scopedConnection });
      expect(fresh).toMatchObject({
        dryRun: false,
        result: {
          applied: migrations.map(({ version }) => version),
          currentVersion: migrations.at(-1)?.version,
        },
      });
      const noOp = await runPostgresMigrations({ connectionString: scopedConnection });
      expect(noOp).toMatchObject({ dryRun: false, result: { applied: [] } });
      const ledger = await admin.query(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      );
      expect(ledger.rows).toHaveLength(migrations.length);
    });
    completedTestCount += 1;
  });

  test("refuses a tampered ledger checksum before applying further work", async () => {
    await withSchema(async (scopedConnection, admin) => {
      await runPostgresMigrations({ connectionString: scopedConnection });
      await admin.query({
        text: "UPDATE schema_migrations SET checksum = $1 WHERE version = $2",
        values: ["0".repeat(64), "0001_v1_product_slice.sql"],
      });
      await expect(
        runPostgresMigrations({ connectionString: scopedConnection }),
      ).rejects.toMatchObject({ _tag: "MigrationLedgerMismatch", reason: "checksum" });
    });
    completedTestCount += 1;
  });

  test("backfills an existing settlement asset before installing the verification guard", async () => {
    const migrations = await loadPostgresMigrations();
    const assetBonusIndex = migrations.findIndex(
      ({ version }) => version === "0088_rewards_song_asset_bonus.sql",
    );
    expect(assetBonusIndex).toBeGreaterThan(0);

    await withSchema(async (scopedConnection, admin) => {
      await runPostgresMigrations({
        connectionString: scopedConnection,
        migrations: migrations.slice(0, assetBonusIndex),
      });
      await admin.query(`INSERT INTO reward_asset_whitelist (
        chain_id, token_address, decimals, symbol, asset_kind, environment,
        status, policy_version, activated_at
      ) VALUES (
        84532, '0x036cbd53842c5426634e7929541ec2318f3dcf7e', 6, 'USDC',
        'settlement_usdc', 'staging', 'active', 'settlement-usdc-v1',
        '2026-08-28T12:27:28.000Z'
      )`);

      const result = await runPostgresMigrations({
        connectionString: scopedConnection,
        migrations,
      });
      expect(result).toMatchObject({
        dryRun: false,
        result: {
          applied: migrations.slice(assetBonusIndex).map(({ version }) => version),
          currentVersion: migrations.at(-1)?.version,
        },
      });
      const asset = await admin.query(
        `SELECT activated_at, plain_erc20_verified_at
           FROM reward_asset_whitelist
          WHERE chain_id = 84532
            AND token_address = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'`,
      );
      expect(asset.rows).toHaveLength(1);
      expect(asset.rows[0]?.plain_erc20_verified_at).toEqual(asset.rows[0]?.activated_at);
      await expect(
        admin.query(`UPDATE reward_asset_whitelist
                        SET symbol = 'USDX'
                      WHERE chain_id = 84532
                        AND token_address = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'`),
      ).rejects.toThrow("reward asset whitelist only permits retirement");
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 3) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
