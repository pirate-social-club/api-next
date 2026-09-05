import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { VideoTransformAttemptStore } from "@pirate/application/video/analysis";
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
  readonly operation:
    | "get"
    | "list"
    | "claim"
    | "mark-launched"
    | "mark-retry-wait"
    | "mark-exhausted"
    | "mark-instance-missing"
    | "reconcile-launch"
    | "touch-reconciliation"
    | "load-transform-attempt"
    | "advance-transform-attempt";
  readonly reason: "invalid-input" | "invalid-row";
  readonly effectIdentity?: string;
}> {}

export type VideoAnalysisOutboxRepositoryFailure =
  | VideoAnalysisOutboxRepositoryError
  | ControlPlaneError;

export interface VideoAnalysisOutboxRepository
  extends VideoAnalysisOutboxStore,
    VideoTransformAttemptStore {
  readonly listEligible: (limit: number) => Promise<readonly VideoAnalysisOutboxRecord[]>;
  readonly touchReconciliation: (record: VideoAnalysisOutboxRecord) => Promise<boolean>;
  readonly listForReconciliation: (limit: number) => Promise<readonly VideoAnalysisOutboxRecord[]>;
  readonly reconcileLaunch: (
    record: VideoAnalysisOutboxRecord,
    instanceId: string | null,
  ) => Promise<boolean>;
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
  const launchAttempts = integer(row.launch_attempts);
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
    !["pending", "launching", "launched", "retry_wait", "exhausted"].includes(String(state)) ||
    launchAttempts === null ||
    launchAttempts < 0 ||
    launchAttempts > 3 ||
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
    launchAttempts,
    claimOwner: row.claim_owner as string | null,
    claimFence,
    workflowInstanceId: row.workflow_instance_id as string | null,
    instanceMissing: row.instance_missing_at !== null,
  });
}

/** PostgreSQL adapter for the durable, lease-recoverable video analysis intent. */
export function makeControlPlaneVideoAnalysisOutboxRepository(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: VideoAnalysisOutboxRepositoryOptions = {},
): VideoAnalysisOutboxRepository {
  const leaseSeconds = options.leaseSeconds ?? 60;
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

  const eligible = `launch_attempts<3 AND (state='pending'
    OR (state='retry_wait' AND next_eligible_at<=clock_timestamp())
    OR (state='launched' AND instance_missing_at IS NOT NULL))
    AND EXISTS (SELECT 1 FROM media_post_submissions s
      WHERE s.submission_id=media_video_analysis_outbox.submission_id
        AND s.creation_revision=media_video_analysis_outbox.creation_revision
        AND s.video_revision=media_video_analysis_outbox.video_revision
        AND s.status='processing')`;
  const listEligible: VideoAnalysisOutboxRepository["listEligible"] = (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Promise.reject(failure("list", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "video-analysis-outbox.list-eligible",
          text: `SELECT * FROM media_video_analysis_outbox WHERE ${eligible}
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
          text: `UPDATE media_video_analysis_outbox SET state='launching',
          launch_attempts=launch_attempts+1,claim_owner=$1,claim_fence=claim_fence+1,
          lease_expires_at=clock_timestamp()+make_interval(secs=>$2),
          next_eligible_at=NULL,failure_code=NULL,updated_at=clock_timestamp()
          WHERE effect_identity=$3 AND ${eligible} RETURNING *`,
          values: [workerId, leaseSeconds, effectIdentity],
          readonly: false,
        });
        if (result.rows.length === 0) return null;
        return decode(result.rows[0] as Row, "claim");
      }),
    );
  };
  const fencedWrite = (
    operation: VideoAnalysisOutboxRepositoryError["operation"],
    record: VideoAnalysisOutboxRecord,
    assignment: string,
    extra: readonly unknown[] = [],
    guard = "",
  ): Promise<boolean> => {
    if (
      !validIdentifier(record.effectIdentity) ||
      !validIdentifier(record.claimOwner) ||
      !Number.isSafeInteger(record.claimFence) ||
      record.claimFence < 1
    ) {
      return Promise.reject(failure(operation, "invalid-input", record.effectIdentity));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: `video-analysis-outbox.${operation}`,
          text: `UPDATE media_video_analysis_outbox SET ${assignment},
          claim_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE effect_identity=$1 AND submission_id=$2 AND operation_id=$3
          AND video_revision=$4 AND creation_revision=$5 AND canonical_video_sha256=$6
          AND claim_owner=$7 AND claim_fence=$8 AND state='launching'
          AND lease_expires_at>clock_timestamp() ${guard}`,
          values: [
            record.effectIdentity,
            record.submissionId,
            record.operationId,
            record.videoRevision,
            record.creationRevision,
            record.canonicalVideoSha256,
            record.claimOwner,
            record.claimFence,
            ...extra,
          ],
          readonly: false,
        });
        return result.rowCount === 1;
      }),
    );
  };
  const markLaunched: VideoAnalysisOutboxStore["markLaunched"] = (record, instanceId) => {
    if (!/^vaw-[0-9a-f]{64}$/u.test(instanceId)) {
      return Promise.reject(failure("mark-launched", "invalid-input", record.effectIdentity));
    }
    return fencedWrite(
      "mark-launched",
      record,
      `state='launched',workflow_instance_id=$9,launched_at=clock_timestamp(),
       instance_missing_at=NULL,next_eligible_at=NULL,failure_code=NULL`,
      [instanceId],
      "AND (workflow_instance_id IS NULL OR workflow_instance_id=$9)",
    );
  };
  const markRetryWait: VideoAnalysisOutboxStore["markRetryWait"] = (record, code) => {
    if (!["provider_unavailable", "provider_timeout", "provider_invalid"].includes(code)) {
      return Promise.reject(failure("mark-retry-wait", "invalid-input", record.effectIdentity));
    }
    const retryAt = new Date(now() + retryBaseMs * 2 ** Math.max(0, record.launchAttempts - 1));
    return fencedWrite(
      "mark-retry-wait",
      record,
      "state='retry_wait',next_eligible_at=$9::timestamptz,failure_code=$10",
      [retryAt.toISOString(), code],
      "AND launch_attempts<3",
    );
  };
  const markExhausted: VideoAnalysisOutboxStore["markExhausted"] = (record) =>
    fencedWrite(
      "mark-exhausted",
      record,
      "state='exhausted',next_eligible_at=NULL,failure_code='provider_unavailable'",
      [],
      "AND launch_attempts=3",
    );
  const markInstanceMissing: VideoAnalysisOutboxStore["markInstanceMissing"] = (record) => {
    if (!validIdentifier(record.effectIdentity) || record.workflowInstanceId === null) {
      return Promise.reject(
        failure("mark-instance-missing", "invalid-input", record.effectIdentity),
      );
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "video-analysis-outbox.mark-instance-missing",
          text: `UPDATE media_video_analysis_outbox
          SET instance_missing_at=COALESCE(instance_missing_at,clock_timestamp()),updated_at=clock_timestamp()
          WHERE effect_identity=$1 AND state='launched' AND claim_fence=$2
          AND workflow_instance_id=$3`,
          values: [record.effectIdentity, record.claimFence, record.workflowInstanceId],
          readonly: false,
        });
        return result.rowCount === 1;
      }),
    );
  };

  const listForReconciliation: VideoAnalysisOutboxRepository["listForReconciliation"] = (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Promise.reject(failure("list", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "video-analysis-outbox.reconciliation-list",
          text: `SELECT * FROM media_video_analysis_outbox
          WHERE (state='launched' OR (state='launching' AND lease_expires_at<=clock_timestamp()))
          AND EXISTS (SELECT 1 FROM media_post_submissions s
            WHERE s.submission_id=media_video_analysis_outbox.submission_id
              AND s.operation_id=media_video_analysis_outbox.operation_id
              AND s.creation_revision=media_video_analysis_outbox.creation_revision
              AND s.video_revision=media_video_analysis_outbox.video_revision
              AND (s.status='processing' OR (s.status='processing_failed'
                AND media_video_analysis_outbox.state='launching' AND launch_attempts=3)))
          AND NOT EXISTS (SELECT 1 FROM media_video_publication_decisions d
            WHERE d.submission_id=media_video_analysis_outbox.submission_id
              AND d.creation_revision=media_video_analysis_outbox.creation_revision)
          ORDER BY updated_at,effect_identity LIMIT $1`,
          values: [limit],
          readonly: true,
        });
        return result.rows.map((row) => decode(row, "list"));
      }),
    );
  };
  // The sweep first observes provider status. It then fences an expired launch;
  // it never reclaims a provider-processing lease or creates an instance itself.
  const reconcileLaunch: VideoAnalysisOutboxRepository["reconcileLaunch"] = (
    record,
    instanceId,
  ) => {
    if (
      !validIdentifier(record.claimOwner) ||
      (instanceId !== null && !/^vaw-[0-9a-f]{64}$/u.test(instanceId))
    ) {
      return Promise.reject(failure("reconcile-launch", "invalid-input", record.effectIdentity));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "video-analysis-outbox.reconcile-launch",
          text: `UPDATE media_video_analysis_outbox SET
          state=CASE WHEN $4::text IS NOT NULL THEN 'launched'
            WHEN launch_attempts=3 THEN 'exhausted' ELSE 'retry_wait' END,
          workflow_instance_id=COALESCE($4,workflow_instance_id),
          launched_at=CASE WHEN $4::text IS NOT NULL THEN clock_timestamp() ELSE launched_at END,
          instance_missing_at=NULL,claim_owner=NULL,lease_expires_at=NULL,
          claim_fence=claim_fence+1,
          failure_code=CASE WHEN $4::text IS NOT NULL THEN NULL ELSE 'provider_unavailable' END,
          next_eligible_at=CASE WHEN $4::text IS NULL AND launch_attempts<3 THEN clock_timestamp() ELSE NULL END,
          updated_at=clock_timestamp()
          WHERE effect_identity=$1 AND state='launching' AND claim_fence=$2
            AND claim_owner=$3 AND lease_expires_at<=clock_timestamp()
            AND ($4::text IS NULL OR workflow_instance_id IS NULL OR workflow_instance_id=$4)`,
          values: [record.effectIdentity, record.claimFence, record.claimOwner, instanceId],
          readonly: false,
        });
        return result.rowCount === 1;
      }),
    );
  };

  const touchReconciliation: VideoAnalysisOutboxRepository["touchReconciliation"] = (record) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "video-analysis-outbox.touch-reconciliation",
          text: `UPDATE media_video_analysis_outbox SET updated_at=clock_timestamp()
          WHERE effect_identity=$1 AND claim_fence=$2 AND state=$3`,
          values: [record.effectIdentity, record.claimFence, record.state],
          readonly: false,
        });
        return result.rowCount === 1;
      }),
    );

  const loadOrCreate: VideoTransformAttemptStore["loadOrCreate"] = (input) => {
    const fence = input.initialAttempt.runtimeFence;
    if (
      !validIdentifier(input.submissionId) ||
      !validIdentifier(input.binding.requestId) ||
      !validIdentifier(input.binding.operationId) ||
      !sha256Pattern.test(input.binding.canonicalVideoSha256) ||
      !Number.isSafeInteger(input.binding.videoRevision) ||
      input.binding.videoRevision < 1 ||
      !Number.isSafeInteger(input.binding.analysisRevision) ||
      input.binding.analysisRevision < 1 ||
      !Number.isSafeInteger(input.binding.creationRevision) ||
      input.binding.creationRevision < 1 ||
      !["audio", "frames", "probe"].includes(input.capability) ||
      !Number.isSafeInteger(fence.submittedAtMs) ||
      !Number.isSafeInteger(fence.runtimeDeadlineMs) ||
      fence.runtimeDeadlineMs <= fence.submittedAtMs ||
      input.initialAttempt.providerJobId !== undefined ||
      input.initialAttempt.providerJobPhase !== undefined
    ) {
      return Promise.reject(
        failure("load-transform-attempt", "invalid-input", input.binding.requestId),
      );
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute({
              label: "video-transform-attempt.authority-lock",
              readonly: true,
              text: "SELECT submission_id FROM media_post_submissions WHERE submission_id=$1 FOR UPDATE",
              values: [input.submissionId],
            });
            yield* tx.execute({
              label: "video-transform-attempt.insert",
              text: `INSERT INTO media_video_transform_attempts
                   (request_id,submission_id,operation_id,video_revision,analysis_revision,
                    canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,creation_revision)
                 SELECT $1::text,$2::text,$3::text,$4::bigint,$5::bigint,$6::text,$7::text,$8::bigint,$9::bigint,$10::bigint
                 WHERE NOT EXISTS (SELECT 1 FROM media_post_submissions WHERE submission_id=$2
                   AND (operation_id IS DISTINCT FROM $3::text
                     OR video_state_snapshot->'video'->>'canonicalSha256' IS DISTINCT FROM $6::text
                     OR status <> 'processing' OR phase IS DISTINCT FROM 'analysis'
                     OR creation_revision <> $10::bigint OR video_revision <> $4::bigint OR analysis_revision <> $5::bigint-1))
                 ON CONFLICT (request_id) DO NOTHING`,
              values: [
                input.binding.requestId,
                input.submissionId,
                input.binding.operationId,
                input.binding.videoRevision,
                input.binding.analysisRevision,
                input.binding.canonicalVideoSha256,
                input.capability,
                fence.submittedAtMs,
                fence.runtimeDeadlineMs,
                input.binding.creationRevision,
              ],
              readonly: false,
            });
            const result = yield* tx.execute<Row>({
              label: "video-transform-attempt.load",
              text: `SELECT submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase
                   FROM media_video_transform_attempts
                  WHERE request_id=$1 AND submission_id=$2 AND operation_id=$3
                    AND video_revision=$4 AND analysis_revision=$5
                    AND canonical_video_sha256=$6 AND capability=$7 AND creation_revision=$8`,
              values: [
                input.binding.requestId,
                input.submissionId,
                input.binding.operationId,
                input.binding.videoRevision,
                input.binding.analysisRevision,
                input.binding.canonicalVideoSha256,
                input.capability,
                input.binding.creationRevision,
              ],
              readonly: true,
            });
            if (result.rows.length !== 1) {
              return yield* Effect.fail(
                failure("load-transform-attempt", "invalid-row", input.binding.requestId),
              );
            }
            const row = result.rows[0] as Row;
            const submittedAtMs = integer(row.submitted_at_ms);
            const runtimeDeadlineMs = integer(row.runtime_deadline_ms);
            if (
              submittedAtMs === null ||
              runtimeDeadlineMs === null ||
              runtimeDeadlineMs <= submittedAtMs ||
              (row.provider_job_id === null) !== (row.provider_job_phase === null) ||
              (row.provider_job_id !== null && !validIdentifier(row.provider_job_id)) ||
              (row.provider_job_phase !== null &&
                row.provider_job_phase !== "allocated" &&
                row.provider_job_phase !== "submitting" &&
                row.provider_job_phase !== "started")
            ) {
              return yield* Effect.fail(
                failure("load-transform-attempt", "invalid-row", input.binding.requestId),
              );
            }
            return {
              version: "media-transform-attempt-v1" as const,
              runtimeFence: { submittedAtMs, runtimeDeadlineMs },
              ...(row.provider_job_id === null
                ? {}
                : {
                    providerJobId: row.provider_job_id as string,
                    providerJobPhase: row.provider_job_phase as
                      | "allocated"
                      | "submitting"
                      | "started",
                  }),
            };
          }),
        );
      }),
    );
  };

  const advance: VideoTransformAttemptStore["advance"] = (input) => {
    if (
      !validIdentifier(input.submissionId) ||
      !validIdentifier(input.binding.requestId) ||
      !validIdentifier(input.binding.operationId) ||
      !validIdentifier(input.attempt.providerJobId) ||
      !Number.isSafeInteger(input.binding.creationRevision) ||
      input.binding.creationRevision < 1 ||
      (input.attempt.providerJobPhase !== "allocated" &&
        input.attempt.providerJobPhase !== "submitting" &&
        input.attempt.providerJobPhase !== "started")
    ) {
      return Promise.reject(
        failure("advance-transform-attempt", "invalid-input", input.binding.requestId),
      );
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "video-transform-attempt.advance",
          text: `UPDATE media_video_transform_attempts
                    SET provider_job_id=$1,provider_job_phase=$2,updated_at=clock_timestamp()
                  WHERE request_id=$3 AND submission_id=$4 AND operation_id=$5
                    AND video_revision=$6 AND analysis_revision=$7
                    AND canonical_video_sha256=$8 AND capability=$9
                    AND submitted_at_ms=$10 AND runtime_deadline_ms=$11
                    AND creation_revision=$12
                    AND ((provider_job_id IS NULL AND $2='allocated') OR (
                      provider_job_id=$1 AND (
                        provider_job_phase=$2 OR
                        (provider_job_phase='allocated' AND $2='submitting') OR
                        (provider_job_phase='submitting' AND $2='started')
                      )
                    ))
                  RETURNING submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase`,
          values: [
            input.attempt.providerJobId,
            input.attempt.providerJobPhase,
            input.binding.requestId,
            input.submissionId,
            input.binding.operationId,
            input.binding.videoRevision,
            input.binding.analysisRevision,
            input.binding.canonicalVideoSha256,
            input.capability,
            input.attempt.runtimeFence.submittedAtMs,
            input.attempt.runtimeFence.runtimeDeadlineMs,
            input.binding.creationRevision,
          ],
          readonly: false,
        });
        if (result.rows.length !== 1) {
          return yield* Effect.fail(
            failure("advance-transform-attempt", "invalid-row", input.binding.requestId),
          );
        }
        return input.attempt;
      }),
    );
  };

  return {
    get,
    listEligible,
    claim,
    markLaunched,
    markRetryWait,
    markExhausted,
    markInstanceMissing,
    listForReconciliation,
    reconcileLaunch,
    touchReconciliation,
    loadOrCreate,
    advance,
  };
}
