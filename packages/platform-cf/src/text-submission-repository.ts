import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  canonicalBodyHash,
  type M2Actor,
  type TextPostCommitOutcome,
  type TextPostModerationEvaluation,
  TextPostRepositoryError,
  type TextPostRepositoryFailure,
  type TextPostStore,
  type TextPostSubmissionDocument,
} from "@pirate/application";
import {
  canonicalTextModerationInput,
  publicTextPublicationResult,
  type TextModerationEvaluationV1,
  textContentSubmissionInvariant,
  textModerationEvaluationInvariant,
} from "@pirate/domain";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;
type StoreFailure = TextPostRepositoryFailure | ControlPlaneError;
type ReplayInput = Parameters<TextPostStore["Service"]["replay"]>[0];
type CommitInput = Parameters<TextPostStore["Service"]["commitTerminal"]>[0];
type GetInput = Parameters<TextPostStore["Service"]["getForAuthor"]>[0];
type RepositoryService = {
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
  readonly getForAuthor: (
    input: GetInput,
  ) => Effect.Effect<TextPostSubmissionDocument | null, StoreFailure, ControlPlaneDb>;
};

const HASH = /^[0-9a-f]{64}$/u;
const failure = (
  operation: "replay" | "commit" | "get",
  reason: "not-found" | "membership-required" | "constraint" | "invalid-row",
) => new TextPostRepositoryError({ operation, reason });

const stringValue = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const validId = (value: string | null): value is string =>
  value !== null && value.length > 0 && value.trim() === value && !value.includes("\u0000");
const validHash = (value: string | null): value is string => value !== null && HASH.test(value);
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
  const status = stringValue(row, "status");
  const createdAt = iso(row, "created_at");
  const updatedAt = iso(row, "updated_at");
  const publicReason = stringValue(row, "public_reason_code");
  const postId = stringValue(row, "published_post_id");
  const reviewRef = stringValue(row, "review_ref");
  if (
    !validId(submissionId) ||
    !["published", "manual_review", "blocked"].includes(status ?? "") ||
    createdAt === null ||
    updatedAt === null
  )
    return null;
  const typedStatus = status as "published" | "manual_review" | "blocked";
  const snapshot: TextPostSubmissionDocument = {
    submission_id: submissionId,
    href: `/text-content-submissions/${submissionId}`,
    surface: "text_post",
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
      typedStatus === "published" && validId(postId)
        ? { kind: "post", post_id: postId, href: `/posts/${postId}` }
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
    readonly idempotencyKey: string;
  },
  lock: boolean,
) =>
  transaction.execute<Row>({
    label: "text-post.replay",
    text: `SELECT community_id, submission_id, actor_user_id, surface, idempotency_key,
                  request_hash, status, public_reason_code, published_post_id,
                  published_comment_id, review_ref, created_at, updated_at,
                  response_snapshot_bytes, response_snapshot_sha256
             FROM text_content_submissions
            WHERE actor_user_id = $1
              AND surface = 'text_post' AND idempotency_key = $2
            ${lock ? "FOR UPDATE" : ""}`,
    values: [input.actorUserId, input.idempotencyKey],
    readonly: !lock,
  });

const finalById = (transaction: Transaction, submissionId: string, actorUserId?: string) =>
  transaction.execute<Row>({
    label: "text-post.final-by-id",
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

const idempotencyLockKey = (actorUserId: string, key: string): string =>
  JSON.stringify([actorUserId, "text_post", key]);

const authority = (
  transaction: Transaction,
  communityId: string,
  actorUserId: string,
): Effect.Effect<{ readonly policyRevision: string; readonly policyHash: string }, StoreFailure> =>
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
    const route = yield* transaction.execute<Row>({
      label: "text-post.commit.effective-route",
      text: `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
             SELECT route.community_id
               FROM db_clock
               CROSS JOIN LATERAL effective_active_route($1, db_clock.now) AS route`,
      values: [communityId],
      readonly: true,
    });
    if (route.rows.length !== 1) return yield* Effect.fail(failure("commit", "not-found"));
    const policy = yield* transaction.execute<Row>({
      label: "text-post.commit.current-policy",
      text: `SELECT pointer.policy_revision_id, revision.policy_hash
               FROM text_moderation_policy_current AS pointer
               JOIN text_moderation_policy_revisions AS revision
                 ON revision.policy_revision_id = pointer.policy_revision_id
              WHERE pointer.singleton = TRUE
              FOR UPDATE OF pointer`,
      values: [],
      readonly: false,
    });
    const row = (policy.rows[0] ?? {}) as Row;
    const policyRevision = stringValue(row, "policy_revision_id");
    const policyHash = stringValue(row, "policy_hash");
    if (policy.rows.length !== 1 || !validId(policyRevision) || !validHash(policyHash))
      return yield* Effect.fail(failure("commit", "invalid-row"));
    return { policyRevision, policyHash };
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

const responseSnapshot = (input: {
  readonly submissionId: string;
  readonly status: "published" | "manual_review" | "blocked";
  readonly reasonCode: "review_required" | "moderation_unavailable" | "policy_violation" | null;
  readonly postId: string | null;
  readonly reviewRef: string | null;
  readonly at: string;
}): TextPostSubmissionDocument => ({
  submission_id: input.submissionId,
  href: `/text-content-submissions/${input.submissionId}`,
  surface: "text_post",
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
    input.status === "published" && input.postId !== null
      ? { kind: "post", post_id: input.postId, href: `/posts/${input.postId}` }
      : null,
  review_ref: input.status === "manual_review" ? input.reviewRef : null,
  created_at: input.at,
  updated_at: input.at,
});

const isProviderFailure = (evaluation: TextPostModerationEvaluation): boolean =>
  evaluation.decision === "manual_review" &&
  evaluation.reason_codes.some((reason) => reason.startsWith("provider_"));

export function makeControlPlaneTextPostRepository(): RepositoryService {
  const replay: RepositoryService["replay"] = (input) =>
    Effect.gen(function* () {
      if (!actorInputValid(input.actor, input.communityId, input.idempotencyKey, input.requestHash))
        return yield* Effect.fail(failure("replay", "constraint"));
      const db = yield* ControlPlaneDb;
      const result = yield* finalByKey(
        db,
        {
          actorUserId: input.actor.userId,
          idempotencyKey: input.idempotencyKey,
        },
        false,
      );
      if (result.rows.length > 1) return yield* Effect.fail(failure("replay", "invalid-row"));
      if (result.rows.length === 0) return { kind: "none" as const };
      const outcome = replayRow(result.rows[0] as Row, input.requestHash);
      return outcome === null ? yield* Effect.fail(failure("replay", "invalid-row")) : outcome;
    });

  const commitTerminal: RepositoryService["commitTerminal"] = (input) =>
    Effect.gen(function* () {
      if (
        !actorInputValid(input.actor, input.communityId, input.idempotencyKey, input.requestHash) ||
        !validId(input.operationId) ||
        input.moderationInput.surface !== "text_post" ||
        input.body.post_type !== "text" ||
        input.body.idempotency_key !== input.idempotencyKey
      )
        return yield* Effect.fail(failure("commit", "constraint"));
      const canonicalRequestHash = yield* canonicalBodyHash({
        community_id: input.communityId,
        body: input.body,
      }).pipe(Effect.mapError(() => failure("commit", "constraint")));
      if (canonicalRequestHash !== input.requestHash)
        return yield* Effect.fail(failure("commit", "constraint"));
      const canonical = canonicalTextModerationInput(input.moderationInput);
      if (
        canonical.kind !== "accepted" ||
        canonical.sha256 !== input.evaluation.input_sha256 ||
        (input.body.title ?? null) !== input.moderationInput.title ||
        (input.body.body ?? null) !== input.moderationInput.body
      )
        return yield* Effect.fail(failure("commit", "constraint"));
      const providerFailure = isProviderFailure(input.evaluation);
      const emptyPolicy =
        input.evaluation.policy_revision === "" && input.evaluation.policy_hash === "";
      if (
        textModerationEvaluationInvariant(input.evaluation as TextModerationEvaluationV1) !==
          null &&
        !(providerFailure && emptyPolicy)
      )
        return yield* Effect.fail(failure("commit", "constraint"));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          // The advisory lock is only a contention fence; it is not a durable
          // reservation. Every accepted request still gets exactly one row.
          yield* lockKey(transaction, idempotencyLockKey(input.actor.userId, input.idempotencyKey));
          const existing = yield* finalByKey(
            transaction,
            {
              actorUserId: input.actor.userId,
              idempotencyKey: input.idempotencyKey,
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
          const evaluation =
            providerFailure &&
            input.evaluation.policy_revision === "" &&
            input.evaluation.policy_hash === ""
              ? {
                  ...input.evaluation,
                  policy_revision: current.policyRevision,
                  policy_hash: current.policyHash,
                }
              : input.evaluation;
          if (
            evaluation.policy_revision !== current.policyRevision ||
            evaluation.policy_hash !== current.policyHash
          )
            return {
              kind: "policy-stale" as const,
              policyRevision: current.policyRevision,
              policyHash: current.policyHash,
            };
          const publicResult = publicTextPublicationResult(
            evaluation as TextModerationEvaluationV1,
          );
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
          const postId = status === "published" ? makeId("post") : null;
          const reviewRef = status === "manual_review" ? makeId("review") : null;
          const snapshot = responseSnapshot({
            submissionId,
            status,
            reasonCode: publicResult.reason_code,
            postId,
            reviewRef,
            at,
          });
          if (textContentSubmissionInvariant(snapshot) !== null)
            return yield* Effect.fail(failure("commit", "invalid-row"));
          const bytes = new TextEncoder().encode(JSON.stringify(snapshot));

          if (postId !== null) {
            yield* transaction.execute({
              label: "text-post.commit.post",
              text: `INSERT INTO posts
                (community_id, post_id, author_user_id, post_type, status, visibility,
                 title, body, created_at, updated_at, idempotency_key, idempotency_body_hash)
               VALUES ($1, $2, $3, 'text', 'published', 'public', $4, $5, $6, $6, $7, $8)`,
              values: [
                input.communityId,
                postId,
                input.actor.userId,
                input.moderationInput.title,
                input.moderationInput.body,
                at,
                input.idempotencyKey,
                input.requestHash,
              ],
              readonly: false,
            });
          }
          yield* transaction.execute({
            label: "text-post.commit.submission",
            text: `INSERT INTO text_content_submissions (
                community_id, submission_id, operation_id, actor_user_id, surface, idempotency_key,
                request_hash, status, moderation_decision, public_reason_code,
                policy_revision_id, policy_hash, input_sha256, internal_reason_codes,
                evidence_ref, published_post_id, published_comment_id, review_ref,
                created_at, updated_at, response_snapshot_bytes, response_snapshot_sha256
              ) VALUES ($1, $2, $3, $4, 'text_post', $5, $6, $7, $8, $9, $10, $11, $12,
                $13::jsonb, $14, $15, NULL, $16, $17, $17, $18, encode(sha256($18), 'hex'))`,
            values: [
              input.communityId,
              submissionId,
              input.operationId,
              input.actor.userId,
              input.idempotencyKey,
              input.requestHash,
              status,
              evaluation.decision,
              publicResult.reason_code,
              current.policyRevision,
              current.policyHash,
              canonical.sha256,
              JSON.stringify(evaluation.reason_codes),
              evaluation.evidence_ref,
              postId,
              reviewRef,
              at,
              bytes,
            ],
            readonly: false,
          });
          if (postId !== null) {
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
                (community_id, case_id, submission_id, status, created_at, updated_at)
               VALUES ($1, $2, $3, 'open', $4, $4)`,
              values: [input.communityId, reviewRef, submissionId, at],
              readonly: false,
            });
          }
          return { kind: "created" as const, snapshot };
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

  return { replay, commitTerminal, getForAuthor };
}

export function makeControlPlaneTextSubmissionRepository(): RepositoryService {
  return makeControlPlaneTextPostRepository();
}

export function makeControlPlaneTextSubmissionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): TextPostStore["Service"] {
  const repository = makeControlPlaneTextPostRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  return {
    replay: (input) => provide(repository.replay(input)),
    commitTerminal: (input) => provide(repository.commitTerminal(input)),
    getForAuthor: (input) => provide(repository.getForAuthor(input)),
  };
}

export type TextSubmissionRepository = TextPostStore["Service"];
