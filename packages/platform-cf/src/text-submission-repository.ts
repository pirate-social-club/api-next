import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type M2Actor,
  type TextPostFinalizeOutcome,
  type TextPostReplayOutcome,
  TextPostRepositoryError,
  type TextPostReservation,
  type TextPostReserveOutcome,
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
type StoreFailure = TextPostRepositoryError | ControlPlaneError;
type ReplayInput = Parameters<TextPostStore["Service"]["replay"]>[0];
type ReserveInput = Parameters<TextPostStore["Service"]["reserve"]>[0];
type FinalizeInput = Parameters<TextPostStore["Service"]["finalize"]>[0];
type GetInput = Parameters<TextPostStore["Service"]["getForAuthor"]>[0];
type RepositoryService = {
  readonly replay: (
    input: ReplayInput,
  ) => Effect.Effect<TextPostReplayOutcome, StoreFailure, ControlPlaneDb>;
  readonly reserve: (
    input: ReserveInput,
  ) => Effect.Effect<TextPostReserveOutcome, StoreFailure, ControlPlaneDb>;
  readonly finalize: (
    input: FinalizeInput,
  ) => Effect.Effect<TextPostFinalizeOutcome, StoreFailure, ControlPlaneDb>;
  readonly getForAuthor: (
    input: GetInput,
  ) => Effect.Effect<TextPostSubmissionDocument | null, StoreFailure, ControlPlaneDb>;
};

const HASH = /^[0-9a-f]{64}$/u;

const failure = (
  operation: "replay" | "reserve" | "finalize" | "get",
  reason: "not-found" | "membership-required" | "constraint" | "invalid-row",
) => new TextPostRepositoryError({ operation, reason });

const stringValue = (row: Row, key: string): string | null => {
  const current = row[key];
  return typeof current === "string" ? current : null;
};

const validId = (value: string | null): value is string =>
  value !== null && value.length > 0 && value.trim() === value && !value.includes("\u0000");

const validHash = (value: string | null): value is string => value !== null && HASH.test(value);

const iso = (row: Row, key: string): string | null => {
  const current = row[key];
  if (current instanceof Date && Number.isFinite(current.getTime())) return current.toISOString();
  if (typeof current === "string") {
    const parsed = Date.parse(current);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
};

const decodeBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array && value.byteLength > 0) return value;
  if (typeof value === "string" && value.length > 0) return new TextEncoder().encode(value);
  return null;
};

function snapshotFromBytes(row: Row): TextPostSubmissionDocument | null {
  const bytes = decodeBytes(row.response_snapshot_bytes);
  if (bytes === null) return null;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof decoded !== "object" || decoded === null) return null;
    const snapshot = decoded as TextPostSubmissionDocument;
    return textContentSubmissionInvariant(snapshot) === null ? snapshot : null;
  } catch {
    return null;
  }
}

function currentSnapshot(row: Row): TextPostSubmissionDocument | null {
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
    surface !== "text_post" ||
    !["published", "manual_review", "blocked"].includes(status ?? "") ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  const typedStatus = status as "published" | "manual_review" | "blocked";
  const result =
    typedStatus === "published"
      ? ({ decision: "allow", reason_code: null } as const)
      : typedStatus === "blocked"
        ? ({ decision: "blocked", reason_code: "policy_violation" } as const)
        : ({
            decision: "manual_review",
            reason_code:
              publicReason === "moderation_unavailable"
                ? "moderation_unavailable"
                : "review_required",
          } as const);
  const snapshot: TextPostSubmissionDocument = {
    submission_id: submissionId,
    href: `/text-content-submissions/${submissionId}`,
    surface: "text_post",
    status: typedStatus,
    result,
    published_resource:
      typedStatus === "published" && validId(postId)
        ? { kind: "post", post_id: postId, href: `/posts/${postId}` }
        : null,
    review_ref: typedStatus === "manual_review" && validId(reviewRef) ? reviewRef : null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
  return textContentSubmissionInvariant(snapshot) === null ? snapshot : null;
}

const finalByKey = (
  transaction: Transaction,
  input: {
    readonly communityId: string;
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
            WHERE community_id = $1 AND actor_user_id = $2
              AND surface = 'text_post' AND idempotency_key = $3
            ${lock ? "FOR UPDATE" : ""}`,
    values: [input.communityId, input.actorUserId, input.idempotencyKey],
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

const reservationByKey = (
  transaction: Transaction,
  input: Pick<TextPostReservation, "communityId" | "actorId" | "idempotencyKey">,
  lock: boolean,
) =>
  transaction.execute<Row>({
    label: "text-post.reservation-by-key",
    text: `SELECT community_id, submission_id, actor_user_id, surface, idempotency_key,
                  request_hash, input_sha256, title, body, policy_revision_id, policy_hash
             FROM text_post_reservations
            WHERE community_id = $1 AND actor_user_id = $2 AND surface = 'text_post'
              AND idempotency_key = $3
            ${lock ? "FOR UPDATE" : ""}`,
    values: [input.communityId, input.actorId, input.idempotencyKey],
    readonly: !lock,
  });

const reservationById = (transaction: Transaction, reservation: TextPostReservation) =>
  transaction.execute<Row>({
    label: "text-post.reservation-by-id",
    text: `SELECT community_id, submission_id, actor_user_id, surface, idempotency_key,
                  request_hash, input_sha256, title, body, policy_revision_id, policy_hash
             FROM text_post_reservations
            WHERE submission_id = $1
            FOR UPDATE`,
    values: [reservation.submissionId],
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
  communityId: string,
  actorUserId: string,
  idempotencyKey: string,
): string => JSON.stringify([communityId, actorUserId, "text_post", idempotencyKey]);

const authority = (
  transaction: Transaction,
  operation: "reserve" | "finalize",
  communityId: string,
  actorUserId: string,
): Effect.Effect<{ readonly policyRevision: string; readonly policyHash: string }, StoreFailure> =>
  Effect.gen(function* () {
    const community = yield* transaction.execute<Row>({
      label: `text-post.${operation}.lock-community`,
      text: "SELECT community_id FROM communities WHERE community_id = $1 AND status = 'active' FOR UPDATE",
      values: [communityId],
      readonly: false,
    });
    if (community.rows.length !== 1) return yield* Effect.fail(failure(operation, "not-found"));
    const membership = yield* transaction.execute<Row>({
      label: `text-post.${operation}.lock-membership`,
      text: "SELECT status FROM community_memberships WHERE community_id = $1 AND user_id = $2 FOR UPDATE",
      values: [communityId, actorUserId],
      readonly: false,
    });
    if (
      membership.rows.length !== 1 ||
      stringValue(membership.rows[0] as Row, "status") !== "member"
    ) {
      return yield* Effect.fail(failure(operation, "membership-required"));
    }
    const route = yield* transaction.execute<Row>({
      label: `text-post.${operation}.effective-route`,
      text: `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
             SELECT route.community_id
               FROM db_clock
               CROSS JOIN LATERAL effective_active_route($1, db_clock.now) AS route`,
      values: [communityId],
      readonly: true,
    });
    if (route.rows.length !== 1) return yield* Effect.fail(failure(operation, "not-found"));
    const policy = yield* transaction.execute<Row>({
      label: `text-post.${operation}.current-policy`,
      text: `SELECT pointer.policy_revision_id, revision.policy_hash
               FROM text_moderation_policy_current AS pointer
               JOIN text_moderation_policy_revisions AS revision
                 ON revision.policy_revision_id = pointer.policy_revision_id
              WHERE pointer.singleton = TRUE
              FOR UPDATE OF pointer`,
      values: [],
      readonly: false,
    });
    const policyRow = (policy.rows[0] ?? {}) as Row;
    const policyRevision = stringValue(policyRow, "policy_revision_id");
    const policyHash = stringValue(policyRow, "policy_hash");
    if (policy.rows.length !== 1 || !validId(policyRevision) || !validHash(policyHash)) {
      return yield* Effect.fail(failure(operation, "invalid-row"));
    }
    return { policyRevision, policyHash };
  });

const toReservation = (row: Row): TextPostReservation | null => {
  const submissionId = stringValue(row, "submission_id");
  const communityId = stringValue(row, "community_id");
  const actorId = stringValue(row, "actor_user_id");
  const key = stringValue(row, "idempotency_key");
  const requestHash = stringValue(row, "request_hash");
  const inputSha256 = stringValue(row, "input_sha256");
  const policyRevision = stringValue(row, "policy_revision_id");
  const policyHash = stringValue(row, "policy_hash");
  if (
    !validId(submissionId) ||
    !validId(communityId) ||
    !validId(actorId) ||
    !validId(key) ||
    !validHash(requestHash) ||
    !validHash(inputSha256) ||
    !validId(policyRevision) ||
    !validHash(policyHash)
  ) {
    return null;
  }
  return {
    submissionId,
    communityId,
    actorId,
    idempotencyKey: key,
    requestHash,
    inputSha256,
    policyRevision,
    policyHash,
  };
};

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

function responseSnapshot(input: {
  readonly submissionId: string;
  readonly status: "published" | "manual_review" | "blocked";
  readonly reasonCode: "review_required" | "moderation_unavailable" | "policy_violation" | null;
  readonly postId: string | null;
  readonly reviewRef: string | null;
  readonly at: string;
}): TextPostSubmissionDocument {
  return {
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
  };
}

export function makeControlPlaneTextPostRepository(): RepositoryService {
  const replay: RepositoryService["replay"] = (input) =>
    Effect.gen(function* () {
      if (
        !actorInputValid(input.actor, input.communityId, input.idempotencyKey, input.requestHash)
      ) {
        return yield* Effect.fail(failure("replay", "constraint"));
      }
      const db = yield* ControlPlaneDb;
      const result = yield* finalByKey(
        db,
        {
          communityId: input.communityId,
          actorUserId: input.actor.userId,
          idempotencyKey: input.idempotencyKey,
        },
        false,
      );
      if (result.rows.length > 1) return yield* Effect.fail(failure("replay", "invalid-row"));
      if (result.rows.length === 0) return { kind: "none" as const };
      const rowResult = replayRow(result.rows[0] as Row, input.requestHash);
      if (rowResult === null) return yield* Effect.fail(failure("replay", "invalid-row"));
      return rowResult;
    });

  const reserve: RepositoryService["reserve"] = (input) =>
    Effect.gen(function* () {
      if (
        !actorInputValid(input.actor, input.communityId, input.idempotencyKey, input.requestHash) ||
        input.moderationInput.surface !== "text_post"
      ) {
        return yield* Effect.fail(failure("reserve", "constraint"));
      }
      const canonical = canonicalTextModerationInput(input.moderationInput);
      if (canonical.kind !== "accepted")
        return yield* Effect.fail(failure("reserve", "constraint"));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const lock = idempotencyLockKey(
            input.communityId,
            input.actor.userId,
            input.idempotencyKey,
          );
          yield* lockKey(transaction, lock);
          const existing = yield* finalByKey(
            transaction,
            {
              communityId: input.communityId,
              actorUserId: input.actor.userId,
              idempotencyKey: input.idempotencyKey,
            },
            true,
          );
          if (existing.rows.length > 1) return yield* failure("reserve", "invalid-row");
          if (existing.rows.length === 1) {
            const result = replayRow(existing.rows[0] as Row, input.requestHash);
            if (result === null) return yield* failure("reserve", "invalid-row");
            return result.kind === "replay" ? result : result;
          }
          const authorityResult = yield* authority(
            transaction,
            "reserve",
            input.communityId,
            input.actor.userId,
          );
          const reservationInput: TextPostReservation = {
            submissionId: makeId("sub"),
            communityId: input.communityId,
            actorId: input.actor.userId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            inputSha256: canonical.sha256,
            policyRevision: authorityResult.policyRevision,
            policyHash: authorityResult.policyHash,
          };
          const prior = yield* reservationByKey(transaction, reservationInput, true);
          if (prior.rows.length > 1) return yield* failure("reserve", "invalid-row");
          if (prior.rows.length === 1) {
            const existingReservation = toReservation(prior.rows[0] as Row);
            if (existingReservation === null) return yield* failure("reserve", "invalid-row");
            if (existingReservation.requestHash !== input.requestHash) {
              return { kind: "conflict" as const, submissionId: existingReservation.submissionId };
            }
            if (
              existingReservation.policyRevision !== authorityResult.policyRevision ||
              existingReservation.policyHash !== authorityResult.policyHash
            ) {
              yield* transaction.execute({
                label: "text-post.reserve.refresh-policy",
                text: `UPDATE text_post_reservations
                           SET policy_revision_id = $2, policy_hash = $3
                         WHERE submission_id = $1`,
                values: [
                  existingReservation.submissionId,
                  authorityResult.policyRevision,
                  authorityResult.policyHash,
                ],
                readonly: false,
              });
              return {
                kind: "reserved" as const,
                reservation: {
                  ...existingReservation,
                  policyRevision: authorityResult.policyRevision,
                  policyHash: authorityResult.policyHash,
                },
              };
            }
            return { kind: "reserved" as const, reservation: existingReservation };
          }
          const inserted = yield* transaction.execute<Row>({
            label: "text-post.reserve",
            text: `INSERT INTO text_post_reservations
              (community_id, submission_id, actor_user_id, surface, idempotency_key,
               request_hash, input_sha256, title, body, policy_revision_id, policy_hash)
             VALUES ($1, $2, $3, 'text_post', $4, $5, $6, $7, $8, $9, $10)
             RETURNING community_id, submission_id, actor_user_id, surface, idempotency_key,
                       request_hash, input_sha256, policy_revision_id, policy_hash`,
            values: [
              input.communityId,
              reservationInput.submissionId,
              input.actor.userId,
              input.idempotencyKey,
              input.requestHash,
              canonical.sha256,
              input.moderationInput.title,
              input.moderationInput.body,
              authorityResult.policyRevision,
              authorityResult.policyHash,
            ],
            readonly: false,
          });
          const reservation =
            inserted.rows.length === 1 ? toReservation(inserted.rows[0] as Row) : null;
          if (reservation === null) return yield* failure("reserve", "invalid-row");
          return { kind: "reserved" as const, reservation };
        }),
      );
    });

  const finalize: RepositoryService["finalize"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.reservation.submissionId) ||
        !validId(input.reservation.communityId) ||
        !validId(input.reservation.actorId) ||
        !validId(input.reservation.idempotencyKey) ||
        !validHash(input.reservation.requestHash) ||
        !validHash(input.reservation.inputSha256) ||
        textModerationEvaluationInvariant(input.evaluation as TextModerationEvaluationV1) !==
          null ||
        input.evaluation.surface !== "text_post" ||
        input.evaluation.policy_revision !== input.reservation.policyRevision ||
        input.evaluation.policy_hash !== input.reservation.policyHash ||
        input.evaluation.input_sha256 !== input.reservation.inputSha256 ||
        publicTextPublicationResult(input.evaluation as TextModerationEvaluationV1) === null
      ) {
        return yield* Effect.fail(failure("finalize", "constraint"));
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* lockKey(
            transaction,
            idempotencyLockKey(
              input.reservation.communityId,
              input.reservation.actorId,
              input.reservation.idempotencyKey,
            ),
          );
          const final = yield* finalById(transaction, input.reservation.submissionId);
          if (final.rows.length > 1) return yield* failure("finalize", "invalid-row");
          if (final.rows.length === 1) {
            const result = replayRow(final.rows[0] as Row, input.reservation.requestHash);
            if (result === null) return yield* failure("finalize", "invalid-row");
            return result.kind === "replay" ? result : result;
          }
          const reservationRows = yield* reservationById(transaction, input.reservation);
          if (reservationRows.rows.length !== 1) {
            const byKey = yield* finalByKey(
              transaction,
              {
                communityId: input.reservation.communityId,
                actorUserId: input.reservation.actorId,
                idempotencyKey: input.reservation.idempotencyKey,
              },
              true,
            );
            if (byKey.rows.length === 1) {
              const result = replayRow(byKey.rows[0] as Row, input.reservation.requestHash);
              if (result !== null) return result;
            }
            return yield* failure("finalize", "not-found");
          }
          const persisted = toReservation(reservationRows.rows[0] as Row);
          if (persisted === null || persisted.requestHash !== input.reservation.requestHash) {
            return yield* failure("finalize", "invalid-row");
          }
          const authorityResult = yield* authority(
            transaction,
            "finalize",
            persisted.communityId,
            persisted.actorId,
          );
          if (
            authorityResult.policyRevision !== persisted.policyRevision ||
            authorityResult.policyHash !== persisted.policyHash
          ) {
            return {
              kind: "policy-stale" as const,
              policyRevision: authorityResult.policyRevision,
              policyHash: authorityResult.policyHash,
            };
          }
          const nowResult = yield* transaction.execute<Row>({
            label: "text-post.finalize.database-clock",
            text: "SELECT clock_timestamp() AS now",
            values: [],
            readonly: true,
          });
          const at = iso(nowResult.rows[0] as Row, "now");
          if (at === null) return yield* failure("finalize", "invalid-row");
          const status =
            input.evaluation.decision === "allow"
              ? ("published" as const)
              : input.evaluation.decision === "manual_review"
                ? ("manual_review" as const)
                : ("blocked" as const);
          const postId = status === "published" ? makeId("post") : null;
          const reviewRef = status === "manual_review" ? makeId("review") : null;
          const heldId = status === "manual_review" ? makeId("held") : null;
          const publicResult = publicTextPublicationResult(
            input.evaluation as TextModerationEvaluationV1,
          );
          if (publicResult === null) return yield* failure("finalize", "constraint");
          const snapshot = responseSnapshot({
            submissionId: persisted.submissionId,
            status,
            reasonCode: publicResult.reason_code,
            postId,
            reviewRef,
            at,
          });
          const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
          if (textContentSubmissionInvariant(snapshot) !== null)
            return yield* failure("finalize", "invalid-row");
          if (status === "published" && postId !== null) {
            yield* transaction.execute({
              label: "text-post.finalize.post",
              text: `INSERT INTO posts
                (community_id, post_id, author_user_id, post_type, status, visibility,
                 title, body, created_at, updated_at, idempotency_key, idempotency_body_hash)
               SELECT $1, $2, $3, 'text', 'published', 'public', title, body, $4, $4, $5, $6
                 FROM text_post_reservations WHERE submission_id = $7`,
              values: [
                persisted.communityId,
                postId,
                persisted.actorId,
                at,
                persisted.idempotencyKey,
                persisted.requestHash,
                persisted.submissionId,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "text-post.finalize.home-feed",
              text: `INSERT INTO home_feed_projection
                (community_id, feed_item_id, post_id, rank_score, projected_at)
               VALUES ($1, $2, $3, 0, $4)`,
              values: [persisted.communityId, makeId("feed"), postId, at],
              readonly: false,
            });
          }
          yield* transaction.execute({
            label: "text-post.finalize.submission",
            text: `INSERT INTO text_content_submissions (
                community_id, submission_id, actor_user_id, surface, idempotency_key,
                request_hash, status, moderation_decision, public_reason_code,
                policy_revision_id, policy_hash, input_sha256, internal_reason_codes,
                evidence_ref, published_post_id, published_comment_id, review_ref,
                created_at, updated_at, response_snapshot_bytes, response_snapshot_sha256
              ) VALUES ($1, $2, $3, 'text_post', $4, $5, $6, $7, $8, $9, $10, $11,
                $12::jsonb, $13, $14, NULL, $15, $16, $16, $17, encode(sha256($17), 'hex'))`,
            values: [
              persisted.communityId,
              persisted.submissionId,
              persisted.actorId,
              persisted.idempotencyKey,
              persisted.requestHash,
              status,
              input.evaluation.decision,
              publicResult.reason_code,
              persisted.policyRevision,
              persisted.policyHash,
              persisted.inputSha256,
              JSON.stringify(input.evaluation.reason_codes),
              input.evaluation.evidence_ref,
              postId,
              reviewRef,
              at,
              bytes,
            ],
            readonly: false,
          });
          if (status === "manual_review" && heldId !== null && reviewRef !== null) {
            yield* transaction.execute({
              label: "text-post.finalize.held-revision",
              text: `INSERT INTO text_content_held_revisions
                (community_id, held_revision_id, submission_id, title, body, content_sha256, created_at)
               SELECT community_id, $1, submission_id, title, body, input_sha256, $2
                 FROM text_post_reservations WHERE submission_id = $3`,
              values: [heldId, at, persisted.submissionId],
              readonly: false,
            });
            yield* transaction.execute({
              label: "text-post.finalize.review-case",
              text: `INSERT INTO text_moderation_cases
                (community_id, case_id, submission_id, status, created_at, updated_at)
               VALUES ($1, $2, $3, 'open', $4, $4)`,
              values: [persisted.communityId, reviewRef, persisted.submissionId, at],
              readonly: false,
            });
          }
          yield* transaction.execute({
            label: "text-post.finalize.consume-reservation",
            text: "DELETE FROM text_post_reservations WHERE submission_id = $1",
            values: [persisted.submissionId],
            readonly: false,
          });
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
      ) {
        return yield* Effect.fail(failure("get", "constraint"));
      }
      const db = yield* ControlPlaneDb;
      const result = yield* finalById(db, input.submissionId, input.actor.userId);
      if (result.rows.length > 1) return yield* Effect.fail(failure("get", "invalid-row"));
      if (result.rows.length === 0) return null;
      const snapshot = currentSnapshot(result.rows[0] as Row);
      return snapshot === null ? yield* Effect.fail(failure("get", "invalid-row")) : snapshot;
    });

  return { replay, reserve, finalize, getForAuthor };
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
    reserve: (input) => provide(repository.reserve(input)),
    finalize: (input) => provide(repository.finalize(input)),
    getForAuthor: (input) => provide(repository.getForAuthor(input)),
  };
}

export type TextSubmissionRepository = TextPostStore["Service"];
