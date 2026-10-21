import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { readCommentThread } from "./comment-thread-repository.ts";
import { withInbox } from "./notifications.pg-fixture.ts";
import {
  community,
  prepareMatrixVideo,
  startMatrixActors,
} from "./notifications-video-matrix.pg-fixture.ts";
import { readyNotificationVideoForReaders } from "./notifications-video-publication-test-fixture.ts";
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
  for (const postType of ["text", "song"] as const)
    test(`${postType}: reads persisted roots and replies, redacts adult content, and rejects foreign or hidden ancestry`, async () => {
      await withSchema(async (connection, admin) => {
        await apply(connection);
        await admin.query("INSERT INTO users (user_id) VALUES ('usr_reader'), ('usr_author')");
        await activatePendingPersonaFixtures(admin);
        await admin.query(`INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at)
        VALUES ('community-a','Community A','usr_author',now(),now()), ('community-b','Community B','usr_author',now(),now())`);
        await admin.query(
          `INSERT INTO posts (community_id, post_id, author_user_id, author_persona_id, post_type, status, visibility, body, created_at, updated_at)
        SELECT community_id, 'post-' || community_id, 'usr_author',
          (SELECT persona_id FROM personas WHERE account_id='usr_author' AND is_first_persona),
          $1,'published','public','Body',now(),now() FROM communities`,
          [postType],
        );
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

suite("Postgres video root ordering", () => {
  test("pages newest video roots and oldest replies with matching target windows and privacy", async () => {
    await withInbox(async (f) => {
      await startMatrixActors(f);
      const video = await prepareMatrixVideo(f, "comment-ordering");
      await video.publish();
      await readyNotificationVideoForReaders(f, video.postId);
      await f.admin.query(
        await Bun.file(
          new URL(
            "../../../db/postgres/migrations/0275_video_root_comment_ordering.sql",
            import.meta.url,
          ),
        ).text(),
      );
      const persona = (
        await f.admin.query<{ persona_id: string }>(
          "SELECT p.persona_id FROM personas p JOIN persona_community_bindings b USING(persona_id) WHERE p.account_id='inbox-author' AND b.community_id=$1 AND p.status='active'",
          [community],
        )
      ).rows[0]?.persona_id;
      if (!persona) throw new Error("Active video-community author required");
      // Reader fixtures include timestamp ties; publication is proved by its separate suite.
      const seed = async (prefix: string, parent: string | null) => {
        await f.admin.query(
          `INSERT INTO comments(community_id,comment_id,post_id,parent_comment_id,author_user_id,author_persona_id,status,body,depth,created_at,updated_at)
          SELECT $1,$2||lpad(i::text,3,'0'),$3,$4,'inbox-author',$5,'published','Ordering fixture',CASE WHEN $4::text IS NULL THEN 0 ELSE 1 END,
            '2026-10-19T00:00:00.123456Z'::timestamptz+(i/3)*interval '1 second',now() FROM generate_series(0,44) i`,
          [community, prefix, video.postId, parent, persona],
        );
      };
      await seed("video-root-", null);
      const targetRoot = "video-root-020";
      await seed("video-reply-", targetRoot);
      const rootIds = Array.from(
        { length: 45 },
        (_, i) => `video-root-${String(44 - i).padStart(3, "0")}`,
      );
      const replyIds = Array.from(
        { length: 45 },
        (_, i) => `video-reply-${String(i).padStart(3, "0")}`,
      );
      const read = (
        input: { cursor?: string; parentCommentId?: string; viewerUserId?: string } = {},
      ) =>
        f.run(
          readCommentThread({
            postId: video.postId,
            ...input,
            viewerUserId: input.viewerUserId ?? "inbox-owner",
          }).pipe(Effect.provide(f.runtime)),
        );
      const ids = (page: Awaited<ReturnType<typeof read>>) =>
        page.items.flatMap((item) => ("comment_id" in item ? [item.comment_id] : []));
      for (const [parent, expected] of [
        [undefined, rootIds],
        [targetRoot, replyIds],
      ] as const) {
        let cursor: string | undefined;
        const collected: string[] = [];
        const sizes: number[] = [];
        do {
          const page = await read({
            ...(parent ? { parentCommentId: parent } : {}),
            ...(cursor ? { cursor } : {}),
          });
          collected.push(...ids(page));
          sizes.push(page.items.length);
          cursor = page.next_cursor ?? undefined;
          if (sizes.length > 3) throw new Error("Pagination did not terminate");
        } while (cursor);
        expect(sizes).toEqual([20, 20, 5]);
        expect(collected).toEqual(expected);
        expect(new Set(collected).size).toBe(45);
      }
      const originalCursor = rootIds[19];
      if (!originalCursor) throw new Error("Original cursor required");
      await f.admin.query(
        `INSERT INTO comments(community_id,comment_id,post_id,author_user_id,author_persona_id,status,body,depth,created_at,updated_at)
        VALUES($1,'video-new-root',$2,'inbox-author',$3,'published','New root',0,'2026-10-20T00:00:00Z',now())`,
        [community, video.postId, persona],
      );
      expect(ids(await read())).toEqual(["video-new-root", ...rootIds.slice(0, 19)]);
      expect(ids(await read({ cursor: originalCursor }))).toEqual(rootIds.slice(20, 40));
      const targetReply = "video-reply-023";
      const resolved = await f.run(
        f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: targetReply }),
      );
      if (resolved.kind !== "available") throw new Error("Available video target required");
      expect(resolved.post_id).toBe(video.postId);
      expect(resolved.ancestor_comment_ids).toEqual([targetRoot]);
      expect(resolved.windows).toHaveLength(2);
      const [rootWindow, replyWindow] = resolved.windows;
      if (!rootWindow || !replyWindow) throw new Error("Both windows required");
      expect(rootWindow).toMatchObject({
        parent_comment_id: null,
        branch_comment_id: targetRoot,
        earlier_items_omitted: true,
        next_cursor: "video-root-001",
      });
      expect(ids(rootWindow)).toEqual(rootIds.slice(24, 44));
      expect(replyWindow).toMatchObject({
        parent_comment_id: targetRoot,
        branch_comment_id: targetReply,
        earlier_items_omitted: true,
        next_cursor: "video-reply-042",
      });
      expect(ids(replyWindow)).toEqual(replyIds.slice(23, 43));
      await f.admin.query("UPDATE comments SET status='hidden' WHERE comment_id='video-root-001'");
      expect(ids(await read({ cursor: "video-root-001" }))).toEqual(["video-root-000"]);
      expect(ids(await read({ parentCommentId: targetRoot, cursor: "video-reply-042" }))).toEqual([
        "video-reply-043",
        "video-reply-044",
      ]);
      await f.seedComment("other-post-root", null, 0);
      await expect(read({ cursor: "other-post-root" })).rejects.toThrow("Invalid comment cursor");
      await expect(read({ parentCommentId: targetRoot, cursor: originalCursor })).rejects.toThrow(
        "Invalid comment cursor",
      );
      await expect(read({ viewerUserId: "missing-account" })).rejects.toThrow("Post not found");
      await f.admin.query("UPDATE posts SET visibility='members_only' WHERE post_id=$1", [
        video.postId,
      ]);
      await f.admin.query(
        "UPDATE community_memberships SET status='left' WHERE community_id=$1 AND user_id='inbox-other'",
        [community],
      );
      await expect(read({ viewerUserId: "inbox-other" })).rejects.toThrow("Post not found");
      await expect(
        f.run(f.navigation.resolve({ viewerUserId: "inbox-other", commentId: targetReply })),
      ).rejects.toThrow("Comment not found");
      expect(ids(await read())).toContain("video-new-root");
      await f.admin.query("UPDATE comments SET content_rating='adult_18' WHERE comment_id=$1", [
        targetRoot,
      ]);
      await expect(
        f.run(f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: targetReply })),
      ).rejects.toThrow("Comment not found");
      await expect(read({ parentCommentId: targetRoot })).rejects.toThrow("Comment not found");
      await f.admin.query("UPDATE posts SET status='removed' WHERE post_id=$1", [video.postId]);
      await expect(read()).rejects.toThrow("Post not found");
      await expect(
        f.run(f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: targetReply })),
      ).rejects.toThrow("Comment not found");
    });
  }, 120000);
});
