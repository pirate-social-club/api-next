import { afterAll, describe, expect, test } from "bun:test";
import {
  CommunityPurchaseFundingProducerRejected,
  produceCommunityPurchaseFundingQuote,
} from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations";
import { makeControlPlaneCommunityPurchaseFundingProducerStore } from "./community-purchase-funding-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

function schemaIdentifier(): string {
  return `api_next_producer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
    await admin.query(`INSERT INTO users (user_id) VALUES ('user_1'), ('user_2')`);
    await admin.query(`INSERT INTO communities (
      community_id, display_name, created_by_user_id, created_at, updated_at
    ) VALUES ('community_1', 'Community One', 'user_1', clock_timestamp(), clock_timestamp())`);
    await admin.query(`INSERT INTO community_memberships (
      community_id, membership_id, user_id, status, created_at, updated_at
    ) VALUES ('community_1', 'membership_1', 'user_1', 'member', clock_timestamp(), clock_timestamp())`);
    await admin.query(`INSERT INTO community_commerce_policy_revisions (
      community_id, policy_version, source_revision, issued_by
    ) VALUES ('community_1', 7, 'source-7', 'user_1')`);
    await admin.query(`INSERT INTO community_commerce_listings (
      listing_id, community_id, policy_version, availability_mode, available_quantity
    ) VALUES ('listing_1', 'community_1', 7, 'finite', 2)`);
    await admin.query(`INSERT INTO community_commerce_eligibility_policy_versions (
      community_id, policy_version, verification_required
    ) VALUES ('community_1', 7, FALSE)`);
    await admin.query(`INSERT INTO community_commerce_pricing_policy_versions (
      community_id, policy_version, amount_atomic
    ) VALUES ('community_1', 7, 12500000)`);
    await admin.query(`INSERT INTO community_commerce_money_route_policy_versions (
      community_id, policy_version, chain_id, token_contract, token_decimals,
      treasury_address, required_confirmations
    ) VALUES ('community_1', 7, 8453, '0x${"11".repeat(20)}', 6,
      '0x${"33".repeat(20)}', 3)`);
    await admin.query(`INSERT INTO community_commerce_allocation_policy_versions (
      community_id, policy_version
    ) VALUES ('community_1', 7)`);
    await admin.query(`INSERT INTO community_commerce_settlement_policy_versions (
      community_id, policy_version, settlement_mode
    ) VALUES ('community_1', 7, 'delivery_only_story_settlement')`);
    await admin.query(`INSERT INTO community_commerce_donation_policy_versions (
      community_id, policy_version, policy_mode, share_bps
    ) VALUES ('community_1', 7, 'none', 0)`);
    return await use(connection, admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function run<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect));
}

suite("community purchase funding producer repository", () => {
  test("atomically creates the server-owned quote, reservation, and plan", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneCommunityPurchaseFundingProducerStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const result = await run(
        produceCommunityPurchaseFundingQuote(
          {
            actorId: "user_1",
            authenticatedWalletAddress: `0x${"22".repeat(20).toUpperCase()}`,
            communityId: "community_1",
            listingId: "listing_1",
          },
          store,
        ),
      );
      expect(result.replayed).toBe(false);
      expect(result.policyVersion).toBe(7);
      expect(result.expected.amountAtomic).toBe(12_500_000n);
      expect(Date.parse(result.expiresAt) - Date.parse(result.quotedAt)).toBe(600_000);

      const rows = await admin.query<{
        readonly reservation_state: string;
        readonly available_quantity: number;
        readonly plan_count: string;
        readonly snapshot_count: string;
      }>(`SELECT reservation.state AS reservation_state,
                   listing.available_quantity,
                   (SELECT count(*) FROM community_purchase_funding_plans) AS plan_count,
                   (SELECT count(*) FROM community_purchase_route_snapshots) AS snapshot_count
              FROM community_purchase_availability_reservations AS reservation
              JOIN community_commerce_listings AS listing
                ON listing.listing_id = reservation.listing_id`);
      expect(rows.rows[0]).toMatchObject({
        reservation_state: "held",
        available_quantity: 1,
        plan_count: "1",
        snapshot_count: "1",
      });
    });
  });

  test("replays the durable quote and rejects an actor without membership", async () => {
    await withSchema(async (connection) => {
      const store = makeControlPlaneCommunityPurchaseFundingProducerStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const input = {
        actorId: "user_1",
        authenticatedWalletAddress: `0x${"22".repeat(20)}`,
        communityId: "community_1",
        listingId: "listing_1",
      };
      const first = await run(produceCommunityPurchaseFundingQuote(input, store));
      const replay = await run(produceCommunityPurchaseFundingQuote(input, store));
      expect(replay).toMatchObject({
        replayed: true,
        quoteId: first.quoteId,
        purchaseId: first.purchaseId,
        expiresAt: first.expiresAt,
      });

      await expect(
        run(produceCommunityPurchaseFundingQuote({ ...input, actorId: "user_2" }, store)),
      ).rejects.toMatchObject(
        new CommunityPurchaseFundingProducerRejected({ reason: "not-found" }),
      );
    });
  });
});

afterAll(() => undefined);
