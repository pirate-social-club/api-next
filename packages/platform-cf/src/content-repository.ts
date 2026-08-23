import {
  type ClearVoteBody,
  type ClearVoteDocument,
  type CommentLocation,
  ContentRepositoryError,
  type ContentRepositoryFailure,
  type ContentRepositoryOperation,
  type ContentStore,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type CreatePostBody,
  type LocalizedPostDocument,
  type M2Actor,
  type PostDocument,
  type PostLocation,
  type VoteBody,
  type VoteDocument,
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
  readonly checkVoteAuthority: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<void, ContentRepositoryFailure, ControlPlaneDb>;
  readonly replayCastPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }) => Effect.Effect<VoteDocument | null, ContentRepositoryFailure, ControlPlaneDb>;
  readonly replayClearPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }) => Effect.Effect<ClearVoteDocument | null, ContentRepositoryFailure, ControlPlaneDb>;
  readonly castPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly body: VoteBody;
    readonly requestHash: string;
  }) => Effect.Effect<VoteDocument, ContentRepositoryFailure, ControlPlaneDb>;
  readonly clearPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly body: ClearVoteBody;
    readonly requestHash: string;
  }) => Effect.Effect<ClearVoteDocument, ContentRepositoryFailure, ControlPlaneDb>;
}

type Row = Readonly<Record<string, unknown>>;

const invalid = (operation: ContentRepositoryOperation) =>
  new ContentRepositoryError({ operation, reason: "invalid-row" });

const constraint = (operation: ContentRepositoryOperation) =>
  new ContentRepositoryError({ operation, reason: "constraint" });

const notFound = (operation: ContentRepositoryOperation) =>
  new ContentRepositoryError({ operation, reason: "not-found" });

const idempotencyConflict = (operation: ContentRepositoryOperation, actionId?: string) =>
  new ContentRepositoryError({
    operation,
    reason: "idempotency-conflict",
    ...(actionId === undefined ? {} : { actionId }),
  });

const validId = (value: string): boolean =>
  value.length > 0 && value.trim() === value && !value.includes("\u0000");

const directTextBody = (body: CreatePostBody): boolean =>
  body.post_type === "text" &&
  (body.authorship_mode === undefined || body.authorship_mode === "human_direct") &&
  (body.identity_mode === undefined || body.identity_mode === "public") &&
  typeof body.body === "string" &&
  body.body.trim().length > 0 &&
  body.idempotency_key.trim().length > 0;

const stringValue = (row: Row, key: string): string | null => {
  const value = row[key];
  return value === null || value === undefined ? null : typeof value === "string" ? value : null;
};

const numberValue = (row: Row, key: string): number | null => {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
};

const safeIntegerValue = (row: Row, key: string): number | null => {
  const value = numberValue(row, key);
  return value !== null && Number.isSafeInteger(value) ? value : null;
};

const nonNegativeIntegerValue = (row: Row, key: string): number | null => {
  const value = safeIntegerValue(row, key);
  return value !== null && value >= 0 ? value : null;
};

const epochSeconds = (value: number): number | null => {
  if (!Number.isFinite(value)) return null;
  const seconds = Math.abs(value) >= 100_000_000_000 ? value / 1000 : value;
  const normalized = Math.floor(seconds);
  return Number.isSafeInteger(normalized) ? normalized : null;
};

const epochValue = (row: Row, key: string): number | null => {
  const value = row[key];
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return epochSeconds(value.getTime());
  }
  if (typeof value === "number") return epochSeconds(value);
  if (typeof value === "string") {
    if (/^-?\d+(?:\.\d+)?$/u.test(value)) return epochSeconds(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? epochSeconds(parsed) : null;
  }
  return null;
};

const booleanValue = (row: Row, key: string): boolean | null => {
  const value = row[key];
  if (typeof value === "boolean") return value;
  return null;
};

const allowedPostType = (value: string): value is PostDocument["post_type"] =>
  ["text", "image", "video", "link", "song", "crosspost", "file"].includes(value);

const allowedPostStatus = (value: string): value is PostDocument["status"] =>
  ["draft", "processing", "published", "failed", "hidden", "removed", "deleted"].includes(value);

const allowedVisibility = (value: string): value is PostDocument["visibility"] =>
  value === "public" || value === "members_only";

const allowedCommunityStatus = (value: string): value is "active" | "hidden" | "archived" =>
  ["active", "hidden", "archived"].includes(value);

const allowedMembershipStatus = (
  value: string,
): value is "pending" | "member" | "left" | "banned" =>
  ["pending", "member", "left", "banned"].includes(value);

const validIdempotencyHash = (value: string | null): value is string =>
  value !== null && /^[0-9a-f]{64}$/u.test(value);

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
    !validId(id) ||
    !validId(community) ||
    postType === null ||
    !allowedPostType(postType) ||
    status === null ||
    !allowedPostStatus(status) ||
    visibility === null ||
    !allowedVisibility(visibility) ||
    created === null ||
    booleanValue(row, "comments_locked") === null ||
    (author !== null && !validId(author))
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
    comments_locked: booleanValue(row, "comments_locked") as boolean,
    visibility,
    title: stringValue(row, "title"),
    body: stringValue(row, "body"),
    analysis_state: "pending",
    content_safety_state: "pending",
    age_gate_policy: "none",
    created,
  };
};

const rowAt = <T extends Row>(rows: readonly T[]): T | null => rows[0] ?? null;

const oneRow = <T extends Row>(
  rows: readonly T[],
  operation: ContentRepositoryOperation,
): Effect.Effect<T | null, ContentRepositoryError> =>
  rows.length > 1 ? Effect.fail(invalid(operation)) : Effect.succeed(rowAt(rows));

const exactlyOneRow = <T extends Row>(
  rows: readonly T[],
  operation: ContentRepositoryOperation,
): Effect.Effect<T, ContentRepositoryError> =>
  rows.length !== 1 ? Effect.fail(invalid(operation)) : Effect.succeed(rows[0] as T);

const makePostId = (): string => `post_${crypto.randomUUID()}`;
const makeVoteId = (): string => `vote_${crypto.randomUUID()}`;
const makeVoteActionId = (): string => `vote_action_${crypto.randomUUID()}`;

type Transaction = ControlPlaneTransaction;

const resolvePostIn = (
  transaction: Transaction,
  postId: string,
  operation: ContentRepositoryOperation,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "content.posts.resolve-global",
      text: `SELECT p.community_id, p.post_id, p.status, c.status AS community_status
             FROM posts p
             LEFT JOIN communities c ON c.community_id = p.community_id
             WHERE p.post_id = $1`,
      values: [postId],
      readonly: true,
    });
    const row = yield* oneRow(result.rows, operation);
    if (row === null) return null;
    const communityId = stringValue(row, "community_id");
    const resolvedPostId = stringValue(row, "post_id");
    const postStatus = stringValue(row, "status");
    const communityStatus = stringValue(row, "community_status");
    if (
      communityId === null ||
      resolvedPostId === null ||
      postStatus === null ||
      communityStatus === null ||
      !validId(communityId) ||
      !validId(resolvedPostId) ||
      resolvedPostId !== postId ||
      !allowedPostStatus(postStatus) ||
      !allowedCommunityStatus(communityStatus)
    ) {
      return yield* invalid(operation);
    }
    return communityStatus === "active"
      ? ({ communityId, postId: resolvedPostId } satisfies PostLocation)
      : null;
  });

const resolveCommentIn = (
  transaction: Transaction,
  commentId: string,
  operation: ContentRepositoryOperation,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "content.comments.resolve-global",
      text: `SELECT c.community_id, c.post_id, c.comment_id, c.status, cm.status AS community_status
             FROM comments c
             LEFT JOIN communities cm ON cm.community_id = c.community_id
             WHERE c.comment_id = $1`,
      values: [commentId],
      readonly: true,
    });
    const row = yield* oneRow(result.rows, operation);
    if (row === null) return null;
    const communityId = stringValue(row, "community_id");
    const postId = stringValue(row, "post_id");
    const resolvedCommentId = stringValue(row, "comment_id");
    const commentStatus = stringValue(row, "status");
    const communityStatus = stringValue(row, "community_status");
    if (
      communityId === null ||
      postId === null ||
      resolvedCommentId === null ||
      commentStatus === null ||
      communityStatus === null ||
      !validId(communityId) ||
      !validId(postId) ||
      !validId(resolvedCommentId) ||
      resolvedCommentId !== commentId ||
      !["published", "hidden", "removed", "deleted"].includes(commentStatus) ||
      !allowedCommunityStatus(communityStatus)
    ) {
      return yield* invalid(operation);
    }
    return communityStatus === "active"
      ? ({
          communityId,
          postId,
          commentId: resolvedCommentId,
        } satisfies CommentLocation)
      : null;
  });

/**
 * The route predicate is deliberately kept in the platform repository.  The
 * application only supplies the canonical community id; it must not recreate
 * route authority from an application clock or a partial set of route rows.
 *
 * The community row is locked before membership and content rows, matching
 * the route-revalidation lock order (community -> binding).
 */
const lockActiveCommunityIn = (
  transaction: Transaction,
  communityId: string,
  operation: ContentRepositoryOperation,
) =>
  Effect.gen(function* () {
    const community = yield* transaction.execute<Row>({
      label: "content.communities.lock-active",
      text: `SELECT c.community_id, c.status
             FROM communities AS c
             WHERE c.community_id = $1
               AND c.status = 'active'
             FOR UPDATE OF c`,
      values: [communityId],
      readonly: false,
    });
    const communityRow = yield* oneRow(community.rows, operation);
    if (communityRow === null) return yield* notFound(operation);
    const storedCommunityId = stringValue(communityRow, "community_id");
    const communityStatus = stringValue(communityRow, "status");
    if (
      storedCommunityId === null ||
      storedCommunityId !== communityId ||
      !validId(storedCommunityId) ||
      communityStatus !== "active"
    ) {
      return yield* invalid(operation);
    }
    return communityRow;
  });

const requireActiveMembershipIn = (
  transaction: Transaction,
  communityId: string,
  userId: string,
  operation: ContentRepositoryOperation,
) =>
  Effect.gen(function* () {
    yield* lockActiveCommunityIn(transaction, communityId, operation);
    const membership = yield* transaction.execute<Row>({
      label: "content.community-memberships.lock-active",
      text: `SELECT status
             FROM community_memberships
             WHERE community_id = $1 AND user_id = $2
             FOR UPDATE`,
      values: [communityId, userId],
      readonly: false,
    });
    const membershipRow = yield* oneRow(membership.rows, operation);
    if (membershipRow === null) {
      return yield* new ContentRepositoryError({
        operation,
        reason: "membership-required",
      });
    }
    const membershipStatus = stringValue(membershipRow, "status");
    if (membershipStatus === null || !allowedMembershipStatus(membershipStatus)) {
      return yield* invalid(operation);
    }
    if (membershipStatus !== "member") {
      return yield* new ContentRepositoryError({
        operation,
        reason: "membership-required",
      });
    }
  });

const requireEffectiveActiveRouteIn = (
  transaction: Transaction,
  communityId: string,
  operation: ContentRepositoryOperation,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "content.communities.require-effective-route",
      text: `WITH db_clock AS MATERIALIZED (
               SELECT clock_timestamp() AS now
             )
             SELECT route.community_id
             FROM db_clock
             CROSS JOIN LATERAL effective_active_route($1, db_clock.now) AS route`,
      values: [communityId],
      readonly: true,
    });
    if (result.rows.length > 1) return yield* invalid(operation);
    if (result.rows.length === 0) return yield* notFound(operation);
    if (stringValue(result.rows[0] as Row, "community_id") !== communityId) {
      return yield* invalid(operation);
    }
  });

const loadPostStateIn = (transaction: Transaction, communityId: string, postId: string) =>
  transaction.execute<Row>({
    label: "content.posts.state",
    text: `SELECT community_id, post_id, author_user_id, status, visibility, comments_locked
           FROM posts
           WHERE community_id = $1 AND post_id = $2
           FOR UPDATE`,
    values: [communityId, postId],
    readonly: false,
  });

type PostState = Readonly<{
  readonly communityId: string;
  readonly postId: string;
  readonly authorUserId: string | null;
  readonly status: PostDocument["status"];
  readonly visibility: PostDocument["visibility"];
  readonly commentsLocked: boolean;
}>;

const postStateFromRow = (row: Row, operation: ContentRepositoryOperation) => {
  const communityId = stringValue(row, "community_id");
  const postId = stringValue(row, "post_id");
  const authorUserId = stringValue(row, "author_user_id");
  const status = stringValue(row, "status");
  const visibility = stringValue(row, "visibility");
  const commentsLocked = booleanValue(row, "comments_locked");
  if (
    communityId === null ||
    postId === null ||
    !validId(communityId) ||
    !validId(postId) ||
    status === null ||
    !allowedPostStatus(status) ||
    visibility === null ||
    !allowedVisibility(visibility) ||
    commentsLocked === null ||
    (authorUserId !== null && !validId(authorUserId))
  ) {
    return Effect.fail(invalid(operation));
  }
  return Effect.succeed({
    communityId,
    postId,
    authorUserId,
    status,
    visibility,
    commentsLocked,
  } satisfies PostState);
};

const requireVoteAuthorityIn = (
  transaction: Transaction,
  communityId: string,
  postId: string,
  actorUserId: string,
  operation: "cast-vote" | "clear-vote",
) =>
  Effect.gen(function* () {
    yield* requireActiveMembershipIn(transaction, communityId, actorUserId, operation);
    const location = yield* resolvePostIn(transaction, postId, operation);
    if (location === null || location.communityId !== communityId) {
      return yield* notFound(operation);
    }
    const postRow = yield* oneRow(
      (yield* loadPostStateIn(transaction, communityId, postId)).rows,
      operation,
    );
    if (postRow === null) return yield* notFound(operation);
    const post = yield* postStateFromRow(postRow, operation);
    if (post.communityId !== communityId || post.postId !== postId || post.status !== "published") {
      return yield* notFound(operation);
    }
    yield* requireEffectiveActiveRouteIn(transaction, communityId, operation);
  });

type ActorVote = Readonly<{
  readonly communityId: string;
  readonly postVoteId: string;
  readonly postId: string;
  readonly userId: string;
  readonly value: -1 | 1;
}>;

const actorVoteFromRow = (row: Row, operation: ContentRepositoryOperation) => {
  const communityId = stringValue(row, "community_id");
  const postVoteId = stringValue(row, "post_vote_id");
  const postId = stringValue(row, "post_id");
  const userId = stringValue(row, "user_id");
  const value = safeIntegerValue(row, "vote_value");
  if (
    communityId === null ||
    postVoteId === null ||
    postId === null ||
    userId === null ||
    !validId(communityId) ||
    !validId(postVoteId) ||
    !validId(postId) ||
    !validId(userId) ||
    (value !== -1 && value !== 1)
  ) {
    return Effect.fail(invalid(operation));
  }
  return Effect.succeed({
    communityId,
    postVoteId,
    postId,
    userId,
    value: value as -1 | 1,
  } satisfies ActorVote);
};

const loadActorVoteIn = (
  transaction: Transaction,
  communityId: string,
  postId: string,
  userId: string,
  operation: ContentRepositoryOperation,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "content.post-votes.lock-actor",
      text: `SELECT community_id, post_vote_id, post_id, user_id, vote_value
             FROM post_votes
             WHERE community_id = $1 AND post_id = $2 AND user_id = $3
             FOR UPDATE`,
      values: [communityId, postId, userId],
      readonly: false,
    });
    const row = yield* oneRow(result.rows, operation);
    if (row === null) return null;
    const vote = yield* actorVoteFromRow(row, operation);
    if (vote.communityId !== communityId || vote.postId !== postId || vote.userId !== userId) {
      return yield* invalid(operation);
    }
    return vote;
  });

type VoteEndpointTemplate = "/posts/:postId/vote" | "/posts/:postId/clear_vote";

type VoteAction = Readonly<{
  readonly actionId: string;
  readonly communityId: string;
  readonly postId: string;
  readonly actorUserId: string;
  readonly endpointTemplate: VoteEndpointTemplate;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly resultValue: -1 | 0 | 1;
}>;

const voteActionFromRow = (row: Row, operation: ContentRepositoryOperation) => {
  const actionId = stringValue(row, "action_id");
  const communityId = stringValue(row, "community_id");
  const postId = stringValue(row, "post_id");
  const actorUserId = stringValue(row, "actor_user_id");
  const endpointTemplate = stringValue(row, "endpoint_template");
  const idempotencyKey = stringValue(row, "idempotency_key");
  const requestHash = stringValue(row, "request_hash");
  const resultValue = safeIntegerValue(row, "result_value");
  if (
    actionId === null ||
    communityId === null ||
    postId === null ||
    actorUserId === null ||
    idempotencyKey === null ||
    !validId(actionId) ||
    !validId(communityId) ||
    !validId(postId) ||
    !validId(actorUserId) ||
    !validId(idempotencyKey) ||
    !validIdempotencyHash(requestHash) ||
    (endpointTemplate !== "/posts/:postId/vote" &&
      endpointTemplate !== "/posts/:postId/clear_vote") ||
    (resultValue !== -1 && resultValue !== 0 && resultValue !== 1)
  ) {
    return Effect.fail(invalid(operation));
  }
  return Effect.succeed({
    actionId,
    communityId,
    postId,
    actorUserId,
    endpointTemplate,
    idempotencyKey,
    requestHash,
    resultValue,
  } satisfies VoteAction);
};

const loadVoteActionIn = (
  transaction: Transaction,
  communityId: string,
  postId: string,
  actorUserId: string,
  endpointTemplate: VoteEndpointTemplate,
  idempotencyKey: string,
  operation: ContentRepositoryOperation,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "content.post-vote-actions.lock",
      text: `SELECT action_id, community_id, post_id, actor_user_id, endpoint_template,
                    idempotency_key, request_hash, result_value
             FROM post_vote_actions
             WHERE actor_user_id = $1
               AND post_id = $2
               AND endpoint_template = $3
               AND idempotency_key = $4
             FOR UPDATE`,
      values: [actorUserId, postId, endpointTemplate, idempotencyKey],
      readonly: false,
    });
    const row = yield* oneRow(result.rows, operation);
    if (row === null) return null;
    const action = yield* voteActionFromRow(row, operation);
    if (
      action.communityId !== communityId ||
      action.postId !== postId ||
      action.actorUserId !== actorUserId ||
      action.endpointTemplate !== endpointTemplate ||
      action.idempotencyKey !== idempotencyKey
    ) {
      return yield* invalid(operation);
    }
    return action;
  });

const castReplayFromAction = (action: VoteAction | null, requestHash: string, postId: string) =>
  Effect.gen(function* () {
    if (action === null) return null;
    if (action.requestHash !== requestHash) {
      return yield* idempotencyConflict("cast-vote", action.actionId);
    }
    if (action.resultValue !== -1 && action.resultValue !== 1) {
      return yield* invalid("cast-vote");
    }
    return { post_id: postId, value: action.resultValue } satisfies VoteDocument;
  });

const clearReplayFromAction = (action: VoteAction | null, requestHash: string, postId: string) =>
  Effect.gen(function* () {
    if (action === null) return null;
    if (action.requestHash !== requestHash) {
      return yield* idempotencyConflict("clear-vote", action.actionId);
    }
    if (action.resultValue !== 0) return yield* invalid("clear-vote");
    return { post_id: postId, value: 0 } satisfies ClearVoteDocument;
  });

const repairVoteAggregatesIn = (
  transaction: Transaction,
  communityId: string,
  postId: string,
  operation: ContentRepositoryOperation,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "content.posts.repair-vote-aggregates",
      text: `UPDATE posts AS p
             SET upvote_count = counts.upvote_count,
                 downvote_count = counts.downvote_count,
                 updated_at = clock_timestamp()
             FROM (
               SELECT
                 COUNT(*) FILTER (WHERE vote_value = 1)::int AS upvote_count,
                 COUNT(*) FILTER (WHERE vote_value = -1)::int AS downvote_count
               FROM post_votes
               WHERE community_id = $1 AND post_id = $2
             ) AS counts
             WHERE p.community_id = $1 AND p.post_id = $2
             RETURNING p.upvote_count, p.downvote_count`,
      values: [communityId, postId],
      readonly: false,
    });
    const row = yield* exactlyOneRow(result.rows, operation);
    const upvoteCount = nonNegativeIntegerValue(row, "upvote_count");
    const downvoteCount = nonNegativeIntegerValue(row, "downvote_count");
    if (upvoteCount === null || downvoteCount === null) return yield* invalid(operation);
    return { upvoteCount, downvoteCount };
  });

const insertVoteActionIn = (
  transaction: Transaction,
  input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actorUserId: string;
    readonly endpointTemplate: VoteEndpointTemplate;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly resultValue: -1 | 0 | 1;
  },
  operation: ContentRepositoryOperation,
) =>
  Effect.gen(function* () {
    const inserted = yield* transaction.execute<Row>({
      label: "content.post-vote-actions.insert",
      text: `INSERT INTO post_vote_actions
               (action_id, community_id, post_id, actor_user_id, endpoint_template,
                idempotency_key, request_hash, result_value, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())
             RETURNING action_id, community_id, post_id, actor_user_id, endpoint_template,
                       idempotency_key, request_hash, result_value`,
      values: [
        makeVoteActionId(),
        input.communityId,
        input.postId,
        input.actorUserId,
        input.endpointTemplate,
        input.idempotencyKey,
        input.requestHash,
        input.resultValue,
      ],
      readonly: false,
    });
    const row = yield* exactlyOneRow(inserted.rows, operation);
    const action = yield* voteActionFromRow(row, operation);
    if (
      action.communityId !== input.communityId ||
      action.postId !== input.postId ||
      action.actorUserId !== input.actorUserId ||
      action.endpointTemplate !== input.endpointTemplate ||
      action.idempotencyKey !== input.idempotencyKey ||
      action.requestHash !== input.requestHash ||
      action.resultValue !== input.resultValue
    ) {
      return yield* invalid(operation);
    }
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
                  idempotency_key, idempotency_body_hash, comments_locked, created_at
           FROM posts
           WHERE community_id = $1 AND author_user_id = $2 AND idempotency_key = $3
           FOR UPDATE`,
    values: [communityId, userId, key],
    readonly: false,
  });

const postDocument = (row: Row, operation: ContentRepositoryOperation) => {
  const document = postFromRow(row);
  return document === null ? Effect.fail(invalid(operation)) : Effect.succeed(document);
};

const postIdempotencyDocument = (row: Row, key: string, operation: ContentRepositoryOperation) => {
  if (
    stringValue(row, "idempotency_key") !== key ||
    !validIdempotencyHash(stringValue(row, "idempotency_body_hash"))
  ) {
    return Effect.fail(invalid(operation));
  }
  return postDocument(row, operation);
};

export function makeControlPlaneContentRepository(): ContentRepository {
  const resolvePost: ContentRepository["resolvePost"] = ({ postId }) =>
    Effect.gen(function* () {
      if (!validId(postId)) return null;
      const db = yield* ControlPlaneDb;
      return yield* resolvePostIn(db, postId, "resolve-post");
    });

  const resolveComment: ContentRepository["resolveComment"] = ({ commentId }) =>
    Effect.gen(function* () {
      if (!validId(commentId)) return null;
      const db = yield* ControlPlaneDb;
      return yield* resolveCommentIn(db, commentId, "resolve-comment");
    });

  const createPost: ContentRepository["createPost"] = ({
    communityId,
    actor,
    body,
    idempotencyBodyHash,
  }) =>
    Effect.gen(function* () {
      if (
        actor.kind === "agent" ||
        !validId(communityId) ||
        !validId(actor.userId) ||
        !directTextBody(body) ||
        !validIdempotencyHash(idempotencyBodyHash)
      ) {
        return yield* constraint("create-post");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* requireActiveMembershipIn(transaction, communityId, actor.userId, "create-post");
          const existing = yield* loadPostByIdempotency(
            transaction,
            communityId,
            actor.userId,
            body.idempotency_key,
          );
          yield* requireEffectiveActiveRouteIn(transaction, communityId, "create-post");
          const found = yield* oneRow(existing.rows, "create-post");
          if (found !== null) {
            const persistedHash = stringValue(found, "idempotency_body_hash");
            if (!validIdempotencyHash(persistedHash)) {
              return yield* invalid("create-post");
            }
            if (persistedHash !== idempotencyBodyHash) {
              return yield* idempotencyConflict("create-post");
            }
            return yield* postIdempotencyDocument(found, body.idempotency_key, "create-post");
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
                       idempotency_key, idempotency_body_hash, comments_locked, created_at`,
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
          const insertedRow = yield* oneRow(inserted.rows, "create-post");
          if (insertedRow !== null) {
            const persistedHash = stringValue(insertedRow, "idempotency_body_hash");
            if (!validIdempotencyHash(persistedHash)) {
              return yield* invalid("create-post");
            }
            if (persistedHash !== idempotencyBodyHash) {
              return yield* invalid("create-post");
            }
            return yield* postIdempotencyDocument(insertedRow, body.idempotency_key, "create-post");
          }

          const concurrent = yield* loadPostByIdempotency(
            transaction,
            communityId,
            actor.userId,
            body.idempotency_key,
          );
          const concurrentRow = yield* oneRow(concurrent.rows, "create-post");
          if (concurrentRow === null) return yield* constraint("create-post");
          const persistedHash = stringValue(concurrentRow, "idempotency_body_hash");
          if (!validIdempotencyHash(persistedHash)) {
            return yield* invalid("create-post");
          }
          if (persistedHash !== idempotencyBodyHash) {
            return yield* idempotencyConflict("create-post");
          }
          return yield* postIdempotencyDocument(concurrentRow, body.idempotency_key, "create-post");
        }),
      );
    });

  const getPost: ContentRepository["getPost"] = ({ communityId, postId, viewerUserId, locale }) =>
    Effect.gen(function* () {
      if (!validId(communityId) || !validId(postId) || !validId(viewerUserId)) return null;
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const location = yield* resolvePostIn(transaction, postId, "get-post");
          if (location === null || location.communityId !== communityId) return null;
          const result = yield* transaction.execute<Row>({
            label: "content.posts.get",
            text: `SELECT community_id, post_id, author_user_id, post_type, status, visibility, title, body,
                          comments_locked, created_at
                   FROM posts WHERE community_id = $1 AND post_id = $2`,
            values: [communityId, postId],
            readonly: true,
          });
          const row = yield* oneRow(result.rows, "get-post");
          if (row === null) return null;
          const post = postFromRow(row);
          if (post === null) return yield* invalid("get-post");
          if (post.community !== communityId || post.id !== postId) {
            return yield* invalid("get-post");
          }
          if (["hidden", "removed", "deleted"].includes(post.status)) return null;
          if (post.status !== "published" && post.status !== "processing") return null;
          if (post.status === "processing" && post.author_user !== viewerUserId) return null;
          if (post.visibility === "members_only") {
            const membership = yield* transaction.execute<Row>({
              label: "content.community-memberships.read-access",
              text: `SELECT status
                     FROM community_memberships
                     WHERE community_id = $1 AND user_id = $2
                     `,
              values: [communityId, viewerUserId],
              readonly: true,
            });
            const membershipRow = yield* oneRow(membership.rows, "get-post");
            if (membershipRow !== null) {
              const membershipStatus = stringValue(membershipRow, "status");
              if (membershipStatus === null || !allowedMembershipStatus(membershipStatus)) {
                return yield* invalid("get-post");
              }
              if (membershipStatus !== "member") return null;
            } else {
              return null;
            }
          }
          const counts = yield* transaction.execute<Row>({
            label: "content.posts.counts",
            text: `SELECT
              p.upvote_count AS stored_upvote_count,
              p.downvote_count AS stored_downvote_count,
              (SELECT COUNT(*)::int FROM post_votes WHERE community_id = $1 AND post_id = $2) AS vote_row_count,
              (SELECT COUNT(DISTINCT user_id)::int FROM post_votes WHERE community_id = $1 AND post_id = $2) AS distinct_voter_count,
              (SELECT COUNT(*)::int FROM post_votes WHERE community_id = $1 AND post_id = $2 AND user_id IS NULL) AS null_voter_count,
              (SELECT COUNT(*)::int FROM post_votes WHERE community_id = $1 AND post_id = $2
                 AND (vote_value IS NULL OR vote_value NOT IN (1, -1))) AS invalid_vote_count,
              (SELECT COUNT(*)::int FROM post_votes WHERE community_id = $1 AND post_id = $2 AND vote_value = 1) AS upvote_count,
              (SELECT COUNT(*)::int FROM post_votes WHERE community_id = $1 AND post_id = $2 AND vote_value = -1) AS downvote_count,
              (SELECT COUNT(*)::int FROM comments WHERE community_id = $1 AND post_id = $2 AND status = 'published') AS comment_count
             FROM posts AS p
             WHERE p.community_id = $1 AND p.post_id = $2`,
            values: [communityId, postId],
            readonly: true,
          });
          const countRow = yield* exactlyOneRow(counts.rows, "get-post");
          const viewerVote = yield* transaction.execute<Row>({
            label: "content.posts.viewer-vote",
            text: "SELECT vote_value FROM post_votes WHERE community_id = $1 AND post_id = $2 AND user_id = $3",
            values: [communityId, postId, viewerUserId],
            readonly: true,
          });
          const viewerVoteRow = yield* oneRow(viewerVote.rows, "get-post");
          const voteValue =
            viewerVoteRow === null ? null : safeIntegerValue(viewerVoteRow, "vote_value");
          if (viewerVoteRow !== null && voteValue !== -1 && voteValue !== 1) {
            return yield* invalid("get-post");
          }
          const vote: -1 | 1 | null = voteValue === -1 ? -1 : voteValue === 1 ? 1 : null;
          const upvoteCount = nonNegativeIntegerValue(countRow, "upvote_count");
          const downvoteCount = nonNegativeIntegerValue(countRow, "downvote_count");
          const storedUpvoteCount = nonNegativeIntegerValue(countRow, "stored_upvote_count");
          const storedDownvoteCount = nonNegativeIntegerValue(countRow, "stored_downvote_count");
          const commentCount = nonNegativeIntegerValue(countRow, "comment_count");
          const voteRowCount = nonNegativeIntegerValue(countRow, "vote_row_count");
          const distinctVoterCount = nonNegativeIntegerValue(countRow, "distinct_voter_count");
          const nullVoterCount = nonNegativeIntegerValue(countRow, "null_voter_count");
          const invalidVoteCount = nonNegativeIntegerValue(countRow, "invalid_vote_count");
          if (
            upvoteCount === null ||
            downvoteCount === null ||
            storedUpvoteCount === null ||
            storedDownvoteCount === null ||
            commentCount === null ||
            voteRowCount === null ||
            distinctVoterCount === null ||
            nullVoterCount === null ||
            invalidVoteCount === null ||
            nullVoterCount !== 0 ||
            invalidVoteCount !== 0 ||
            voteRowCount !== distinctVoterCount ||
            upvoteCount + downvoteCount !== voteRowCount
          ) {
            return yield* invalid("get-post");
          }
          if (storedUpvoteCount !== upvoteCount || storedDownvoteCount !== downvoteCount) {
            console.warn("content_vote_aggregate_drift", {
              community_id: communityId,
              post_id: postId,
              stored_upvote_count: storedUpvoteCount,
              stored_downvote_count: storedDownvoteCount,
              live_upvote_count: upvoteCount,
              live_downvote_count: downvoteCount,
            });
          }
          return {
            post,
            thread_snapshot: null,
            upvote_count: storedUpvoteCount,
            downvote_count: storedDownvoteCount,
            like_count: 0,
            comment_count: commentCount,
            viewer_vote: vote,
            viewer_is_author: post.author_user === viewerUserId,
            viewer_reaction_kinds: [],
            resolved_locale: locale ?? "en",
            translation_state: "same_language",
            machine_translated: false,
            source_hash: "",
          } satisfies LocalizedPostDocument;
        }),
      );
    });

  const checkVoteAuthority: ContentRepository["checkVoteAuthority"] = ({
    communityId,
    postId,
    actor,
  }) =>
    Effect.gen(function* () {
      if (
        actor.kind === "agent" ||
        !validId(communityId) ||
        !validId(postId) ||
        !validId(actor.userId)
      ) {
        return yield* constraint("cast-vote");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        requireVoteAuthorityIn(transaction, communityId, postId, actor.userId, "cast-vote"),
      );
    });

  const replayCastPostVote: ContentRepository["replayCastPostVote"] = ({
    communityId,
    postId,
    actor,
    idempotencyKey,
    requestHash,
  }) =>
    Effect.gen(function* () {
      if (
        actor.kind === "agent" ||
        !validId(communityId) ||
        !validId(postId) ||
        !validId(actor.userId) ||
        !validId(idempotencyKey) ||
        !validIdempotencyHash(requestHash)
      ) {
        return yield* constraint("cast-vote");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        loadVoteActionIn(
          transaction,
          communityId,
          postId,
          actor.userId,
          "/posts/:postId/vote",
          idempotencyKey,
          "cast-vote",
        ).pipe(Effect.flatMap((action) => castReplayFromAction(action, requestHash, postId))),
      );
    });

  const replayClearPostVote: ContentRepository["replayClearPostVote"] = ({
    communityId,
    postId,
    actor,
    idempotencyKey,
    requestHash,
  }) =>
    Effect.gen(function* () {
      if (
        actor.kind === "agent" ||
        !validId(communityId) ||
        !validId(postId) ||
        !validId(actor.userId) ||
        !validId(idempotencyKey) ||
        !validIdempotencyHash(requestHash)
      ) {
        return yield* constraint("clear-vote");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        loadVoteActionIn(
          transaction,
          communityId,
          postId,
          actor.userId,
          "/posts/:postId/clear_vote",
          idempotencyKey,
          "clear-vote",
        ).pipe(Effect.flatMap((action) => clearReplayFromAction(action, requestHash, postId))),
      );
    });

  const castPostVote: ContentRepository["castPostVote"] = ({
    communityId,
    postId,
    actor,
    body,
    requestHash,
  }) =>
    Effect.gen(function* () {
      if (
        actor.kind === "agent" ||
        !validId(communityId) ||
        !validId(postId) ||
        !validId(actor.userId) ||
        !validId(body.idempotency_key) ||
        !validIdempotencyHash(requestHash) ||
        (body.value !== -1 && body.value !== 1)
      ) {
        return yield* constraint("cast-vote");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const endpointTemplate = "/posts/:postId/vote" as const;
          const initialAction = yield* loadVoteActionIn(
            transaction,
            communityId,
            postId,
            actor.userId,
            endpointTemplate,
            body.idempotency_key,
            "cast-vote",
          );
          const initialReplay = yield* castReplayFromAction(initialAction, requestHash, postId);
          if (initialReplay !== null) return initialReplay;
          yield* requireVoteAuthorityIn(
            transaction,
            communityId,
            postId,
            actor.userId,
            "cast-vote",
          );
          const existingAction = yield* loadVoteActionIn(
            transaction,
            communityId,
            postId,
            actor.userId,
            endpointTemplate,
            body.idempotency_key,
            "cast-vote",
          );
          const replay = yield* castReplayFromAction(existingAction, requestHash, postId);
          if (replay !== null) return replay;
          yield* loadActorVoteIn(transaction, communityId, postId, actor.userId, "cast-vote");
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
          const row = yield* exactlyOneRow(result.rows, "cast-vote");
          const value = safeIntegerValue(row, "vote_value");
          const returnedPost = stringValue(row, "post_id");
          if (
            returnedPost === null ||
            !validId(returnedPost) ||
            returnedPost !== postId ||
            (value !== -1 && value !== 1)
          )
            return yield* invalid("cast-vote");
          const voteValue: -1 | 1 = value as -1 | 1;
          yield* repairVoteAggregatesIn(transaction, communityId, postId, "cast-vote");
          yield* insertVoteActionIn(
            transaction,
            {
              communityId,
              postId,
              actorUserId: actor.userId,
              endpointTemplate,
              idempotencyKey: body.idempotency_key,
              requestHash,
              resultValue: voteValue,
            },
            "cast-vote",
          );
          return { post_id: returnedPost, value: voteValue };
        }),
      );
    });

  const clearPostVote: ContentRepository["clearPostVote"] = ({
    communityId,
    postId,
    actor,
    body,
    requestHash,
  }) =>
    Effect.gen(function* () {
      if (
        actor.kind === "agent" ||
        !validId(communityId) ||
        !validId(postId) ||
        !validId(actor.userId) ||
        !validId(body.idempotency_key) ||
        !validIdempotencyHash(requestHash)
      ) {
        return yield* constraint("clear-vote");
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const endpointTemplate = "/posts/:postId/clear_vote" as const;
          const initialAction = yield* loadVoteActionIn(
            transaction,
            communityId,
            postId,
            actor.userId,
            endpointTemplate,
            body.idempotency_key,
            "clear-vote",
          );
          const initialReplay = yield* clearReplayFromAction(initialAction, requestHash, postId);
          if (initialReplay !== null) return initialReplay;
          yield* requireVoteAuthorityIn(
            transaction,
            communityId,
            postId,
            actor.userId,
            "clear-vote",
          );
          const existingAction = yield* loadVoteActionIn(
            transaction,
            communityId,
            postId,
            actor.userId,
            endpointTemplate,
            body.idempotency_key,
            "clear-vote",
          );
          const replay = yield* clearReplayFromAction(existingAction, requestHash, postId);
          if (replay !== null) return replay;
          yield* loadActorVoteIn(transaction, communityId, postId, actor.userId, "clear-vote");
          yield* transaction.execute({
            label: "content.post-votes.clear",
            text: "DELETE FROM post_votes WHERE community_id = $1 AND post_id = $2 AND user_id = $3",
            values: [communityId, postId, actor.userId],
            readonly: false,
          });
          yield* repairVoteAggregatesIn(transaction, communityId, postId, "clear-vote");
          yield* insertVoteActionIn(
            transaction,
            {
              communityId,
              postId,
              actorUserId: actor.userId,
              endpointTemplate,
              idempotencyKey: body.idempotency_key,
              requestHash,
              resultValue: 0,
            },
            "clear-vote",
          );
          return { post_id: postId, value: 0 } as const;
        }),
      );
    });

  return {
    resolvePost,
    resolveComment,
    createPost,
    getPost,
    checkVoteAuthority,
    replayCastPostVote,
    replayClearPostVote,
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
    checkVoteAuthority: (input) => provide(repository.checkVoteAuthority(input)),
    replayCastPostVote: (input) => provide(repository.replayCastPostVote(input)),
    replayClearPostVote: (input) => provide(repository.replayClearPostVote(input)),
    castPostVote: (input) => provide(repository.castPostVote(input)),
    clearPostVote: (input) => provide(repository.clearPostVote(input)),
  };
}
