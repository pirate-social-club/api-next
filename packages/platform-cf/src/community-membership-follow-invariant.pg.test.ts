import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const MIGRATION_VERSION = "0112_community_membership_follow_invariant.sql";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = `api_next_membership_follow_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function expectDeferredFailure(admin: Client, mutation: string): Promise<void> {
  await admin.query("BEGIN");
  await admin.query(mutation);
  await expect(admin.query("COMMIT")).rejects.toThrow(
    "active Community membership requires an active follow",
  );
  await admin.query("ROLLBACK");
}

suite("community membership-follow PostgreSQL invariant", () => {
  test("repairs prior rows and rejects a member without its active follow", async () => {
    await withSchema(async (connection, admin) => {
      const migrations = await loadPostgresMigrations();
      const migrationIndex = migrations.findIndex(
        (migration) => migration.version === MIGRATION_VERSION,
      );
      expect(migrationIndex).toBeGreaterThan(0);
      await runPostgresMigrations({
        connectionString: connection,
        migrations: migrations.slice(0, migrationIndex),
      });
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('follow-owner', 'active', '{}'::jsonb),
                ('follow-missing', 'active', '{}'::jsonb),
                ('follow-inactive', 'active', '{}'::jsonb)`,
      );
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id, created_at, updated_at
         ) VALUES (
           'follow-community', 'Follow invariant', 'active', 'follow-owner',
           clock_timestamp(), clock_timestamp()
         )`,
      );
      await admin.query(
        `INSERT INTO community_memberships (
           community_id, membership_id, user_id, status, joined_at, created_at, updated_at
         ) VALUES
           ('follow-community', 'membership-missing', 'follow-missing', 'member',
             clock_timestamp(), clock_timestamp(), clock_timestamp()),
           ('follow-community', 'membership-inactive', 'follow-inactive', 'member',
             clock_timestamp(), clock_timestamp(), clock_timestamp())`,
      );
      await admin.query(
        `INSERT INTO community_follows (
           community_follow_id, community_id, user_id, status,
           unfollowed_at, created_at, updated_at
         ) VALUES (
           'follow-existing-identity', 'follow-community', 'follow-inactive', 'inactive',
           clock_timestamp(), clock_timestamp(), clock_timestamp()
         )`,
      );

      const applied = await runPostgresMigrations({ connectionString: connection, migrations });
      if (applied.dryRun) throw new Error("expected a real migration run");
      expect(applied.result.applied).toContain(MIGRATION_VERSION);
      const repaired = await admin.query(
        `SELECT community_follow_id, user_id, status, unfollowed_at
           FROM community_follows
          WHERE community_id = 'follow-community'
          ORDER BY user_id`,
      );
      expect(repaired.rows).toEqual([
        {
          community_follow_id: "follow-existing-identity",
          user_id: "follow-inactive",
          status: "active",
          unfollowed_at: null,
        },
        expect.objectContaining({
          user_id: "follow-missing",
          status: "active",
          unfollowed_at: null,
        }),
      ]);
      expect(repaired.rows[1]?.community_follow_id).toMatch(/^follow_repair_[0-9a-f]{64}$/u);

      await expectDeferredFailure(
        admin,
        `UPDATE community_follows
            SET status = 'inactive', unfollowed_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE community_id = 'follow-community' AND user_id = 'follow-missing'`,
      );
      await expectDeferredFailure(
        admin,
        `DELETE FROM community_follows
          WHERE community_id = 'follow-community' AND user_id = 'follow-inactive'`,
      );
      await expectDeferredFailure(
        admin,
        `INSERT INTO community_memberships (
           community_id, membership_id, user_id, status, joined_at, created_at, updated_at
         ) VALUES (
           'follow-community', 'membership-owner', 'follow-owner', 'member',
           clock_timestamp(), clock_timestamp(), clock_timestamp()
         )`,
      );

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_memberships (
           community_id, membership_id, user_id, status, joined_at, created_at, updated_at
         ) VALUES (
           'follow-community', 'membership-owner', 'follow-owner', 'member',
           clock_timestamp(), clock_timestamp(), clock_timestamp()
         )`,
      );
      await admin.query(
        `INSERT INTO community_follows (
           community_follow_id, community_id, user_id, status,
           unfollowed_at, created_at, updated_at
         ) VALUES (
           'follow-owner-identity', 'follow-community', 'follow-owner', 'active',
           NULL, clock_timestamp(), clock_timestamp()
         )`,
      );
      await expect(admin.query("COMMIT")).resolves.toBeDefined();
    });
  }, 60_000);
});
