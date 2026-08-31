import { AlertCollector, ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { Effect as EffectType, Layer } from "effect";
import { Effect } from "effect";
import type { AlertSink } from "../../../packages/platform-cf/src/alerts.ts";
import { alertTick } from "../../../packages/platform-cf/src/alerts.ts";
import {
  type CloudflareDataRegistrationWorkflowBinding,
  makeCloudflareDataRegistrationWorkflowLauncher,
} from "../../../packages/platform-cf/src/data/registration-workflow-cloudflare.ts";
import {
  type CloudflareMediaWorkflowBinding,
  makeCloudflareMediaProcessingWorkflowLauncher,
} from "../../../packages/platform-cf/src/media-processing-cloudflare.ts";
import type { SongPipelineEnablement } from "./song-pipeline-outbox-alerts.ts";
import { SONG_WORKFLOW_MAX_REVISION } from "./song-workflow-recovery-policy.ts";

type Subsystem = "media" | "data";

type ReconciliationRow = Readonly<{
  operation_id: string;
  workflow_revision: string;
}>;

type ProviderFailureRow = Readonly<{
  operation_id: string;
  workflow_revision: string;
  attempt_id: string;
  failure_code: string;
}>;

type WorkflowCeilingRow = Readonly<{
  operation_id: string;
  workflow_revision: string;
  workflow_instance_id: string;
}>;

type DlqAuthorityRow = Readonly<{
  operation_id: string;
  outbox_id: string;
  workflow_revision: string;
  failure_code: string | null;
}>;

type SongPipelineTerminalWorkflowBindings = Readonly<{
  readonly media?: CloudflareMediaWorkflowBinding;
  readonly data?: CloudflareDataRegistrationWorkflowBinding;
}>;

interface SongPipelineDlqMessage {
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: (options?: { readonly delaySeconds?: number }) => void;
}

interface SongPipelineDlqBatch {
  readonly queue: string;
  readonly messages: readonly SongPipelineDlqMessage[];
}

const DATA_RECONCILIATION_ALERT_SQL = `SELECT operation.registration_operation_id AS operation_id,
       operation.workflow_revision::text AS workflow_revision
  FROM data_registration_operations operation
 WHERE operation.state='reconciliation_required'
 ORDER BY operation.updated_at,operation.registration_operation_id
 LIMIT 50`;

const MEDIA_PROVIDER_FAILURE_ALERT_SQL = `SELECT submission.operation_id,
       submission.workflow_revision::text AS workflow_revision,
       attempt.attempt_id,
       attempt.failure_code
  FROM media_processing_attempts attempt
  JOIN media_post_submissions submission
    ON submission.submission_id=attempt.submission_id
   AND submission.operation_id=attempt.operation_id
 WHERE attempt.state='exhausted'
   AND attempt.attempt_number=3
   AND attempt.retryable=FALSE
   AND attempt.failure_code IN ('provider_unavailable','provider_timeout','provider_invalid')
   AND submission.status='manual_review'
   AND submission.review_exhaustion_code='acr_exhausted'
   AND submission.review_exhaustion_attempt_id=attempt.attempt_id
   AND attempt.audio_revision=submission.audio_revision
   AND attempt.analysis_revision=submission.analysis_revision
   AND NOT EXISTS (
     SELECT 1
       FROM media_processing_attempts later
      WHERE later.submission_id=attempt.submission_id
        AND later.operation_id=attempt.operation_id
        AND later.audio_revision=attempt.audio_revision
        AND later.analysis_revision=attempt.analysis_revision
        AND later.stage=attempt.stage
        AND later.attempt_number>attempt.attempt_number
   )
 ORDER BY attempt.updated_at,attempt.attempt_id
 LIMIT 50`;

const MEDIA_WORKFLOW_CEILING_ALERT_SQL = `SELECT submission.operation_id,
       submission.workflow_revision::text AS workflow_revision,
       launch.workflow_instance_id
  FROM media_post_submissions submission
  JOIN media_submission_outbox launch
    ON launch.submission_id=submission.submission_id
   AND launch.operation_id=submission.operation_id
   AND launch.workflow_revision=submission.workflow_revision
   AND launch.event_type IN ('analysis_launch','workflow_replacement')
 WHERE submission.workflow_revision>=${SONG_WORKFLOW_MAX_REVISION}
   AND submission.status IN ('processing','action_required','manual_review')
   AND launch.state IN ('delivered','exhausted')
 ORDER BY submission.updated_at,submission.operation_id
 LIMIT 25`;

const DATA_WORKFLOW_CEILING_ALERT_SQL = `SELECT operation.registration_operation_id AS operation_id,
       operation.workflow_revision::text AS workflow_revision,
       operation.workflow_instance_id
  FROM data_registration_operations operation
  JOIN data_registration_outbox launch
    ON launch.registration_operation_id=operation.registration_operation_id
   AND launch.workflow_revision=operation.workflow_revision
   AND launch.workflow_instance_id=operation.workflow_instance_id
 WHERE operation.workflow_revision>=${SONG_WORKFLOW_MAX_REVISION}
   AND operation.state NOT IN ('registered','failed','reconciliation_required')
   AND launch.state IN ('delivered','exhausted')
 ORDER BY operation.updated_at,operation.registration_operation_id
 LIMIT 25`;

const dlqSql = (subsystem: Subsystem): string =>
  subsystem === "media"
    ? `SELECT submission.operation_id,outbox.outbox_event_id AS outbox_id,
              submission.workflow_revision::text AS workflow_revision,outbox.failure_code
         FROM media_submission_outbox outbox
         JOIN media_post_submissions submission
           ON submission.submission_id=outbox.submission_id
          AND submission.operation_id=outbox.operation_id
          AND submission.workflow_revision=outbox.workflow_revision
        WHERE outbox.outbox_event_id=$1
          AND outbox.state<>'delivered'
          AND submission.status IN ('processing','action_required','manual_review')
        LIMIT 1`
    : `SELECT operation.registration_operation_id AS operation_id,outbox.outbox_id,
              operation.workflow_revision::text AS workflow_revision,outbox.failure_code
         FROM data_registration_outbox outbox
         JOIN data_registration_operations operation
           ON operation.registration_operation_id=outbox.registration_operation_id
          AND operation.workflow_revision=outbox.workflow_revision
          AND operation.workflow_instance_id=outbox.workflow_instance_id
        WHERE outbox.outbox_id=$1
          AND outbox.state<>'delivered'
          AND operation.state NOT IN ('registered','failed','reconciliation_required')
        LIMIT 1`;

const dataReconciliationAlert = (row: ReconciliationRow) => ({
  key: "song-pipeline:data-reconciliation-required",
  severity: "high" as const,
  body: "A current DATA registration requires reconciliation observation.",
  entity: `data:${row.operation_id}:r${row.workflow_revision}`,
  subsystem: "data" as const,
  operation: "data-registration" as const,
  operation_id: row.operation_id,
  workflow_revision: Number(row.workflow_revision),
  failure_class: "reconciliation_required",
  outcome: "terminal" as const,
});

const mediaProviderFailureAlert = (row: ProviderFailureRow) => ({
  key: "song-pipeline:media-provider-terminal-failure",
  severity: "high" as const,
  body: "A current media-provider attempt exhausted and requires observation.",
  entity: `media:${row.operation_id}:r${row.workflow_revision}:${row.attempt_id}`,
  subsystem: "media" as const,
  operation: "media-analysis" as const,
  operation_id: row.operation_id,
  workflow_revision: Number(row.workflow_revision),
  failure_class: row.failure_code,
  outcome: "terminal" as const,
});

const missingWorkflowCeilingAlert = (subsystem: Subsystem, row: WorkflowCeilingRow) => ({
  key: `song-pipeline:${subsystem}-replacement-limit-reached`,
  severity: "high" as const,
  body: "A current song-pipeline Workflow is missing at the replacement ceiling.",
  entity: `${subsystem}:${row.operation_id}:r${row.workflow_revision}:workflow-missing`,
  subsystem,
  operation: subsystem === "media" ? ("media-analysis" as const) : ("data-registration" as const),
  operation_id: row.operation_id,
  workflow_revision: Number(row.workflow_revision),
  failure_class: "workflow_missing_at_replacement_limit",
  outcome: "terminal" as const,
});

export const SONG_MAINTENANCE_OBSERVATION_OPERATION_ID =
  "production-maintenance-observation-20260831" as const;
export const SONG_MAINTENANCE_OBSERVATION_WORKFLOW_ID =
  `media-${SONG_MAINTENANCE_OBSERVATION_OPERATION_ID}-r${SONG_WORKFLOW_MAX_REVISION}` as const;

/**
 * Emits the temporary production proof only after the platform confirms that
 * the opaque revision-ceiling Workflow identity does not exist. The marker is
 * configuration-only: this path never creates a Workflow or writes product
 * state, and removal of the activation overlay removes the fixture entirely.
 */
export function collectSongMaintenanceObservationAlert(
  input: Readonly<{
    enabled: boolean;
    environment: "development" | "staging" | "production";
    media: CloudflareMediaWorkflowBinding | undefined;
  }>,
) {
  if (!input.enabled) return Effect.succeed(0);
  return Effect.gen(function* () {
    if (input.environment !== "production" || input.media === undefined) {
      return yield* Effect.fail(
        new Error("song maintenance observation requires the production media Workflow binding"),
      );
    }
    const media = input.media;

    // Cloudflare documents `get` as throwing for a nonexistent or invalid ID.
    // This source-owned constant is valid, so a throw proves the bounded
    // synthetic identity is absent; a returned instance fails closed.
    const missing = yield* Effect.promise(async () => {
      try {
        await media.get(SONG_MAINTENANCE_OBSERVATION_WORKFLOW_ID);
        return false;
      } catch {
        return true;
      }
    });
    if (!missing) {
      return yield* Effect.fail(
        new Error("song maintenance observation Workflow identity unexpectedly exists"),
      );
    }

    const collector = yield* AlertCollector;
    yield* collector.emit(
      missingWorkflowCeilingAlert("media", {
        operation_id: SONG_MAINTENANCE_OBSERVATION_OPERATION_ID,
        workflow_revision: String(SONG_WORKFLOW_MAX_REVISION),
        workflow_instance_id: SONG_MAINTENANCE_OBSERVATION_WORKFLOW_ID,
      }),
    );
    return 1;
  });
}

const queueDlqAlert = (subsystem: Subsystem, row: DlqAuthorityRow) => ({
  key: `song-pipeline:${subsystem}-queue-dlq`,
  severity: "high" as const,
  body: "A current song-pipeline launch reached its Queue dead-letter queue.",
  entity: `${subsystem}:${row.operation_id}:r${row.workflow_revision}:${row.outbox_id}`,
  subsystem,
  operation: subsystem === "media" ? ("media-analysis" as const) : ("data-registration" as const),
  operation_id: row.operation_id,
  outbox_id: row.outbox_id,
  workflow_revision: Number(row.workflow_revision),
  failure_class: row.failure_code ?? "queue_dlq",
  outcome: "terminal" as const,
});

function report(message: string): void {
  console.error(message);
}

function validRevision(value: string): boolean {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 1;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,256}$/u.test(value);
}

function decodeDlqBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Readonly<Record<string, unknown>>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "outbox_id")) return null;
  return validIdentity(record.outbox_id) ? record.outbox_id : null;
}

async function workflowIsMissing(
  subsystem: Subsystem,
  row: WorkflowCeilingRow,
  bindings: SongPipelineTerminalWorkflowBindings,
): Promise<boolean | null> {
  try {
    if (subsystem === "media") {
      if (bindings.media === undefined) return null;
      const workflow = makeCloudflareMediaProcessingWorkflowLauncher(bindings.media, () => false);
      return (await workflow.get(row.workflow_instance_id)) === "missing";
    }
    if (bindings.data === undefined) return null;
    const workflow = makeCloudflareDataRegistrationWorkflowLauncher(bindings.data, () => false);
    return (await workflow.get(row.workflow_instance_id)) === "missing";
  } catch {
    report(`song-pipeline ${subsystem} Workflow observation unavailable`);
    return null;
  }
}

function safeRows<A>(
  effect: EffectType.Effect<readonly A[], unknown, never>,
  diagnostic: string,
): EffectType.Effect<readonly A[], never, never> {
  return effect.pipe(
    Effect.catchCause(() =>
      Effect.sync(() => {
        report(diagnostic);
        return [];
      }),
    ),
  );
}

export function collectSongPipelineTerminalAlerts(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  enabled: SongPipelineEnablement,
  bindings: SongPipelineTerminalWorkflowBindings,
) {
  return Effect.provide(runtime)(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const collector = yield* AlertCollector;
      let emitted = 0;

      if (enabled.data) {
        const reconciliation = yield* safeRows(
          db
            .execute<ReconciliationRow>({
              label: "song-pipeline.terminal.data-reconciliation",
              text: DATA_RECONCILIATION_ALERT_SQL,
              values: [],
              readonly: true,
            })
            .pipe(Effect.map((result) => result.rows)),
          "song-pipeline DATA reconciliation alert query unavailable",
        );
        for (const row of reconciliation) {
          if (!validIdentity(row.operation_id) || !validRevision(row.workflow_revision)) continue;
          yield* collector.emit(dataReconciliationAlert(row));
          emitted += 1;
        }
      }

      if (enabled.media) {
        const providerFailures = yield* safeRows(
          db
            .execute<ProviderFailureRow>({
              label: "song-pipeline.terminal.media-provider-failures",
              text: MEDIA_PROVIDER_FAILURE_ALERT_SQL,
              values: [],
              readonly: true,
            })
            .pipe(Effect.map((result) => result.rows)),
          "song-pipeline media-provider alert query unavailable",
        );
        for (const row of providerFailures) {
          if (
            !validIdentity(row.operation_id) ||
            !validIdentity(row.attempt_id) ||
            !validIdentity(row.failure_code) ||
            !validRevision(row.workflow_revision)
          ) {
            continue;
          }
          yield* collector.emit(mediaProviderFailureAlert(row));
          emitted += 1;
        }
      }

      for (const subsystem of ["media", "data"] as const) {
        if (!enabled[subsystem]) continue;
        const candidates = yield* safeRows(
          db
            .execute<WorkflowCeilingRow>({
              label: `song-pipeline.terminal.${subsystem}-workflow-ceiling`,
              text:
                subsystem === "media"
                  ? MEDIA_WORKFLOW_CEILING_ALERT_SQL
                  : DATA_WORKFLOW_CEILING_ALERT_SQL,
              values: [],
              readonly: true,
            })
            .pipe(Effect.map((result) => result.rows)),
          `song-pipeline ${subsystem} Workflow ceiling query unavailable`,
        );
        for (const row of candidates) {
          if (
            !validIdentity(row.operation_id) ||
            !validIdentity(row.workflow_instance_id) ||
            !validRevision(row.workflow_revision)
          ) {
            continue;
          }
          const missing = yield* Effect.promise(() => workflowIsMissing(subsystem, row, bindings));
          if (missing !== true) continue;
          yield* collector.emit(missingWorkflowCeilingAlert(subsystem, row));
          emitted += 1;
        }
      }
      return emitted;
    }),
  );
}

function queueSubsystem(queue: string, environment: string): Subsystem | null {
  const suffix =
    environment === "development" || environment === "staging" || environment === "production"
      ? environment
      : null;
  if (suffix === null) return null;
  if (queue === `pirate-media-processing-${suffix}-dlq`) return "media";
  if (queue === `pirate-data-registration-${suffix}-dlq`) return "data";
  return null;
}

function collectDlqAuthorityAlert(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  subsystem: Subsystem,
  outboxId: string,
) {
  return Effect.provide(runtime)(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<DlqAuthorityRow>({
        label: `song-pipeline.dlq.${subsystem}-authority`,
        text: dlqSql(subsystem),
        values: [outboxId],
        readonly: true,
      });
      const row = result.rows[0];
      if (
        row === undefined ||
        !validIdentity(row.operation_id) ||
        !validIdentity(row.outbox_id) ||
        !validRevision(row.workflow_revision) ||
        (row.failure_code !== null && !validIdentity(row.failure_code))
      ) {
        return false;
      }
      const collector = yield* AlertCollector;
      yield* collector.emit(queueDlqAlert(subsystem, row));
      return true;
    }),
  );
}

/** A DLQ delivery never calls a provider or mutates product state. */
export async function handleSongPipelineDlqBatch(
  batch: SongPipelineDlqBatch,
  dependencies: Readonly<{
    runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
    sink: AlertSink;
    environment: string;
  }>,
): Promise<void> {
  const subsystem = queueSubsystem(batch.queue, dependencies.environment);
  if (subsystem === null) {
    report("song-pipeline DLQ queue identity is not authorized");
    for (const message of batch.messages) message.retry({ delaySeconds: 300 });
    return;
  }

  for (const message of batch.messages) {
    const outboxId = decodeDlqBody(message.body);
    if (outboxId === null) {
      report("song-pipeline DLQ payload is invalid");
      message.ack();
      continue;
    }
    try {
      await Effect.runPromise(
        alertTick(
          dependencies.sink,
          collectDlqAuthorityAlert(dependencies.runtime, subsystem, outboxId),
        ),
      );
      message.ack();
    } catch {
      report("song-pipeline DLQ authority query unavailable");
      message.retry({ delaySeconds: 300 });
    }
  }
}
