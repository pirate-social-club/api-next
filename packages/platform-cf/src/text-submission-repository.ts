import {
  type CommentReportOutcome,
  type CommentReportReasonCode,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type CreatePostBody,
  canonicalBodyHash,
  type M2Actor,
  type ModerationAction,
  type ModerationActionOutcome,
  type TextCommentTargetResolution,
  type TextPostCommitOutcome,
  TextPostRepositoryError,
  type TextPostRepositoryFailure,
  type TextPostStore,
  type TextPostSubmissionDocument,
  type TextSubmissionSurface,
  type TextSubmissionTarget,
} from "@pirate/application";
import type {
  RestrictedTextModerationEvidenceV1,
  TextModerationPolicySnapshotV2,
  TextPostCommitInputV2,
  TextPostStoreServiceV2,
} from "@pirate/application/text-moderation-runtime";
import {
  MODERATION_POLICY_CATEGORIES_V1,
  type ModerationPolicyDecisionV1,
  type ModerationPolicyTableV1,
} from "@pirate/contracts";
import {
  canonicalTextModerationInput,
  publicTextPublicationResult,
  type TextModerationEvaluation,
  textContentSubmissionInvariant,
  textModerationEvaluationInvariant,
} from "@pirate/domain";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;
type StoreFailure = TextPostRepositoryFailure | ControlPlaneError;
type ReplayInput = Parameters<TextPostStore["Service"]["replay"]>[0];
type CommitInput = TextPostCommitInputV2;
type GetInput = Parameters<TextPostStore["Service"]["getForAuthor"]>[0];
type AuthorityInput = Parameters<TextPostStore["Service"]["checkAuthority"]>[0];
type RepositoryService = {
  readonly checkAuthority: (
    input: AuthorityInput,
  ) => Effect.Effect<void, StoreFailure, ControlPlaneDb>;
  readonly replay: (
    input: ReplayInput,
  ) => Effect.Effect<
    import("@pirate/application").TextPostReplayOutcome,
    StoreFailure,
    ControlPlaneDb
  >;
  readonly commitTerminal: (
    input: CommitInput,
  ) => Effect.Effect<TextPostCommitOutcome, StoreFailure, ControlPlaneDb>;
  readonly readModerationPolicy: (input: {
    readonly communityId: string;
  }) => Effect.Effect<TextModerationPolicySnapshotV2, StoreFailure, ControlPlaneDb>;
  readonly getForAuthor: (
    input: GetInput,
  ) => Effect.Effect<TextPostSubmissionDocument | null, StoreFailure, ControlPlaneDb>;
  readonly resolveCommentTarget: (input: {
    readonly surface: "comment" | "reply";
    readonly targetId: string;
  }) => Effect.Effect<TextCommentTargetResolution, StoreFailure, ControlPlaneDb>;
  readonly reportComment: (input: {
    readonly commentId: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly reasonCode: CommentReportReasonCode;
    readonly requestHash: string;
  }) => Effect.Effect<CommentReportOutcome, StoreFailure, ControlPlaneDb>;
  readonly moderateCaseAction: (input: {
    readonly caseRef: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly action: ModerationAction;
    readonly requestHash: string;
  }) => Effect.Effect<ModerationActionOutcome, StoreFailure, ControlPlaneDb>;
};

const HASH = /^[0-9a-f]{64}$/u;
const failure = (
  operation: "authority" | "replay" | "commit" | "get" | "resolve-target" | "report" | "action",
  reason:
    | "not-found"
    | "membership-required"
    | "comments-locked"
    | "reply-depth-exceeded"
    | "idempotency-conflict"
    | "action-conflict"
    | "constraint"
    | "invalid-row",
) => new TextPostRepositoryError({ operation, reason });
const failureWithSubmission = (
  operation: "report" | "action",
  reason:
    | "not-found"
    | "membership-required"
    | "idempotency-conflict"
    | "action-conflict"
    | "constraint"
    | "invalid-row",
  submissionId: string,
) => new TextPostRepositoryError({ operation, reason, submissionId });

const stringValue = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const booleanValue = (row: Row, key: string): boolean | null => {
  const value = row[key];
  return typeof value === "boolean" ? value : null;
};
const safeIntegerValue = (row: Row, key: string): number | null => {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
};
const validId = (value: string | null): value is string =>
  value !== null && value.length > 0 && value.trim() === value && !value.includes("\u0000");
const validHash = (value: string | null): value is string => value !== null && HASH.test(value);
const POLICY_DECISIONS = new Set<ModerationPolicyDecisionV1>(["permit", "review", "block"]);

const policyTable = (rows: readonly Row[]): ModerationPolicyTableV1 | null => {
  if (rows.length !== MODERATION_POLICY_CATEGORIES_V1.length) return null;
  const values: Partial<
    Record<(typeof MODERATION_POLICY_CATEGORIES_V1)[number], ModerationPolicyDecisionV1>
  > = {};
  for (const row of rows) {
    const category = stringValue(row, "category");
    const decision = stringValue(row, "decision") as ModerationPolicyDecisionV1 | null;
    if (
      category === null ||
      !MODERATION_POLICY_CATEGORIES_V1.includes(
        category as (typeof MODERATION_POLICY_CATEGORIES_V1)[number],
      ) ||
      decision === null ||
      !POLICY_DECISIONS.has(decision) ||
      category in values
    ) {
      return null;
    }
    values[category as (typeof MODERATION_POLICY_CATEGORIES_V1)[number]] = decision;
  }
  return MODERATION_POLICY_CATEGORIES_V1.every((category) => values[category] !== undefined)
    ? (values as ModerationPolicyTableV1)
    : null;
};
const iso = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const decodeBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array && value.byteLength > 0) return value;
  if (typeof value === "string" && value.length > 0) return new TextEncoder().encode(value);
  return null;
};

const snapshotFromBytes = (row: Row): TextPostSubmissionDocument | null => {
  const bytes = decodeBytes(row.response_snapshot_bytes);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== "object" || value === null) return null;
    const snapshot = value as TextPostSubmissionDocument;
    return textContentSubmissionInvariant(snapshot) === null ? snapshot : null;
  } catch {
    return null;
  }
};

const currentSnapshot = (row: Row): TextPostSubmissionDocument | null => {
  const submissionId = stringValue(row, "submission_id");
  const surface = stringValue(row, "surface");
  const status = stringValue(row, "status");
  const createdAt = iso(row, "created_at");
  const updatedAt = iso(row, "updated_at");
  const publicReason = stringValue(row, "public_reason_code");
  const postId = stringValue(row, "published_post_id");
  const reviewRef = stringValue(row, "review_ref");
  if (
    !validId(submissionId) ||
    !["text_post", "comment", "reply"].includes(surface ?? "") ||
    !["published", "manual_review", "blocked"].includes(status ?? "") ||
    createdAt === null ||
    updatedAt === null
  )
    return null;
  const typedStatus = status as "published" | "manual_review" | "blocked";
  const typedSurface = surface as TextSubmissionSurface;
  const snapshot: TextPostSubmissionDocument = {
    submission_id: submissionId,
    href: `/text-content-submissions/${submissionId}`,
    surface: typedSurface,
    status: typedStatus,
    result:
      typedStatus === "published"
        ? { decision: "allow", reason_code: null }
        : typedStatus === "blocked"
          ? { decision: "blocked", reason_code: "policy_violation" }
          : {
              decision: "manual_review",
              reason_code:
                publicReason === "moderation_unavailable"
                  ? "moderation_unavailable"
                  : "review_required",
            },
    published_resource:
      typedStatus === "published"
        ? typedSurface === "text_post" && validId(postId)
          ? { kind: "post", post_id: postId, href: `/posts/${postId}` }
          : typedSurface !== "text_post" && validId(stringValue(row, "published_comment_id"))
            ? {
                kind: "comment",
                comment_id: stringValue(row, "published_comment_id") as string,
                href: `/comments/${stringValue(row, "published_comment_id")}`,
              }
            : null
        : null,
    review_ref: typedStatus === "manual_review" && validId(reviewRef) ? reviewRef : null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
  return textContentSubmissionInvariant(snapshot) === null ? snapshot : null;
};

const finalByKey = (
  transaction: Transaction,
  input: {
    readonly actorUserId: string;
    readonly personaId: string;
    readonly idempotencyKey: string;
    readonly surface: TextSubmissionSurface;
  },
  lock: boolean,
) =>
  transaction.execute<Row>({
    label: "text-submission.replay",
    text: `SELECT community_id, submission_id, actor_user_id, surface, idempotency_key,
                  request_hash, status, public_reason_code, published_post_id,
                  published_comment_id, review_ref, created_at, updated_at,
                  response_snapshot_bytes, response_snapshot_sha256
             FROM text_content_submissions
            WHERE actor_account_id = $1 AND author_persona_id = $2
              AND surface = $3 AND idempotency_key = $4
            ${lock ? "FOR UPDATE" : ""}`,
    values: [input.actorUserId, input.personaId, input.surface, input.idempotencyKey],
    readonly: !lock,
  });

const finalById = (transaction: Transaction, submissionId: string, actorUserId?: string) =>
  transaction.execute<Row>({
    label: "text-submission.final-by-id",
    text: `SELECT community_id, submission_id, actor_user_id, surface, idempotency_key,
                  request_hash, status, public_reason_code, published_post_id,
                  published_comment_id, review_ref, created_at, updated_at,
                  response_snapshot_bytes, response_snapshot_sha256
             FROM text_content_submissions
            WHERE submission_id = $1 ${actorUserId === undefined ? "" : "AND actor_user_id = $2"}
            FOR UPDATE`,
    values: actorUserId === undefined ? [submissionId] : [submissionId, actorUserId],
    readonly: false,
  });

const lockKey = (transaction: Transaction, value: string) =>
  transaction.execute({
    label: "text-post.lock-idempotency",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    values: [value],
    readonly: false,
  });

const idempotencyLockKey = (
  actorUserId: string,
  personaId: string,
  surface: TextSubmissionSurface,
  key: string,
): string => JSON.stringify([actorUserId, personaId, surface, key]);

const moderationPolicySnapshot = (
  db: Transaction,
  communityId: string,
  lock: boolean,
): Effect.Effect<TextModerationPolicySnapshotV2, StoreFailure> =>
  Effect.gen(function* () {
    const provider = yield* db.execute<Row>({
      label: "text-moderation.policy.provider",
      text: `SELECT pointer.policy_revision_id, revision.policy_hash
               FROM text_moderation_policy_current AS pointer
               JOIN text_moderation_policy_revisions AS revision
                 ON revision.policy_revision_id = pointer.policy_revision_id
              WHERE pointer.singleton = TRUE
              ${lock ? "FOR UPDATE OF pointer" : ""}`,
      values: [],
      readonly: !lock,
    });
    const floor = yield* db.execute<Row>({
      label: "text-moderation.policy.platform-floor",
      text: `SELECT pointer.policy_revision_id, pointer.policy_hash,
                    category.category, category.decision
               FROM moderation_platform_floor_current AS pointer
               JOIN moderation_platform_floor_category_decisions AS category
                 ON category.policy_revision_id = pointer.policy_revision_id
              WHERE pointer.singleton = TRUE
              ORDER BY moderation_policy_category_ordinal_v1(category.category)
              ${lock ? "FOR UPDATE OF pointer" : ""}`,
      values: [],
      readonly: !lock,
    });
    const community = yield* db.execute<Row>({
      label: "text-moderation.policy.community",
      text: `SELECT pointer.policy_revision_id, pointer.policy_hash,
                    category.category, category.decision
               FROM community_moderation_policy_current AS pointer
               JOIN community_moderation_policy_category_decisions AS category
                 ON category.community_id = pointer.community_id
                AND category.policy_revision_id = pointer.policy_revision_id
              WHERE pointer.community_id = $1
              ORDER BY moderation_policy_category_ordinal_v1(category.category)
              ${lock ? "FOR UPDATE OF pointer" : ""}`,
      values: [communityId],
      readonly: !lock,
    });
    const providerRow = provider.rows[0] as Row | undefined;
    const floorRow = floor.rows[0] as Row | undefined;
    const communityRow = community.rows[0] as Row | undefined;
    const providerRevision =
      providerRow === undefined ? null : stringValue(providerRow, "policy_revision_id");
    const providerHash = providerRow === undefined ? null : stringValue(providerRow, "policy_hash");
    const platformRevision =
      floorRow === undefined ? null : stringValue(floorRow, "policy_revision_id");
    const platformHash = floorRow === undefined ? null : stringValue(floorRow, "policy_hash");
    const communityRevision =
      communityRow === undefined ? null : stringValue(communityRow, "policy_revision_id");
    const communityHash =
      communityRow === undefined ? null : stringValue(communityRow, "policy_hash");
    const platformPolicy = policyTable(floor.rows);
    const communityPolicy = policyTable(community.rows);
    if (
      provider.rows.length !== 1 ||
      !validId(providerRevision) ||
      !validHash(providerHash) ||
      !validId(platformRevision) ||
      !validHash(platformHash) ||
      platformPolicy === null ||
      !validId(communityRevision) ||
      !validHash(communityHash) ||
      communityPolicy === null
    ) {
      return yield* Effect.fail(failure("commit", "invalid-row"));
    }
    return {
      policy_revision: providerRevision,
      policy_hash: providerHash,
      platform_policy_revision: platformRevision,
      platform_policy_hash: platformHash,
      platform_policy: platformPolicy,
      community_policy_revision: communityRevision,
      community_policy_hash: communityHash,
      community_policy: communityPolicy,
    };
  });

const authority = (
  transaction: Transaction,
  communityId: string,
  actorUserId: string,
): Effect.Effect<TextModerationPolicySnapshotV2, StoreFailure> =>
  Effect.gen(function* () {
    const community = yield* transaction.execute<Row>({
      label: "text-post.commit.lock-community",
      text: "SELECT community_id FROM communities WHERE community_id = $1 AND status = 'active' FOR UPDATE",
      values: [communityId],
      readonly: false,
    });
    if (community.rows.length !== 1) return yield* Effect.fail(failure("commit", "not-found"));
    const membership = yield* transaction.execute<Row>({
      label: "text-post.commit.lock-membership",
      text: "SELECT status FROM community_memberships WHERE community_id = $1 AND user_id = $2 FOR UPDATE",
      values: [communityId, actorUserId],
      readonly: false,
    });
    if (
      membership.rows.length !== 1 ||
      stringValue(membership.rows[0] as Row, "status") !== "member"
    )
      return yield* Effect.fail(failure("commit", "membership-required"));
    const activeEffect = yield* transaction.execute<Row>({
      label: "text-post.commit.active-community-effect",
      text: "SELECT active_community_effect($1, $2) AS allowed",
      values: [communityId, actorUserId],
      readonly: true,
    });
    if (
      activeEffect.rows.length !== 1 ||
      booleanValue(activeEffect.rows[0] as Row, "allowed") !== true
    )
      return yield* Effect.fail(failure("commit", "membership-required"));
    return yield* moderationPolicySnapshot(transaction, communityId, true);
  });

const lockCommentTarget = (
  transaction: Transaction,
  target: Extract<TextSubmissionTarget, { readonly surface: "comment" | "reply" }>,
): Effect.Effect<{ readonly parentDepth: number }, StoreFailure> =>
  Effect.gen(function* () {
    const post = yield* transaction.execute<Row>({
      label: "text-submission.commit.lock-comment-post",
      text: `SELECT community_id, post_id, status, comments_locked
                FROM posts
               WHERE community_id = $1 AND post_id = $2
               FOR UPDATE`,
      values: [target.communityId, target.postId],
      readonly: false,
    });
    const postRow = post.rows[0] as Row | undefined;
    if (
      post.rows.length !== 1 ||
      postRow === undefined ||
      stringValue(postRow, "status") !== "published"
    )
      return yield* Effect.fail(failure("commit", "not-found"));
    if (booleanValue(postRow, "comments_locked") === true)
      return yield* Effect.fail(failure("commit", "comments-locked"));
    if (target.surface === "comment") return { parentDepth: -1 };

    const parent = yield* transaction.execute<Row>({
      label: "text-submission.commit.lock-parent-comment",
      text: `SELECT community_id, post_id, comment_id, status, depth
                FROM comments
               WHERE community_id = $1 AND comment_id = $2
               FOR UPDATE`,
      values: [target.communityId, target.parentCommentId],
      readonly: false,
    });
    const parentRow = parent.rows[0] as Row | undefined;
    const parentDepth = parentRow === undefined ? null : safeIntegerValue(parentRow, "depth");
    if (
      parent.rows.length !== 1 ||
      parentRow === undefined ||
      stringValue(parentRow, "post_id") !== target.postId ||
      stringValue(parentRow, "status") !== "published" ||
      parentDepth === null
    )
      return yield* Effect.fail(failure("commit", "not-found"));
    if (parentDepth >= 8) return yield* Effect.fail(failure("commit", "reply-depth-exceeded"));
    return { parentDepth };
  });

const replayRow = (
  row: Row,
  requestHash: string,
):
  | { readonly kind: "replay"; readonly snapshot: TextPostSubmissionDocument }
  | { readonly kind: "conflict"; readonly submissionId: string }
  | null => {
  const submissionId = stringValue(row, "submission_id");
  const storedHash = stringValue(row, "request_hash");
  if (!validId(submissionId) || !validHash(storedHash)) return null;
  if (storedHash !== requestHash) return { kind: "conflict", submissionId };
  const snapshot = snapshotFromBytes(row);
  return snapshot === null ? null : { kind: "replay", snapshot };
};

const actorInputValid = (actor: M2Actor, communityId: string, key: string, hash: string): boolean =>
  actor.kind !== "agent" &&
  validId(actor.userId) &&
  validId(communityId) &&
  validId(key) &&
  validHash(hash);
const makeId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

const commentBodyValid = (
  body: unknown,
): body is Readonly<{
  readonly idempotency_key: string;
  readonly persona_id: string;
  readonly body: string;
}> => {
  if (typeof body !== "object" || body === null) return false;
  const value = body as Record<string, unknown>;
  return (
    typeof value.idempotency_key === "string" &&
    value.idempotency_key.trim() !== "" &&
    typeof value.persona_id === "string" &&
    validId(value.persona_id) &&
    typeof value.body === "string" &&
    value.body.trim() !== ""
  );
};

const targetFor = (input: CommitInput): TextSubmissionTarget =>
  input.target ?? { surface: "text_post", communityId: input.communityId };

const requestHashValue = (input: CommitInput, target: TextSubmissionTarget): unknown =>
  target.surface === "text_post"
    ? { community_id: input.communityId, body: input.body }
    : {
        endpoint: target.surface,
        community_id: input.communityId,
        post_id: target.postId,
        ...(target.surface === "reply" ? { parent_comment_id: target.parentCommentId } : {}),
        body: input.body,
      };

const responseSnapshot = (input: {
  readonly submissionId: string;
  readonly surface: TextSubmissionSurface;
  readonly status: "published" | "manual_review" | "blocked";
  readonly reasonCode: "review_required" | "moderation_unavailable" | "policy_violation" | null;
  readonly postId: string | null;
  readonly commentId: string | null;
  readonly reviewRef: string | null;
  readonly at: string;
}): TextPostSubmissionDocument => ({
  submission_id: input.submissionId,
  href: `/text-content-submissions/${input.submissionId}`,
  surface: input.surface,
  status: input.status,
  result:
    input.status === "published"
      ? { decision: "allow", reason_code: null }
      : input.status === "manual_review"
        ? {
            decision: "manual_review",
            reason_code:
              input.reasonCode === "moderation_unavailable"
                ? "moderation_unavailable"
                : "review_required",
          }
        : { decision: "blocked", reason_code: "policy_violation" },
  published_resource:
    input.status === "published"
      ? input.surface === "text_post" && input.postId !== null
        ? { kind: "post", post_id: input.postId, href: `/posts/${input.postId}` }
        : input.surface !== "text_post" && input.commentId !== null
          ? { kind: "comment", comment_id: input.commentId, href: `/comments/${input.commentId}` }
          : null
      : null,
  review_ref: input.status === "manual_review" ? input.reviewRef : null,
  created_at: input.at,
  updated_at: input.at,
});

const isProviderFailure = (evaluation: TextModerationEvaluation): boolean =>
  evaluation.decision === "manual_review" &&
  evaluation.reason_codes.some((reason) => reason.startsWith("provider_"));

const restrictedEvidenceValid = (
  evidence: RestrictedTextModerationEvidenceV1,
  evaluation: Extract<TextModerationEvaluation, { readonly version: "text-moderation-v2" }>,
): boolean =>
  validId(evidence.evidence_ref) &&
  validHash(evidence.evidence_hash) &&
  evidence.evidence_ref === evaluation.evidence_ref &&
  evidence.input_sha256 === evaluation.input_sha256 &&
  validId(evidence.community_id) &&
  evidence.policy_revision === evaluation.policy_revision &&
  evidence.policy_hash === evaluation.policy_hash &&
  evidence.platform_policy_revision === evaluation.platform_policy_revision &&
  evidence.platform_policy_hash === evaluation.platform_policy_hash &&
  evidence.community_policy_revision === evaluation.community_policy_revision &&
  evidence.community_policy_hash === evaluation.community_policy_hash &&
  evidence.provider_id === "openai" &&
  evidence.requested_model === "omni-moderation-2024-09-26" &&
  evidence.returned_model === "omni-moderation-2024-09-26" &&
  evidence.inputs.length > 0;

export function makeControlPlaneTextPostRepository(): RepositoryService {
  const checkAuthority: RepositoryService["checkAuthority"] = (input) =>
    Effect.gen(function* () {
      if (
        input.actor.kind === "agent" ||
        !validId(input.actor.userId) ||
        !validId(input.communityId)
      )
        return yield* Effect.fail(failure("authority", "constraint"));
      const db = yield* ControlPlaneDb;
      const community = yield* db.execute<Row>({
        label: "text-post.preflight.community",
        text: "SELECT community_id FROM communities WHERE community_id = $1 AND status = 'active'",
        values: [input.communityId],
        readonly: true,
      });
      if (community.rows.length !== 1) return yield* Effect.fail(failure("authority", "not-found"));
      const membership = yield* db.execute<Row>({
        label: "text-post.preflight.membership",
        text: "SELECT status FROM community_memberships WHERE community_id = $1 AND user_id = $2",
        values: [input.communityId, input.actor.userId],
        readonly: true,
      });
      if (
        membership.rows.length !== 1 ||
        stringValue(membership.rows[0] as Row, "status") !== "member"
      )
        return yield* Effect.fail(failure("authority", "membership-required"));
      const activeEffect = yield* db.execute<Row>({
        label: "text-post.preflight.active-community-effect",
        text: "SELECT active_community_effect($1, $2) AS allowed",
        values: [input.communityId, input.actor.userId],
        readonly: true,
      });
      if (
        activeEffect.rows.length !== 1 ||
        booleanValue(activeEffect.rows[0] as Row, "allowed") !== true
      )
        return yield* Effect.fail(failure("authority", "membership-required"));
    });

  const replay: RepositoryService["replay"] = (input) =>
    Effect.gen(function* () {
      if (
        !actorInputValid(input.actor, input.communityId, input.idempotencyKey, input.requestHash) ||
        !validId(input.personaId)
      )
        return yield* Effect.fail(failure("replay", "constraint"));
      const surface = input.surface ?? "text_post";
      const db = yield* ControlPlaneDb;
      const result = yield* finalByKey(
        db,
        {
          actorUserId: input.actor.userId,
          personaId: input.personaId,
          idempotencyKey: input.idempotencyKey,
          surface,
        },
        false,
      );
      if (result.rows.length > 1) return yield* Effect.fail(failure("replay", "invalid-row"));
      if (result.rows.length === 0) return { kind: "none" as const };
      const outcome = replayRow(result.rows[0] as Row, input.requestHash);
      return outcome === null ? yield* Effect.fail(failure("replay", "invalid-row")) : outcome;
    });

  const readModerationPolicy: RepositoryService["readModerationPolicy"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.communityId)) {
        return yield* Effect.fail(failure("commit", "constraint"));
      }
      const db = yield* ControlPlaneDb;
      return yield* moderationPolicySnapshot(db, input.communityId, false);
    });

  const commitTerminal: RepositoryService["commitTerminal"] = (input) =>
    Effect.gen(function* () {
      const target = targetFor(input);
      const surface = target.surface;
      const body = input.body as CreatePostBody;
      const targetValid =
        target.communityId === input.communityId &&
        (surface === "text_post"
          ? true
          : validId(target.postId) && (surface === "comment" || validId(target.parentCommentId)));
      const bodyValid =
        surface === "text_post"
          ? body.post_type === "text" &&
            body.idempotency_key === input.idempotencyKey &&
            body.persona_id === input.personaId
          : commentBodyValid(input.body) &&
            input.body.idempotency_key === input.idempotencyKey &&
            input.body.persona_id === input.personaId;
      if (
        !actorInputValid(input.actor, input.communityId, input.idempotencyKey, input.requestHash) ||
        !validId(input.personaId) ||
        !validId(input.operationId) ||
        !targetValid ||
        input.moderationInput.surface !== surface ||
        !bodyValid
      )
        return yield* Effect.fail(failure("commit", "constraint"));
      const canonicalRequestHash = yield* canonicalBodyHash(requestHashValue(input, target)).pipe(
        Effect.mapError(() => failure("commit", "constraint")),
      );
      if (canonicalRequestHash !== input.requestHash)
        return yield* Effect.fail(failure("commit", "constraint"));
      const canonical = canonicalTextModerationInput(input.moderationInput);
      if (
        canonical.kind !== "accepted" ||
        canonical.sha256 !== input.evaluation.input_sha256 ||
        (surface === "text_post" ? (body.title ?? null) : null) !== input.moderationInput.title ||
        body.body !== input.moderationInput.body
      )
        return yield* Effect.fail(failure("commit", "constraint"));
      const providerFailure = isProviderFailure(input.evaluation);
      const emptyPolicy =
        input.evaluation.policy_revision === "" && input.evaluation.policy_hash === "";
      if (
        (textModerationEvaluationInvariant(input.evaluation) !== null &&
          !(input.evaluation.version === "text-moderation-v1" && providerFailure && emptyPolicy)) ||
        (input.evaluation.version === "text-moderation-v2" &&
          (providerFailure
            ? input.restrictedEvidence !== undefined || input.evaluation.evidence_ref !== null
            : input.restrictedEvidence === undefined ||
              input.restrictedEvidence.community_id !== input.communityId ||
              !restrictedEvidenceValid(input.restrictedEvidence, input.evaluation)))
      )
        return yield* Effect.fail(failure("commit", "constraint"));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          // The advisory lock is only a contention fence; it is not a durable
          // reservation. Every accepted request still gets exactly one row.
          yield* lockKey(
            transaction,
            idempotencyLockKey(input.actor.userId, input.personaId, surface, input.idempotencyKey),
          );
          const persona = yield* transaction.execute({
            label: "text-post.commit.persona-authority",
            text: `SELECT 1 FROM personas
                    WHERE account_id=$1 AND persona_id=$2 AND status='active'
                    FOR SHARE`,
            values: [input.actor.userId, input.personaId],
            readonly: false,
          });
          if (persona.rows.length !== 1) return yield* Effect.fail(failure("commit", "not-found"));
          const existing = yield* finalByKey(
            transaction,
            {
              actorUserId: input.actor.userId,
              personaId: input.personaId,
              idempotencyKey: input.idempotencyKey,
              surface,
            },
            true,
          );
          if (existing.rows.length > 1) return yield* Effect.fail(failure("commit", "invalid-row"));
          if (existing.rows.length === 1) {
            const outcome = replayRow(existing.rows[0] as Row, input.requestHash);
            if (outcome === null) return yield* Effect.fail(failure("commit", "invalid-row"));
            return outcome;
          }

          const current = yield* authority(transaction, input.communityId, input.actor.userId);
          const targetState =
            target.surface === "text_post"
              ? { parentDepth: -1 }
              : yield* lockCommentTarget(transaction, target);
          const evaluation =
            input.evaluation.version === "text-moderation-v1" &&
            providerFailure &&
            input.evaluation.policy_revision === "" &&
            input.evaluation.policy_hash === ""
              ? {
                  ...input.evaluation,
                  policy_revision: current.policy_revision,
                  policy_hash: current.policy_hash,
                }
              : input.evaluation;
          if (
            evaluation.policy_revision !== current.policy_revision ||
            evaluation.policy_hash !== current.policy_hash ||
            (evaluation.version === "text-moderation-v2" &&
              (evaluation.platform_policy_revision !== current.platform_policy_revision ||
                evaluation.platform_policy_hash !== current.platform_policy_hash ||
                evaluation.community_policy_revision !== current.community_policy_revision ||
                evaluation.community_policy_hash !== current.community_policy_hash))
          )
            return {
              kind: "policy-stale" as const,
              policyRevision: current.policy_revision,
              policyHash: current.policy_hash,
            };
          const publicResult = publicTextPublicationResult(evaluation);
          if (publicResult === null) return yield* Effect.fail(failure("commit", "constraint"));
          const nowResult = yield* transaction.execute<Row>({
            label: "text-post.commit.database-clock",
            text: "SELECT clock_timestamp() AS now",
            values: [],
            readonly: true,
          });
          const at = iso(nowResult.rows[0] as Row, "now");
          if (at === null) return yield* Effect.fail(failure("commit", "invalid-row"));
          const submissionId = makeId("sub");
          const status =
            evaluation.decision === "allow"
              ? ("published" as const)
              : evaluation.decision === "manual_review"
                ? ("manual_review" as const)
                : ("blocked" as const);
          const postId = surface === "text_post" && status === "published" ? makeId("post") : null;
          const commentId =
            surface !== "text_post" && status === "published" ? makeId("comment") : null;
          const targetPostId = target.surface === "text_post" ? null : target.postId;
          const targetParentCommentId = target.surface === "reply" ? target.parentCommentId : null;
          const reviewRef = status === "manual_review" ? makeId("review") : null;
          const snapshot = responseSnapshot({
            submissionId,
            surface,
            status,
            reasonCode: publicResult.reason_code,
            postId,
            commentId,
            reviewRef,
            at,
          });
          if (textContentSubmissionInvariant(snapshot) !== null)
            return yield* Effect.fail(failure("commit", "invalid-row"));
          const bytes = new TextEncoder().encode(JSON.stringify(snapshot));

          if (
            evaluation.version === "text-moderation-v2" &&
            input.restrictedEvidence !== undefined
          ) {
            const evidence = input.restrictedEvidence;
            const categories = Object.fromEntries(
              evidence.inputs.map((entry, index) => [
                `${index}:${entry.input_sha256}`,
                entry.categories,
              ]),
            );
            const scores = Object.fromEntries(
              evidence.inputs.map((entry, index) => [
                `${index}:${entry.input_sha256}`,
                entry.scores,
              ]),
            );
            const appliedInputTypes = Object.fromEntries(
              evidence.inputs.map((entry, index) => [
                `${index}:${entry.input_sha256}`,
                entry.applied_input_types,
              ]),
            );
            const inputHashes = evidence.inputs.map((entry) => entry.input_sha256);
            yield* transaction.execute({
              label: "text-post.commit.restricted-evidence",
              text: `INSERT INTO text_moderation_evidence (
                  evidence_ref, provider_id, requested_model_identifier,
                  response_model_identifier, outcome, normalized_categories,
                  normalized_scores, applied_input_types, input_sha256,
                  input_hashes, evidence_hash, response_sha256, community_id,
                  policy_revision_id, policy_hash,
                  platform_policy_revision_id, platform_policy_hash,
                  community_policy_revision_id, community_policy_hash
                ) VALUES (
                  $1, $2, $3, $4, 'evaluated', $5::jsonb, $6::jsonb, $7::jsonb,
                  $8, $9::jsonb, $10, $10, $11, $12, $13, $14, $15, $16, $17
                ) ON CONFLICT (evidence_ref) DO NOTHING`,
              values: [
                evidence.evidence_ref,
                evidence.provider_id,
                evidence.requested_model,
                evidence.returned_model,
                JSON.stringify(categories),
                JSON.stringify(scores),
                JSON.stringify(appliedInputTypes),
                evidence.input_sha256,
                JSON.stringify(inputHashes),
                evidence.evidence_hash,
                evidence.community_id,
                evidence.policy_revision,
                evidence.policy_hash,
                evidence.platform_policy_revision,
                evidence.platform_policy_hash,
                evidence.community_policy_revision,
                evidence.community_policy_hash,
              ],
              readonly: false,
            });
            const agreed = yield* transaction.execute({
              label: "text-post.commit.restricted-evidence-agreement",
              text: `SELECT evidence_ref FROM text_moderation_evidence
                      WHERE evidence_ref = $1
                        AND provider_id = $2
                        AND requested_model_identifier = $3
                        AND response_model_identifier = $4
                        AND outcome = 'evaluated'
                        AND normalized_categories = $5::jsonb
                        AND normalized_scores = $6::jsonb
                        AND applied_input_types = $7::jsonb
                        AND input_sha256 = $8
                        AND input_hashes = $9::jsonb
                        AND evidence_hash = $10
                        AND response_sha256 = $10
                        AND community_id = $11
                        AND policy_revision_id = $12 AND policy_hash = $13
                        AND platform_policy_revision_id = $14 AND platform_policy_hash = $15
                        AND community_policy_revision_id = $16 AND community_policy_hash = $17`,
              values: [
                evidence.evidence_ref,
                evidence.provider_id,
                evidence.requested_model,
                evidence.returned_model,
                JSON.stringify(categories),
                JSON.stringify(scores),
                JSON.stringify(appliedInputTypes),
                evidence.input_sha256,
                JSON.stringify(inputHashes),
                evidence.evidence_hash,
                evidence.community_id,
                evidence.policy_revision,
                evidence.policy_hash,
                evidence.platform_policy_revision,
                evidence.platform_policy_hash,
                evidence.community_policy_revision,
                evidence.community_policy_hash,
              ],
              readonly: false,
            });
            if (agreed.rows.length !== 1) {
              return yield* Effect.fail(failure("commit", "invalid-row"));
            }
          }

          if (postId !== null) {
            yield* transaction.execute({
              label: "text-post.commit.post",
              text: `INSERT INTO posts
                (community_id, post_id, author_user_id, author_persona_id,
                 post_type, status, visibility,
                 title, body, created_at, updated_at, idempotency_key, idempotency_body_hash)
               VALUES ($1, $2, $3, $4, 'text', 'published', 'public', $5, $6, $7, $7, $8, $9)`,
              values: [
                input.communityId,
                postId,
                input.actor.userId,
                input.personaId,
                input.moderationInput.title,
                input.moderationInput.body,
                at,
                input.idempotencyKey,
                input.requestHash,
              ],
              readonly: false,
            });
          }
          if (commentId !== null) {
            const commentTarget = target.surface === "text_post" ? null : target;
            if (commentTarget === null) return yield* Effect.fail(failure("commit", "invalid-row"));
            const parentCommentId =
              commentTarget.surface === "reply" ? commentTarget.parentCommentId : null;
            const depth = surface === "comment" ? 0 : targetState.parentDepth + 1;
            yield* transaction.execute({
              label: "text-submission.commit.comment",
              text: `INSERT INTO comments (
                  community_id, comment_id, post_id, parent_comment_id,
                  author_user_id, author_persona_id,
                  status, body, created_at, updated_at, idempotency_key, idempotency_body_hash,
                  depth, reply_count
                ) VALUES ($1, $2, $3, $4, $5, $6, 'published', $7, $8, $8, $9, $10, $11, 0)`,
              values: [
                input.communityId,
                commentId,
                commentTarget.postId,
                parentCommentId,
                input.actor.userId,
                input.personaId,
                input.moderationInput.body,
                at,
                input.idempotencyKey,
                input.requestHash,
                depth,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "text-submission.commit.comment-count",
              text: "UPDATE posts SET comment_count = comment_count + 1, updated_at = $3 WHERE community_id = $1 AND post_id = $2",
              values: [input.communityId, commentTarget.postId, at],
              readonly: false,
            });
            if (target.surface === "reply") {
              yield* transaction.execute({
                label: "text-submission.commit.reply-count",
                text: "UPDATE comments SET reply_count = reply_count + 1, updated_at = $3 WHERE community_id = $1 AND comment_id = $2",
                values: [
                  input.communityId,
                  target.surface === "reply" ? target.parentCommentId : null,
                  at,
                ],
                readonly: false,
              });
            }
            yield* transaction.execute({
              label: "text-submission.commit.comment-projection",
              text: `INSERT INTO comment_publication_projection (
                  community_id, comment_id, post_id, parent_comment_id,
                  author_user_id, author_persona_id,
                  body, depth, status, projected_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published', $9, $9)`,
              values: [
                input.communityId,
                commentId,
                commentTarget.postId,
                parentCommentId,
                input.actor.userId,
                input.personaId,
                input.moderationInput.body,
                depth,
                at,
              ],
              readonly: false,
            });
          }
          yield* transaction.execute({
            label: "text-post.commit.submission",
            text:
              evaluation.version === "text-moderation-v2"
                ? `INSERT INTO text_content_submissions (
                    community_id, submission_id, operation_id, actor_user_id, surface, idempotency_key,
                    request_hash, status, moderation_decision, public_reason_code,
                    policy_revision_id, policy_hash,
                    platform_policy_revision_id, platform_policy_hash,
                    community_policy_revision_id, community_policy_hash,
                    input_sha256, internal_reason_codes,
                    evidence_ref, published_post_id, published_comment_id, review_ref,
                    target_post_id, target_parent_comment_id,
                    created_at, updated_at, response_snapshot_bytes, response_snapshot_sha256,
                    author_persona_id, author_declared_rating, resulting_content_rating,
                    matched_categories, category_decisions, effective_policy_decision
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23, $24,
                    $25, $25, $26, encode(sha256($26), 'hex'), $27, $28, $29,
                    $30::jsonb, $31::jsonb, $32)`
                : `INSERT INTO text_content_submissions (
                    community_id, submission_id, operation_id, actor_user_id, surface, idempotency_key,
                    request_hash, status, moderation_decision, public_reason_code,
                    policy_revision_id, policy_hash,
                    platform_policy_revision_id, platform_policy_hash,
                    community_policy_revision_id, community_policy_hash,
                    input_sha256, internal_reason_codes,
                    evidence_ref, published_post_id, published_comment_id, review_ref,
                    target_post_id, target_parent_comment_id,
                    created_at, updated_at, response_snapshot_bytes, response_snapshot_sha256,
                    author_persona_id
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23, $24,
                    $25, $25, $26, encode(sha256($26), 'hex'), $27)`,
            values:
              evaluation.version === "text-moderation-v2"
                ? [
                    input.communityId,
                    submissionId,
                    input.operationId,
                    input.actor.userId,
                    surface,
                    input.idempotencyKey,
                    input.requestHash,
                    status,
                    evaluation.decision,
                    publicResult.reason_code,
                    current.policy_revision,
                    current.policy_hash,
                    evaluation.platform_policy_revision,
                    evaluation.platform_policy_hash,
                    evaluation.community_policy_revision,
                    evaluation.community_policy_hash,
                    canonical.sha256,
                    JSON.stringify(evaluation.reason_codes),
                    evaluation.evidence_ref,
                    postId,
                    commentId,
                    reviewRef,
                    targetPostId,
                    targetParentCommentId,
                    at,
                    bytes,
                    input.personaId,
                    evaluation.author_declared_rating,
                    evaluation.resulting_content_rating,
                    JSON.stringify(evaluation.matched_categories),
                    JSON.stringify(evaluation.category_decisions),
                    evaluation.effective_policy_decision,
                  ]
                : [
                    input.communityId,
                    submissionId,
                    input.operationId,
                    input.actor.userId,
                    surface,
                    input.idempotencyKey,
                    input.requestHash,
                    status,
                    evaluation.decision,
                    publicResult.reason_code,
                    current.policy_revision,
                    current.policy_hash,
                    null,
                    null,
                    null,
                    null,
                    canonical.sha256,
                    JSON.stringify(evaluation.reason_codes),
                    evaluation.evidence_ref,
                    postId,
                    commentId,
                    reviewRef,
                    targetPostId,
                    targetParentCommentId,
                    at,
                    bytes,
                    input.personaId,
                  ],
            readonly: false,
          });
          if (commentId !== null) {
            const commentTarget = target.surface === "text_post" ? null : target;
            if (commentTarget === null) return yield* Effect.fail(failure("commit", "invalid-row"));
            const parentCommentId =
              commentTarget.surface === "reply" ? commentTarget.parentCommentId : null;
            const outboxEvents = [
              [
                "comment_published",
                { comment_id: commentId, post_id: commentTarget.postId },
              ] as const,
              [
                "comment_notification",
                { comment_id: commentId, parent_comment_id: parentCommentId },
              ] as const,
              [
                "comment_cache_invalidation",
                { comment_id: commentId, post_id: commentTarget.postId },
              ] as const,
            ];
            for (const [eventType, payload] of outboxEvents) {
              yield* transaction.execute({
                label: `text-submission.commit.outbox.${eventType}`,
                text: `INSERT INTO content_publication_outbox (
                    outbox_event_id, community_id, submission_id, comment_id, event_type,
                    effect_key, payload, created_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
                values: [
                  makeId("outbox"),
                  input.communityId,
                  submissionId,
                  commentId,
                  eventType,
                  `${submissionId}:${eventType}`,
                  JSON.stringify(payload),
                  at,
                ],
                readonly: false,
              });
            }
          }
          if (surface === "text_post" && postId !== null) {
            yield* transaction.execute({
              label: "text-post.commit.home-feed",
              text: `INSERT INTO home_feed_projection
                (community_id, feed_item_id, post_id, rank_score, projected_at)
               VALUES ($1, $2, $3, 0, $4)`,
              values: [input.communityId, makeId("feed"), postId, at],
              readonly: false,
            });
          }
          if (status === "manual_review" && reviewRef !== null) {
            yield* transaction.execute({
              label: "text-post.commit.held-revision",
              text: `INSERT INTO text_content_held_revisions
                (community_id, held_revision_id, submission_id, title, body, content_sha256, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              values: [
                input.communityId,
                makeId("held"),
                submissionId,
                input.moderationInput.title,
                input.moderationInput.body,
                canonical.sha256,
                at,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "text-post.commit.review-case",
              text: `INSERT INTO text_moderation_cases
                (community_id, case_id, submission_id, status,
                 platform_policy_revision_id, platform_policy_hash,
                 community_policy_revision_id, community_policy_hash,
                 created_at, updated_at)
               VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $8)`,
              values: [
                input.communityId,
                reviewRef,
                submissionId,
                evaluation.version === "text-moderation-v2"
                  ? evaluation.platform_policy_revision
                  : null,
                evaluation.version === "text-moderation-v2"
                  ? evaluation.platform_policy_hash
                  : null,
                evaluation.version === "text-moderation-v2"
                  ? evaluation.community_policy_revision
                  : null,
                evaluation.version === "text-moderation-v2"
                  ? evaluation.community_policy_hash
                  : null,
                at,
              ],
              readonly: false,
            });
            if (surface === "comment" || surface === "reply") {
              yield* transaction.execute({
                label: "text-post.commit.comment-moderation-case",
                text: `INSERT INTO comment_moderation_cases
                  (case_ref, community_id, submission_id, source, text_case_id, status, created_at, updated_at)
                 VALUES ($1, $2, $3, 'automated', $1, 'open', $4, $4)`,
                values: [reviewRef, input.communityId, submissionId, at],
                readonly: false,
              });
            }
            if (evaluation.version === "text-moderation-v2") {
              yield* transaction.execute({
                label: "text-post.commit.owner-moderation-case-v2",
                text: `INSERT INTO community_moderation_cases_v2 (
                    case_ref, community_id, submission_id, target_type,
                    target_resource_id, source, visibility, view_state,
                    target_status, case_revision, created_at, updated_at
                  ) VALUES ($1, $2, $3, $4, NULL, 'automatic', 'owner',
                    'open', 'held', 1, $5, $5)`,
                values: [reviewRef, input.communityId, submissionId, surface, at],
                readonly: false,
              });
            }
          }
          if (
            evaluation.version === "text-moderation-v2" &&
            status === "blocked" &&
            evaluation.reason_codes.includes("sexual_minors")
          ) {
            yield* transaction.execute({
              label: "text-post.commit.platform-hold-v2",
              text: `INSERT INTO community_moderation_cases_v2 (
                  case_ref, community_id, submission_id, target_type,
                  target_resource_id, source, visibility, view_state,
                  target_status, case_revision, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, NULL, 'platform_held', 'platform',
                  'platform_held', 'blocked', 1, $5, $5)`,
              values: [makeId("platform-hold"), input.communityId, submissionId, surface, at],
              readonly: false,
            });
          }
          return { kind: "created" as const, snapshot };
        }),
      );
    });

  const resolveCommentTarget: RepositoryService["resolveCommentTarget"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.targetId)) return { kind: "not-found" as const };
      const db = yield* ControlPlaneDb;
      if (input.surface === "comment") {
        const result = yield* db.execute<Row>({
          label: "text-submission.resolve-comment-post",
          text: "SELECT community_id, post_id, status, comments_locked FROM posts WHERE post_id = $1",
          values: [input.targetId],
          readonly: true,
        });
        const row = result.rows[0] as Row | undefined;
        if (result.rows.length !== 1 || row === undefined) return { kind: "not-found" as const };
        if (
          stringValue(row, "status") !== "published" ||
          booleanValue(row, "comments_locked") === true
        )
          return { kind: "closed" as const };
        const communityId = stringValue(row, "community_id");
        const postId = stringValue(row, "post_id");
        if (communityId === null || postId === null) return { kind: "not-found" as const };
        return {
          kind: "ready" as const,
          communityId,
          postId,
          parentCommentId: null,
          parentDepth: -1,
        };
      }
      const result = yield* db.execute<Row>({
        label: "text-submission.resolve-reply-parent",
        text: `SELECT p.community_id, p.post_id, p.status AS post_status, p.comments_locked,
                       c.comment_id, c.status AS comment_status, c.depth
                  FROM comments AS c
                  JOIN posts AS p
                    ON p.community_id = c.community_id AND p.post_id = c.post_id
                 WHERE c.comment_id = $1`,
        values: [input.targetId],
        readonly: true,
      });
      const row = result.rows[0] as Row | undefined;
      if (result.rows.length !== 1 || row === undefined) return { kind: "not-found" as const };
      const depth = safeIntegerValue(row, "depth");
      const communityId = stringValue(row, "community_id");
      const postId = stringValue(row, "post_id");
      const parentCommentId = stringValue(row, "comment_id");
      if (depth === null || communityId === null || postId === null || parentCommentId === null)
        return { kind: "not-found" as const };
      if (depth >= 8) return { kind: "depth-exceeded" as const, depth: depth + 1 };
      if (
        stringValue(row, "post_status") !== "published" ||
        stringValue(row, "comment_status") !== "published" ||
        booleanValue(row, "comments_locked") === true
      )
        return { kind: "closed" as const };
      return { kind: "ready" as const, communityId, postId, parentCommentId, parentDepth: depth };
    });

  const reportComment: RepositoryService["reportComment"] = (input) =>
    Effect.gen(function* () {
      if (
        input.actor.kind === "agent" ||
        !validId(input.actor.userId) ||
        !validId(input.commentId) ||
        !validId(input.idempotencyKey) ||
        !validHash(input.requestHash)
      )
        return yield* Effect.fail(failure("report", "constraint"));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const comment = yield* transaction.execute<Row>({
            label: "comment-report.lock-comment",
            text: `SELECT community_id, comment_id, status
                     FROM comments
                    WHERE comment_id = $1
                    FOR UPDATE`,
            values: [input.commentId],
            readonly: false,
          });
          const commentRow = comment.rows[0] as Row | undefined;
          const communityId =
            commentRow === undefined ? null : stringValue(commentRow, "community_id");
          if (
            comment.rows.length !== 1 ||
            commentRow === undefined ||
            communityId === null ||
            !["published", "hidden", "removed"].includes(stringValue(commentRow, "status") ?? "")
          )
            return yield* Effect.fail(
              failureWithSubmission("report", "not-found", input.commentId),
            );
          const submission = yield* transaction.execute<Row>({
            label: "comment-report.lock-submission",
            text: `SELECT submission_id
                     FROM text_content_submissions
                    WHERE community_id = $1 AND published_comment_id = $2
                    FOR UPDATE`,
            values: [communityId, input.commentId],
            readonly: false,
          });
          const submissionId =
            submission.rows.length === 1
              ? stringValue(submission.rows[0] as Row, "submission_id")
              : null;
          if (submissionId === null)
            return yield* Effect.fail(
              failureWithSubmission("report", "not-found", input.commentId),
            );
          const membership = yield* transaction.execute<Row>({
            label: "comment-report.check-membership",
            text: "SELECT status FROM community_memberships WHERE community_id = $1 AND user_id = $2",
            values: [communityId, input.actor.userId],
            readonly: true,
          });
          if (
            membership.rows.length !== 1 ||
            stringValue(membership.rows[0] as Row, "status") !== "member"
          )
            return yield* Effect.fail(
              failureWithSubmission("report", "membership-required", submissionId),
            );
          const existing = yield* transaction.execute<Row>({
            label: "comment-report.replay",
            text: `SELECT report_id, case_ref, status, request_hash
                      FROM comment_reports
                     WHERE reporter_user_id = $1 AND comment_id = $2 AND idempotency_key = $3
                     FOR UPDATE`,
            values: [input.actor.userId, input.commentId, input.idempotencyKey],
            readonly: false,
          });
          if (existing.rows.length > 1)
            return yield* Effect.fail(failureWithSubmission("report", "invalid-row", submissionId));
          if (existing.rows.length === 1) {
            const row = existing.rows[0] as Row;
            const reportId = stringValue(row, "report_id");
            const caseRef = stringValue(row, "case_ref");
            const status = stringValue(row, "status");
            if (
              reportId === null ||
              caseRef === null ||
              !["open", "coalesced"].includes(status ?? "")
            )
              return yield* Effect.fail(
                failureWithSubmission("report", "invalid-row", submissionId),
              );
            if (stringValue(row, "request_hash") !== input.requestHash)
              return yield* Effect.fail(
                failureWithSubmission("report", "idempotency-conflict", reportId),
              );
            return { reportId, caseRef, status: status as "open" | "coalesced" };
          }
          const openCase = yield* transaction.execute<Row>({
            label: "comment-report.find-case",
            text: `SELECT case_ref, status
                     FROM comment_moderation_cases
                    WHERE community_id = $1
                      AND submission_id = $2
                      AND source = 'report'
                      AND status = 'open'
                    FOR UPDATE`,
            values: [communityId, submissionId],
            readonly: false,
          });
          let caseRef: string;
          let reportStatus: "open" | "coalesced";
          if (openCase.rows.length === 0) {
            caseRef = makeId("case");
            const now = yield* transaction.execute<Row>({
              label: "comment-report.database-clock",
              text: "SELECT clock_timestamp() AS now",
              values: [],
              readonly: true,
            });
            const at = iso(now.rows[0] as Row, "now");
            if (at === null)
              return yield* Effect.fail(
                failureWithSubmission("report", "invalid-row", submissionId),
              );
            yield* transaction.execute({
              label: "comment-report.case",
              text: `INSERT INTO comment_moderation_cases
                (case_ref, community_id, submission_id, comment_id, source, status, created_at, updated_at)
               VALUES ($1, $2, $3, $4, 'report', 'open', $5, $5)`,
              values: [caseRef, communityId, submissionId, input.commentId, at],
              readonly: false,
            });
            reportStatus = "open";
          } else {
            const row = openCase.rows[0] as Row;
            caseRef = stringValue(row, "case_ref") ?? "";
            if (!validId(caseRef))
              return yield* Effect.fail(
                failureWithSubmission("report", "invalid-row", submissionId),
              );
            reportStatus = "coalesced";
          }
          const now = yield* transaction.execute<Row>({
            label: "comment-report.created-at",
            text: "SELECT clock_timestamp() AS now",
            values: [],
            readonly: true,
          });
          const at = iso(now.rows[0] as Row, "now");
          if (at === null)
            return yield* Effect.fail(failureWithSubmission("report", "invalid-row", submissionId));
          const reportId = makeId("report");
          yield* transaction.execute({
            label: "comment-report.insert",
            text: `INSERT INTO comment_reports
              (report_id, community_id, comment_id, case_ref, reporter_user_id,
               idempotency_key, request_hash, reason_code, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            values: [
              reportId,
              communityId,
              input.commentId,
              caseRef,
              input.actor.userId,
              input.idempotencyKey,
              input.requestHash,
              input.reasonCode,
              reportStatus,
              at,
            ],
            readonly: false,
          });
          return { reportId, caseRef, status: reportStatus };
        }),
      );
    });

  const moderateCaseAction: RepositoryService["moderateCaseAction"] = (input) =>
    Effect.gen(function* () {
      if (
        input.actor.kind === "agent" ||
        !validId(input.actor.userId) ||
        !validId(input.caseRef) ||
        !validId(input.idempotencyKey) ||
        !validHash(input.requestHash)
      )
        return yield* Effect.fail(failure("action", "constraint"));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* lockKey(
            transaction,
            JSON.stringify([
              "moderation-case-action",
              input.caseRef,
              input.actor.userId,
              input.idempotencyKey,
            ]),
          );
          const existingAction = yield* transaction.execute<Row>({
            label: "moderation-action.replay",
            text: `SELECT action.action_id, action.case_ref, action.action, action.target_status,
                          action.request_hash, cmc.submission_id
                     FROM comment_moderation_actions AS action
                     JOIN comment_moderation_cases AS cmc
                       ON cmc.community_id = action.community_id
                      AND cmc.case_ref = action.case_ref
                    WHERE action.case_ref = $1
                      AND action.actor_user_id = $2
                      AND action.idempotency_key = $3
                    FOR UPDATE OF action`,
            values: [input.caseRef, input.actor.userId, input.idempotencyKey],
            readonly: false,
          });
          if (existingAction.rows.length > 1)
            return yield* Effect.fail(failure("action", "invalid-row"));
          if (existingAction.rows.length === 1) {
            const row = existingAction.rows[0] as Row;
            const actionId = stringValue(row, "action_id");
            const caseRef = stringValue(row, "case_ref");
            const action = stringValue(row, "action") as ModerationAction | null;
            const targetStatus = stringValue(row, "target_status") as
              | "held"
              | "published"
              | "hidden"
              | "removed"
              | null;
            if (
              actionId === null ||
              caseRef === null ||
              action === null ||
              targetStatus === null ||
              stringValue(row, "request_hash") !== input.requestHash
            ) {
              return yield* Effect.fail(
                failureWithSubmission(
                  "action",
                  "idempotency-conflict",
                  stringValue(row, "submission_id") ?? input.caseRef,
                ),
              );
            }
            return { actionId, caseRef, action, targetStatus };
          }
          const caseTarget = yield* transaction.execute<Row>({
            label: "moderation-action.resolve-lock-target",
            text: `SELECT cmc.community_id, cmc.submission_id,
                          COALESCE(cmc.comment_id, s.published_comment_id) AS comment_id
                     FROM comment_moderation_cases AS cmc
                     JOIN text_content_submissions AS s
                       ON s.community_id = cmc.community_id
                      AND s.submission_id = cmc.submission_id
                    WHERE cmc.case_ref = $1`,
            values: [input.caseRef],
            readonly: true,
          });
          const targetRow = caseTarget.rows[0] as Row | undefined;
          if (caseTarget.rows.length !== 1 || targetRow === undefined)
            return yield* Effect.fail(failure("action", "not-found"));
          const targetCommunityId = stringValue(targetRow, "community_id");
          const targetSubmissionId = stringValue(targetRow, "submission_id");
          const targetCommentId = stringValue(targetRow, "comment_id");
          if (targetCommunityId === null || targetSubmissionId === null)
            return yield* Effect.fail(failure("action", "invalid-row"));
          let lockedCommentRow: Row | undefined;
          if (targetCommentId !== null) {
            const lockedComment = yield* transaction.execute<Row>({
              label: "moderation-action.lock-comment",
              text: `SELECT comment_id, post_id, parent_comment_id, status
                       FROM comments
                      WHERE community_id = $1 AND comment_id = $2
                      FOR UPDATE`,
              values: [targetCommunityId, targetCommentId],
              readonly: false,
            });
            lockedCommentRow = lockedComment.rows[0] as Row | undefined;
            if (lockedComment.rows.length !== 1 || lockedCommentRow === undefined)
              return yield* Effect.fail(failure("action", "not-found"));
          }
          const lockedSubmission = yield* transaction.execute<Row>({
            label: "moderation-action.lock-submission",
            text: `SELECT submission_id
                     FROM text_content_submissions
                    WHERE community_id = $1 AND submission_id = $2
                    FOR UPDATE`,
            values: [targetCommunityId, targetSubmissionId],
            readonly: false,
          });
          if (lockedSubmission.rows.length !== 1)
            return yield* Effect.fail(failure("action", "not-found"));
          const caseRows = yield* transaction.execute<Row>({
            label: "moderation-action.lock-case",
            text: `SELECT cmc.community_id, cmc.case_ref, cmc.status AS comment_case_status,
                          tc.case_id AS text_case_id, tc.status AS case_status,
                          s.submission_id, s.actor_user_id, s.author_persona_id,
                          s.status AS submission_status,
                          s.surface, s.idempotency_key, s.request_hash,
                          s.target_post_id, s.target_parent_comment_id,
                          s.published_comment_id, h.body AS held_body,
                          c.comment_id, c.post_id, c.parent_comment_id, c.author_user_id,
                          c.status AS comment_status, c.body AS comment_body, c.depth
                     FROM comment_moderation_cases AS cmc
                     LEFT JOIN text_moderation_cases AS tc
                       ON tc.community_id = cmc.community_id
                      AND tc.case_id = cmc.text_case_id
                      AND tc.submission_id = cmc.submission_id
                     JOIN text_content_submissions AS s
                       ON s.community_id = cmc.community_id AND s.submission_id = cmc.submission_id
                     LEFT JOIN text_content_held_revisions AS h
                       ON h.community_id = s.community_id AND h.submission_id = s.submission_id
                     LEFT JOIN comments AS c
                       ON c.community_id = s.community_id AND c.comment_id = s.published_comment_id
                    WHERE cmc.case_ref = $1
                    FOR UPDATE OF cmc`,
            values: [input.caseRef],
            readonly: false,
          });
          const row = caseRows.rows[0] as Row | undefined;
          if (caseRows.rows.length !== 1 || row === undefined)
            return yield* Effect.fail(failure("action", "not-found"));
          const communityId = stringValue(row, "community_id");
          const submissionId = stringValue(row, "submission_id");
          const submissionActorId = stringValue(row, "actor_user_id");
          const submissionPersonaId = stringValue(row, "author_persona_id");
          const submissionIdempotencyKey = stringValue(row, "idempotency_key");
          const submissionRequestHash = stringValue(row, "request_hash");
          const surface = stringValue(row, "surface");
          if (
            communityId === null ||
            submissionId === null ||
            submissionActorId === null ||
            submissionPersonaId === null ||
            submissionIdempotencyKey === null ||
            !validHash(submissionRequestHash) ||
            !["comment", "reply"].includes(surface ?? "")
          )
            return yield* Effect.fail(failure("action", "invalid-row"));
          if (communityId !== targetCommunityId || submissionId !== targetSubmissionId)
            return yield* Effect.fail(failure("action", "invalid-row"));
          const textCaseId = stringValue(row, "text_case_id");
          const isModerator = input.actor.scopes?.includes("moderator") === true;
          if (input.actor.kind !== "admin" && !isModerator)
            return yield* Effect.fail(failure("action", "not-found"));
          const commentCaseStatus = stringValue(row, "comment_case_status");
          if (commentCaseStatus !== "open")
            return yield* Effect.fail(failure("action", "action-conflict"));
          if (textCaseId !== null) {
            const textCase = yield* transaction.execute<Row>({
              label: "moderation-action.lock-text-case",
              text: "SELECT case_id, status FROM text_moderation_cases WHERE community_id = $1 AND case_id = $2 FOR UPDATE",
              values: [communityId, textCaseId],
              readonly: false,
            });
            if (
              textCase.rows.length !== 1 ||
              stringValue(textCase.rows[0] as Row, "status") !== "open"
            )
              return yield* Effect.fail(failure("action", "action-conflict"));
          }
          const submissionStatus = stringValue(row, "submission_status");
          let commentId = stringValue(row, "comment_id");
          let commentStatus = stringValue(row, "comment_status");
          let commentPostId = stringValue(row, "post_id");
          let commentParentId = stringValue(row, "parent_comment_id");
          if (commentId !== null) {
            if (lockedCommentRow === undefined || targetCommentId !== commentId)
              return yield* Effect.fail(failure("action", "invalid-row"));
            commentId = stringValue(lockedCommentRow, "comment_id");
            commentStatus = stringValue(lockedCommentRow, "status");
            commentPostId = stringValue(lockedCommentRow, "post_id");
            commentParentId = stringValue(lockedCommentRow, "parent_comment_id");
          }
          const currentStatus =
            submissionStatus === "manual_review"
              ? ("held" as const)
              : commentStatus === "published" ||
                  commentStatus === "hidden" ||
                  commentStatus === "removed"
                ? (commentStatus as "published" | "hidden" | "removed")
                : null;
          if (currentStatus === null)
            return yield* Effect.fail(failure("action", "action-conflict"));
          const targetPostId = stringValue(row, "target_post_id") ?? commentPostId;
          const targetParentCommentId =
            stringValue(row, "target_parent_comment_id") ?? commentParentId;
          if (targetPostId === null) return yield* Effect.fail(failure("action", "invalid-row"));

          const actionId = makeId("action");
          let targetStatus: "held" | "published" | "hidden" | "removed";
          if (input.action === "approve") {
            if (currentStatus !== "held" || submissionStatus !== "manual_review")
              return yield* Effect.fail(failure("action", "action-conflict"));
            const target =
              surface === "comment"
                ? { surface: "comment" as const, communityId, postId: targetPostId }
                : targetParentCommentId === null
                  ? null
                  : {
                      surface: "reply" as const,
                      communityId,
                      postId: targetPostId,
                      parentCommentId: targetParentCommentId,
                    };
            if (target === null) return yield* Effect.fail(failure("action", "invalid-row"));
            const activeEffect = yield* transaction.execute<Row>({
              label: "moderation-action.approve.active-community-effect",
              text: "SELECT active_community_effect($1, $2) AS allowed",
              values: [communityId, input.actor.userId],
              readonly: true,
            });
            if (
              activeEffect.rows.length !== 1 ||
              booleanValue(activeEffect.rows[0] as Row, "allowed") !== true
            )
              return yield* Effect.fail(
                failureWithSubmission("action", "membership-required", submissionId),
              );
            const targetState = yield* lockCommentTarget(transaction, target);
            const body = stringValue(row, "held_body");
            if (body === null || body.trim() === "")
              return yield* Effect.fail(failure("action", "invalid-row"));
            const now = yield* transaction.execute<Row>({
              label: "moderation-action.approve.database-clock",
              text: "SELECT clock_timestamp() AS now",
              values: [],
              readonly: true,
            });
            const at = iso(now.rows[0] as Row, "now");
            if (at === null) return yield* Effect.fail(failure("action", "invalid-row"));
            const newCommentId = makeId("comment");
            const depth = surface === "comment" ? 0 : targetState.parentDepth + 1;
            yield* transaction.execute({
              label: "moderation-action.approve.comment",
              text: `INSERT INTO comments (
                  community_id, comment_id, post_id, parent_comment_id,
                  author_user_id, author_persona_id,
                  status, body, created_at, updated_at, idempotency_key, idempotency_body_hash,
                  depth, reply_count
                ) VALUES ($1, $2, $3, $4, $5, $6, 'published', $7, $8, $8, $9, $10, $11, 0)`,
              values: [
                communityId,
                newCommentId,
                targetPostId,
                targetParentCommentId,
                submissionActorId,
                submissionPersonaId,
                body,
                at,
                submissionIdempotencyKey,
                submissionRequestHash,
                depth,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "moderation-action.approve.comment-count",
              text: "UPDATE posts SET comment_count = comment_count + 1, updated_at = $3 WHERE community_id = $1 AND post_id = $2",
              values: [communityId, targetPostId, at],
              readonly: false,
            });
            if (surface === "reply" && targetParentCommentId !== null) {
              yield* transaction.execute({
                label: "moderation-action.approve.reply-count",
                text: "UPDATE comments SET reply_count = reply_count + 1, updated_at = $3 WHERE community_id = $1 AND comment_id = $2",
                values: [communityId, targetParentCommentId, at],
                readonly: false,
              });
            }
            yield* transaction.execute({
              label: "moderation-action.approve.projection",
              text: `INSERT INTO comment_publication_projection (
                  community_id, comment_id, post_id, parent_comment_id,
                  author_user_id, author_persona_id,
                  body, depth, status, projected_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published', $9, $9)`,
              values: [
                communityId,
                newCommentId,
                targetPostId,
                targetParentCommentId,
                submissionActorId,
                submissionPersonaId,
                body,
                depth,
                at,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "moderation-action.approve.submission",
              text: `UPDATE text_content_submissions
                         SET status = 'published', public_reason_code = NULL,
                             published_comment_id = $2, review_ref = NULL, updated_at = $3
                       WHERE community_id = $1 AND submission_id = $4`,
              values: [communityId, newCommentId, at, submissionId],
              readonly: false,
            });
            const events = [
              ["comment_published", { comment_id: newCommentId, post_id: targetPostId }] as const,
              [
                "comment_notification",
                { comment_id: newCommentId, parent_comment_id: targetParentCommentId },
              ] as const,
              [
                "comment_cache_invalidation",
                { comment_id: newCommentId, post_id: targetPostId },
              ] as const,
            ];
            for (const [eventType, payload] of events) {
              yield* transaction.execute({
                label: `moderation-action.approve.outbox.${eventType}`,
                text: `INSERT INTO content_publication_outbox (
                    outbox_event_id, community_id, submission_id, comment_id, event_type,
                    effect_key, payload, created_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
                  ON CONFLICT DO NOTHING`,
                values: [
                  makeId("outbox"),
                  communityId,
                  submissionId,
                  newCommentId,
                  eventType,
                  `${submissionId}:${eventType}`,
                  JSON.stringify(payload),
                  at,
                ],
                readonly: false,
              });
            }
            targetStatus = "published";
          } else {
            if (commentId === null) return yield* Effect.fail(failure("action", "action-conflict"));
            if (input.action === "dismiss") {
              if (currentStatus === "held")
                return yield* Effect.fail(failure("action", "action-conflict"));
              targetStatus = currentStatus;
            } else if (input.action === "hide" || input.action === "remove") {
              if (currentStatus !== "published")
                return yield* Effect.fail(failure("action", "action-conflict"));
              targetStatus = input.action === "hide" ? "hidden" : "removed";
            } else if (input.action === "restore") {
              if (currentStatus !== "hidden" && currentStatus !== "removed")
                return yield* Effect.fail(failure("action", "action-conflict"));
              targetStatus = "published";
            } else {
              return yield* Effect.fail(failure("action", "action-conflict"));
            }
            if (input.action !== "dismiss") {
              const now = yield* transaction.execute<Row>({
                label: "moderation-action.visibility.database-clock",
                text: "SELECT clock_timestamp() AS now",
                values: [],
                readonly: true,
              });
              const at = iso(now.rows[0] as Row, "now");
              if (at === null) return yield* Effect.fail(failure("action", "invalid-row"));
              const wasPublic = currentStatus === "published";
              const isPublic = targetStatus === "published";
              yield* transaction.execute({
                label: "moderation-action.visibility.comment",
                text: "UPDATE comments SET status = $3, updated_at = $4 WHERE community_id = $1 AND comment_id = $2",
                values: [communityId, commentId, targetStatus, at],
                readonly: false,
              });
              yield* transaction.execute({
                label: "moderation-action.visibility.projection",
                text: "UPDATE comment_publication_projection SET status = $3, updated_at = $4 WHERE community_id = $1 AND comment_id = $2",
                values: [communityId, commentId, targetStatus, at],
                readonly: false,
              });
              if (wasPublic !== isPublic) {
                const delta = isPublic ? 1 : -1;
                yield* transaction.execute({
                  label: "moderation-action.visibility.comment-count",
                  text: "UPDATE posts SET comment_count = GREATEST(comment_count + $3, 0), updated_at = $4 WHERE community_id = $1 AND post_id = $2",
                  values: [communityId, targetPostId, delta, at],
                  readonly: false,
                });
                if (targetParentCommentId !== null) {
                  yield* transaction.execute({
                    label: "moderation-action.visibility.reply-count",
                    text: "UPDATE comments SET reply_count = GREATEST(reply_count + $3, 0), updated_at = $4 WHERE community_id = $1 AND comment_id = $2",
                    values: [communityId, targetParentCommentId, delta, at],
                    readonly: false,
                  });
                }
              }
              yield* transaction.execute({
                label: "moderation-action.visibility.outbox",
                text: `INSERT INTO content_publication_outbox (
                    outbox_event_id, community_id, submission_id, comment_id, event_type,
                    effect_key, payload, created_at
                  ) VALUES ($1, $2, $3, $4, 'comment_cache_invalidation', $5, $6::jsonb, $7)
                  ON CONFLICT DO NOTHING`,
                values: [
                  makeId("outbox"),
                  communityId,
                  submissionId,
                  commentId,
                  `${submissionId}:comment_cache_invalidation:${actionId}`,
                  JSON.stringify({ comment_id: commentId, status: targetStatus }),
                  at,
                ],
                readonly: false,
              });
            }
          }
          const now = yield* transaction.execute<Row>({
            label: "moderation-action.created-at",
            text: "SELECT clock_timestamp() AS now",
            values: [],
            readonly: true,
          });
          const at = iso(now.rows[0] as Row, "now");
          if (at === null) return yield* Effect.fail(failure("action", "invalid-row"));
          yield* transaction.execute({
            label: "moderation-action.insert",
            text: `INSERT INTO comment_moderation_actions
              (action_id, community_id, case_ref, actor_user_id, idempotency_key,
               request_hash, action, target_status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            values: [
              actionId,
              communityId,
              input.caseRef,
              input.actor.userId,
              input.idempotencyKey,
              input.requestHash,
              input.action,
              targetStatus,
              at,
            ],
            readonly: false,
          });
          const caseStatus =
            input.action === "dismiss"
              ? "dismissed"
              : input.action === "hide" || input.action === "remove"
                ? "blocked"
                : "approved";
          if (textCaseId !== null) {
            yield* transaction.execute({
              label: "moderation-action.resolve-text-case",
              text: `UPDATE text_moderation_cases
                         SET status = $3, resolved_by_user_id = $4, updated_at = $5
                       WHERE community_id = $1 AND case_id = $2`,
              values: [communityId, textCaseId, caseStatus, input.actor.userId, at],
              readonly: false,
            });
          }
          yield* transaction.execute({
            label: "moderation-action.resolve-comment-case",
            text: `UPDATE comment_moderation_cases
                       SET status = $3, resolved_by_user_id = $4, updated_at = $5
                     WHERE community_id = $1 AND case_ref = $2`,
            values: [communityId, input.caseRef, caseStatus, input.actor.userId, at],
            readonly: false,
          });
          return { actionId, caseRef: input.caseRef, action: input.action, targetStatus };
        }),
      );
    });

  const getForAuthor: RepositoryService["getForAuthor"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.submissionId) ||
        input.actor.kind === "agent" ||
        !validId(input.actor.userId)
      )
        return yield* Effect.fail(failure("get", "constraint"));
      const db = yield* ControlPlaneDb;
      const result = yield* finalById(db, input.submissionId, input.actor.userId);
      if (result.rows.length > 1) return yield* Effect.fail(failure("get", "invalid-row"));
      if (result.rows.length === 0) return null;
      const snapshot = currentSnapshot(result.rows[0] as Row);
      return snapshot === null ? yield* Effect.fail(failure("get", "invalid-row")) : snapshot;
    });

  return {
    checkAuthority,
    replay,
    readModerationPolicy,
    commitTerminal,
    getForAuthor,
    resolveCommentTarget,
    reportComment,
    moderateCaseAction,
  };
}

export function makeControlPlaneTextSubmissionRepository(): RepositoryService {
  return makeControlPlaneTextPostRepository();
}

export function makeControlPlaneTextSubmissionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): TextPostStore["Service"] & TextPostStoreServiceV2 {
  const repository = makeControlPlaneTextPostRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  return {
    checkAuthority: (input) => provide(repository.checkAuthority(input)),
    replay: (input) => provide(repository.replay(input)),
    readModerationPolicy: (input) => provide(repository.readModerationPolicy(input)),
    commitTerminal: (input) => provide(repository.commitTerminal(input)),
    getForAuthor: (input) => provide(repository.getForAuthor(input)),
    resolveCommentTarget: (input) => provide(repository.resolveCommentTarget(input)),
    reportComment: (input) => provide(repository.reportComment(input)),
    moderateCaseAction: (input) => provide(repository.moderateCaseAction(input)),
  };
}

export type TextSubmissionRepository = TextPostStore["Service"] & TextPostStoreServiceV2;
