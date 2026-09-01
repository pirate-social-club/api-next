import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneFeedStore } from "./feed-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_FEED_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-feed-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-feed-suite-complete\n";
let completedTestCount = 0;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_feed_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      return await use(connectionForSchema(connectionString, schema), admin);
    },
  });
}

async function apply(connection: string): Promise<void> {
  await applyPostgresTestBaselineConnection({ connectionString: connection });
}

async function seedCommunity(admin: Client): Promise<void> {
  await admin.query("INSERT INTO users (user_id) VALUES ('usr_member'), ('usr_other')");
  await activatePendingPersonaFixtures(admin);
  await admin.query(
    `INSERT INTO communities
      (community_id, display_name, status, created_by_user_id, created_at, updated_at)
     VALUES
      ('com_alpha', 'Alpha', 'active', 'usr_member', now(), now()),
      ('com_hidden', 'Hidden', 'hidden', 'usr_member', now(), now())`,
  );
  await admin.query(
    `INSERT INTO community_memberships
      (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
     VALUES ('com_alpha', 'mem_alpha', 'usr_member', 'member', now(), now(), now())`,
  );
  await admin.query(
    `INSERT INTO community_follows
      (community_follow_id, community_id, user_id, status, created_at, updated_at)
     VALUES ('follow_alpha', 'com_alpha', 'usr_member', 'active', now(), now())`,
  );
}

async function insertProjectedPost(
  admin: Client,
  input: {
    readonly id: string;
    readonly community?: "com_alpha" | "com_hidden";
    readonly status?: "published" | "processing";
    readonly visibility?: "public" | "members_only";
    readonly rank?: number;
    readonly created?: Date;
  },
): Promise<void> {
  const community = input.community ?? "com_alpha";
  const status = input.status ?? "published";
  const visibility = input.visibility ?? "public";
  const created = input.created ?? new Date("2026-08-17T10:00:00.000Z");
  await admin.query(
    `INSERT INTO posts
      (community_id, post_id, author_user_id, author_persona_id,
       post_type, status, visibility, body, created_at, updated_at)
     VALUES (
       $1, $2, 'usr_member',
       (SELECT persona_id FROM personas WHERE account_id='usr_member' AND is_first_persona),
       'text', $3, $4, $2, $5, $5
     )`,
    [community, input.id, status, visibility, created],
  );
  await admin.query(
    `INSERT INTO home_feed_projection
      (community_id, feed_item_id, post_id, rank_score, projected_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [community, `feed_${input.id}`, input.id, input.rank ?? 1, created],
  );
}

suite("Postgres 17 home feed repository", () => {
  test("public feed exposes only active-community published public projections", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seedCommunity(admin);
      await insertProjectedPost(admin, { id: "post_public", rank: 10 });
      await insertProjectedPost(admin, {
        id: "post_members",
        visibility: "members_only",
        rank: 9,
      });
      await insertProjectedPost(admin, { id: "post_processing", status: "processing", rank: 8 });
      await insertProjectedPost(admin, {
        id: "post_hidden_community",
        community: "com_hidden",
        rank: 7,
      });
      const store = makeControlPlaneFeedStore(makeDirectPostgresControlPlaneLayer(connection), {
        now: () => Date.parse("2026-08-17T12:00:00.000Z"),
      });

      const result = await Effect.runPromise(Effect.scoped(store.listHome({ query: {} })));
      expect(result.items.map((item) => ("kind" in item ? item.kind : item.post.post.id))).toEqual([
        "post_public",
      ]);
      expect(result.items[0]).toMatchObject({ post: { post: { created: 1_786_960_800 } } });
      expect(result.top_communities).toEqual([
        {
          id: "com_alpha",
          object: "home_feed_community_summary",
          display_name: "Alpha",
          member_count: 1,
          follower_count: 1,
        },
      ]);
    });
    completedTestCount += 1;
  });

  test("authenticated membership reveals members-only posts and viewer votes", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seedCommunity(admin);
      await insertProjectedPost(admin, { id: "post_members", visibility: "members_only" });
      await admin.query(
        `INSERT INTO post_votes
          (community_id, post_vote_id, post_id, user_id, vote_value, created_at, updated_at)
         VALUES ('com_alpha', 'vote_member', 'post_members', 'usr_member', 1, now(), now())`,
      );
      const store = makeControlPlaneFeedStore(makeDirectPostgresControlPlaneLayer(connection));

      const member = await Effect.runPromise(
        Effect.scoped(store.listHome({ query: {}, viewerUserId: "usr_member" })),
      );
      const other = await Effect.runPromise(
        Effect.scoped(store.listHome({ query: {}, viewerUserId: "usr_other" })),
      );
      expect(member.items.map((item) => ("kind" in item ? item.kind : item.post.post.id))).toEqual([
        "post_members",
      ]);
      expect(member.items[0]).toMatchObject({
        post: { viewer_vote: 1, viewer_is_author: true },
      });
      expect(other.items).toEqual([]);
    });
    completedTestCount += 1;
  });

  test("keyset pagination returns every projected post once with a frozen time cutoff", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seedCommunity(admin);
      const base = Date.parse("2026-08-17T12:00:00.000Z");
      for (let index = 0; index < 22; index += 1) {
        await insertProjectedPost(admin, {
          id: `post_page_${index.toString().padStart(2, "0")}`,
          rank: 100 - index,
          created: new Date(base - index * 1_000),
        });
      }
      const store = makeControlPlaneFeedStore(makeDirectPostgresControlPlaneLayer(connection), {
        now: () => base,
      });

      const first = await Effect.runPromise(
        Effect.scoped(store.listHome({ query: { sort: "best", time_range: "hour" } })),
      );
      const second = await Effect.runPromise(
        Effect.scoped(
          store.listHome({
            query: {
              sort: "best",
              time_range: "hour",
              cursor: first.next_cursor ?? undefined,
            },
          }),
        ),
      );
      const ids = [...first.items, ...second.items].map((item) =>
        "kind" in item ? item.kind : item.post.post.id,
      );
      expect(first.items).toHaveLength(20);
      expect(second.items).toHaveLength(2);
      expect(new Set(ids).size).toBe(22);
      expect(second.next_cursor).toBeNull();
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 3) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
