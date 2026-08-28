import { AlertCollector, ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { Layer } from "effect";
import { Effect } from "effect";

type ExhaustedLaunch = Readonly<{
  subsystem: "media" | "data";
  operation_id: string;
  outbox_id: string;
  workflow_revision: string;
  failure_code: string | null;
  outcome: "exhausted" | "queue_dlq";
}>;

export const exhaustedLaunchAlert = (row: ExhaustedLaunch) => ({
  key: `song-pipeline:${row.subsystem}-${row.outcome === "exhausted" ? "launch-exhausted" : "queue_dlq"}`,
  severity: "high" as const,
  body: "A current song-pipeline launch exhausted and requires recovery observation.",
  entity: `${row.subsystem}:${row.operation_id}:r${row.workflow_revision}:${row.outbox_id}`,
});

export function collectSongPipelineOutboxAlerts(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  return Effect.provide(runtime)(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<ExhaustedLaunch>({
        label: "song-pipeline.outbox.exhausted-alerts",
        text: `SELECT 'media'::text AS subsystem,outbox.operation_id AS operation_id,
                      outbox.outbox_event_id AS outbox_id,
                      outbox.workflow_revision::text AS workflow_revision,
                      outbox.failure_code,
                      CASE WHEN outbox.state='exhausted' THEN 'exhausted'
                           ELSE 'queue_dlq' END AS outcome
                 FROM media_submission_outbox outbox
                 JOIN media_post_submissions submission
                   ON submission.submission_id=outbox.submission_id
                  AND submission.operation_id=outbox.operation_id
                  AND submission.workflow_revision=outbox.workflow_revision
                WHERE (outbox.state='exhausted'
                       OR (outbox.state='failed' AND outbox.next_eligible_at IS NULL))
                  AND submission.status IN ('processing','action_required','manual_review')
                UNION ALL
               SELECT 'data'::text AS subsystem,outbox.registration_operation_id AS operation_id,
                      outbox.outbox_id,outbox.workflow_revision::text,outbox.failure_code,
                      CASE WHEN outbox.state='exhausted' THEN 'exhausted'
                           ELSE 'queue_dlq' END AS outcome
                 FROM data_registration_outbox outbox
                 JOIN data_registration_operations operation
                   ON operation.registration_operation_id=outbox.registration_operation_id
                  AND operation.workflow_revision=outbox.workflow_revision
                WHERE (outbox.state='exhausted'
                       OR (outbox.state='failed' AND outbox.next_eligible_at IS NULL))
                  AND operation.state NOT IN ('registered','failed','reconciliation_required')
                ORDER BY subsystem,operation_id,workflow_revision
                LIMIT 50`,
        values: [],
        readonly: true,
      });
      const collector = yield* AlertCollector;
      for (const row of result.rows) yield* collector.emit(exhaustedLaunchAlert(row));
      return result.rows.length;
    }),
  );
}
