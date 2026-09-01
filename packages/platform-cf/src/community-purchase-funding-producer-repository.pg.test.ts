import { afterAll, describe, expect, test } from "bun:test";
import {
  CommunityPurchaseFundingProducerRejected,
  produceCommunityPurchaseFundingQuote,
} from "@pirate/application";
import { communityPurchaseAtomicAmount } from "@pirate/domain";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityPurchaseFundingProducerStore } from "./community-purchase-funding-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(
  use: (connection: string, admin: Client) => Promise<A>,
  options: Readonly<{ readonly verificationRequired?: boolean }> = {},
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName:
      "packages_platform_cf_src_community_purchase_funding_producer_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      const connection = connectionForSchema(connectionString, schema);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
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
          ) VALUES ('community_1', 7, ${options.verificationRequired === true ? "TRUE" : "FALSE"})`);
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
    },
  });
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
      expect(result.expected.amountAtomic).toBe(communityPurchaseAtomicAmount(12_500_000n));
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
      const expiryRows = await admin.query<{
        readonly quoted_at: string;
        readonly quote_expires_at: string;
        readonly reservation_expires_at: string;
        readonly plan_expires_at: string;
      }>(
        `SELECT quote.quoted_at::text AS quoted_at,
                quote.expires_at::text AS quote_expires_at,
                reservation.expires_at::text AS reservation_expires_at,
                plan.expires_at::text AS plan_expires_at
           FROM community_purchase_quotes AS quote
           JOIN community_purchase_availability_reservations AS reservation
             ON reservation.purchase_id = quote.purchase_id
           JOIN community_purchase_funding_plans AS plan
             ON plan.quote_id = quote.quote_id
          WHERE quote.quote_id = $1`,
        [result.quoteId],
      );
      expect(expiryRows.rows).toHaveLength(1);
      const expiry = expiryRows.rows[0];
      if (expiry === undefined) throw new Error("expected quote expiry row");
      expect(expiry.reservation_expires_at).toBe(expiry.quote_expires_at);
      expect(expiry.plan_expires_at).toBe(expiry.quote_expires_at);
      expect(Date.parse(expiry.quote_expires_at) - Date.parse(expiry.quoted_at)).toBe(600_000);
      await expect(
        admin.query(
          `UPDATE community_purchase_quotes
              SET amount_atomic = amount_atomic + 1
            WHERE quote_id = $1`,
          [result.quoteId],
        ),
      ).rejects.toThrow("terms are immutable");
      await expect(
        admin.query(`DELETE FROM community_purchase_pricing_snapshots WHERE quote_id = $1`, [
          result.quoteId,
        ]),
      ).rejects.toThrow("append-only");
    });
  });

  test("does not replay a quote across community identities", async () => {
    await withSchema(async (connection, admin) => {
      await admin.query(`INSERT INTO communities (
        community_id, display_name, created_by_user_id, created_at, updated_at
      ) VALUES ('community_2', 'Community Two', 'user_1', clock_timestamp(), clock_timestamp())`);
      await admin.query(`INSERT INTO community_memberships (
        community_id, membership_id, user_id, status, created_at, updated_at
      ) VALUES ('community_2', 'membership_2', 'user_1', 'member', clock_timestamp(), clock_timestamp())`);
      await admin.query(`INSERT INTO community_commerce_policy_revisions (
        community_id, policy_version, source_revision, issued_by
      ) VALUES ('community_2', 8, 'source-8', 'user_1')`);
      await admin.query(`INSERT INTO community_commerce_listings (
        listing_id, community_id, policy_version, availability_mode, available_quantity
      ) VALUES ('listing_2', 'community_2', 8, 'finite', 2)`);
      await admin.query(`INSERT INTO community_commerce_eligibility_policy_versions (
        community_id, policy_version, verification_required
      ) VALUES ('community_2', 8, FALSE)`);
      await admin.query(`INSERT INTO community_commerce_pricing_policy_versions (
        community_id, policy_version, amount_atomic
      ) VALUES ('community_2', 8, 13000000)`);
      await admin.query(`INSERT INTO community_commerce_money_route_policy_versions (
        community_id, policy_version, chain_id, token_contract, token_decimals,
        treasury_address, required_confirmations
      ) VALUES ('community_2', 8, 8453, '0x${"44".repeat(20)}', 6,
        '0x${"55".repeat(20)}', 3)`);
      await admin.query(`INSERT INTO community_commerce_allocation_policy_versions (
        community_id, policy_version
      ) VALUES ('community_2', 8)`);
      await admin.query(`INSERT INTO community_commerce_settlement_policy_versions (
        community_id, policy_version, settlement_mode
      ) VALUES ('community_2', 8, 'delivery_only_story_settlement')`);
      await admin.query(`INSERT INTO community_commerce_donation_policy_versions (
        community_id, policy_version, policy_mode, share_bps
      ) VALUES ('community_2', 8, 'none', 0)`);

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
      const crossCommunity = await run(
        produceCommunityPurchaseFundingQuote({ ...input, communityId: "community_2" }, store),
      ).then(
        (value) => ({ kind: "returned" as const, value }),
        (error) => ({ kind: "rejected" as const, error }),
      );
      if (crossCommunity.kind === "returned") {
        expect(crossCommunity.value.replayed).toBe(false);
      } else {
        expect(crossCommunity.error).toMatchObject({ reason: "not-found" });
      }

      const original = await admin.query<{
        readonly community_id: string;
        readonly status: string;
        readonly amount_atomic: string;
      }>(
        `SELECT community_id, status, amount_atomic::text AS amount_atomic
           FROM community_purchase_quotes
          WHERE quote_id = $1`,
        [first.quoteId],
      );
      expect(original.rows[0]).toEqual({
        community_id: "community_1",
        status: "active",
        amount_atomic: "12500000",
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

  test("expires the quote with its hold and restores finite availability once", async () => {
    await withSchema(async (connection, admin) => {
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
      await admin.query(
        `UPDATE community_purchase_intents
            SET expires_at = created_at + INTERVAL '10 milliseconds'
          WHERE purchase_id = $1`,
        [first.purchaseId],
      );
      await admin.query("SELECT pg_sleep(0.05)");

      const replacement = await run(produceCommunityPurchaseFundingQuote(input, store));
      expect(replacement.replayed).toBe(false);
      expect(replacement.purchaseId).not.toBe(first.purchaseId);

      const rows = await admin.query<{
        readonly quote_status: string;
        readonly intent_status: string;
        readonly reservation_state: string;
        readonly available_quantity: number;
      }>(
        `SELECT quote.status AS quote_status,
                intent.status AS intent_status,
                reservation.state AS reservation_state,
                listing.available_quantity
           FROM community_purchase_quotes AS quote
           JOIN community_purchase_intents AS intent ON intent.purchase_id = quote.purchase_id
           JOIN community_purchase_availability_reservations AS reservation
             ON reservation.purchase_id = quote.purchase_id
           JOIN community_commerce_listings AS listing ON listing.listing_id = quote.listing_id
          WHERE quote.quote_id = $1`,
        [first.quoteId],
      );
      expect(rows.rows[0]).toMatchObject({
        quote_status: "expired",
        intent_status: "expired",
        reservation_state: "expired",
        available_quantity: 1,
      });
    });
  });

  test("requires a recent verification snapshot for the active policy revision", async () => {
    await withSchema(
      async (connection, admin) => {
        await admin.query(
          `INSERT INTO community_purchase_verification_snapshots (
           snapshot_id, actor_id, community_id, policy_version, provider, verified_at, snapshot
         ) VALUES ('verification_source_1', 'user_1', 'community_1', 7, 'zkpassport',
                   clock_timestamp(), '{"source":"test"}'::jsonb)`,
        );
        const store = makeControlPlaneCommunityPurchaseFundingProducerStore(
          makeDirectPostgresControlPlaneLayer(connection),
        );
        const result = await run(
          produceCommunityPurchaseFundingQuote(
            {
              actorId: "user_1",
              authenticatedWalletAddress: `0x${"22".repeat(20)}`,
              communityId: "community_1",
              listingId: "listing_1",
            },
            store,
          ),
        );
        expect(result.replayed).toBe(false);
        const rows = await admin.query<{
          readonly policy_version: string;
          readonly provider: string;
        }>(
          `SELECT policy_version, provider
           FROM community_purchase_verification_snapshots
          WHERE quote_id = $1`,
          [result.quoteId],
        );
        expect(rows.rows[0]).toEqual({ policy_version: "7", provider: "zkpassport" });
        await expect(
          admin.query(
            `UPDATE community_commerce_pricing_policy_versions
              SET amount_atomic = amount_atomic + 1
            WHERE community_id = 'community_1' AND policy_version = 7`,
          ),
        ).rejects.toThrow("append-only");
      },
      { verificationRequired: true },
    );
  });

  test("rejects invalid policy supersession ordering and mutation", async () => {
    await withSchema(async (_connection, admin) => {
      const revision = await admin.query<{ readonly effective_at: string }>(
        `SELECT effective_at::text AS effective_at
           FROM community_commerce_policy_revisions
          WHERE community_id = 'community_1' AND policy_version = 7`,
      );
      const effectiveAt = revision.rows[0]?.effective_at;
      if (effectiveAt === undefined) throw new Error("expected policy revision");

      await expect(
        admin.query(
          `UPDATE community_commerce_policy_revisions
              SET superseded_at = effective_at - INTERVAL '1 microsecond'
            WHERE community_id = 'community_1' AND policy_version = 7`,
        ),
      ).rejects.toThrow("supersession precedes effectiveness");

      await admin.query(
        `UPDATE community_commerce_policy_revisions
            SET superseded_at = effective_at + INTERVAL '1 second'
          WHERE community_id = 'community_1' AND policy_version = 7`,
      );
      await expect(
        admin.query(
          `UPDATE community_commerce_policy_revisions
              SET superseded_at = effective_at + INTERVAL '2 seconds'
            WHERE community_id = 'community_1' AND policy_version = 7`,
        ),
      ).rejects.toThrow("supersession is immutable");
      expect(Date.parse(effectiveAt)).not.toBeNaN();
    });
  });
});

afterAll(() => undefined);
