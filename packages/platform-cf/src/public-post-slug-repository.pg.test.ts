import { afterAll, describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  ensurePostSlugAliasInTransaction,
  listPublicPostSitemapInTransaction,
  lookupPublicPostBySlugInTransaction,
  lookupPublicPostCanonicalRouteByPostIdInTransaction,
} from "./public-post-slug-repository.ts";

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

const lookupBySlug = (connection: string, slug: string, viewerUserId?: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          lookupPublicPostBySlugInTransaction(transaction, {
            slug,
            ...(viewerUserId === undefined ? {} : { viewerUserId }),
          }),
        );
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
    ),
  );

const lookupByPostId = (connection: string, postId: string, viewerUserId?: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          lookupPublicPostCanonicalRouteByPostIdInTransaction(transaction, {
            postId,
            ...(viewerUserId === undefined ? {} : { viewerUserId }),
          }),
        );
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
    ),
  );

const listSitemap = (connection: string, input: { cursor?: string; limit: number }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          listPublicPostSitemapInTransaction(transaction, input),
        );
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
    ),
  );

async function seedLiveStateFixtures(admin: Client): Promise<void> {
  await admin.query("INSERT INTO users (user_id) VALUES ('slug-owner'), ('slug-member')");
  await admin.query(
    `INSERT INTO communities
      (community_id, display_name, status, created_by_user_id, created_at, updated_at)
     VALUES
      ('slug-live-community', 'Slug live fixtures', 'active', 'slug-owner', now(), now()),
      ('slug-hidden-community', 'Slug hidden fixtures', 'hidden', 'slug-owner', now(), now())`,
  );
  await admin.query(
    `INSERT INTO community_memberships
      (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
     VALUES
      ('slug-live-community', 'slug-member-membership', 'slug-member', 'member', now(), now(), now())`,
  );
  await admin.query(
    `INSERT INTO posts
      (community_id, post_id, post_type, status, visibility, title, created_at, updated_at,
       author_declared_rating, content_rating)
     VALUES
      ('slug-live-community', 'slug-public', 'text', 'published', 'public', 'Public',
       '2026-09-01T00:00:01Z', '2026-09-01T00:00:01Z', 'general', 'general'),
      ('slug-live-community', 'slug-members', 'text', 'published', 'members_only', 'Members',
       '2026-09-01T00:00:02Z', '2026-09-01T00:00:02Z', 'general', 'general'),
      ('slug-live-community', 'slug-adult', 'text', 'published', 'public', 'Adult',
       '2026-09-01T00:00:03Z', '2026-09-01T00:00:03Z', 'general', 'adult_18'),
      ('slug-live-community', 'slug-hidden', 'text', 'hidden', 'public', 'Hidden',
       '2026-09-01T00:00:04Z', '2026-09-01T00:00:04Z', 'general', 'general'),
      ('slug-live-community', 'slug-draft', 'text', 'draft', 'public', 'Draft',
       '2026-09-01T00:00:05Z', '2026-09-01T00:00:05Z', 'general', 'general'),
      ('slug-hidden-community', 'slug-inactive', 'text', 'published', 'public', 'Inactive',
       '2026-09-01T00:00:06Z', '2026-09-01T00:00:06Z', 'general', 'general'),
      ('slug-live-community', 'slug-transition', 'text', 'published', 'public', 'Transition',
       '2026-09-01T00:00:07Z', '2026-09-01T00:00:07Z', 'general', 'general'),
      ('slug-live-community', 'slug-stable', 'text', 'published', 'public', 'Stable',
       '2026-09-01T00:00:09Z', '2026-09-01T00:00:09Z', 'general', 'general'),
      ('slug-live-community', 'slug-no-alias', 'text', 'published', 'public', 'No alias',
       '2026-09-01T00:00:08Z', '2026-09-01T00:00:08Z', 'general', 'general')`,
  );
  await admin.query(
    `INSERT INTO post_slug_aliases (slug, post_id, slug_policy_version, created_at)
     VALUES
      ('café-post', 'slug-public', 'post-slug-v1', '2026-09-01T00:00:01Z'),
      ('members-post', 'slug-members', 'post-slug-v1', '2026-09-01T00:00:02Z'),
      ('adult-post', 'slug-adult', 'post-slug-v1', '2026-09-01T00:00:03Z'),
      ('hidden-post', 'slug-hidden', 'post-slug-v1', '2026-09-01T00:00:04Z'),
      ('draft-post', 'slug-draft', 'post-slug-v1', '2026-09-01T00:00:05Z'),
      ('inactive-post', 'slug-inactive', 'post-slug-v1', '2026-09-01T00:00:06Z'),
      ('transition-post', 'slug-transition', 'post-slug-v1', '2026-09-01T00:00:07Z'),
      ('stable-post', 'slug-stable', 'post-slug-v1', '2026-09-01T00:00:09Z')`,
  );
}

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

  test("reads live guards by slug and id and enumerates a stable sitemap without allocation", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await seedLiveStateFixtures(admin);

      const publicBySlug = await lookupBySlug(connection, "café-post");
      expect(publicBySlug).toMatchObject({
        alias: { slug: "café-post", postId: "slug-public" },
        post: {
          postId: "slug-public",
          status: "published",
          visibility: "public",
          contentRating: "general",
        },
        community: { status: "active" },
        viewer: { userId: undefined, isMember: false, ratingViewAllowed: true, canRead: true },
        canonicalPath: "/posts/caf%C3%A9-post",
      });

      const publicById = await lookupByPostId(connection, "slug-public");
      expect(publicById).toMatchObject({
        alias: { slug: "café-post", postId: "slug-public" },
        canonicalPath: "/posts/caf%C3%A9-post",
      });

      const guarded = await Promise.all([
        lookupBySlug(connection, "members-post"),
        lookupBySlug(connection, "adult-post"),
        lookupBySlug(connection, "hidden-post"),
        lookupBySlug(connection, "draft-post"),
        lookupBySlug(connection, "inactive-post"),
      ]);
      expect(guarded[0]).toMatchObject({
        post: { postId: "slug-members", visibility: "members_only" },
        viewer: { isMember: false, canRead: false },
        canonicalPath: null,
      });
      expect(guarded[1]).toMatchObject({
        post: { postId: "slug-adult", contentRating: "adult_18" },
        viewer: { ratingViewAllowed: false, canRead: false },
        canonicalPath: null,
      });
      expect(guarded[2]).toMatchObject({
        post: { postId: "slug-hidden", status: "hidden" },
        viewer: { canRead: false },
        canonicalPath: null,
      });
      expect(guarded[3]).toMatchObject({
        post: { postId: "slug-draft", status: "draft" },
        viewer: { canRead: false },
        canonicalPath: null,
      });
      expect(guarded[4]).toMatchObject({
        post: { postId: "slug-inactive" },
        community: { status: "hidden" },
        viewer: { canRead: false },
        canonicalPath: null,
      });
      await expect(lookupBySlug(connection, "members-post", "slug-member")).resolves.toMatchObject({
        viewer: { userId: "slug-member", isMember: true, canRead: true },
        canonicalPath: null,
      });
      await expect(
        lookupByPostId(connection, "slug-members", "slug-member"),
      ).resolves.toMatchObject({
        alias: { slug: "members-post" },
        viewer: { isMember: true, canRead: true },
        canonicalPath: null,
      });

      await expect(lookupBySlug(connection, "does-not-exist")).resolves.toBeNull();
      const aliasesBeforeReads = await admin.query(
        "SELECT slug, post_id FROM post_slug_aliases ORDER BY post_id",
      );
      const firstPage = await listSitemap(connection, { limit: 2 });
      expect(firstPage).toMatchObject({
        items: [
          { canonical_path: "/posts/caf%C3%A9-post" },
          { canonical_path: "/posts/transition-post" },
        ],
      });
      expect(firstPage.items).not.toContainEqual({ canonical_path: "/posts/members-post" });
      expect(firstPage.items).not.toContainEqual({ canonical_path: "/posts/adult-post" });
      expect(firstPage.items).not.toContainEqual({ canonical_path: "/posts/hidden-post" });
      expect(firstPage.items).not.toContainEqual({ canonical_path: "/posts/draft-post" });
      expect(firstPage.items).not.toContainEqual({ canonical_path: "/posts/inactive-post" });
      expect(firstPage.next_cursor).toStartWith("pps1.");
      const secondPage = await listSitemap(connection, {
        ...(firstPage.next_cursor === null ? {} : { cursor: firstPage.next_cursor }),
        limit: 2,
      });
      expect(secondPage).toEqual({
        object: "public_post_sitemap_page",
        items: [{ canonical_path: "/posts/stable-post" }],
        next_cursor: null,
      });
      const aliasesAfterReads = await admin.query(
        "SELECT slug, post_id FROM post_slug_aliases ORDER BY post_id",
      );
      expect(aliasesAfterReads.rows).toEqual(aliasesBeforeReads.rows);

      const transitionBefore = await lookupBySlug(connection, "transition-post");
      expect(transitionBefore?.alias).toMatchObject({
        slug: "transition-post",
        postId: "slug-transition",
      });
      await admin.query(
        "UPDATE posts SET status = 'hidden', updated_at = clock_timestamp() WHERE post_id = 'slug-transition'",
      );
      await expect(lookupBySlug(connection, "transition-post")).resolves.toMatchObject({
        post: { status: "hidden" },
        alias: { slug: "transition-post", postId: "slug-transition" },
        canonicalPath: null,
      });
      await admin.query(
        "UPDATE posts SET status = 'published', visibility = 'members_only', updated_at = clock_timestamp() WHERE post_id = 'slug-transition'",
      );
      await expect(
        lookupByPostId(connection, "slug-transition", "slug-member"),
      ).resolves.toMatchObject({
        post: { status: "published", visibility: "members_only" },
        alias: { slug: "transition-post" },
        viewer: { isMember: true, canRead: true },
        canonicalPath: null,
      });
      await admin.query(
        "UPDATE posts SET visibility = 'public', updated_at = clock_timestamp() WHERE post_id = 'slug-transition'",
      );
      await expect(lookupBySlug(connection, "transition-post")).resolves.toMatchObject({
        post: { status: "published", visibility: "public", contentRating: "general" },
        alias: { slug: "transition-post", postId: "slug-transition" },
        canonicalPath: "/posts/transition-post",
      });
      await admin.query(
        "UPDATE posts SET content_rating = 'adult_18', updated_at = clock_timestamp() WHERE post_id = 'slug-transition'",
      );
      await expect(lookupBySlug(connection, "transition-post")).resolves.toMatchObject({
        post: { visibility: "public", contentRating: "adult_18" },
        alias: { slug: "transition-post" },
        canonicalPath: null,
      });
      const aliasesAfterTransitions = await admin.query(
        "SELECT slug, post_id FROM post_slug_aliases ORDER BY post_id",
      );
      expect(aliasesAfterTransitions.rows).toEqual(aliasesBeforeReads.rows);
    });
    completedTestCount += 1;
  });
});

afterAll(async () => {
  if (connectionString === undefined || completedTestCount !== 4) return;
  await Bun.write(sentinelPath, sentinelContents);
});
