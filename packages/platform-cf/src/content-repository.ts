import {
  type ClearVoteBody,
  type CommentDocument,
  type CommentLocation,
  ContentRepositoryError,
  type ContentRepositoryFailure,
  type ContentRepositoryOperation,
  type ContentStore,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type CreateCommentBody,
  type CreatePostBody,
  type LocalizedPostDocument,
  type M2Actor,
  type PostDocument,
  type PostLocation,
  type VoteBody,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

export interface ContentRepository {
  readonly resolvePost: (input: {
    readonly postId: string;
  }) => Effect.Effect<PostLocation | null, ContentRepositoryFailure, ControlPlaneDb>;
  readonly resolveComment: (input: {
    readonly commentId: string;
  }) => Effect.Effect<CommentLocation | null, ContentRepositoryFailure, ControlPlaneDb>;
  readonly createPost: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
    readonly body: CreatePostBody;
    readonly idempotencyBodyHash: string;
  }) => Effect.Effect<PostDocument, ContentRepositoryFailure, ControlPlaneDb>;
  readonly getPost: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly viewerUserId: string;
    readonly locale?: string;
  }) => Effect.Effect<LocalizedPostDocument | null, ContentRepositoryFailure, ControlPlaneDb>;
  readonly createCommentReply: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly parentCommentId: string;
    readonly actor: M2Actor;
    readonly body: CreateCommentBody;
    readonly idempotencyBodyHash?: string;
  }) => Effect.Effect<CommentDocument, ContentRepositoryFailure, ControlPlaneDb>;
  readonly castPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly body: VoteBody;
  }) => Effect.Effect<
    { readonly post: string; readonly value: -1 | 1 },
    ContentRepositoryFailure,
    ControlPlaneDb
  >;
  readonly clearPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly body: ClearVoteBody;
  }) => Effect.Effect<
    { readonly post: string; readonly value: null },
    ContentRepositoryFailure,
    ControlPlaneDb
  >;
}

type Row = Readonly<Record<string, unknown>>;

const invalid = (operation: ContentRepositoryOperation) =>
  new ContentRepositoryError({ operation, reason: "invalid-row" });

const constraint = (operation: ContentRepositoryOperation) =>
  new ContentRepositoryError({ operation, reason: "constraint" });

const idempotencyConflict = () =>
  new ContentRepositoryError({ operation: "create-post", reason: "idempotency-conflict" });

const validId = (value: string): boolean =>
  value.length > 0 && value.trim() === value && !value.includes("\u0000");

const directTextBody = (body: CreatePostBody): boolean =>
  body.post_type === "text" &&
  (body.authorship_mode === undefined || body.authorship_mode === "human_direct") &&
  (body.identity_mode === undefined || body.identity_mode === "public") &&
  body.agent_id == null &&
  body.agent_action_proof == null &&
  body.anonymous_scope == null &&
  (body.media_refs === undefined || body.media_refs.length === 0) &&
  body.caption == null &&
  body.link_url == null &&
  body.asset_id == null &&
  body.file_upload == null &&
  body.song_artifact_bundle == null &&
  body.song_mode == null &&
  body.source_post == null &&
  body.source_community == null &&
  body.crosspost_source == null &&
  body.lyrics == null &&
  typeof body.body === "string" &&
  body.body.trim().length > 0 &&
  body.idempotency_key.trim().length > 0;

const directCommentBody = (body: CreateCommentBody): boolean =>
  (body.authorship_mode === undefined || body.authorship_mode === "human_direct") &&
  (body.identity_mode === undefined || body.identity_mode === "public") &&
  body.agent_id == null &&
  body.agent_action_proof == null &&
  body.anonymous_scope == null &&
  (body.media_refs === undefined || body.media_refs.length === 0) &&
  typeof body.body === "string" &&
  body.body.trim().length > 0;

const stringValue = (row: Row, key: string): string | null => {
  const value = row[key];
  return value === null || value === undefined ? null : typeof value === "string" ? value : null;
};

const numberValue = (row: Row, key: string): number | null => {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const epochValue = (row: Row, key: string): number | null => {
  const value = row[key];
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
};

const allowedPostType = (value: string): value is PostDocument["post_type"] =>
  ["text", "image", "video", "link", "song", "crosspost", "file"].includes(value);

const allowedPostStatus = (value: string): value is PostDocument["status"] =>
  ["draft", "processing", "published", "failed", "hidden", "removed", "deleted"].includes(value);

const allowedVisibility = (value: string): value is PostDocument["visibility"] =>
  value === "public" || value === "members_only";

const postFromRow = (row: Row): PostDocument | null => {
  const id = stringValue(row, "post_id");
  const community = stringValue(row, "community_id");
  const author = stringValue(row, "author_user_id");
  const postType = stringValue(row, "post_type");
  const status = stringValue(row, "status");
  const visibility = stringValue(row, "visibility");
  const created = epochValue(row, "created_at");
  if (
    id === null ||
    community === null ||
    postType === null ||
    !allowedPostType(postType) ||
    status === null ||
    !allowedPostStatus(status) ||
    visibility === null ||
    !allowedVisibility(visibility) ||
    created === null
  ) {
    return null;
  }
  return {
    id,
    object: "post",
    community,
    author_user: author,
    author_public_handle: null,
    authorship_mode: "human_direct",
    agent: null,
    agent_ownership_record: null,
    identity_mode: "public",
    anonymous_scope: null,
    anonymous_label: null,
    post_type: postType,
    status,
    comments_locked: false,
    visibility,
    title: stringValue(row, "title"),
    body: stringValue(row, "body"),
    analysis_state: "pending",
    content_safety_state: "pending",
    age_gate_policy: "none",
    created,
  };
};

const commentFromRow = (row: Row): CommentDocument | null => {
  const id = stringValue(row, "comment_id");
  const community = stringValue(row, "community_id");
  const post = stringValue(row, "post_id");
  const parent = stringValue(row, "parent_comment_id");
  const status = stringValue(row, "status");
  const created = epochValue(row, "created_at");
  const author = stringValue(row, "author_user_id");
  if (
    id === null ||
    community === null ||
    post === null ||
    status === null ||
    !["published", "hidden", "removed", "deleted"].includes(status) ||
    created === null
  ) {
    return null;
  }
  return {
    id,
    object: "comment",
    community,
    thread_root_post: post,
    parent_comment: parent,
    author_user: author,
    author_public_handle: null,
    authorship_mode: "human_direct",
    agent: null,
    agent_ownership_record: null,
    identity_mode: "public",
    anonymous_scope: null,
    anonymous_label: null,
    body: stringValue(row, "body"),
    status: status as CommentDocument["status"],
    depth: 0,
    direct_reply_count: 0,
    descendant_count: 0,
    upvote_count: 0,
    downvote_count: 0,
    score: 0,
    content_hash: null,
    swarm_body_ref: null,
    idempotency_key: stringValue(row, "idempotency_key") || null,
    created,
  };
};

const rowAt = <T extends Row>(rows: readonly T[]): T | null => rows[0] ?? null;

const makePostId = (): string => `post_${crypto.randomUUID()}`;
const makeCommentId = (): string => `comment_${crypto.randomUUID()}`;
const makeVoteId = (): string => `vote_${crypto.randomUUID()}`;

type Transaction = ControlPlaneTransaction;

const resolvePostIn = (transaction: Transaction, postId: string) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "content.posts.resolve-global",
      text: "SELECT community_id, post_id FROM posts WHERE post_id = $1",
      values: [postId],
      readonly: true,
    });
    const row = rowAt(result.rows);
    if (row === null) return null;
    const communityId = stringValue(row, "community_id");
    const resolvedPostId = stringValue(row, "post_id");
    return communityId === null || resolvedPostId === null
      ? null
      : ({ communityId, postId: resolvedPostId } satisfies PostLocation);
  });

const resolveCommentIn = (transaction: Transaction, commentId: string) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "content.comments.resolve-global",
      text: "SELECT community_id, post_id, comment_id FROM comments WHERE comment_id = $1",
      values: [commentId],
      readonly: true,
    });
    const row = rowAt(result.rows);
    if (row === null) return null;
    const communityId = stringValue(row, "community_id");
    const postId = stringValue(row, "post_id");
    const resolvedCommentId = stringValue(row, "comment_id");
    return communityId === null || postId === null || resolvedCommentId === null
      ? null
      : ({ communityId, postId, commentId: resolvedCommentId } satisfies CommentLocation);
  });

const loadPostByIdempotency = (
  transaction: Transaction,
  communityId: string,
  userId: string,
  key: string,
) =>
  transaction.execute<Row>({
    label: "content.posts.find-idempotency",
    text: `SELECT community_id, post_id, author_user_id, post_type, status, visibility, title, body,
                  idempotency_key, idempotency_body_hash, created_at
           FROM posts
           WHERE community_id = $1 AND author_user_id = $2 AND idempotency_key = $3
           FOR UPDATE`,
    values: [communityId, userId, key],
    readonly: false,
  });

const loadCommentByIdempotency = (
  transaction: Transaction,
  communityId: string,
  userId: string,
  key: string,
) =>
  transaction.execute<Row>({
    label: "content.comments.find-idempotency",
    text: `SELECT community_id, comment_id, post_id, parent_comment_id, author_user_id, status, body,
                  idempotency_key, idempotency_body_hash, created_at
           FROM comments
           WHERE community_id = $1 AND author_user_id = $2 AND idempotency_key = $3
           FOR UPDATE`,
    values: [communityId, userId, key],
    readonly: false,
  });

const postDocument = (row: Row, operation: ContentRepositoryOperation) => {
  const document = postFromRow(row);
  return document === null ? Effect.fail(invalid(operation)) : Effect.succeed(document);
};

const commentDocument = (row: Row) => {
  const document = commentFromRow(row);
  return document === null
    ? Effect.fail(invalid("create-comment-reply"))
    : Effect.succeed(document);
};

export function makeControlPlaneContentRepository(): ContentRepository {
  const resolvePost: ContentRepository["resolvePost"] = ({ postId }) =>
    Effect.gen(function* () {
      if (!validId(postId)) return null;
      const db = yield* ControlPlaneDb;
      return yield* resolvePostIn(db, postId);
    });

  const resolveComment: ContentRepository["resolveComment"] = ({ commentId }) =>
    Effect.gen(function* () {
      if (!validId(commentId)) return null;
      const db = yield* ControlPlaneDb;
      return yield* resolveCommentIn(db, commentId);
    });

  const createPost: ContentRepository["createPost"] = ({
    communityId,
    actor,
    body,
    idempotencyBodyHash,
  }) =>
    Effect.gen(function* () {
      if (!validId(communityId) || !validId(actor.userId) || !directTextBody(body)) {
        return yield* constraint("create-post");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const existing = yield* loadPostByIdempotency(
            transaction,
            communityId,
            actor.userId,
            body.idempotency_key,
          );
          const found = rowAt(existing.rows);
          if (found !== null) {
            if (stringValue(found, "idempotency_body_hash") !== idempotencyBodyHash) {
              return yield* idempotencyConflict();
            }
            return yield* postDocument(found, "create-post");
          }

          const postId = makePostId();
          const now = new Date();
          const inserted = yield* transaction.execute<Row>({
            label: "content.posts.insert",
            text: `INSERT INTO posts
              (community_id, post_id, author_user_id, post_type, status, visibility, title, body,
               created_at, updated_at, idempotency_key, idempotency_body_hash)
             VALUES ($1, $2, $3, 'text', 'processing', $4, $5, $6, $7, $7, $8, $9)
             ON CONFLICT DO NOTHING
             RETURNING community_id, post_id, author_user_id, post_type, status, visibility, title, body,
                       idempotency_key, idempotency_body_hash, created_at`,
            values: [
              communityId,
              postId,
              actor.userId,
              body.visibility ?? "public",
              body.title ?? null,
              body.body ?? null,
              now,
              body.idempotency_key,
              idempotencyBodyHash,
            ],
            readonly: false,
          });
          const insertedRow = rowAt(inserted.rows);
          if (insertedRow !== null) return yield* postDocument(insertedRow, "create-post");

          const concurrent = yield* loadPostByIdempotency(
            transaction,
            communityId,
            actor.userId,
            body.idempotency_key,
          );
          const concurrentRow = rowAt(concurrent.rows);
          if (concurrentRow === null) return yield* constraint("create-post");
          if (stringValue(concurrentRow, "idempotency_body_hash") !== idempotencyBodyHash) {
            return yield* idempotencyConflict();
          }
          return yield* postDocument(concurrentRow, "create-post");
        }),
      );
    });

  const getPost: ContentRepository["getPost"] = ({ communityId, postId, viewerUserId, locale }) =>
    Effect.gen(function* () {
      if (!validId(communityId) || !validId(postId)) return null;
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const location = yield* resolvePostIn(transaction, postId);
          if (location === null || location.communityId !== communityId) return null;
          const result = yield* transaction.execute<Row>({
            label: "content.posts.get",
            text: `SELECT community_id, post_id, author_user_id, post_type, status, visibility, title, body,
                          idempotency_body_hash, created_at
                   FROM posts WHERE community_id = $1 AND post_id = $2`,
            values: [communityId, postId],
            readonly: true,
          });
          const row = rowAt(result.rows);
          if (row === null) return null;
          const post = postFromRow(row);
          if (post === null) return yield* invalid("get-post");
          const counts = yield* transaction.execute<Row>({
            label: "content.posts.counts",
            text: `SELECT
              (SELECT COUNT(*)::int FROM post_votes WHERE community_id = $1 AND post_id = $2 AND vote_value = 1) AS upvote_count,
              (SELECT COUNT(*)::int FROM post_votes WHERE community_id = $1 AND post_id = $2 AND vote_value = -1) AS downvote_count,
              (SELECT COUNT(*)::int FROM comments WHERE community_id = $1 AND post_id = $2 AND status <> 'deleted') AS comment_count`,
            values: [communityId, postId],
            readonly: true,
          });
          const countRow = rowAt(counts.rows);
          const viewerVote = yield* transaction.execute<Row>({
            label: "content.posts.viewer-vote",
            text: "SELECT vote_value FROM post_votes WHERE community_id = $1 AND post_id = $2 AND user_id = $3",
            values: [communityId, postId, viewerUserId],
            readonly: true,
          });
          const vote = numberValue(rowAt(viewerVote.rows) ?? {}, "vote_value");
          const sourceHash = stringValue(row, "idempotency_body_hash") ?? "";
          return {
            post,
            thread_snapshot: null,
            upvote_count: numberValue(countRow ?? {}, "upvote_count") ?? 0,
            downvote_count: numberValue(countRow ?? {}, "downvote_count") ?? 0,
            like_count: 0,
            comment_count: numberValue(countRow ?? {}, "comment_count") ?? 0,
            viewer_vote: vote === -1 || vote === 1 ? vote : null,
            viewer_is_author: post.author_user === viewerUserId,
            viewer_reaction_kinds: [],
            resolved_locale: locale ?? "en",
            translation_state: "same_language",
            machine_translated: false,
            source_hash: sourceHash,
          } satisfies LocalizedPostDocument;
        }),
      );
    });

  const createCommentReply: ContentRepository["createCommentReply"] = ({
    communityId,
    postId,
    parentCommentId,
    actor,
    body,
    idempotencyBodyHash,
  }) =>
    Effect.gen(function* () {
      if (
        !validId(communityId) ||
        !validId(postId) ||
        !validId(parentCommentId) ||
        !validId(actor.userId)
      ) {
        return yield* constraint("create-comment-reply");
      }
      if (!directCommentBody(body)) {
        return yield* constraint("create-comment-reply");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const post = yield* resolvePostIn(transaction, postId);
          const parent = yield* resolveCommentIn(transaction, parentCommentId);
          if (
            post === null ||
            parent === null ||
            post.communityId !== communityId ||
            parent.communityId !== communityId ||
            parent.postId !== postId
          ) {
            return yield* constraint("create-comment-reply");
          }
          const key = body.idempotency_key ?? "";
          if (key !== "") {
            const existing = yield* loadCommentByIdempotency(
              transaction,
              communityId,
              actor.userId,
              key,
            );
            const found = rowAt(existing.rows);
            if (found !== null) {
              if (stringValue(found, "idempotency_body_hash") !== (idempotencyBodyHash ?? null)) {
                return yield* new ContentRepositoryError({
                  operation: "create-comment-reply",
                  reason: "idempotency-conflict",
                });
              }
              return yield* commentDocument(found);
            }
          }
          const commentId = makeCommentId();
          const now = new Date();
          const inserted = yield* transaction.execute<Row>({
            label: "content.comments.insert",
            text: `INSERT INTO comments
              (community_id, comment_id, post_id, parent_comment_id, author_user_id, status, body,
               created_at, updated_at, idempotency_key, idempotency_body_hash)
             VALUES ($1, $2, $3, $4, $5, 'published', $6, $7, $7, $8, $9)
             ON CONFLICT DO NOTHING
             RETURNING community_id, comment_id, post_id, parent_comment_id, author_user_id, status, body,
                       idempotency_key, idempotency_body_hash, created_at`,
            values: [
              communityId,
              commentId,
              postId,
              parentCommentId,
              actor.userId,
              body.body,
              now,
              key,
              idempotencyBodyHash ?? null,
            ],
            readonly: false,
          });
          const insertedRow = rowAt(inserted.rows);
          if (insertedRow !== null) return yield* commentDocument(insertedRow);
          if (key === "") return yield* constraint("create-comment-reply");
          const concurrent = yield* loadCommentByIdempotency(
            transaction,
            communityId,
            actor.userId,
            key,
          );
          const concurrentRow = rowAt(concurrent.rows);
          if (concurrentRow === null) return yield* constraint("create-comment-reply");
          if (
            stringValue(concurrentRow, "idempotency_body_hash") !== (idempotencyBodyHash ?? null)
          ) {
            return yield* new ContentRepositoryError({
              operation: "create-comment-reply",
              reason: "idempotency-conflict",
            });
          }
          return yield* commentDocument(concurrentRow);
        }),
      );
    });

  const castPostVote: ContentRepository["castPostVote"] = ({ communityId, postId, actor, body }) =>
    Effect.gen(function* () {
      if (!validId(communityId) || !validId(postId) || !validId(actor.userId)) {
        return yield* constraint("cast-vote");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const location = yield* resolvePostIn(transaction, postId);
          if (location === null || location.communityId !== communityId)
            return yield* constraint("cast-vote");
          const result = yield* transaction.execute<Row>({
            label: "content.post-votes.upsert",
            text: `INSERT INTO post_votes
              (community_id, post_vote_id, post_id, user_id, vote_value, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $6)
             ON CONFLICT (community_id, post_id, user_id)
             DO UPDATE SET vote_value = EXCLUDED.vote_value, updated_at = EXCLUDED.updated_at
             RETURNING post_id, vote_value`,
            values: [communityId, makeVoteId(), postId, actor.userId, body.value, new Date()],
            readonly: false,
          });
          const row = rowAt(result.rows);
          const value = numberValue(row ?? {}, "vote_value");
          const returnedPost = stringValue(row ?? {}, "post_id");
          if (returnedPost === null || (value !== -1 && value !== 1))
            return yield* invalid("cast-vote");
          return { post: returnedPost, value };
        }),
      );
    });

  const clearPostVote: ContentRepository["clearPostVote"] = ({ communityId, postId, actor }) =>
    Effect.gen(function* () {
      if (!validId(communityId) || !validId(postId) || !validId(actor.userId)) {
        return yield* constraint("clear-vote");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const location = yield* resolvePostIn(transaction, postId);
          if (location === null || location.communityId !== communityId)
            return yield* constraint("clear-vote");
          yield* transaction.execute({
            label: "content.post-votes.clear",
            text: "DELETE FROM post_votes WHERE community_id = $1 AND post_id = $2 AND user_id = $3",
            values: [communityId, postId, actor.userId],
            readonly: false,
          });
          return { post: postId, value: null } as const;
        }),
      );
    });

  return {
    resolvePost,
    resolveComment,
    createPost,
    getPost,
    createCommentReply,
    castPostVote,
    clearPostVote,
  };
}

export function makeControlPlaneContentStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): ContentStore["Service"] {
  const repository = makeControlPlaneContentRepository();
  const provide = <A, E>(
    effect: Effect.Effect<A, E, ControlPlaneDb>,
  ): Effect.Effect<A, E | ControlPlaneError> => Effect.provide(runtime)(effect);
  return {
    resolvePost: (input) => provide(repository.resolvePost(input)),
    resolveComment: (input) => provide(repository.resolveComment(input)),
    createPost: (input) => provide(repository.createPost(input)),
    getPost: (input) => provide(repository.getPost(input)),
    createCommentReply: (input) => provide(repository.createCommentReply(input)),
    castPostVote: (input) => provide(repository.castPostVote(input)),
    clearPostVote: (input) => provide(repository.clearPostVote(input)),
  };
}
