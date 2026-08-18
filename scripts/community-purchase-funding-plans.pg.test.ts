import { describe, expect, test } from "bun:test";

import {
  loadPublicProfileBackfillPgDriver,
  type PublicProfileBackfillPgClient,
} from "./public-profile-backfill-pg";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const pgModule =
  connectionString === undefined
    ? undefined
    : await loadPublicProfileBackfillPgDriver().catch((error: unknown) => {
        if (required) throw error;
        return undefined;
      });
const migrationModule =
  connectionString === undefined
    ? undefined
    : await import("./postgres-migrations").catch((error: unknown) => {
        if (required) throw error;
        return undefined;
      });
const PgClientConstructor = pgModule?.Client;
const runPostgresMigrations = migrationModule?.runPostgresMigrations;
const suite =
  connectionString === undefined ||
  PgClientConstructor === undefined ||
  runPostgresMigrations === undefined
    ? describe.skip
    : describe;

const BUYER = `0x${"11".repeat(20)}`;
const TOKEN = `0x${"22".repeat(20)}`;
const TREASURY = `0x${"33".repeat(20)}`;
const OPERATION = "money:v1:community_purchase:community_1:quote_1:purchase_1:3";
const OPERATION_2 = "money:v1:community_purchase:community_1:quote_2:purchase_2:3";

function schemaIdentifier(): string {
  return `api_next_funding_plans_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(
  use: (admin: PublicProfileBackfillPgClient) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  if (PgClientConstructor === undefined) throw new Error("package-local pg driver unavailable");
  const admin = new PgClientConstructor({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  try {
    await runPostgresMigrations({
      connectionString: connectionForSchema(connectionString, schema),
    });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await admin.query("INSERT INTO users (user_id) VALUES ('user_1')");
    await admin.query(`
      INSERT INTO communities (
        community_id, display_name, created_by_user_id, created_at, updated_at
      ) VALUES ('community_1', 'Community One', 'user_1', clock_timestamp(), clock_timestamp())
    `);
    return await use(admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

const planSql = `
  INSERT INTO community_purchase_funding_plans (
    quote_id, community_id, actor_id, buyer_wallet_address, buyer_chain_id, purchase_id,
    policy_version, chain_id, token_contract, token_decimals, treasury_address,
    amount_atomic, required_confirmations, quoted_at, expires_at, status, operation_id
  ) VALUES ($1, 'community_1', 'user_1', $2, 8453, $3, 3, 8453, $4, $5, $6,
            12500000, 3, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', $7, $8)
`;

async function insertPlan(
  admin: PublicProfileBackfillPgClient,
  quoteId: string,
  purchaseId: string,
  status = "active",
  operationId: string | null = null,
): Promise<void> {
  await admin.query(planSql, [quoteId, BUYER, purchaseId, TOKEN, 6, TREASURY, status, operationId]);
}

async function expectPgFailure(
  admin: PublicProfileBackfillPgClient,
  code: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<void> {
  try {
    await admin.query(text, values);
    throw new Error(`expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

async function insertJournal(
  admin: PublicProfileBackfillPgClient,
  operationId = OPERATION,
): Promise<void> {
  await admin.query(
    `INSERT INTO community_purchase_funding_journal (
       operation_id, community_id, actor_id, quote_id, purchase_id, policy_version,
       chain_id, token_contract, token_decimals, expected_sender, expected_recipient,
       expected_amount_atomic, required_confirmations, state, version, snapshot
     ) VALUES ($1, 'community_1', 'user_1', 'quote_1', 'purchase_1', 3,
       8453, $2, 6, $3, $4, 12500000, 3, 'planned', 1, '{}'::jsonb)`,
    [operationId, TOKEN, BUYER, TREASURY],
  );
}

suite("Postgres 17 community purchase funding plans", () => {
  test("enforces quote identity, canonical terms, and binding coherence", async () => {
    await withSchema(async (admin) => {
      await expectPgFailure(admin, "23503", planSql, [
        "quote_fk",
        BUYER,
        "purchase_fk",
        TOKEN,
        6,
        TREASURY,
        "bound",
        "missing_operation",
      ]);
      await expectPgFailure(admin, "23514", planSql, [
        "quote_wallet",
        `0X${"11".repeat(20)}`,
        "purchase_wallet",
        TOKEN,
        6,
        TREASURY,
        "active",
        null,
      ]);
      await expectPgFailure(
        admin,
        "23514",
        `INSERT INTO community_purchase_funding_plans (
          quote_id, community_id, actor_id, buyer_wallet_address, buyer_chain_id, purchase_id,
          policy_version, chain_id, token_contract, token_decimals, treasury_address,
          amount_atomic, required_confirmations, expires_at
        ) VALUES ('quote_chain', 'community_1', 'user_1', $1, 1, 'purchase_chain',
          3, 8453, $2, 6, $3, 1, 1, '2026-01-02T00:00:00Z')`,
        [BUYER, TOKEN, TREASURY],
      );
      await expectPgFailure(
        admin,
        "23514",
        `INSERT INTO community_purchase_funding_plans (
          quote_id, community_id, actor_id, buyer_wallet_address, buyer_chain_id, purchase_id,
          policy_version, chain_id, token_contract, token_decimals, treasury_address,
          amount_atomic, required_confirmations, expires_at
        ) VALUES ('quote_expiry', 'community_1', 'user_1', $1, 8453, 'purchase_expiry',
          3, 8453, $2, 6, $3, 1, 1, '2026-01-01T00:00:00Z')`,
        [BUYER, TOKEN, TREASURY],
      );
      await expectPgFailure(admin, "23514", planSql, [
        "quote_decimals",
        BUYER,
        "purchase_decimals",
        TOKEN,
        18,
        TREASURY,
        "active",
        null,
      ]);
      await insertPlan(admin, "quote_1", "purchase_1");
      await expectPgFailure(admin, "23505", planSql, [
        "quote_2",
        BUYER,
        "purchase_1",
        TOKEN,
        6,
        TREASURY,
        "active",
        null,
      ]);
      await expectPgFailure(admin, "23514", planSql, [
        "quote_bound_without_operation",
        BUYER,
        "purchase_bound_without_operation",
        TOKEN,
        6,
        TREASURY,
        "bound",
        null,
      ]);
    });
  });

  test("freezes terms and permits only legal active binding/cancellation", async () => {
    await withSchema(async (admin) => {
      await insertPlan(admin, "quote_1", "purchase_1");
      await insertPlan(admin, "quote_cancel", "purchase_cancel");
      await insertJournal(admin);
      await insertJournal(admin, OPERATION_2);

      await expectPgFailure(
        admin,
        "P0001",
        "UPDATE community_purchase_funding_plans SET amount_atomic = 2 WHERE quote_id = 'quote_1'",
      );
      await admin.query(
        "UPDATE community_purchase_funding_plans SET status = 'bound', operation_id = $1 WHERE quote_id = 'quote_1'",
        [OPERATION],
      );
      await admin.query(
        "UPDATE community_purchase_funding_plans SET status = 'cancelled' WHERE quote_id = 'quote_cancel'",
      );
      await expectPgFailure(
        admin,
        "P0001",
        "UPDATE community_purchase_funding_plans SET status = 'active', operation_id = NULL WHERE quote_id = 'quote_1'",
      );
      await expectPgFailure(
        admin,
        "P0001",
        "UPDATE community_purchase_funding_plans SET operation_id = $1 WHERE quote_id = 'quote_1'",
        [OPERATION_2],
      );
      await expectPgFailure(
        admin,
        "P0001",
        "UPDATE community_purchase_funding_plans SET status = 'bound', operation_id = $1 WHERE quote_id = 'quote_cancel'",
        [OPERATION],
      );
      const rows = await admin.query<{ status: string; operation_id: string | null }>(
        "SELECT status, operation_id FROM community_purchase_funding_plans ORDER BY quote_id",
      );
      expect(rows.rows).toEqual([
        { status: "bound", operation_id: OPERATION },
        { status: "cancelled", operation_id: null },
      ]);
    });
  });

  test("keeps operation binding unique and rolls back a failed transaction", async () => {
    await withSchema(async (admin) => {
      await insertPlan(admin, "quote_1", "purchase_1");
      await insertJournal(admin);
      await admin.query(
        "UPDATE community_purchase_funding_plans SET status = 'bound', operation_id = $1 WHERE quote_id = 'quote_1'",
        [OPERATION],
      );

      await admin.query("BEGIN");
      try {
        await expectPgFailure(admin, "23505", planSql, [
          "quote_rollback",
          BUYER,
          "purchase_rollback",
          TOKEN,
          6,
          TREASURY,
          "bound",
          OPERATION,
        ]);
      } finally {
        await admin.query("ROLLBACK");
      }
      const rows = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM community_purchase_funding_plans WHERE quote_id = 'quote_rollback'",
      );
      expect(rows.rows[0]?.count).toBe("0");
    });
  });
});
