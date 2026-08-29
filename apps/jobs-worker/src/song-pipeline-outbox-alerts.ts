import { AlertCollector, ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { Effect as EffectType, Layer } from "effect";
import { Effect } from "effect";
import {
  type AlertSink,
  alertTick,
  type PipelineHealthSnapshotFields,
  type PipelineLogEvent,
  type PipelineLogFields,
  writePipelineHealthSnapshot,
} from "../../../packages/platform-cf/src/alerts.ts";

type ExhaustedLaunch = Readonly<{
  subsystem: "media" | "data";
  operation_id: string;
  outbox_id: string;
  workflow_revision: string;
  failure_code: string | null;
  outcome: "exhausted" | "queue_dlq" | "replacement_limit";
}>;

type PipelineHealthRow = Readonly<{
  pending_count: number | string;
  retrying_count: number | string;
  exhausted_count: number | string;
  terminal_count: number | string;
  oldest_pending_age_seconds: number | string | null;
  last_success_at: string | Date | null;
}>;

export type SongPipelineEnablement = Readonly<{
  readonly media: boolean;
  readonly data: boolean;
}>;

export type SongPipelineOutboxAlertOptions = Readonly<{
  readonly scheduledTime?: number;
  readonly environment?: string;
  readonly log?: (event: PipelineLogEvent, fields: PipelineLogFields) => void;
  readonly claimSnapshot?: (key: string) => EffectType.Effect<boolean, unknown, never>;
}>;

export const SONG_PIPELINE_HEALTH_INTERVAL_MS = 5 * 60 * 1000;

const healthSql = (subsystem: "media" | "data"): string =>
  subsystem === "media"
    ? `SELECT COUNT(*) FILTER (WHERE state='pending')::int AS pending_count,
              COUNT(*) FILTER (WHERE state IN ('running','failed'))::int AS retrying_count,
              COUNT(*) FILTER (WHERE state='exhausted')::int AS exhausted_count,
              COUNT(*) FILTER (WHERE state='delivered')::int AS terminal_count,
              EXTRACT(EPOCH FROM (clock_timestamp()-MIN(created_at) FILTER (WHERE state='pending')))::bigint AS oldest_pending_age_seconds,
              MAX(delivered_at) AS last_success_at
         FROM media_submission_outbox`
    : `SELECT COUNT(*) FILTER (WHERE state='pending')::int AS pending_count,
              COUNT(*) FILTER (WHERE state IN ('running','failed'))::int AS retrying_count,
              COUNT(*) FILTER (WHERE state='exhausted')::int AS exhausted_count,
              COUNT(*) FILTER (WHERE state='delivered')::int AS terminal_count,
              EXTRACT(EPOCH FROM (clock_timestamp()-MIN(created_at) FILTER (WHERE state='pending')))::bigint AS oldest_pending_age_seconds,
              MAX(updated_at) FILTER (WHERE state='delivered') AS last_success_at
         FROM data_registration_outbox`;

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function isHealthSnapshotBoundary(scheduledTime: number): boolean {
  return (
    Number.isSafeInteger(scheduledTime) && scheduledTime % SONG_PIPELINE_HEALTH_INTERVAL_MS === 0
  );
}

function healthStatus(row: PipelineHealthRow): PipelineHealthSnapshotFields["health"] {
  if (integer(row.exhausted_count) > 0) return "blocked";
  if (integer(row.pending_count) > 0 || integer(row.retrying_count) > 0) return "degraded";
  return "healthy";
}

export const exhaustedLaunchAlert = (row: ExhaustedLaunch) => ({
  key: `song-pipeline:${row.subsystem}-${
    row.outcome === "exhausted"
      ? "launch-exhausted"
      : row.outcome === "queue_dlq"
        ? "queue_dlq"
        : "replacement-limit-reached"
  }`,
  severity: "high" as const,
  body: "A current song-pipeline launch exhausted and requires recovery observation.",
  entity: `${row.subsystem}:${row.operation_id}:r${row.workflow_revision}:${row.outbox_id}`,
  subsystem: row.subsystem,
  operation:
    row.subsystem === "media" ? ("media-analysis" as const) : ("data-registration" as const),
  operation_id: row.operation_id,
  outbox_id: row.outbox_id,
  workflow_revision: Number(row.workflow_revision),
  failure_class: row.failure_code ?? row.outcome,
  outcome: "terminal" as const,
});

export function collectSongPipelineOutboxAlerts(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  enabled: SongPipelineEnablement,
  options: SongPipelineOutboxAlertOptions = {},
) {
  return Effect.provide(runtime)(
    Effect.gen(function* () {
      const queries: string[] = [];
      if (enabled.media) {
        queries.push(`SELECT 'media'::text AS subsystem,outbox.operation_id AS operation_id,
                      outbox.outbox_event_id AS outbox_id,
                      outbox.workflow_revision::text AS workflow_revision,
                      outbox.failure_code,
                      CASE WHEN outbox.workflow_revision>=4 THEN 'replacement_limit'
                           WHEN outbox.state='exhausted' THEN 'exhausted'
                           ELSE 'queue_dlq' END AS outcome
                 FROM media_submission_outbox outbox
                 JOIN media_post_submissions submission
                   ON submission.submission_id=outbox.submission_id
                  AND submission.operation_id=outbox.operation_id
                  AND submission.workflow_revision=outbox.workflow_revision
                WHERE (outbox.state='exhausted'
                       OR (outbox.state='failed' AND outbox.next_eligible_at IS NULL))
                  AND submission.status IN ('processing','action_required','manual_review')`);
      }
      if (enabled.data) {
        queries.push(`SELECT 'data'::text AS subsystem,outbox.registration_operation_id AS operation_id,
                      outbox.outbox_id,outbox.workflow_revision::text,outbox.failure_code,
                      CASE WHEN outbox.workflow_revision>=4 THEN 'replacement_limit'
                           WHEN outbox.state='exhausted' THEN 'exhausted'
                           ELSE 'queue_dlq' END AS outcome
                 FROM data_registration_outbox outbox
                 JOIN data_registration_operations operation
                   ON operation.registration_operation_id=outbox.registration_operation_id
                  AND operation.workflow_revision=outbox.workflow_revision
                WHERE (outbox.state='exhausted'
                       OR (outbox.state='failed' AND outbox.next_eligible_at IS NULL))
                  AND operation.state NOT IN ('registered','failed','reconciliation_required')`);
      }
      if (queries.length === 0) return 0;
      const db = yield* ControlPlaneDb;
      const log =
        options.log ??
        ((event: PipelineLogEvent, fields: PipelineLogFields) => console.info(event, fields));
      if (options.scheduledTime !== undefined) {
        for (const subsystem of ["media", "data"] as const) {
          if (!enabled[subsystem] || !isHealthSnapshotBoundary(options.scheduledTime)) continue;
          if (options.claimSnapshot !== undefined) {
            const window = Math.floor(options.scheduledTime / SONG_PIPELINE_HEALTH_INTERVAL_MS);
            const claimed = yield* options
              .claimSnapshot(`pipeline-health:${subsystem}:window-${window}`)
              .pipe(Effect.catchCause(() => Effect.succeed(false)));
            if (!claimed) continue;
          }
          const health = yield* db
            .execute<PipelineHealthRow>({
              label: `song-pipeline.health.${subsystem}`,
              text: healthSql(subsystem),
              values: [],
              readonly: true,
            })
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (health === null) continue;
          const row = health.rows[0];
          const snapshot = row ?? {
            pending_count: 0,
            retrying_count: 0,
            exhausted_count: 0,
            terminal_count: 0,
            oldest_pending_age_seconds: null,
            last_success_at: null,
          };
          try {
            writePipelineHealthSnapshot(
              {
                environment: options.environment ?? "unknown",
                emitted_at: new Date(options.scheduledTime).toISOString(),
                subsystem,
                pending_count: integer(snapshot.pending_count),
                retrying_count: integer(snapshot.retrying_count),
                exhausted_count: integer(snapshot.exhausted_count),
                terminal_count: integer(snapshot.terminal_count),
                oldest_pending_age_seconds:
                  snapshot.oldest_pending_age_seconds === null
                    ? null
                    : integer(snapshot.oldest_pending_age_seconds),
                last_success_at: timestamp(snapshot.last_success_at),
                health: healthStatus(snapshot),
              },
              log,
            );
          } catch {
            // A logging adapter must not fail alert collection or maintenance.
          }
        }
      }
      const result = yield* db.execute<ExhaustedLaunch>({
        label: "song-pipeline.outbox.exhausted-alerts",
        text: `${queries.join("\nUNION ALL\n")}
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

/** Alert transport or database outages must not reject the rest of a jobs tick. */
export async function runSongPipelineOutboxAlertTick(
  sink: AlertSink,
  alerts: EffectType.Effect<number, unknown, AlertCollector>,
): Promise<void> {
  try {
    await Effect.runPromise(alertTick(sink, alerts));
  } catch {
    console.error("song-pipeline outbox alert collection unavailable");
  }
}
