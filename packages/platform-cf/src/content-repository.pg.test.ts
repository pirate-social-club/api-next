import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  ClearVoteBody,
  CreateCommentBody,
  CreatePostBody,
  M2Actor,
} from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { makeControlPlaneContentStore } from "./content-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import { applyPostgresMigrations, type PostgresMigration } from "./postgres-migrations";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_CONTENT_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-content-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-content-suite-complete\n";
let completedTestCount = 0;

const migrationFiles = [
  "0001_v1_product_slice.sql",
  "0002_identity.sql",
  "0003_m2_community_content.sql",
  "0004_post_comment_lock.sql",
  "0005_m2_behavior_invariants.sql",
] as const;
const migrations: readonly PostgresMigration[] = await Promise.all(
  migrationFiles.map(async (version) => {
    const sql = await Bun.file(
      new URL(`../../../db/postgres/migrations/${version}`, import.meta.url),
    ).text();
    return { version, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }),
);

function schemaIdentifier(): string {
  return `api_next_content_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  const option = encodeURIComponent(`-c search_path=${schema}`);
  return `${raw}${separator}options=${option}`;
}

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
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* applyPostgresMigrations(migrations);
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
    ),
  );
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E | undefined {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
}

const actor: M2Actor = { userId: "usr_alice", kind: "user" };
const postBody = (key: string, body = "hello"): CreatePostBody =>
  ({ post_type: "text", idempotency_key: key, body }) as CreatePostBody;
const commentBody = (key: string, body = "reply"): CreateCommentBody =>
  ({
    body,
    idempotency_key: key,
    authorship_mode: "human_direct",
    identity_mode: "public",
  }) as CreateCommentBody;

async function seed(admin: Client): Promise<void> {
  await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor.userId]);
  await admin.query("INSERT INTO users (user_id) VALUES ('usr_bob')");
  await admin.query(
    `INSERT INTO communities
      (community_id, display_name, created_by_user_id, created_at, updated_at)
     VALUES ('community_1', 'Community', $1, now(), now())`,
    [actor.userId],
  );
  await admin.query(
    `INSERT INTO community_memberships
      (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
     VALUES ('community_1', 'membership_alice', $1, 'member', now(), now(), now())`,
    [actor.userId],
  );
  await admin.query(
    `INSERT INTO posts
      (community_id, post_id, author_user_id, post_type, status, visibility, body, created_at, updated_at)
     VALUES ('community_1', 'post_parent', $1, 'text', 'published', 'public', 'parent', now(), now())`,
    [actor.userId],
  );
  await admin.query(
    `INSERT INTO comments
      (community_id, comment_id, post_id, parent_comment_id, author_user_id, status, body, created_at, updated_at)
     VALUES ('community_1', 'comment_parent', 'post_parent', NULL, $1, 'published', 'parent comment', now(), now())`,
    [actor.userId],
  );
}

async function storeFor(connection: string) {
  return makeControlPlaneContentStore(makeDirectPostgresControlPlaneLayer(connection));
}

suite("Postgres 17 content repository", () => {
  test("creates processing posts and replays/conflicts idempotency atomically", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      const first = await Effect.runPromise(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor,
            body: postBody("post-key"),
            idempotencyBodyHash: "a".repeat(64),
          }),
        ),
      );
      expect(first.status).toBe("processing");
      expect(first.id.startsWith("post_")).toBe(true);
      expect(first.analysis_state).toBe("pending");
      expect(first.content_safety_state).toBe("pending");
      expect(Number.isInteger(first.created)).toBe(true);
      const row = await admin.query<{ status: string }>(
        "SELECT status FROM posts WHERE post_id = $1",
        [first.id],
      );
      expect(row.rows[0]?.status).toBe("processing");

      const replay = await Effect.runPromise(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor,
            body: postBody("post-key"),
            idempotencyBodyHash: "a".repeat(64),
          }),
        ),
      );
      expect(replay.id).toBe(first.id);
      const concurrent = await Promise.all(
        ["concurrent-a", "concurrent-b"].map(() =>
          Effect.runPromise(
            Effect.scoped(
              store.createPost({
                communityId: "community_1",
                actor,
                body: postBody("concurrent-key"),
                idempotencyBodyHash: "c".repeat(64),
              }),
            ),
          ),
        ),
      );
      expect(concurrent[0]?.id).toBe(concurrent[1]?.id);
      const conflict = await Effect.runPromiseExit(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor,
            body: postBody("post-key", "different"),
            idempotencyBodyHash: "b".repeat(64),
          }),
        ),
      );
      expect(failureOf(conflict)).toMatchObject({
        _tag: "ContentRepositoryError",
        operation: "create-post",
        reason: "idempotency-conflict",
      });
      const count = await admin.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM posts WHERE community_id = 'community_1' AND idempotency_key = 'post-key'",
      );
      expect(count.rows[0]?.count).toBe("1");
    });
    completedTestCount += 1;
  });

  test("resolves global IDs and creates body-only replies with zero response counts", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      await expect(
        Effect.runPromise(Effect.scoped(store.resolvePost({ postId: "post_parent" }))),
      ).resolves.toEqual({ communityId: "community_1", postId: "post_parent" });
      await expect(
        Effect.runPromise(Effect.scoped(store.resolveComment({ commentId: "comment_parent" }))),
      ).resolves.toEqual({
        communityId: "community_1",
        postId: "post_parent",
        commentId: "comment_parent",
      });
      const reply = await Effect.runPromise(
        Effect.scoped(
          store.createCommentReply({
            communityId: "community_1",
            postId: "post_parent",
            parentCommentId: "comment_parent",
            actor,
            body: commentBody("comment-key"),
            idempotencyBodyHash: "c".repeat(64),
          }),
        ),
      );
      expect(reply.parent_comment).toBe("comment_parent");
      expect(reply.id.startsWith("cmt_")).toBe(true);
      expect(reply.depth).toBe(1);
      expect(reply.upvote_count).toBe(0);
      expect(reply.downvote_count).toBe(0);
      expect(reply.direct_reply_count).toBe(0);
      const replay = await Effect.runPromise(
        Effect.scoped(
          store.createCommentReply({
            communityId: "community_1",
            postId: "post_parent",
            parentCommentId: "comment_parent",
            actor,
            body: commentBody("comment-key"),
            idempotencyBodyHash: "c".repeat(64),
          }),
        ),
      );
      expect(replay.id).toBe(reply.id);
      const commentConflict = await Effect.runPromiseExit(
        Effect.scoped(
          store.createCommentReply({
            communityId: "community_1",
            postId: "post_parent",
            parentCommentId: "comment_parent",
            actor,
            body: commentBody("comment-key", "different"),
            idempotencyBodyHash: "e".repeat(64),
          }),
        ),
      );
      expect(failureOf(commentConflict)).toMatchObject({
        _tag: "ContentRepositoryError",
        operation: "create-comment-reply",
        reason: "idempotency-conflict",
      });
      const wrongScope = await Effect.runPromiseExit(
        Effect.scoped(
          store.createCommentReply({
            communityId: "other-community",
            postId: "post_parent",
            parentCommentId: "comment_parent",
            actor,
            body: commentBody("other-key"),
            idempotencyBodyHash: "d".repeat(64),
          }),
        ),
      );
      expect(failureOf(wrongScope)).toMatchObject({ reason: "not-found" });
      const rows = await admin.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM comments WHERE idempotency_key = 'other-key'",
      );
      expect(rows.rows[0]?.count).toBe("0");

      const nested = await Effect.runPromise(
        Effect.scoped(
          store.createCommentReply({
            communityId: "community_1",
            postId: "post_parent",
            parentCommentId: reply.id,
            actor,
            body: commentBody("nested-key"),
            idempotencyBodyHash: "f".repeat(64),
          }),
        ),
      );
      expect(nested.depth).toBe(2);

      const keyless = await Effect.runPromise(
        Effect.scoped(
          store.createCommentReply({
            communityId: "community_1",
            postId: "post_parent",
            parentCommentId: "comment_parent",
            actor,
            body: {
              body: "keyless reply",
              authorship_mode: "human_direct",
              identity_mode: "public",
            },
            idempotencyBodyHash: "a".repeat(64),
          }),
        ),
      );
      expect(keyless.idempotency_key).toBeNull();
      const keylessRow = await admin.query<{
        idempotency_key: string;
        idempotency_body_hash: string | null;
      }>("SELECT idempotency_key, idempotency_body_hash FROM comments WHERE comment_id = $1", [
        keyless.id,
      ]);
      expect(keylessRow.rows[0]?.idempotency_key).toBe("");
      expect(keylessRow.rows[0]?.idempotency_body_hash).toBeNull();
    });
    completedTestCount += 1;
  });

  test("replaces votes atomically, counts them, and clears them", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      await Effect.runPromise(
        Effect.scoped(
          store.castPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor,
            body: { value: 1 },
          }),
        ),
      );
      await Effect.runPromise(
        Effect.scoped(
          store.castPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor,
            body: { value: -1 },
          }),
        ),
      );
      const afterReplace = await Effect.runPromise(
        Effect.scoped(
          store.getPost({
            communityId: "community_1",
            postId: "post_parent",
            viewerUserId: actor.userId,
          }),
        ),
      );
      expect(afterReplace?.upvote_count).toBe(0);
      expect(afterReplace?.downvote_count).toBe(1);
      expect(afterReplace?.viewer_vote).toBe(-1);
      await Effect.runPromise(
        Effect.scoped(
          store.clearPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor,
            body: {} as ClearVoteBody,
          }),
        ),
      );
      const afterClear = await Effect.runPromise(
        Effect.scoped(
          store.getPost({
            communityId: "community_1",
            postId: "post_parent",
            viewerUserId: actor.userId,
          }),
        ),
      );
      expect(afterClear?.downvote_count).toBe(0);
      expect(afterClear?.viewer_vote).toBeNull();
      const rows = await admin.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM post_votes WHERE post_id = 'post_parent'",
      );
      expect(rows.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("requires active membership and rejects delegated actors", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      const nonmember: M2Actor = { userId: "usr_bob", kind: "user" };
      const create = await Effect.runPromiseExit(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor: nonmember,
            body: postBody("nonmember-key"),
            idempotencyBodyHash: "1".repeat(64),
          }),
        ),
      );
      expect(failureOf(create)).toMatchObject({
        _tag: "ContentRepositoryError",
        reason: "membership-required",
      });
      const vote = await Effect.runPromiseExit(
        Effect.scoped(
          store.castPostVote({
            communityId: "community_1",
            postId: "post_parent",
            actor: nonmember,
            body: { value: 1 },
          }),
        ),
      );
      expect(failureOf(vote)).toMatchObject({ reason: "membership-required" });
      const reply = await Effect.runPromiseExit(
        Effect.scoped(
          store.createCommentReply({
            communityId: "community_1",
            postId: "post_parent",
            parentCommentId: "comment_parent",
            actor: nonmember,
            body: commentBody("nonmember-comment"),
            idempotencyBodyHash: "2".repeat(64),
          }),
        ),
      );
      expect(failureOf(reply)).toMatchObject({ reason: "membership-required" });

      const delegated = await Effect.runPromiseExit(
        Effect.scoped(
          store.createPost({
            communityId: "community_1",
            actor: { userId: actor.userId, kind: "agent" },
            body: postBody("delegated-key"),
            idempotencyBodyHash: "3".repeat(64),
          }),
        ),
      );
      expect(failureOf(delegated)).toMatchObject({ reason: "constraint" });
    });
    completedTestCount += 1;
  });

  test("applies status and members-only visibility rules", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      await admin.query("UPDATE posts SET status = 'processing' WHERE post_id = 'post_parent'");
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.getPost({
              communityId: "community_1",
              postId: "post_parent",
              viewerUserId: actor.userId,
            }),
          ),
        ),
      ).resolves.toMatchObject({ post: { status: "processing" } });
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.getPost({
              communityId: "community_1",
              postId: "post_parent",
              viewerUserId: "usr_bob",
            }),
          ),
        ),
      ).resolves.toBeNull();

      await admin.query(
        "UPDATE posts SET status = 'published', visibility = 'members_only' WHERE post_id = 'post_parent'",
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.getPost({
              communityId: "community_1",
              postId: "post_parent",
              viewerUserId: actor.userId,
            }),
          ),
        ),
      ).resolves.toMatchObject({ post: { visibility: "members_only" } });
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.getPost({
              communityId: "community_1",
              postId: "post_parent",
              viewerUserId: "usr_bob",
            }),
          ),
        ),
      ).resolves.toBeNull();

      for (const status of ["hidden", "removed", "deleted"] as const) {
        await admin.query("UPDATE posts SET status = $1 WHERE post_id = 'post_parent'", [status]);
        await expect(
          Effect.runPromise(
            Effect.scoped(
              store.getPost({
                communityId: "community_1",
                postId: "post_parent",
                viewerUserId: actor.userId,
              }),
            ),
          ),
        ).resolves.toBeNull();
      }
    });
    completedTestCount += 1;
  });

  test("blocks replies on locked posts and preserves transactional state", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await seed(admin);
      const store = await storeFor(connection);
      await admin.query("UPDATE posts SET comments_locked = TRUE WHERE post_id = 'post_parent'");
      const result = await Effect.runPromiseExit(
        Effect.scoped(
          store.createCommentReply({
            communityId: "community_1",
            postId: "post_parent",
            parentCommentId: "comment_parent",
            actor,
            body: commentBody("locked-key"),
            idempotencyBodyHash: "4".repeat(64),
          }),
        ),
      );
      expect(failureOf(result)).toMatchObject({
        _tag: "ContentRepositoryError",
        reason: "comments-locked",
      });
      const rows = await admin.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM comments WHERE idempotency_key = 'locked-key'",
      );
      expect(rows.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 6) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
