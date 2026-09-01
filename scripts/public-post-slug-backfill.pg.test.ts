import { afterAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "./postgres-test-baseline.ts";
import {
  type PostSlugBackfillAuthorization,
  postSlugBackfillAuthorizationDigest,
} from "./public-post-slug-backfill-authorization.ts";
import { createPostSlugBackfillPgAdapter } from "./public-post-slug-backfill-pg.ts";
import { encodePostSlugBackfillCursor } from "./public-post-slug-backfill-planner.ts";
import {
  runAuthorizedPostSlugBackfillPage,
  runPostSlugBackfillDryRunPage,
} from "./public-post-slug-backfill-transaction.ts";
import { postSlugBackfillResultDigest } from "./public-post-slug-backfill-types.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_PUBLIC_POST_SLUG_BACKFILL_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-public-post-slug-backfill-suite-complete";
const sentinelContents =
  "api-next-control-plane-postgres-public-post-slug-backfill-suite-complete\n";
let completedTestCount = 0;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string =>
  `${raw}${raw.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "scripts_public_post_slug_backfill_pg_test_ts",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await applyPostgresTestBaselineConnection({
        connectionString: connectionForSchema(connectionString, schema),
      });
      return use(connectionForSchema(connectionString, schema), admin);
    },
  });
}

async function seed(admin: Client, includeRemoved = false): Promise<void> {
  await admin.query("INSERT INTO users (user_id) VALUES ('slug-backfill-owner')");
  await admin.query(
    `INSERT INTO communities
      (community_id, display_name, status, created_by_user_id, created_at, updated_at)
     VALUES ('slug-backfill-community', 'Backfill fixtures', 'active',
       'slug-backfill-owner', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
  );
  await admin.query(
    `INSERT INTO posts
      (community_id, post_id, post_type, status, visibility, title, body,
       created_at, updated_at, author_declared_rating, content_rating)
     VALUES
      ('slug-backfill-community', 'backfill-a', 'text', 'published', 'public',
       'Same title', NULL, '2026-09-01T00:00:01Z', '2026-09-01T00:00:01Z', 'general', 'general'),
      ('slug-backfill-community', 'backfill-b', 'text', 'published', 'public',
       'Same title', NULL, '2026-09-01T00:00:02Z', '2026-09-01T00:00:02Z', 'general', 'general'),
      ('slug-backfill-community', 'backfill-member', 'text', 'published', 'members_only',
       'Guarded member title', NULL, '2026-09-01T00:00:03Z', '2026-09-01T00:00:03Z', 'general', 'general'),
      ('slug-backfill-community', 'backfill-hidden', 'text', 'hidden', 'public',
       'Guarded hidden title', NULL, '2026-09-01T00:00:04Z', '2026-09-01T00:00:04Z', 'general', 'general'),
      ('slug-backfill-community', 'backfill-draft', 'text', 'draft', 'public',
       'Draft title', NULL, '2026-09-01T00:00:05Z', '2026-09-01T00:00:05Z', 'general', 'general')`,
  );
  if (includeRemoved) {
    await admin.query(
      `INSERT INTO posts
        (community_id, post_id, post_type, status, visibility, title, body,
         created_at, updated_at, author_declared_rating, content_rating)
       VALUES ('slug-backfill-community', 'backfill-removed', 'text', 'removed', 'public',
         'Removed title', NULL, '2026-09-01T00:00:06Z', '2026-09-01T00:00:06Z',
         'general', 'general')`,
    );
  }
}

const makeAuthorization = (input: {
  readonly upperBound: string;
  readonly pageDigests: readonly string[];
  readonly dryRunResultDigest: string;
  readonly pageSize?: number;
}): PostSlugBackfillAuthorization => {
  const unsigned = {
    record_version: 1 as const,
    run_id: "public-post-slug-pg-run",
    repository: "api-next" as const,
    database_environment: "test",
    policy_version: "post-slug-v1" as const,
    actor_role: "operator" as const,
    authorized_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-02T00:00:00.000Z",
    page_bounds: {
      page_size: input.pageSize ?? 3,
      start_cursor: null,
      upper_bound: input.upperBound,
      max_pages: input.pageDigests.length,
    },
    authorized_page_digests: input.pageDigests,
    dry_run_result_digest: input.dryRunResultDigest,
  };
  return { ...unsigned, canonical_digest: postSlugBackfillAuthorizationDigest(unsigned) };
};

suite("public Post slug backfill against PostgreSQL 17", () => {
  test("dry-runs bounded pages and applies them idempotently under recorded authorization", async () => {
    await withSchema(async (connection, admin) => {
      await seed(admin);
      const adapter = await createPostSlugBackfillPgAdapter(connection, "test");
      await adapter.client.connect();
      try {
        const firstDryRun = await runPostSlugBackfillDryRunPage({
          database: adapter.database,
          pageSize: 3,
        });
        const upperBound = encodePostSlugBackfillCursor(firstDryRun.plan.upper_bound);
        const firstCursor = firstDryRun.plan.next_cursor;
        if (firstCursor === null) throw new Error("expected a second dry-run page");
        const secondDryRun = await runPostSlugBackfillDryRunPage({
          database: adapter.database,
          cursor: encodePostSlugBackfillCursor(firstCursor),
          upperBound,
          pageSize: 3,
        });
        expect(firstDryRun.plan.report).toMatchObject({
          input_count: 3,
          descriptive_count: 2,
          opaque_count: 1,
          collision_classes: [{ candidate: "same-title", count: 2 }],
        });
        expect(secondDryRun.plan.report).toMatchObject({
          input_count: 2,
          opaque_count: 1,
          skipped_count: 1,
        });
        expect(
          JSON.stringify([firstDryRun.plan.decisions, secondDryRun.plan.decisions]),
        ).not.toMatch(/Guarded member title|Guarded hidden title|Draft title/u);
        expect(
          (await admin.query("SELECT count(*)::int AS count FROM post_slug_aliases")).rows[0]
            ?.count,
        ).toBe(0);

        const pageDigests = [
          firstDryRun.plan.report.page_digest,
          secondDryRun.plan.report.page_digest,
        ];
        const counts = {
          input: 5,
          descriptive: 2,
          opaque: 2,
          skipped: 1,
          blocked: 0,
        };
        const dryRunResultDigest = postSlugBackfillResultDigest({
          run_id: "public-post-slug-pg-run",
          policy_version: "post-slug-v1",
          page_digests: pageDigests,
          counts,
        });
        const authorization = makeAuthorization({
          upperBound,
          pageDigests,
          dryRunResultDigest,
        });
        const now = new Date("2026-09-01T12:00:00.000Z");
        const firstApply = await runAuthorizedPostSlugBackfillPage({
          database: adapter.database,
          allocator: adapter.allocator,
          runId: authorization.run_id,
          authorizationRegistry: { getRecordedAuthorization: async () => authorization },
          now,
        });
        const replay = await runAuthorizedPostSlugBackfillPage({
          database: adapter.database,
          allocator: adapter.allocator,
          runId: authorization.run_id,
          authorizationRegistry: { getRecordedAuthorization: async () => authorization },
          now,
        });
        expect(replay.checkpoint).toEqual(firstApply.checkpoint);

        await admin.query(
          `INSERT INTO posts
            (community_id, post_id, post_type, status, visibility, title,
             created_at, updated_at, author_declared_rating, content_rating)
           VALUES ('slug-backfill-community', 'backfill-after-bound', 'text', 'published', 'public',
             'After bound', '2026-09-01T00:00:07Z', '2026-09-01T00:00:07Z',
             'general', 'general')`,
        );
        const secondApply = await runAuthorizedPostSlugBackfillPage({
          database: adapter.database,
          allocator: adapter.allocator,
          runId: authorization.run_id,
          authorizationRegistry: { getRecordedAuthorization: async () => authorization },
          checkpoint: firstApply.checkpoint,
          now,
        });
        expect(secondApply.checkpoint).toMatchObject({
          page_index: 2,
          cursor: upperBound,
          counts,
          completed_at: now.toISOString(),
          result_digest: dryRunResultDigest,
        });
        const aliases = await admin.query<{ readonly post_id: string; readonly slug: string }>(
          "SELECT post_id, slug FROM post_slug_aliases ORDER BY post_id",
        );
        expect(aliases.rows).toHaveLength(4);
        expect(aliases.rows.filter(({ slug }) => slug.startsWith("same-title"))).toEqual([
          { post_id: "backfill-a", slug: "same-title" },
          { post_id: "backfill-b", slug: "same-title-2" },
        ]);
        expect(aliases.rows.find(({ post_id }) => post_id === "backfill-member")?.slug).toMatch(
          /^post-[0-9abcdefghjkmnpqrstvwxyz]{10}$/u,
        );
        expect(aliases.rows.find(({ post_id }) => post_id === "backfill-hidden")?.slug).toMatch(
          /^post-[0-9abcdefghjkmnpqrstvwxyz]{10}$/u,
        );
        expect(aliases.rows.some(({ post_id }) => post_id === "backfill-draft")).toBe(false);
        expect(aliases.rows.some(({ post_id }) => post_id === "backfill-after-bound")).toBe(false);
      } finally {
        await adapter.client.end();
      }
    });
    completedTestCount += 1;
  }, 30_000);

  test("blocks historical removed rows before allocation", async () => {
    await withSchema(async (connection, admin) => {
      await seed(admin, true);
      const adapter = await createPostSlugBackfillPgAdapter(connection, "test");
      await adapter.client.connect();
      try {
        const dryRun = await runPostSlugBackfillDryRunPage({
          database: adapter.database,
          pageSize: 10,
        });
        expect(dryRun.plan.report).toMatchObject({
          blocked_count: 1,
          issue_counts: { "removed-not-normalized": 1 },
        });
        const upperBound = encodePostSlugBackfillCursor(dryRun.plan.upper_bound);
        const authorization = makeAuthorization({
          upperBound,
          pageDigests: [dryRun.plan.report.page_digest],
          dryRunResultDigest: "a".repeat(64),
          pageSize: 10,
        });
        await expect(
          runAuthorizedPostSlugBackfillPage({
            database: adapter.database,
            allocator: adapter.allocator,
            runId: authorization.run_id,
            authorizationRegistry: { getRecordedAuthorization: async () => authorization },
            now: new Date("2026-09-01T12:00:00.000Z"),
          }),
        ).rejects.toThrow("page-blocked");
        expect(
          (await admin.query("SELECT count(*)::int AS count FROM post_slug_aliases")).rows[0]
            ?.count,
        ).toBe(0);
      } finally {
        await adapter.client.end();
      }
    });
    completedTestCount += 1;
  }, 30_000);
});

afterAll(async () => {
  if (connectionString === undefined || completedTestCount !== 2) return;
  await Bun.write(sentinelPath, sentinelContents);
});
