import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { readCommentThread } from "./comment-thread-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("Postgres test URL required");
const suite = connectionString ? describe : describe.skip;
const schemaIdentifier = (): string =>
  `api_next_comment_thread_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function apply(connection: string): Promise<void> {
  await applyPostgresTestBaselineConnection({ connectionString: connection });
}

suite("Postgres comment threads", () => {
  test("reads persisted roots and replies, redacts adult content, and rejects foreign or hidden ancestry", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await admin.query("INSERT INTO users (user_id) VALUES ('usr_reader'), ('usr_author')");
      await activatePendingPersonaFixtures(admin);
      await admin.query(`INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at)
        VALUES ('community-a','Community A','usr_author',now(),now()), ('community-b','Community B','usr_author',now(),now())`);
      await admin.query(`INSERT INTO posts (community_id, post_id, author_user_id, author_persona_id, post_type, status, visibility, body, created_at, updated_at)
        SELECT community_id, 'post-' || community_id, 'usr_author',
          (SELECT persona_id FROM personas WHERE account_id='usr_author' AND is_first_persona),
          'text','published','public','Body',now(),now() FROM communities`);
      const insert = async (
        id: string,
        parent: string | null,
        overrides: { community?: string; status?: string; rating?: string; depth?: number } = {},
      ) => {
        const community = overrides.community ?? "community-a";
        await admin.query(
          `INSERT INTO comments (community_id, comment_id, post_id, parent_comment_id,
          author_user_id, author_persona_id, status, body, depth, content_rating, created_at, updated_at)
          VALUES ($1,$2,$3,$4,'usr_author',(SELECT persona_id FROM personas WHERE account_id='usr_author' AND is_first_persona),
            $5,$2,$6,$7,'2026-09-09T00:00:00Z',now())`,
          [
            community,
            id,
            `post-${community}`,
            parent,
            overrides.status ?? "published",
            overrides.depth ?? (parent ? 1 : 0),
            overrides.rating ?? "general",
          ],
        );
      };
      for (let i = 0; i < 22; i++) await insert(`root-${String(i).padStart(2, "0")}`, null);
      await insert("reply", "root-00");
      await insert("grandchild", "reply", { depth: 2 });
      await insert("removed-root", null, { status: "removed" });
      await insert("orphan-visible", "removed-root");
      await insert("foreign", null, { community: "community-b" });
      await admin.query(
        "UPDATE comments SET content_rating='adult_18', body='Secret body' WHERE comment_id='root-01'",
      );
      const read = (extra: { parentCommentId?: string; cursor?: string } = {}) =>
        Effect.runPromise(
          Effect.scoped(
            readCommentThread({
              postId: "post-community-a",
              viewerUserId: "usr_reader",
              ...extra,
            }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
          ),
        );
      const first = await read();
      expect(first.items).toHaveLength(20);
      expect(first.items[0]).toMatchObject({
        comment_id: "root-00",
        reply_count: 1,
        author_persona: { object: "persona" },
      });
      expect(first.items[1]).toEqual({
        kind: "age_locked",
        content_rating: "adult_18",
        next_action: { kind: "verify_minimum_age", minimum_age: 18 },
      });
      expect(JSON.stringify(first)).not.toContain("Secret body");
      expect(first.next_cursor).toBe("root-19");
      if (first.next_cursor === null) throw new Error("Expected continuation cursor");
      const second = await read({ cursor: first.next_cursor });
      expect(
        second.items.map((item) => ("comment_id" in item ? item.comment_id : "locked")),
      ).toEqual(["root-20", "root-21"]);
      expect(second.next_cursor).toBeNull();
      expect((await read({ parentCommentId: "root-00" })).items).toMatchObject([
        { comment_id: "reply", reply_count: 1 },
      ]);
      expect((await read({ parentCommentId: "reply" })).items).toMatchObject([
        { comment_id: "grandchild", depth: 2 },
      ]);
      for (const parentCommentId of [
        "foreign",
        "removed-root",
        "orphan-visible",
        "root-01",
        "missing",
      ]) {
        await expect(read({ parentCommentId })).rejects.toThrow("Comment not found");
      }
      await expect(read({ cursor: "foreign" })).rejects.toThrow("Invalid comment cursor");
      await expect(read({ parentCommentId: "root-00", cursor: "root-19" })).rejects.toThrow(
        "Invalid comment cursor",
      );
      await admin.query(
        "UPDATE posts SET visibility='members_only' WHERE post_id='post-community-a'",
      );
      await expect(read()).rejects.toThrow("Post not found");
      await admin.query(
        "INSERT INTO community_follows (community_follow_id,community_id,user_id,created_at,updated_at) VALUES ('follow-reader','community-a','usr_reader',now(),now())",
      );
      await admin.query(
        "INSERT INTO community_memberships (community_id,membership_id,user_id,status,created_at,updated_at) VALUES ('community-a','membership-reader','usr_reader','member',now(),now())",
      );
      expect((await read()).items).toHaveLength(20);
      await admin.query("UPDATE posts SET status='removed' WHERE post_id='post-community-a'");
      await expect(read()).rejects.toThrow("Post not found");
    });
  }, 60000);
});
