import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type {
  VideoAnalysisOutboxRecord,
  VideoAnalysisOutboxStore,
} from "@pirate/application/video/analysis-queue";
import { Data, Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const identifierPattern = /^\S(?:.*\S)?$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

const validIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes("\u0000") &&
  identifierPattern.test(value);

const integer = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export class VideoAnalysisOutboxRepositoryError extends Data.TaggedError(
  "VideoAnalysisOutboxRepositoryError",
)<{
  readonly operation: "get" | "list" | "claim" | "complete" | "fail";
  readonly reason: "invalid-input" | "invalid-row";
  readonly effectIdentity?: string;
}> {}

export type VideoAnalysisOutboxRepositoryFailure =
  | VideoAnalysisOutboxRepositoryError
  | ControlPlaneError;

export interface VideoAnalysisOutboxRepository extends VideoAnalysisOutboxStore {
  readonly listEligible: (limit: number) => Promise<readonly VideoAnalysisOutboxRecord[]>;
}

export type VideoAnalysisOutboxRepositoryOptions = Readonly<{
  readonly leaseSeconds?: number;
  readonly retryBaseMs?: number;
  readonly now?: () => number;
}>;

function failure(
  operation: VideoAnalysisOutboxRepositoryError["operation"],
  reason: VideoAnalysisOutboxRepositoryError["reason"],
  effectIdentity?: string,
): VideoAnalysisOutboxRepositoryError {
  return new VideoAnalysisOutboxRepositoryError({
    operation,
    reason,
    ...(effectIdentity === undefined ? {} : { effectIdentity }),
  });
}

function decode(
  row: Row,
  operation: VideoAnalysisOutboxRepositoryError["operation"],
): VideoAnalysisOutboxRecord {
  const videoRevision = integer(row.video_revision);
  const creationRevision = integer(row.creation_revision);
  const deliveryAttempts = integer(row.delivery_attempts);
  const claimFence = integer(row.claim_fence);
  const state = row.state;
  if (
    !validIdentifier(row.effect_identity) ||
    !validIdentifier(row.submission_id) ||
    !validIdentifier(row.operation_id) ||
    videoRevision === null ||
    videoRevision < 1 ||
    creationRevision === null ||
    creationRevision < 1 ||
    typeof row.canonical_video_sha256 !== "string" ||
    !sha256Pattern.test(row.canonical_video_sha256) ||
    !["pending", "running", "delivered", "failed", "exhausted"].includes(String(state)) ||
    deliveryAttempts === null ||
    deliveryAttempts < 0 ||
    deliveryAttempts > 3 ||
    claimFence === null ||
    claimFence < 0 ||
    (row.claim_owner !== null && !validIdentifier(row.claim_owner))
  ) {
    throw failure(operation, "invalid-row", String(row.effect_identity ?? ""));
  }
  return Object.freeze({
    effectIdentity: row.effect_identity,
    submissionId: row.submission_id,
    operationId: row.operation_id,
    videoRevision,
    creationRevision,
    canonicalVideoSha256: row.canonical_video_sha256,
    state: state as VideoAnalysisOutboxRecord["state"],
    deliveryAttempts,
    claimOwner: row.claim_owner as string | null,
    claimFence,
  });
}

/** PostgreSQL adapter for the durable, lease-recoverable video analysis intent. */
export function makeControlPlaneVideoAnalysisOutboxRepository(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: VideoAnalysisOutboxRepositoryOptions = {},
): VideoAnalysisOutboxRepository {
  const leaseSeconds = options.leaseSeconds ?? 15 * 60;
  const retryBaseMs = options.retryBaseMs ?? 30_000;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3_600) {
    throw new TypeError("video analysis outbox lease must be between 1 and 3600 seconds");
  }
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1 || retryBaseMs > 3_600_000) {
    throw new TypeError("video analysis outbox retry base must be bounded");
  }
  const run = <A>(
    effect: Effect.Effect<A, VideoAnalysisOutboxRepositoryFailure, ControlPlaneDb>,
  ): Promise<A> => Effect.runPromise(Effect.provide(runtime)(effect));

  const get: VideoAnalysisOutboxStore["get"] = (effectIdentity) => {
    if (!validIdentifier(effectIdentity)) {
      return Promise.reject(failure("get", "invalid-input", effectIdentity));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "video-analysis-outbox.get",
          text: "SELECT * FROM media_video_analysis_outbox WHERE effect_identity=$1",
          values: [effectIdentity],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) {
          return yield* Effect.fail(failure("get", "invalid-row", effectIdentity));
        }
        return decode(result.rows[0] as Row, "get");
      }),
    );
  };

  const listEligible: VideoAnalysisOutboxRepository["listEligible"] = (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Promise.reject(failure("list", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "video-analysis-outbox.list-eligible",
          text: `SELECT * FROM media_video_analysis_outbox
                  WHERE delivery_attempts < 3 AND (
                    state='pending'
                    OR (state='failed' AND next_eligible_at<=clock_timestamp())
                    OR (state='running' AND lease_expires_at<=clock_timestamp())
                  )
                  ORDER BY created_at,effect_identity LIMIT $1`,
          values: [limit],
          readonly: true,
        });
        return result.rows.map((row) => decode(row, "list"));
      }),
    );
  };

  const claim: VideoAnalysisOutboxStore["claim"] = (effectIdentity, workerId) => {
    if (!validIdentifier(effectIdentity) || !validIdentifier(workerId)) {
      return Promise.reject(failure("claim", "invalid-input", effectIdentity));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "video-analysis-outbox.claim",
          text: `UPDATE media_video_analysis_outbox
                    SET state='running',delivery_attempts=delivery_attempts+1,
                        claim_owner=$1,claim_fence=claim_fence+1,
                        lease_expires_at=clock_timestamp()+make_interval(secs=>$2),
                        next_eligible_at=NULL,failure_code=NULL,updated_at=clock_timestamp()
                  WHERE effect_identity=$3 AND delivery_attempts < 3 AND (
                    state='pending'
                    OR (state='failed' AND next_eligible_at<=clock_timestamp())
                    OR (state='running' AND lease_expires_at<=clock_timestamp())
                  ) RETURNING *`,
          values: [workerId, leaseSeconds, effectIdentity],
          readonly: false,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) {
          return yield* Effect.fail(failure("claim", "invalid-row", effectIdentity));
        }
        return decode(result.rows[0] as Row, "claim");
      }),
    );
  };

  const complete: VideoAnalysisOutboxStore["complete"] = (record) => {
    if (
      !validIdentifier(record.effectIdentity) ||
      !validIdentifier(record.claimOwner) ||
      record.claimFence < 1
    ) {
      return Promise.reject(failure("complete", "invalid-input", record.effectIdentity));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "video-analysis-outbox.complete",
          text: `UPDATE media_video_analysis_outbox
                    SET state='delivered',claim_owner=NULL,lease_expires_at=NULL,
                        delivered_at=clock_timestamp(),failure_code=NULL,next_eligible_at=NULL,
                        updated_at=clock_timestamp()
                  WHERE effect_identity=$1 AND submission_id=$2 AND operation_id=$3
                    AND video_revision=$4 AND creation_revision=$5
                    AND canonical_video_sha256=$6 AND state='running'
                    AND claim_owner=$7 AND claim_fence=$8
                    AND lease_expires_at>clock_timestamp()`,
          values: [
            record.effectIdentity,
            record.submissionId,
            record.operationId,
            record.videoRevision,
            record.creationRevision,
            record.canonicalVideoSha256,
            record.claimOwner,
            record.claimFence,
          ],
          readonly: false,
        });
        return result.rowCount === 1;
      }),
    );
  };

  const fail: VideoAnalysisOutboxStore["fail"] = (record, failureCode) => {
    if (
      !validIdentifier(record.effectIdentity) ||
      !validIdentifier(record.claimOwner) ||
      record.claimFence < 1 ||
      !["provider_unavailable", "provider_timeout", "provider_invalid"].includes(failureCode)
    ) {
      return Promise.reject(failure("fail", "invalid-input", record.effectIdentity));
    }
    const retryAt = new Date(now() + retryBaseMs * 2 ** Math.max(0, record.deliveryAttempts - 1));
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "video-analysis-outbox.fail",
          text: `UPDATE media_video_analysis_outbox
                    SET state=CASE WHEN delivery_attempts>=3 THEN 'exhausted' ELSE 'failed' END,
                        claim_owner=NULL,lease_expires_at=NULL,failure_code=$1,
                        next_eligible_at=CASE WHEN delivery_attempts>=3 THEN NULL ELSE $2::timestamptz END,
                        updated_at=clock_timestamp()
                  WHERE effect_identity=$3 AND submission_id=$4 AND operation_id=$5
                    AND video_revision=$6 AND creation_revision=$7
                    AND canonical_video_sha256=$8 AND state='running'
                    AND claim_owner=$9 AND claim_fence=$10
                    AND lease_expires_at>clock_timestamp()`,
          values: [
            failureCode,
            retryAt.toISOString(),
            record.effectIdentity,
            record.submissionId,
            record.operationId,
            record.videoRevision,
            record.creationRevision,
            record.canonicalVideoSha256,
            record.claimOwner,
            record.claimFence,
          ],
          readonly: false,
        });
        return result.rowCount === 1;
      }),
    );
  };

  return { get, listEligible, claim, complete, fail };
}
