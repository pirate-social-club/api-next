import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";

import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import {
  applyPostgresMigrations,
  MigrationDefinitionInvalid,
  MigrationLedgerMismatch,
  type PostgresMigration,
} from "./postgres-migrations";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";

if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}

const suite = connectionString === undefined ? describe.skip : describe;
const foundationTestCount = 4;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_FOUNDATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-foundation-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-foundation-suite-complete\n";
let completedTestCount = 0;
const baselineSql = await Bun.file(
  new URL("../../../db/postgres/schema.sql", import.meta.url),
).text();
const migrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0001_v1_product_slice.sql", import.meta.url),
).text();
const identityMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0002_identity.sql", import.meta.url),
).text();
const m2MigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0003_m2_community_content.sql", import.meta.url),
).text();
const commentLockMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0004_post_comment_lock.sql", import.meta.url),
).text();
const m2BehaviorMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0005_m2_behavior_invariants.sql", import.meta.url),
).text();
const publicProfileMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0006_public_profile_handle_index.sql", import.meta.url),
).text();
const publicProfileInvariantMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0007_public_profile_handle_invariants.sql",
    import.meta.url,
  ),
).text();
const communityRouteSlugMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0008_community_route_slug.sql", import.meta.url),
).text();
const checksumManifest = (await Bun.file(
  new URL("../../../db/postgres/migrations/checksums.json", import.meta.url),
).json()) as { readonly migrations: Readonly<Record<string, string>> };

const migration: PostgresMigration = {
  version: "0001_v1_product_slice.sql",
  checksum: checksumManifest.migrations["0001_v1_product_slice.sql"] ?? "",
  sql: migrationSql,
};
const identityMigration: PostgresMigration = {
  version: "0002_identity.sql",
  checksum: checksumManifest.migrations["0002_identity.sql"] ?? "",
  sql: identityMigrationSql,
};
const m2Migration: PostgresMigration = {
  version: "0003_m2_community_content.sql",
  checksum: checksumManifest.migrations["0003_m2_community_content.sql"] ?? "",
  sql: m2MigrationSql,
};
const commentLockMigration: PostgresMigration = {
  version: "0004_post_comment_lock.sql",
  checksum: checksumManifest.migrations["0004_post_comment_lock.sql"] ?? "",
  sql: commentLockMigrationSql,
};
const m2BehaviorMigration: PostgresMigration = {
  version: "0005_m2_behavior_invariants.sql",
  checksum: checksumManifest.migrations["0005_m2_behavior_invariants.sql"] ?? "",
  sql: m2BehaviorMigrationSql,
};
const publicProfileMigration: PostgresMigration = {
  version: "0006_public_profile_handle_index.sql",
  checksum: checksumManifest.migrations["0006_public_profile_handle_index.sql"] ?? "",
  sql: publicProfileMigrationSql,
};
const publicProfileInvariantMigration: PostgresMigration = {
  version: "0007_public_profile_handle_invariants.sql",
  checksum: checksumManifest.migrations["0007_public_profile_handle_invariants.sql"] ?? "",
  sql: publicProfileInvariantMigrationSql,
};
const communityRouteSlugMigration: PostgresMigration = {
  version: "0008_community_route_slug.sql",
  checksum: checksumManifest.migrations["0008_community_route_slug.sql"] ?? "",
  sql: communityRouteSlugMigrationSql,
};
const migrations: readonly PostgresMigration[] = [
  migration,
  identityMigration,
  m2Migration,
  commentLockMigration,
  m2BehaviorMigration,
  publicProfileMigration,
  publicProfileInvariantMigration,
  communityRouteSlugMigration,
];

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function schemaIdentifier(): string {
  return `api_next_foundation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  const option = encodeURIComponent(`-c search_path=${schema}`);
  return `${raw}${separator}options=${option}`;
}

async function applyMigrations(
  scopedConnectionString: string,
  migrations: readonly PostgresMigration[],
): Promise<unknown> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ControlPlaneDb;
        return yield* applyPostgresMigrations(migrations);
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnectionString))),
    ),
  );
}

interface SchemaCatalog {
  readonly tables: readonly Record<string, unknown>[];
  readonly columns: readonly Record<string, unknown>[];
  readonly indexes: readonly Record<string, unknown>[];
  readonly constraints: readonly Record<string, unknown>[];
}

async function catalogForSchema(admin: Client, schema: string): Promise<SchemaCatalog> {
  const tables = await admin.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema],
  );
  const columns = await admin.query(
    `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1
     ORDER BY table_name, ordinal_position`,
    [schema],
  );
  const indexes = await admin.query<{
    readonly table_name: string;
    readonly index_name: string;
    readonly indexdef: string;
  }>(
    `SELECT tablename AS table_name, indexname AS index_name, indexdef
     FROM pg_indexes
     WHERE schemaname = $1
     ORDER BY tablename, indexname`,
    [schema],
  );
  const constraints = await admin.query(
    `SELECT relation.relname AS table_name,
            pg_constraint.conname AS constraint_name,
            pg_constraint.contype AS constraint_type,
            pg_get_constraintdef(pg_constraint.oid) AS definition
     FROM pg_constraint
     JOIN pg_class AS relation ON relation.oid = pg_constraint.conrelid
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1
     ORDER BY relation.relname, constraint_name`,
    [schema],
  );
  return {
    tables: tables.rows,
    columns: columns.rows,
    indexes: indexes.rows.map((index) => ({
      ...index,
      indexdef: index.indexdef.replaceAll(`${schema}.`, ""),
    })),
    constraints: constraints.rows,
  };
}

async function withSchema<A>(
  use: (admin: Client, connection: string, schema: string) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  const scopedConnectionString = connectionForSchema(connectionString, schema);
  try {
    return await use(admin, scopedConnectionString, schema);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function expectForeignKeyFailure(
  admin: Client,
  text: string,
  values: readonly unknown[],
): Promise<void> {
  try {
    await admin.query({ text, values: [...values] });
    throw new Error("expected a composite foreign-key violation");
  } catch (error) {
    expect(error).toMatchObject({ code: "23503" });
  }
}

suite("Postgres 17 v1 foundation", () => {
  test("applies all migrations and matches the cumulative schema source", async () => {
    await withSchema(async (admin, scopedConnectionString, schema) => {
      expect(checksum(migrationSql)).toBe(migration.checksum);
      expect(checksum(identityMigrationSql)).toBe(identityMigration.checksum);
      expect(checksum(m2MigrationSql)).toBe(m2Migration.checksum);
      expect(checksum(publicProfileMigrationSql)).toBe(publicProfileMigration.checksum);
      expect(checksum(publicProfileInvariantMigrationSql)).toBe(
        publicProfileInvariantMigration.checksum,
      );
      expect(checksum(communityRouteSlugMigrationSql)).toBe(communityRouteSlugMigration.checksum);
      const version = await admin.query<{ server_version_num: string }>("SHOW server_version_num");
      expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(170000);

      await applyMigrations(scopedConnectionString, migrations);
      const migratedCatalog = await catalogForSchema(admin, schema);
      const baselineSchema = schemaIdentifier();
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(baselineSchema)}`);
      try {
        await admin.query(`SET search_path TO ${quoteIdentifier(baselineSchema)}`);
        await admin.query(baselineSql);
        expect(migratedCatalog).toEqual(await catalogForSchema(admin, baselineSchema));
      } finally {
        await admin.query(`DROP SCHEMA ${quoteIdentifier(baselineSchema)} CASCADE`);
        await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      }

      const tables = await admin.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()",
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        "account_aliases",
        "comments",
        "communities",
        "community_feed_projection",
        "community_follows",
        "community_memberships",
        "home_feed_projection",
        "moderation_actions",
        "moderation_reports",
        "post_votes",
        "posts",
        "public_handle_index",
        "schema_migrations",
        "users",
      ]);

      const columns = await admin.query<{
        readonly table_name: string;
        readonly column_name: string;
        readonly is_nullable: string;
      }>(
        `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND ((table_name = 'communities' AND column_name IN ('membership_mode', 'human_verification_lane', 'route_slug'))
             OR (table_name = 'community_memberships' AND column_name = 'request_note')
             OR (table_name = 'posts' AND column_name IN ('author_user_id', 'body', 'post_type', 'visibility', 'idempotency_key', 'idempotency_body_hash', 'comments_locked'))
             OR (table_name = 'comments' AND column_name IN ('author_user_id', 'body', 'idempotency_key', 'idempotency_body_hash', 'depth')))`,
      );
      expect(columns.rows).toEqual(
        expect.arrayContaining([
          { table_name: "posts", column_name: "author_user_id", is_nullable: "YES" },
          { table_name: "posts", column_name: "body", is_nullable: "YES" },
          { table_name: "posts", column_name: "post_type", is_nullable: "NO" },
          { table_name: "posts", column_name: "visibility", is_nullable: "NO" },
          { table_name: "posts", column_name: "idempotency_key", is_nullable: "NO" },
          { table_name: "posts", column_name: "idempotency_body_hash", is_nullable: "YES" },
          { table_name: "posts", column_name: "comments_locked", is_nullable: "NO" },
          { table_name: "comments", column_name: "author_user_id", is_nullable: "YES" },
          { table_name: "comments", column_name: "body", is_nullable: "YES" },
          { table_name: "comments", column_name: "idempotency_key", is_nullable: "NO" },
          { table_name: "comments", column_name: "idempotency_body_hash", is_nullable: "YES" },
          { table_name: "comments", column_name: "depth", is_nullable: "NO" },
          {
            table_name: "community_memberships",
            column_name: "request_note",
            is_nullable: "YES",
          },
          { table_name: "communities", column_name: "membership_mode", is_nullable: "NO" },
          {
            table_name: "communities",
            column_name: "human_verification_lane",
            is_nullable: "YES",
          },
          { table_name: "communities", column_name: "route_slug", is_nullable: "YES" },
        ]),
      );

      const postStatus = await admin.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'posts'::regclass AND contype = 'c' AND conname = 'posts_status_check'`,
      );
      expect(postStatus.rows[0]?.definition).toContain("processing");
      expect(postStatus.rows[0]?.definition).toContain("removed");

      const routeSlugIndex = await admin.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'communities_route_slug_uidx'`,
      );
      expect(routeSlugIndex.rows).toHaveLength(1);
      expect(routeSlugIndex.rows[0]?.indexdef).toContain("WHERE (route_slug IS NOT NULL)");

      const communityOrdinals = await admin.query<{
        readonly column_name: string;
        readonly ordinal_position: number;
      }>(
        `SELECT column_name, ordinal_position
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'communities'
          ORDER BY ordinal_position`,
      );
      expect(communityOrdinals.rows).toEqual([
        { column_name: "community_id", ordinal_position: 1 },
        { column_name: "display_name", ordinal_position: 2 },
        { column_name: "status", ordinal_position: 3 },
        { column_name: "created_by_user_id", ordinal_position: 4 },
        { column_name: "created_at", ordinal_position: 5 },
        { column_name: "updated_at", ordinal_position: 6 },
        { column_name: "membership_mode", ordinal_position: 7 },
        { column_name: "human_verification_lane", ordinal_position: 8 },
        { column_name: "route_slug", ordinal_position: 9 },
      ]);
    });
    completedTestCount += 1;
  });

  test("rejects duplicate, out-of-order, and checksum-mismatched migrations", async () => {
    await withSchema(async (_admin, scopedConnectionString) => {
      const duplicate = await applyMigrations(scopedConnectionString, [migration, migration]).catch(
        (error) => error,
      );
      expect(duplicate).toBeInstanceOf(MigrationDefinitionInvalid);
      expect(duplicate).toMatchObject({ reason: "duplicate" });

      const outOfOrder = await applyMigrations(scopedConnectionString, [
        { ...migration, version: "0002_out_of_order.sql" },
        { ...migration, version: "0001_out_of_order.sql" },
      ]).catch((error) => error);
      expect(outOfOrder).toBeInstanceOf(MigrationDefinitionInvalid);
      expect(outOfOrder).toMatchObject({ reason: "out-of-order" });

      await applyMigrations(scopedConnectionString, [migration]);
      const mismatch = await applyMigrations(scopedConnectionString, [
        { ...migration, checksum: "0".repeat(64) },
      ]).catch((error) => error);
      expect(mismatch).toBeInstanceOf(MigrationLedgerMismatch);
      expect(mismatch).toMatchObject({ version: migration.version });

      const secondMigration = { ...migration, version: "0002_v1_follow-up.sql" };
      await withSchema(async (_admin, secondScopedConnectionString) => {
        await applyMigrations(secondScopedConnectionString, [secondMigration]);
        const gap = await applyMigrations(secondScopedConnectionString, [
          migration,
          secondMigration,
        ]).catch((error) => error);
        expect(gap).toBeInstanceOf(MigrationLedgerMismatch);
        expect(gap).toMatchObject({
          reason: "not-prefix",
          version: migration.version,
          expectedVersion: migration.version,
          actualVersion: secondMigration.version,
        });
      });

      await withSchema(async (_admin, secondScopedConnectionString) => {
        await applyMigrations(secondScopedConnectionString, [identityMigration]);
        const gap = await applyMigrations(secondScopedConnectionString, migrations).catch(
          (error) => error,
        );
        expect(gap).toBeInstanceOf(MigrationLedgerMismatch);
        expect(gap).toMatchObject({
          reason: "not-prefix",
          version: migration.version,
          expectedVersion: migration.version,
          actualVersion: identityMigration.version,
        });
      });
    });
    completedTestCount += 1;
  });

  test("rejects cross-community post, comment, and vote references", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date();
      await admin.query({
        text: "INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4), ($5, $6, $7, $4, $4)",
        values: ["community-a", "A", "user-a", now, "community-b", "B", "user-b"],
      });
      await admin.query({
        text: "INSERT INTO posts (community_id, post_id, author_user_id, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        values: ["community-a", "post-a", "user-a", "post", now],
      });

      await expectForeignKeyFailure(
        admin,
        "INSERT INTO comments (community_id, comment_id, post_id, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        ["community-b", "comment-b", "post-a", "comment", now],
      );
      await expectForeignKeyFailure(
        admin,
        "INSERT INTO post_votes (community_id, post_vote_id, post_id, user_id, vote_value, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)",
        ["community-b", "vote-b", "post-a", "user-b", 1, now],
      );
    });
    completedTestCount += 1;
  });

  test("scopes repository reads, updates, and deletes by community", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date();
      await admin.query({
        text: "INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4), ($5, $6, $7, $4, $4)",
        values: ["community-a", "A", "user-a", now, "community-b", "B", "user-b"],
      });
      await admin.query({
        text: "INSERT INTO posts (community_id, post_id, author_user_id, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5), ($6, $7, $8, $9, $5, $5)",
        values: [
          "community-a",
          "post-a",
          "user-a",
          "community A",
          now,
          "community-b",
          "post-b",
          "user-b",
          "community B",
        ],
      });

      const readPost = async (communityId: string, postId: string) =>
        (
          await admin.query<{ readonly body: string }>({
            text: "SELECT body FROM posts WHERE community_id = $1 AND post_id = $2",
            values: [communityId, postId],
          })
        ).rows;

      expect(await readPost("community-a", "post-b")).toEqual([]);
      expect(await readPost("community-b", "post-b")).toEqual([{ body: "community B" }]);

      const wrongUpdate = await admin.query({
        text: "UPDATE posts SET body = $1, updated_at = $2 WHERE community_id = $3 AND post_id = $4",
        values: ["cross-tenant update", now, "community-a", "post-b"],
      });
      expect(wrongUpdate.rowCount).toBe(0);

      const wrongDelete = await admin.query({
        text: "DELETE FROM posts WHERE community_id = $1 AND post_id = $2",
        values: ["community-a", "post-b"],
      });
      expect(wrongDelete.rowCount).toBe(0);
      expect(await readPost("community-b", "post-b")).toEqual([{ body: "community B" }]);

      const ownUpdate = await admin.query({
        text: "UPDATE posts SET body = $1, updated_at = $2 WHERE community_id = $3 AND post_id = $4",
        values: ["updated A", now, "community-a", "post-a"],
      });
      expect(ownUpdate.rowCount).toBe(1);
      const ownDelete = await admin.query({
        text: "DELETE FROM posts WHERE community_id = $1 AND post_id = $2",
        values: ["community-a", "post-a"],
      });
      expect(ownDelete.rowCount).toBe(1);
      expect(await readPost("community-a", "post-a")).toEqual([]);
      expect(await readPost("community-b", "post-b")).toEqual([{ body: "community B" }]);
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === foundationTestCount) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
