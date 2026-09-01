import { afterAll, describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { ensurePostSlugAliasInTransaction } from "./public-post-slug-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_PUBLIC_POST_SLUG_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-public-post-slug-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-public-post-slug-suite-complete\n";
let completedTestCount = 0;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const connectionForSchema = (raw: string, schema: string): string =>
  `${raw}${raw.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_public_post_slug_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      return await use(connectionForSchema(connectionString, schema), admin);
    },
  });
}

async function seedPosts(admin: Client): Promise<void> {
  await admin.query("INSERT INTO users (user_id) VALUES ('slug-owner')");
  await admin.query(
    `INSERT INTO communities
      (community_id, display_name, status, created_by_user_id, created_at, updated_at)
     VALUES ('slug-community', 'Slug fixtures', 'active', 'slug-owner', now(), now())`,
  );
  await admin.query(
    `INSERT INTO posts
      (community_id, post_id, post_type, status, visibility, title, created_at, updated_at)
     VALUES
      ('slug-community', 'post-1', 'text', 'published', 'public', 'Same title', now(), now()),
      ('slug-community', 'post-2', 'text', 'published', 'public', 'Same title', now(), now()),
      ('slug-community', 'post-3', 'text', 'published', 'public', 'Race', now(), now())`,
  );
}

const allocate = (connection: string, postId: string, slug: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          ensurePostSlugAliasInTransaction(transaction, {
            postId,
            candidate: { kind: "descriptive", branch: "ascii", slug },
          }),
        );
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
    ),
  );

suite("Postgres 17 public post slug aliases", () => {
  test("allocates collisions and observes a same-post race", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await seedPosts(admin);

      await expect(allocate(connection, "post-1", "same-title")).resolves.toMatchObject({
        slug: "same-title",
        postId: "post-1",
      });
      await expect(allocate(connection, "post-2", "same-title")).resolves.toMatchObject({
        slug: "same-title-2",
        postId: "post-2",
      });

      const race = await Promise.all([
        allocate(connection, "post-3", "race"),
        allocate(connection, "post-3", "race"),
      ]);
      expect(race[0]).toEqual(race[1]);
      await expect(
        admin.query("SELECT slug FROM post_slug_aliases ORDER BY post_id"),
      ).resolves.toMatchObject({
        rows: [{ slug: "same-title" }, { slug: "same-title-2" }, { slug: "race" }],
      });
    });
    completedTestCount += 1;
  });

  test("rejects alias mutation, recycling, and physical post deletion", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await seedPosts(admin);
      await allocate(connection, "post-1", "immutable-title");

      await expect(
        admin.query("UPDATE post_slug_aliases SET slug='rewritten' WHERE post_id='post-1'"),
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(
        admin.query("DELETE FROM post_slug_aliases WHERE post_id='post-1'"),
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(admin.query("DELETE FROM posts WHERE post_id='post-1'")).rejects.toMatchObject({
        code: "23503",
      });
    });
    completedTestCount += 1;
  });

  test("enforces the UTF-16 logical maximum", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await seedPosts(admin);
      await expect(
        admin.query(
          "INSERT INTO post_slug_aliases (slug, post_id, slug_policy_version) VALUES ($1, 'post-1', 'post-slug-v1')",
          ["𐀀".repeat(41)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        admin.query(
          "INSERT INTO post_slug_aliases (slug, post_id, slug_policy_version) VALUES ($1, 'post-1', 'post-slug-v1') RETURNING slug",
          ["𐀀".repeat(40)],
        ),
      ).resolves.toMatchObject({ rows: [{ slug: "𐀀".repeat(40) }] });
    });
    completedTestCount += 1;
  });
});

afterAll(async () => {
  if (connectionString === undefined || completedTestCount !== 3) return;
  await Bun.write(sentinelPath, sentinelContents);
});
