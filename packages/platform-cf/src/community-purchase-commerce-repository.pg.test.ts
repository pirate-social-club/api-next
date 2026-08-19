import { afterAll, describe, expect, test } from "bun:test";
import { createCommunityPurchaseQuote } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations";
import { makeControlPlaneCommunityPurchaseCommerceStore } from "./community-purchase-commerce-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_COMMUNITY_PURCHASE_COMMERCE_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-community-purchase-commerce-suite-complete";
const sentinelContents =
  "api-next-control-plane-postgres-community-purchase-commerce-suite-complete\n";
let completedTestCount = 0;

const WALLET = `0x${"11".repeat(20)}` as const;
const TOKEN = `0x${"22".repeat(20)}` as const;
const TREASURY = `0x${"33".repeat(20)}` as const;

function schemaIdentifier(): string {
  return `api_next_commerce_${crypto.randomUUID().replaceAll("-", "")}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  try {
    const connection = connectionForSchema(connectionString, schema);
    await runPostgresMigrations({ connectionString: connection });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await admin.query("INSERT INTO users (user_id) VALUES ('user_1'), ('operator_1')");
    await admin.query(`INSERT INTO communities (
      community_id, display_name, created_by_user_id, created_at, updated_at
    ) VALUES ('community_1', 'Community One', 'user_1', clock_timestamp(), clock_timestamp())`);
    await admin.query(`INSERT INTO community_memberships (
      community_id, membership_id, user_id, status, joined_at, created_at, updated_at
    ) VALUES ('community_1', 'membership_1', 'user_1', 'member', clock_timestamp(), clock_timestamp(), clock_timestamp())`);
    await admin.query(`
      INSERT INTO community_commerce_policy_revisions (
        community_id, policy_version, source_revision, issued_by_user_id
      ) VALUES ('community_1', 1, 'commerce-1', 'operator_1');
      INSERT INTO community_commerce_listings (
        listing_id, community_id, policy_version, availability_mode, available_quantity
      ) VALUES ('listing_1', 'community_1', 1, 'finite', 1);
      INSERT INTO community_commerce_eligibility_policy_versions (community_id, policy_version)
        VALUES ('community_1', 1);
      INSERT INTO community_commerce_pricing_policy_versions (community_id, policy_version)
        VALUES ('community_1', 1);
      INSERT INTO community_commerce_money_route_policy_versions (community_id, policy_version)
        VALUES ('community_1', 1);
      INSERT INTO community_commerce_allocation_policy_versions (community_id, policy_version)
        VALUES ('community_1', 1);
      INSERT INTO community_commerce_settlement_policy_versions (community_id, policy_version, mode)
        VALUES ('community_1', 1, 'delivery_only_story_settlement');
      INSERT INTO community_commerce_donation_policy_versions (community_id, policy_version, mode)
        VALUES ('community_1', 1, 'none');
      INSERT INTO community_purchase_verification_snapshots (
        snapshot_id, community_id, actor_id, provider, provider_policy_version,
        verified_at, expires_at, status
      ) VALUES (
        'verification_1', 'community_1', 'user_1', 'zkPassport', '0.14.2',
        clock_timestamp() - INTERVAL '1 hour', clock_timestamp() + INTERVAL '23 hours', 'valid'
      );
      INSERT INTO community_purchase_eligibility_snapshots (
        snapshot_id, community_id, actor_id, policy_version, verification_snapshot_id, decision
      ) VALUES ('eligibility_1', 'community_1', 'user_1', 1, 'verification_1', 'eligible');
      INSERT INTO community_purchase_pricing_snapshots (
        snapshot_id, community_id, actor_id, policy_version, amount_atomic, region_code
      ) VALUES ('pricing_1', 'community_1', 'user_1', 1, 12500000, 'US');
      INSERT INTO community_purchase_route_snapshots (
        snapshot_id, community_id, policy_version, chain_id, token_contract,
        token_decimals, treasury_address, required_confirmations
      ) VALUES ('route_1', 'community_1', 1, 8453, '${TOKEN}', 6, '${TREASURY}', 3);
      INSERT INTO community_purchase_allocation_snapshots (
        snapshot_id, community_id, listing_id, policy_version, quantity
      ) VALUES ('allocation_1', 'community_1', 'listing_1', 1, 1);
      INSERT INTO community_purchase_settlement_snapshots (
        snapshot_id, community_id, policy_version, mode
      ) VALUES ('settlement_1', 'community_1', 1, 'delivery_only_story_settlement');
      INSERT INTO community_purchase_donation_snapshots (
        snapshot_id, community_id, policy_version, mode
      ) VALUES ('donation_1', 'community_1', 1, 'none');
    `);
    return await use(connection, admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function run<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect));
}

function input(idempotencyKey = "request_1", wallet = WALLET) {
  return {
    actorId: "user_1",
    communityId: "community_1",
    listingId: "listing_1",
    authenticatedWalletAddress: wallet,
    verificationSnapshotId: "verification_1",
    idempotencyKey,
  };
}

suite("Postgres 17 community-purchase commerce producer", () => {
  afterAll(async () => {
    if (completedTestCount !== 4) return;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sentinelPath, sentinelContents, "utf8");
  });

  test("derives an immutable quote and plan atomically, then replays exact identity", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneCommunityPurchaseCommerceStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const first = await run(createCommunityPurchaseQuote(input(), store));
      expect(first.amountAtomic.toString()).toBe("12500000");
      expect(first.plan.expected.recipient).toBe(TREASURY);
      expect(first.expiresAt).toBeTruthy();

      const replay = await run(createCommunityPurchaseQuote(input(), store));
      expect(replay).toEqual(first);
      const counts = await admin.query(
        `SELECT
           (SELECT count(*) FROM community_purchase_intents) AS intents,
           (SELECT count(*) FROM community_purchase_quotes) AS quotes,
           (SELECT count(*) FROM community_purchase_availability_reservations) AS reservations,
           (SELECT count(*) FROM community_purchase_funding_plans) AS plans`,
      );
      expect(counts.rows[0]).toMatchObject({
        intents: "1",
        quotes: "1",
        reservations: "1",
        plans: "1",
      });
      const listing = await admin.query(
        "SELECT available_quantity FROM community_commerce_listings WHERE listing_id = 'listing_1'",
      );
      expect(listing.rows[0]?.available_quantity).toBe("0");
      completedTestCount += 1;
    });
  });

  test("rejects a second finite reservation and conflicts on changed replay identity", async () => {
    await withSchema(async (connection) => {
      const store = makeControlPlaneCommunityPurchaseCommerceStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      await run(createCommunityPurchaseQuote(input(), store));
      await expect(
        run(createCommunityPurchaseQuote(input("request_2"), store)),
      ).rejects.toMatchObject({
        reason: "not-found",
      });
      await expect(
        run(createCommunityPurchaseQuote(input("request_1", `0x${"44".repeat(20)}`), store)),
      ).rejects.toMatchObject({
        reason: "conflict",
      });
      completedTestCount += 1;
    });
  });

  test("lazily expires a held reservation and returns finite availability", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneCommunityPurchaseCommerceStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      await run(createCommunityPurchaseQuote(input(), store));
      await admin.query(`
        UPDATE community_purchase_availability_reservations
           SET expires_at = clock_timestamp() - INTERVAL '1 second'
         WHERE listing_id = 'listing_1' AND status = 'held'
      `);
      const second = await run(createCommunityPurchaseQuote(input("request_2"), store));
      expect(second.quoteId).not.toBe("quote_1");
      const rows = await admin.query(`
        SELECT
          (SELECT count(*) FROM community_purchase_availability_reservations WHERE status = 'expired') AS expired,
          (SELECT count(*) FROM community_purchase_availability_reservations WHERE status = 'held') AS held,
          (SELECT count(*) FROM community_purchase_quotes WHERE status = 'expired') AS expired_quotes,
          (SELECT available_quantity FROM community_commerce_listings WHERE listing_id = 'listing_1') AS available
      `);
      expect(rows.rows[0]).toMatchObject({
        expired: "1",
        held: "1",
        expired_quotes: "1",
        available: "0",
      });
      completedTestCount += 1;
    });
  });

  test("rolls back intent and reservation when the plan boundary conflicts", async () => {
    await withSchema(async (connection, admin) => {
      await admin.query(`
        INSERT INTO community_purchase_funding_plans (
          quote_id, community_id, actor_id, buyer_wallet_address, buyer_chain_id,
          purchase_id, policy_version, chain_id, token_contract, token_decimals,
          treasury_address, amount_atomic, required_confirmations, quoted_at, expires_at
        ) VALUES (
          'quote_fixed', 'community_1', 'user_1', '${WALLET}', 8453,
          'purchase_fixed', 1, 8453, '${TOKEN}', 6, '${TREASURY}',
          12500000, 3, clock_timestamp(), clock_timestamp() + INTERVAL '600 seconds'
        )`);
      const store = makeControlPlaneCommunityPurchaseCommerceStore(
        makeDirectPostgresControlPlaneLayer(connection),
        {
          nextId: (prefix) => `${prefix}_fixed`,
        },
      );
      await expect(
        run(createCommunityPurchaseQuote(input("request_1"), store)),
      ).rejects.toMatchObject({
        reason: "conflict",
      });
      const counts = await admin.query(
        `SELECT
           (SELECT count(*) FROM community_purchase_intents) AS intents,
           (SELECT count(*) FROM community_purchase_quotes) AS quotes,
           (SELECT count(*) FROM community_purchase_availability_reservations) AS reservations,
           (SELECT count(*) FROM community_purchase_funding_plans) AS plans,
           (SELECT available_quantity FROM community_commerce_listings WHERE listing_id = 'listing_1') AS available`,
      );
      expect(counts.rows[0]).toMatchObject({
        intents: "0",
        quotes: "0",
        reservations: "0",
        plans: "1",
        available: "1",
      });
    });
  });
});
